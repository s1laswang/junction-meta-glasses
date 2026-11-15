import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { LabelRead, ServerMsg } from "../../shared/types.ts";
import { ALL_FEATURES, env } from "../src/env.ts";
import { SCENE_SCHEMA } from "../src/find.ts";
import { ai } from "../src/gemini.ts";
import { getHub, Hub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { LiveProxy, speakInstruction } from "../src/live.ts";
import { SPEC } from "../src/speculate.ts";

process.env.HOLDUP_QUIET = "1";

type ConnectArg = {
  model: string;
  config: {
    tools?: { functionDeclarations?: { name?: string }[] }[];
    systemInstruction?: string;
    sessionResumption?: { handle?: string };
  };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

type GenArg = {
  model: string;
  contents: any[];
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
  };
};

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

const makeRead = (overrides: Partial<LabelRead> = {}): LabelRead => ({
  kind: "medication",
  product: f("Norvasc"),
  ingredient: f("amlodipine", 0.96),
  strength: f("5 mg", 0.95),
  dosing: f("1 tablet daily", 0.9),
  expiry: f("2027-08", 0.92),
  allergens: f<string[]>(null, 0),
  barcode: f(null, 0),
  readability: 0.92,
  ...overrides,
});

const tmpBase = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  live: [...env.liveModels],
  verify: [...env.verifyModels],
  features: [...env.features],
  ledgerPath: env.ledgerPath,
  debounce: SPEC.debounceMs,
  minGap: SPEC.minGapMs,
  holdupKey: process.env.HOLDUP_KEY,
};

function makeSession(arg: ConnectArg) {
  const toolResponses: any[] = [];
  const realtimeInputs: any[] = [];
  let closed = false;
  const session = {
    sendToolResponse: (r: any) => { toolResponses.push(r); },
    sendRealtimeInput: (r: any) => { realtimeInputs.push(r); },
    close: () => { closed = true; },
  };
  return { arg, toolResponses, realtimeInputs, get closed() { return closed; }, session };
}

let sessions: ReturnType<typeof makeSession>[] = [];
let genArgs: GenArg[] = [];
let nextLabelRead: LabelRead = makeRead();
let nextSceneItems: any[] = [];
let tempLedger = "";

const sendTool = (s: ReturnType<typeof makeSession>, ...functionCalls: any[]) =>
  s.arg.callbacks.onmessage({ toolCall: { functionCalls } });

beforeEach(() => {
  sessions = [];
  genArgs = [];
  nextLabelRead = makeRead();
  nextSceneItems = [
    {
      box_2d: [300, 100, 700, 300],
      read: makeRead({ product: f("Burana"), ingredient: f("ibuprofen", 0.96), strength: f("400 mg", 0.95) }),
      answers_target: false,
    },
    {
      box_2d: [300, 700, 700, 900],
      read: makeRead(),
      answers_target: true,
    },
  ];
  tempLedger = path.join(tmpBase, `holdup-w2-ledger-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jsonl`);
  env.ledgerPath = tempLedger;
  delete process.env.HOLDUP_KEY;
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
  env.verifyModels = ["gemini-3.8-flash"];
  env.features = [...ALL_FEATURES];
  SPEC.debounceMs = 60_000;
  SPEC.minGapMs = 60_000;
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };
  (ai.models as any).generateContent = async (arg: GenArg) => {
    genArgs.push(arg);
    if (arg.config?.responseJsonSchema === SCENE_SCHEMA) {
      return { text: JSON.stringify({ items: nextSceneItems }), usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 30 } };
    }
    return { text: JSON.stringify(nextLabelRead), usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24 } };
  };
});

afterEach(() => {
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.live];
  env.verifyModels = [...saved.verify];
  env.features = [...saved.features];
  env.ledgerPath = saved.ledgerPath;
  SPEC.debounceMs = saved.debounce;
  SPEC.minGapMs = saved.minGap;
  if (saved.holdupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = saved.holdupKey;
  if (tempLedger && fs.existsSync(tempLedger)) {
    try { fs.unlinkSync(tempLedger); } catch {}
  }
});

test("Direct LiveProxy constructor syncs opts.lang onto hub.profile.lang and falls back to en when unset", async () => {
  const hubFi = new Hub("direct-ctor-fi");
  hubFi.features = new Set(["scene"]);
  hubFi.profile.meds = [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }];
  const emittedFi: ServerMsg[] = [];
  hubFi.clients.add({ readyState: 1, send(raw: string) { emittedFi.push(JSON.parse(raw) as ServerMsg); } } as unknown as WebSocket);
  const proxyFi = new LiveProxy(hubFi, { lang: "fi", voice: true });
  assert.equal(hubFi.profile.lang, "fi");
  await proxyFi.start();
  try {
    assert.match(sessions[0].arg.config.systemInstruction ?? "", /Language: Finnish\. Speak Finnish\./);
    hubFi.ring.push({ data: "frame-fi", sharpness: 0.9, ts: Date.now(), bytes: 512, source: "phone" });
    sendTool(sessions[0], { id: "d-vf-1", name: "verify_label", args: {} });
    while (!sessions[0].toolResponses.length) await new Promise((r) => setImmediate(r));
    const out = sessions[0].toolResponses[0].functionResponses[0].response.output;
    assert.equal(out.lead, "Oikea pakkaus.");
    assert.equal(out.instruction, speakInstruction("fi", "No disclaimer, add nothing."));
  } finally {
    proxyFi.stop("done");
    hubFi.dropFrames();
  }

  const hubEmpty = new Hub("direct-ctor-empty");
  hubEmpty.profile.lang = "";
  const proxyEmpty = new LiveProxy(hubEmpty, { lang: "", voice: false });
  await proxyEmpty.start();
  try {
    assert.match(sessions[1].arg.config.systemInstruction ?? "", /Language: English\. Speak English\./);
  } finally {
    proxyEmpty.stop("done");
    hubEmpty.dropFrames();
  }
});

test("WS /live mid-session start updates switch verify_label, find_item, and goAway systemInstruction across en -> fi -> sv -> en", async () => {
  const server: http.Server = await startServer(0);
  const sockets: WebSocket[] = [];
  const sessionId = "ws-mid-lang-sync";

  function connectLive(pathAndQuery: string) {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${pathAndQuery}`);
    sockets.push(ws);
    const received: ServerMsg[] = [];
    const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      received.push(msg);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    });
    const open = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> =>
      received.slice(from).find(pred)
        ? Promise.resolve(received.slice(from).find(pred)!)
        : new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("WS waitFor timeout")), 3000);
            waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
          });
    const sync = async (tag: number) => {
      const from = received.length;
      ws.send(JSON.stringify({ type: "ping", t: tag }));
      await waitFor((m) => m.type === "pong" && m.t === tag, from);
    };
    const close = async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { ws, open, received, waitFor, sync, close };
  }

  const amlMed = { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] };
  const metMed = { id: "met", name: "Glucophage", ingredient: "metformin", strength: "500 mg", schedule: ["morning"] };

  try {
    const client = connectLive(`/live?session=${sessionId}`);
    await client.open;

    client.ws.send(JSON.stringify({
      type: "start",
      profile: { meds: [amlMed], allergies: ["peanut"], avoid: ["NSAIDs"], doseLog: [], lang: "en" },
      lang: "en",
      voice: true,
      source: "phone",
      features: ["scene", "addmed"],
    }));

    await client.waitFor((m) => m.type === "ready");
    await client.waitFor((m) => m.type === "status" && m.live === "open");
    assert.equal(sessions.length, 1);
    assert.match(sessions[0].arg.config.systemInstruction ?? "", /Language: English\. Speak English\./);
    assert.match(sessions[0].arg.config.systemInstruction ?? "", /medId "aml": Norvasc \(amlodipine\)/);
    assert.match(sessions[0].arg.config.systemInstruction ?? "", /Allergies: peanut/);

    client.ws.send(JSON.stringify({ type: "frame", data: "F".repeat(160), w: 640, h: 480, sharpness: 0.93, ts: Date.now() }));
    await client.sync(1);

    let idx = client.received.length;
    sendTool(sessions[0], { id: "en-vf-1", name: "verify_label", args: { question: "is this my evening pill?" } });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const enVfOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(enVfOut.level, "match");
    assert.equal("lead" in enVfOut, false);
    assert.equal(enVfOut.instruction, speakInstruction("en", "No disclaimer, add nothing."));

    idx = client.received.length;
    sendTool(sessions[0], { id: "en-fi-1", name: "find_item", args: { target: "my evening pill" } });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const enFiOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(enFiOut.level, "match");
    assert.equal("lead" in enFiOut, false);
    assert.equal(enFiOut.instruction, speakInstruction("en", "If they pick one up, call verify_label."));

    sessions[0].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-fi-1" } });

    client.ws.send(JSON.stringify({
      type: "start",
      profile: { meds: [amlMed, metMed], allergies: ["peanut", "soy"], avoid: ["NSAIDs"], doseLog: [], lang: "fi" },
      lang: "fi",
      voice: true,
      source: "phone",
      features: ["scene", "addmed"],
    }));
    await client.sync(2);
    assert.equal(sessions.length, 1);

    idx = client.received.length;
    nextLabelRead = makeRead();
    sendTool(sessions[0], { id: "fi-vf-match", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const fiMatchOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(fiMatchOut.level, "match");
    assert.equal(fiMatchOut.lead, "Oikea pakkaus.");
    assert.equal(fiMatchOut.instruction, speakInstruction("fi", "No disclaimer, add nothing."));

    idx = client.received.length;
    nextLabelRead = makeRead({ product: f("Burana"), ingredient: f("ibuprofen", 0.97), strength: f("400 mg", 0.96) });
    sendTool(sessions[0], { id: "fi-vf-warn", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const fiWarnOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(fiWarnOut.level, "warning");
    assert.equal(fiWarnOut.lead, "Varoitus.");
    assert.equal(fiWarnOut.instruction, speakInstruction("fi", "No disclaimer, add nothing."));

    idx = client.received.length;
    nextLabelRead = makeRead({ strength: f("5 mg", 0.4) });
    sendTool(sessions[0], { id: "fi-vf-unsure", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const fiUnsureOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(fiUnsureOut.level, "unsure");
    assert.equal(fiUnsureOut.lead, "En ole varma.");

    idx = client.received.length;
    sendTool(sessions[0], { id: "fi-find-match", name: "find_item", args: { target: "iltalääke" } });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const fiSceneOut = sessions[0].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(fiSceneOut.level, "match");
    assert.equal(fiSceneOut.lead, "Oikea pakkaus.");
    assert.equal(fiSceneOut.instruction, speakInstruction("fi", "If they pick one up, call verify_label."));

    idx = client.received.length;
    sessions[0].arg.callbacks.onmessage({ goAway: { timeLeft: "5s" } });
    await client.waitFor((m) => m.type === "status" && m.live === "open", idx);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].arg.config.sessionResumption?.handle, "resume-fi-1");
    assert.match(sessions[1].arg.config.systemInstruction ?? "", /Language: Finnish\. Speak Finnish\./);
    assert.match(sessions[1].arg.config.systemInstruction ?? "", /medId "met": Glucophage \(metformin\)/);
    assert.match(sessions[1].arg.config.systemInstruction ?? "", /Allergies: peanut, soy/);

    sessions[1].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-sv-2" } });

    client.ws.send(JSON.stringify({
      type: "start",
      profile: { meds: [amlMed, metMed], allergies: ["sesame"], avoid: ["NSAIDs", "grapefruit"], doseLog: [], lang: "sv" },
      lang: "sv",
      voice: true,
      source: "phone",
      features: ["scene", "addmed"],
    }));
    await client.sync(3);

    idx = client.received.length;
    nextLabelRead = makeRead();
    sendTool(sessions[1], { id: "sv-vf-match", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const svMatchOut = sessions[1].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(svMatchOut.level, "match");
    assert.equal(svMatchOut.lead, "Rätt förpackning.");
    assert.equal(svMatchOut.instruction, speakInstruction("sv", "No disclaimer, add nothing."));

    idx = client.received.length;
    nextLabelRead = makeRead({ product: f("Burana"), ingredient: f("ibuprofen", 0.97), strength: f("400 mg", 0.96) });
    sendTool(sessions[1], { id: "sv-vf-warn", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const svWarnOut = sessions[1].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(svWarnOut.level, "warning");
    assert.equal(svWarnOut.lead, "Varning.");

    idx = client.received.length;
    nextLabelRead = makeRead({ strength: f("5 mg", 0.35) });
    sendTool(sessions[1], { id: "sv-vf-unsure", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const svUnsureOut = sessions[1].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(svUnsureOut.level, "unsure");
    assert.equal(svUnsureOut.lead, "Jag är inte säker.");

    idx = client.received.length;
    sendTool(sessions[1], { id: "sv-find-match", name: "find_item", args: { target: "kvällstablett" } });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const svSceneOut = sessions[1].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(svSceneOut.level, "match");
    assert.equal(svSceneOut.lead, "Rätt förpackning.");
    assert.equal(svSceneOut.instruction, speakInstruction("sv", "If they pick one up, call verify_label."));

    idx = client.received.length;
    sessions[1].arg.callbacks.onmessage({ goAway: { timeLeft: "4s" } });
    await client.waitFor((m) => m.type === "status" && m.live === "open", idx);
    assert.equal(sessions.length, 3);
    assert.equal(sessions[2].arg.config.sessionResumption?.handle, "resume-sv-2");
    assert.match(sessions[2].arg.config.systemInstruction ?? "", /Language: Swedish\. Speak Swedish\./);
    assert.match(sessions[2].arg.config.systemInstruction ?? "", /Allergies: sesame/);
    assert.match(sessions[2].arg.config.systemInstruction ?? "", /Avoid: NSAIDs, grapefruit/);

    sessions[2].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "resume-en-3" } });

    client.ws.send(JSON.stringify({
      type: "start",
      profile: { meds: [amlMed], allergies: [], avoid: [], doseLog: [], lang: "en" },
      lang: "en",
      voice: true,
      source: "phone",
      features: ["scene", "addmed"],
    }));
    await client.sync(4);

    idx = client.received.length;
    nextLabelRead = makeRead();
    sendTool(sessions[2], { id: "en2-vf-match", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const en2VfOut = sessions[2].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(en2VfOut.level, "match");
    assert.equal("lead" in en2VfOut, false);
    assert.equal(en2VfOut.instruction, speakInstruction("en", "No disclaimer, add nothing."));

    idx = client.received.length;
    sendTool(sessions[2], { id: "en2-find-match", name: "find_item", args: { target: "evening pill" } });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    const en2FiOut = sessions[2].toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal("lead" in en2FiOut, false);
    assert.equal(en2FiOut.instruction, speakInstruction("en", "If they pick one up, call verify_label."));

    idx = client.received.length;
    sessions[2].arg.callbacks.onmessage({ goAway: { timeLeft: "3s" } });
    await client.waitFor((m) => m.type === "status" && m.live === "open", idx);
    assert.equal(sessions.length, 4);
    assert.equal(sessions[3].arg.config.sessionResumption?.handle, "resume-en-3");
    assert.match(sessions[3].arg.config.systemInstruction ?? "", /Language: English\. Speak English\./);
    assert.doesNotMatch(sessions[3].arg.config.systemInstruction ?? "", /Glucophage/);
    assert.match(sessions[3].arg.config.systemInstruction ?? "", /Allergies: none saved/);
    assert.match(sessions[3].arg.config.systemInstruction ?? "", /Avoid: nothing saved/);

    const hub = getHub(sessionId);
    assert.equal(hub?.profile.lang, "en");

    await client.close();
  } finally {
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("add_medication deduplicates case/whitespace/clock schedule slots and prevents 1-of-2 false match after 1 logged dose", async () => {
  const server: http.Server = await startServer(0);
  const sockets: WebSocket[] = [];
  const sessionId = "ws-sched-dedup-1";

  function connectLive(pathAndQuery: string) {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${pathAndQuery}`);
    sockets.push(ws);
    const received: ServerMsg[] = [];
    const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      received.push(msg);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    });
    const open = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> =>
      received.slice(from).find(pred)
        ? Promise.resolve(received.slice(from).find(pred)!)
        : new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("WS waitFor timeout")), 3000);
            waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
          });
    const sync = async (tag: number) => {
      const from = received.length;
      ws.send(JSON.stringify({ type: "ping", t: tag }));
      await waitFor((m) => m.type === "pong" && m.t === tag, from);
    };
    const close = async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { ws, open, received, waitFor, sync, close };
  }

  try {
    const client = connectLive(`/live?session=${sessionId}`);
    await client.open;

    client.ws.send(JSON.stringify({
      type: "start",
      profile: { meds: [], allergies: [], avoid: [], doseLog: [], lang: "en" },
      lang: "en",
      voice: true,
      source: "phone",
      features: ["addmed"],
    }));

    await client.waitFor((m) => m.type === "ready");
    await client.waitFor((m) => m.type === "status" && m.live === "open");
    const s = sessions[0];

    client.ws.send(JSON.stringify({ type: "frame", data: "M".repeat(160), w: 640, h: 480, sharpness: 0.94, ts: Date.now() }));
    await client.sync(10);

    let idx = client.received.length;
    nextLabelRead = makeRead();
    sendTool(s, { id: "vf-aml-0", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = client.received.length;
    sendTool(s, { id: "add-aml-dup", name: "add_medication", args: { schedule: ["evening", "Evening", "  evening  "] } });
    const prop1 = await client.waitFor((m) => m.type === "profile_add", idx);
    assert.equal(prop1.type, "profile_add");
    if (prop1.type !== "profile_add") throw new Error("expected profile_add");
    assert.deepEqual(prop1.med.schedule, ["evening"]);
    assert.match(prop1.speech, /taken in the evening,/);
    assert.doesNotMatch(prop1.speech, /in the evening and in the evening/);

    client.ws.send(JSON.stringify({ type: "profile_add_result", proposalId: prop1.proposalId, accepted: true }));
    await client.sync(11);

    const hub = getHub(sessionId)!;
    assert.equal(hub.profile.meds.length, 1);
    assert.deepEqual(hub.profile.meds[0].schedule, ["evening"]);

    idx = client.received.length;
    sendTool(s, { id: "log-aml-1", name: "log_dose", args: { medId: prop1.med.id } });
    await client.waitFor((m) => m.type === "dose_logged", idx);
    assert.equal(hub.profile.doseLog.length, 1);

    idx = client.received.length;
    sendTool(s, { id: "vf-aml-after-dose", name: "verify_label", args: { question: "did I take this?" } });
    const verdictMsg = await client.waitFor((m) => m.type === "verdict", idx);
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);
    assert.equal(verdictMsg.type, "verdict");
    if (verdictMsg.type === "verdict") {
      assert.equal(verdictMsg.verdict.level, "warning");
      assert.equal(verdictMsg.verdict.takenToday, true);
      assert.match(verdictMsg.verdict.headline, /already taken today/i);
      assert.match(verdictMsg.verdict.speech, /already took it today/i);
      assert.doesNotMatch(verdictMsg.verdict.speech, /1 of 2 doses today/i);
    }
    const afterDoseOut = s.toolResponses.at(-1)!.functionResponses[0].response.output;
    assert.equal(afterDoseOut.level, "warning");
    assert.equal(afterDoseOut.takenToday, true);
    assert.match(afterDoseOut.headline, /already taken today/i);
    assert.doesNotMatch(afterDoseOut.headline, /1 of 2/i);
    assert.match(afterDoseOut.speech, /already took it today/i);

    idx = client.received.length;
    nextLabelRead = makeRead({ product: f("Glucophage"), ingredient: f("metformin", 0.96), strength: f("500 mg", 0.95) });
    sendTool(s, { id: "vf-met-0", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = client.received.length;
    sendTool(s, { id: "add-met-clock", name: "add_medication", args: { schedule: ["8:00", "08.00", "20:00", "20.00"] } });
    const prop2 = await client.waitFor((m) => m.type === "profile_add", idx);
    assert.equal(prop2.type, "profile_add");
    if (prop2.type !== "profile_add") throw new Error("expected profile_add");
    assert.deepEqual(prop2.med.schedule, ["8:00", "20:00"]);

    client.ws.send(JSON.stringify({ type: "profile_add_result", proposalId: prop2.proposalId, accepted: false }));
    await client.sync(12);

    idx = client.received.length;
    sendTool(s, {
      id: "add-met-8cap",
      name: "add_medication",
      args: {
        schedule: [
          "morning", "Morning", "  MORNING ",
          "07:30", "7.30",
          "With   breakfast", "with breakfast",
          "noon", "14:00", "16:00", "18:00", "20:00", "bedtime", "22:30",
        ],
      },
    });
    const prop3 = await client.waitFor((m) => m.type === "profile_add", idx);
    assert.equal(prop3.type, "profile_add");
    if (prop3.type !== "profile_add") throw new Error("expected profile_add");
    assert.deepEqual(prop3.med.schedule, [
      "morning", "07:30", "With   breakfast", "noon", "14:00", "16:00", "18:00", "20:00",
    ]);

    await client.close();
  } finally {
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("toolCallCancellation caps cancelled set at 64 entries with oldest eviction while suppressing recent in-flight verify_label and find_item", async () => {
  const hub = new Hub("cancel-cap-64");
  hub.features = new Set(["scene"]);
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "fi",
  };
  const emitted: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      const msg = JSON.parse(raw) as ServerMsg;
      emitted.push(msg);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    },
  } as unknown as WebSocket);
  const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> =>
    emitted.slice(from).find(pred)
      ? Promise.resolve(emitted.slice(from).find(pred)!)
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("waitFor timeout")), 2000);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
        });

  const proxy = new LiveProxy(hub, { lang: "fi", voice: true });
  hub.live = proxy;

  try {
    await proxy.start();
    const s = sessions[0];
    const cancelledSet = (proxy as any).cancelled as Set<string>;

    const hundredIds = Array.from({ length: 100 }, (_, i) => `stale-${i}`);
    s.arg.callbacks.onmessage({ toolCallCancellation: { ids: hundredIds } });
    assert.equal(cancelledSet.size, 64);
    assert.equal(cancelledSet.has("stale-0"), false);
    assert.equal(cancelledSet.has("stale-35"), false);
    assert.equal(cancelledSet.has("stale-36"), true);
    assert.equal(cancelledSet.has("stale-99"), true);

    s.arg.callbacks.onmessage({ toolCallCancellation: { ids: ["stale-36"] } });
    assert.equal(cancelledSet.size, 64);
    assert.equal(cancelledSet.has("stale-37"), true);
    assert.equal([...cancelledSet].at(-1), "stale-36");

    hub.ring.push({ data: "frame-cancel-1", sharpness: 0.92, ts: Date.now(), bytes: 1024, source: "phone" });

    let vfInFlight!: () => void;
    let fiInFlight!: () => void;
    let releaseVf!: () => void;
    let releaseFi!: () => void;
    const vfEntered = new Promise<void>((r) => { vfInFlight = r; });
    const fiEntered = new Promise<void>((r) => { fiInFlight = r; });
    const vfGate = new Promise<void>((r) => { releaseVf = r; });
    const fiGate = new Promise<void>((r) => { releaseFi = r; });

    (ai.models as any).generateContent = async (arg: GenArg) => {
      if (arg.config?.responseJsonSchema === SCENE_SCHEMA) {
        fiInFlight();
        await fiGate;
        return { text: JSON.stringify({ items: nextSceneItems }), usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 30 } };
      }
      vfInFlight();
      await vfGate;
      return { text: JSON.stringify(nextLabelRead), usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24 } };
    };

    const startIdx = emitted.length;
    sendTool(
      s,
      { id: "inflight-vf", name: "verify_label", args: { question: "is this right?" } },
      { id: "inflight-fi", name: "find_item", args: { target: "evening pill" } },
    );
    await Promise.all([vfEntered, fiEntered]);

    const fillerIds = Array.from({ length: 60 }, (_, i) => `recent-pad-${i}`);
    s.arg.callbacks.onmessage({ toolCallCancellation: { ids: ["inflight-vf", "inflight-fi", ...fillerIds] } });
    assert.equal(cancelledSet.size, 64);
    assert.equal(cancelledSet.has("inflight-vf"), true);
    assert.equal(cancelledSet.has("inflight-fi"), true);

    releaseVf();
    releaseFi();
    await waitFor((m) => emitted.slice(startIdx).filter((x) => x.type === "checking" && x.phase === "end").length === 2, startIdx);

    assert.equal(emitted.slice(startIdx).some((m) => m.type === "verdict"), false);
    assert.equal(s.toolResponses.length, 0);
    assert.equal(cancelledSet.has("inflight-vf"), false);
    assert.equal(cancelledSet.has("inflight-fi"), false);
    assert.equal(cancelledSet.size, 62);

    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(nextLabelRead),
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24 },
    });

    const okIdx = emitted.length;
    sendTool(s, { id: "fresh-vf-ok", name: "verify_label", args: {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", okIdx);
    assert.equal(emitted.slice(okIdx).some((m) => m.type === "verdict"), true);
    assert.equal(s.toolResponses.length, 1);
    assert.equal(s.toolResponses[0].functionResponses[0].response.output.lead, "Oikea pakkaus.");
  } finally {
    proxy.stop("done");
    hub.dropFrames();
  }
});
