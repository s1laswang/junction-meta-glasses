import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { LabelRead, Profile, ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub, addHud, addStage, getHub, markLatest } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { type LedgerLine } from "../src/ledger.ts";
import { LiveProxy } from "../src/live.ts";
import { SPEC } from "../src/speculate.ts";

process.env.HOLDUP_QUIET = "1";

type ConnectArg = {
  model: string;
  config: Record<string, unknown>;
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

const fld = <T>(value: T | null, confidence = 0.96) => ({ value, confidence });

const AMLODIPINE_LABEL: LabelRead = {
  kind: "medication",
  product: fld("Norvasc"),
  ingredient: fld("amlodipine besilate", 0.97),
  strength: fld("5 mg", 0.96),
  dosing: fld("1 tablet daily", 0.9),
  expiry: fld("2028-06", 0.94),
  allergens: fld(null, 0),
  barcode: fld(null, 0),
  readability: 0.94,
};

const AMLODIPINE_LOW_STRENGTH_LABEL: LabelRead = {
  ...AMLODIPINE_LABEL,
  strength: fld("5 mg", 0.45),
};

const IBUPROFEN_LABEL: LabelRead = {
  kind: "medication",
  product: fld("Burana"),
  ingredient: fld("ibuprofen", 0.97),
  strength: fld("400 mg", 0.96),
  dosing: fld("1 tablet up to 3 times daily", 0.88),
  expiry: fld("2028-09", 0.93),
  allergens: fld(null, 0),
  barcode: fld(null, 0),
  readability: 0.93,
};

const BISOPROLOL_DECIMAL_LABEL: LabelRead = {
  kind: "medication",
  product: fld("Emconcor"),
  ingredient: fld("bisoprolol fumarate", 0.97),
  strength: fld("2.5 mg", 0.95),
  dosing: fld("1 tablet daily", 0.9),
  expiry: fld("2028-11", 0.92),
  allergens: fld(null, 0),
  barcode: fld(null, 0),
  readability: 0.93,
};

const DEMO_PROFILE: Profile = {
  meds: [
    { id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["daily"] },
    { id: "biso", name: "Emconcor", ingredient: "bisoprolol", strength: "2.5 mg", schedule: ["daily"] },
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en",
};

const VALID_JPEG_B64 = Buffer.alloc(160, 0x42).toString("base64");

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
const tempDirs: string[] = [];
const openSockets: WebSocket[] = [];
let httpServer: http.Server | null = null;
let serverPort = 0;

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  liveModels: [...env.liveModels],
  verifyModels: [...env.verifyModels],
  features: [...env.features],
  ledgerPath: env.ledgerPath,
  debounceMs: SPEC.debounceMs,
  minGapMs: SPEC.minGapMs,
};

function makeFakeLiveSession(arg: ConnectArg) {
  const toolResponses: any[] = [];
  let closed = false;
  const session = {
    sendToolResponse(r: any) {
      toolResponses.push(r);
    },
    sendRealtimeInput() {},
    close() {
      closed = true;
    },
  };
  return { arg, toolResponses, get closed() { return closed; }, session };
}

let liveSessions: ReturnType<typeof makeFakeLiveSession>[] = [];
let nextGeneratePayload: unknown = AMLODIPINE_LABEL;

function useTempLedger(tag: string): string {
  const dir = fs.mkdtempSync(path.join(shmRoot, `holdup-spoken-corr-${tag}-`));
  tempDirs.push(dir);
  const p = path.join(dir, "ledger.jsonl");
  env.ledgerPath = p;
  return p;
}

function readLedgerLines(filePath: string): LedgerLine[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerLine);
}

function fidelityLines(filePath: string): LedgerLine[] {
  return readLedgerLines(filePath).filter((l) => l.feature === "live_fidelity");
}

async function ensureServer(): Promise<{ wsBase: string; port: number }> {
  if (!httpServer) {
    httpServer = await startServer(0);
    serverPort = (httpServer.address() as AddressInfo).port;
  }
  return { wsBase: `ws://127.0.0.1:${serverPort}`, port: serverPort };
}

function httpGetJson(port: number, reqPath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET", headers: { connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function connectWs(url: string) {
  const ws = new WebSocket(url);
  openSockets.push(ws);
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    msgs.push(parsed);
    const idx = waiters.findIndex((w) => w.pred(parsed));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const waitFor = (pred: (m: any) => boolean, from = 0, timeoutMs = 2000): Promise<any> => {
    const hit = msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WS waitFor timeout from=${from} seen=${msgs.slice(from).map((x) => x.type).join(",")}`)), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  return { ws, msgs, opened, waitFor };
}

function makeMockSocket() {
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  const closeHandlers: (() => void)[] = [];
  const ws = {
    readyState: 1,
    send(raw: string) {
      const m = JSON.parse(raw);
      msgs.push(m);
      const idx = waiters.findIndex((w) => w.pred(m));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(m);
    },
    on(ev: string, fn: () => void) {
      if (ev === "close") closeHandlers.push(fn);
    },
    close() {
      ws.readyState = 3;
      for (const fn of closeHandlers) fn();
    },
  };
  const waitFor = (pred: (m: any) => boolean, from = 0): Promise<any> => {
    const hit = msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`mock socket waitFor timeout seen=${msgs.slice(from).map((x) => x.type).join(",")}`)), 2000);
      t.unref?.();
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  return { ws: ws as unknown as WebSocket, msgs, waitFor, close: () => ws.close() };
}

function makeDirectRig(id: string, opts: { lang?: string; voice?: boolean; features?: ("scene" | "datamatrix" | "addmed" | "sonar")[] } = {}) {
  const hub = new Hub(id);
  hub.profile = structuredClone(DEMO_PROFILE);
  hub.profile.lang = opts.lang ?? "en";
  if (opts.features) hub.features = new Set(opts.features);
  markLatest(hub);
  const phone = makeMockSocket();
  const hud = makeMockSocket();
  const stage = makeMockSocket();
  hub.clients.add(phone.ws);
  addHud(hud.ws, id);
  addStage(stage.ws, id);
  const proxy = new LiveProxy(hub, { lang: opts.lang ?? "en", voice: opts.voice ?? true });
  hub.live = proxy;
  hub.ring.push({ data: VALID_JPEG_B64, sharpness: 0.92, ts: Date.now(), bytes: 120, source: "phone" });
  phone.msgs.length = 0;
  hud.msgs.length = 0;
  stage.msgs.length = 0;
  return {
    hub,
    proxy,
    phone,
    hud,
    stage,
    cleanup() {
      proxy.stop("test cleanup");
      hud.close();
      stage.close();
      hub.clients.delete(phone.ws);
      hub.dropFrames();
    },
  };
}

async function runVerifyTool(
  session: ReturnType<typeof makeFakeLiveSession>,
  phone: { msgs: any[]; waitFor: (pred: (m: any) => boolean, from?: number) => Promise<any> },
  callId: string,
  question?: string,
): Promise<Verdict> {
  const from = phone.msgs.length;
  session.arg.callbacks.onmessage({
    toolCall: { functionCalls: [{ id: callId, name: "verify_label", args: question ? { question } : {} }] },
  });
  await phone.waitFor((m) => m.type === "checking" && m.phase === "end", from);
  const verdictMsg = phone.msgs.slice(from).find((m): m is Extract<ServerMsg, { type: "verdict" }> => m.type === "verdict");
  assert.ok(verdictMsg, "expected verdict message from verify_label");
  return verdictMsg.verdict;
}

beforeEach(() => {
  liveSessions = [];
  nextGeneratePayload = AMLODIPINE_LABEL;
  SPEC.debounceMs = 60_000;
  SPEC.minGapMs = 60_000;
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
  env.verifyModels = ["gemini-3.8-flash"];
  env.features = ["scene", "datamatrix", "addmed", "sonar"];
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeFakeLiveSession(arg);
    liveSessions.push(s);
    return s.session;
  };
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify(nextGeneratePayload),
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
  });
});

afterEach(() => {
  while (openSockets.length) {
    const ws = openSockets.pop()!;
    try { ws.terminate(); } catch {}
  }
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.liveModels];
  env.verifyModels = [...saved.verifyModels];
  env.features = [...saved.features];
  env.ledgerPath = saved.ledgerPath;
  SPEC.debounceMs = saved.debounceMs;
  SPEC.minGapMs = saved.minGapMs;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(async () => {
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
});

test("matching output transcription over live WS emits no correction and logs live_fidelity ok:true to ledger and /api/stats", async () => {
  const ledgerPath = useTempLedger("ws-match");
  const { wsBase, port } = await ensureServer();
  const sessionId = "sc-ws-match-1";

  const phone = connectWs(`${wsBase}/live?session=${sessionId}`);
  await phone.opened;
  const stage = connectWs(`${wsBase}/hud-ws?role=stage&session=${sessionId}`);
  const hud = connectWs(`${wsBase}/hud-ws?session=${sessionId}`);
  await Promise.all([stage.opened, hud.opened]);

  phone.ws.send(JSON.stringify({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "phone",
    features: [],
  }));
  await phone.waitFor((m) => m.type === "status" && m.live === "open");
  phone.ws.send(JSON.stringify({
    type: "frame",
    data: VALID_JPEG_B64,
    w: 640,
    h: 480,
    sharpness: 0.91,
    ts: Date.now(),
  }));
  await new Promise((r) => setTimeout(r, 20));

  const s = liveSessions[0];
  assert.ok(s);

  nextGeneratePayload = AMLODIPINE_LABEL;
  const verdict1 = await runVerifyTool(s, phone, "vf-ok-1");
  assert.equal(verdict1.level, "match");

  const pFrom1 = phone.msgs.length;
  const stFrom1 = stage.msgs.length;
  s.arg.callbacks.onmessage({ serverContent: { outputTranscription: { text: "Yes, Amlodipine " } } });
  s.arg.callbacks.onmessage({ serverContent: { outputTranscription: { text: "five milligrams, on your list. You haven't taken it today." } } });
  s.arg.callbacks.onmessage({ serverContent: { turnComplete: true } });

  await phone.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true, pFrom1);
  await stage.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true, stFrom1);

  assert.equal(phone.msgs.filter((m) => m.type === "correction").length, 0);
  assert.equal(stage.msgs.filter((m) => m.type === "correction").length, 0);
  assert.equal(hud.msgs.filter((m) => m.type === "correction").length, 0);
  assert.equal(hud.msgs.filter((m) => m.type === "transcript").length, 0);

  nextGeneratePayload = IBUPROFEN_LABEL;
  const verdict2 = await runVerifyTool(s, phone, "vf-ok-2");
  assert.equal(verdict2.level, "warning");

  const pFrom2 = phone.msgs.length;
  s.arg.callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "This is ibuprofen 400 milligrams. It is not on your medication list, and your list says to avoid NSAIDs." },
      turnComplete: true,
    },
  });
  await phone.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true, pFrom2);
  assert.equal(phone.msgs.filter((m) => m.type === "correction").length, 0);

  const hub = getHub(sessionId)!;
  const proxy = hub.live as LiveProxy;
  assert.deepEqual(proxy.fidelity, { checked: 2, mismatched: 0 });

  const fLines = fidelityLines(ledgerPath);
  assert.equal(fLines.length, 2);
  assert.equal(fLines[0].ok, true);
  assert.equal(fLines[0].level, "match");
  assert.equal(fLines[0].reasons, undefined);
  assert.equal(fLines[0].model, "gemini-3.8-live");
  assert.equal(fLines[1].ok, true);
  assert.equal(fLines[1].level, "warning");
  assert.equal(fLines[1].reasons, undefined);

  const rawLedger = fs.readFileSync(ledgerPath, "utf8").toLowerCase();
  assert.ok(!rawLedger.includes("amlodipine"));
  assert.ok(!rawLedger.includes("ibuprofen"));

  const statsRes = await httpGetJson(port, "/api/stats");
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.body.features.live_fidelity.calls, 2);
  assert.equal(statsRes.body.features.live_fidelity.ok, 2);
  assert.equal(statsRes.body.features.live_fidelity.errors, 0);
  assert.deepEqual(statsRes.body.features.live_fidelity.models, { "gemini-3.8-live": 2 });

  proxy.stop("done");
  hub.dropFrames();
});

test("mismatched strength (changed dose and invented dose on unsure) emits correction to phone, keeps HUD clean, and logs category reasons", async () => {
  const ledgerPath = useTempLedger("strength-mismatch");
  const { wsBase, port } = await ensureServer();
  const sessionId = "sc-ws-strength-1";

  const phone = connectWs(`${wsBase}/live?session=${sessionId}`);
  await phone.opened;
  const stage = connectWs(`${wsBase}/hud-ws?role=stage&session=${sessionId}`);
  const hud = connectWs(`${wsBase}/hud-ws?session=${sessionId}`);
  await Promise.all([stage.opened, hud.opened]);

  phone.ws.send(JSON.stringify({
    type: "start",
    profile: DEMO_PROFILE,
    lang: "en",
    voice: true,
    source: "phone",
    features: [],
  }));
  await phone.waitFor((m) => m.type === "status" && m.live === "open");
  phone.ws.send(JSON.stringify({
    type: "frame",
    data: VALID_JPEG_B64,
    w: 640,
    h: 480,
    sharpness: 0.93,
    ts: Date.now(),
  }));
  await new Promise((r) => setTimeout(r, 20));

  const s = liveSessions[0];
  phone.msgs.length = 0;
  stage.msgs.length = 0;
  hud.msgs.length = 0;

  nextGeneratePayload = AMLODIPINE_LABEL;
  const matchVerdict = await runVerifyTool(s, phone, "vf-str-1");
  assert.equal(matchVerdict.level, "match");

  const pIdx1 = phone.msgs.length;
  const stIdx1 = stage.msgs.length;
  s.arg.callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "Yes, Amlodipine 10 mg, on your list. You haven't taken it today." },
      turnComplete: true,
    },
  });
  const corr1 = await phone.waitFor((m) => m.type === "correction", pIdx1);
  await stage.waitFor((m) => m.type === "transcript" && m.role === "assistant" && m.final === true, stIdx1);
  await new Promise((r) => setTimeout(r, 25));

  assert.deepEqual(corr1, {
    type: "correction",
    speech: matchVerdict.speech,
    reasons: ["strength_missing", "strength_invented"],
  });
  assert.ok(stage.msgs.some((m) => m.type === "verdict" && m.verdict.speech === matchVerdict.speech));
  assert.ok(stage.msgs.some((m) => m.type === "transcript" && m.role === "assistant" && m.final === true));
  assert.ok(stage.msgs.every((m) => ["verdict", "coach", "status", "device", "transcript", "checking", "readiness", "ready", "interrupted", "metrics"].includes(m.type)));
  assert.ok(hud.msgs.every((m) => ["verdict", "coach", "status", "device"].includes(m.type)));
  assert.equal(hud.msgs.some((m) => m.type === "correction" || m.type === "transcript"), false);

  nextGeneratePayload = AMLODIPINE_LOW_STRENGTH_LABEL;
  const unsureVerdict = await runVerifyTool(s, phone, "vf-str-2");
  assert.equal(unsureVerdict.level, "unsure");

  const pIdx2 = phone.msgs.length;
  s.arg.callbacks.onmessage({
    serverContent: {
      outputTranscription: { text: "It looks like Amlodipine 5 mg, but I can't read the strength confidently." },
      turnComplete: true,
    },
  });
  const corr2 = await phone.waitFor((m) => m.type === "correction", pIdx2);
  assert.equal(corr2.speech, unsureVerdict.speech);
  assert.deepEqual(corr2.reasons, ["strength_invented"]);

  const fLines = fidelityLines(ledgerPath);
  assert.equal(fLines.length, 2);
  assert.equal(fLines[0].ok, false);
  assert.equal(fLines[0].level, "match");
  assert.equal(fLines[0].reasons, "strength_missing,strength_invented");
  assert.equal(fLines[1].ok, false);
  assert.equal(fLines[1].level, "unsure");
  assert.equal(fLines[1].reasons, "strength_invented");

  const statsRes = await httpGetJson(port, "/api/stats");
  assert.equal(statsRes.body.features.live_fidelity.calls, 2);
  assert.equal(statsRes.body.features.live_fidelity.ok, 0);
  assert.equal(statsRes.body.features.live_fidelity.errors, 2);

  const hub = getHub(sessionId)!;
  (hub.live as LiveProxy).stop("done");
  hub.dropFrames();
});

test("dropped caution and affirmative openers on warning and unsure emit correction and record category codes", async () => {
  const ledgerPath = useTempLedger("caution-affirm");
  const rig = makeDirectRig("sc-caution-1");
  try {
    await rig.proxy.start();
    const s = liveSessions[0];
    rig.phone.msgs.length = 0;
    rig.hud.msgs.length = 0;
    rig.stage.msgs.length = 0;

    nextGeneratePayload = IBUPROFEN_LABEL;
    const warnVerdict1 = await runVerifyTool(s, rig.phone, "vf-caut-1");
    assert.equal(warnVerdict1.level, "warning");

    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "This is Ibuprofen 400 mg, a common painkiller." },
        turnComplete: true,
      },
    });
    const corrDropped = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corrDropped.length, 1);
    assert.deepEqual(corrDropped[0], {
      type: "correction",
      speech: warnVerdict1.speech,
      reasons: ["caution_dropped"],
    });

    nextGeneratePayload = IBUPROFEN_LABEL;
    const warnVerdict2 = await runVerifyTool(s, rig.phone, "vf-caut-2");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Yes, this is Ibuprofen 400 mg, and it isn't on your medication list." },
        turnComplete: true,
      },
    });
    const corrAffirmWarn = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corrAffirmWarn.length, 2);
    assert.deepEqual(corrAffirmWarn[1], {
      type: "correction",
      speech: warnVerdict2.speech,
      reasons: ["affirmative_on_caution"],
    });

    nextGeneratePayload = AMLODIPINE_LOW_STRENGTH_LABEL;
    const unsureVerdict = await runVerifyTool(s, rig.phone, "vf-caut-3");
    assert.equal(unsureVerdict.level, "unsure");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "That's right, it looks like Amlodipine, ask a pharmacist." },
        turnComplete: true,
      },
    });
    const corrAffirmUnsure = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corrAffirmUnsure.length, 3);
    assert.deepEqual(corrAffirmUnsure[2], {
      type: "correction",
      speech: unsureVerdict.speech,
      reasons: ["affirmative_on_caution"],
    });

    assert.equal(rig.hud.msgs.some((m) => m.type === "correction"), false);
    assert.deepEqual(rig.proxy.fidelity, { checked: 3, mismatched: 3 });

    const fLines = fidelityLines(ledgerPath);
    assert.deepEqual(
      fLines.map((l) => ({ ok: l.ok, level: l.level, reasons: l.reasons })),
      [
        { ok: false, level: "warning", reasons: "caution_dropped" },
        { ok: false, level: "warning", reasons: "affirmative_on_caution" },
        { ok: false, level: "unsure", reasons: "affirmative_on_caution" },
      ],
    );
  } finally {
    rig.cleanup();
  }
});

test("missing medicine name triggers name_missing correction while spoken INN or brand from namesFor passes", async () => {
  const ledgerPath = useTempLedger("name-missing");
  const rig = makeDirectRig("sc-name-1");
  try {
    await rig.proxy.start();
    const s = liveSessions[0];
    rig.phone.msgs.length = 0;

    nextGeneratePayload = AMLODIPINE_LABEL;
    const v1 = await runVerifyTool(s, rig.phone, "vf-name-1");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Yes, this is your 5 mg tablet on your list. You haven't taken it today." },
        turnComplete: true,
      },
    });
    const corrections = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corrections.length, 1);
    assert.deepEqual(corrections[0], {
      type: "correction",
      speech: v1.speech,
      reasons: ["name_missing"],
    });

    const v2 = await runVerifyTool(s, rig.phone, "vf-name-2");
    assert.equal(v2.level, "match");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Yes, Amlodipine 5 mg, on your list. You haven't taken it today." },
        turnComplete: true,
      },
    });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 1);

    assert.deepEqual(rig.proxy.fidelity, { checked: 2, mismatched: 1 });
    const fLines = fidelityLines(ledgerPath);
    assert.equal(fLines.length, 2);
    assert.equal(fLines[0].reasons, "name_missing");
    assert.equal(fLines[0].ok, false);
    assert.equal(fLines[1].reasons, undefined);
    assert.equal(fLines[1].ok, true);
  } finally {
    rig.cleanup();
  }
});

test("empty turnComplete and 12s silence fire not_spoken once, while speech arriving after an empty turnComplete clears the timer", async (t) => {
  const ledgerPath = useTempLedger("silence-timeout");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = makeDirectRig("sc-silence-1");
  try {
    await rig.proxy.start();
    const s = liveSessions[0];
    rig.phone.msgs.length = 0;

    nextGeneratePayload = AMLODIPINE_LABEL;
    const v1 = await runVerifyTool(s, rig.phone, "vf-sil-1");
    s.arg.callbacks.onmessage({ serverContent: { outputTranscription: { text: "   " }, turnComplete: true } });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.equal(rig.proxy.fidelity.checked, 0);

    t.mock.timers.tick(11_999);
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);

    t.mock.timers.tick(1);
    const corrAfterSilence = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corrAfterSilence.length, 1);
    assert.deepEqual(corrAfterSilence[0], {
      type: "correction",
      speech: v1.speech,
      reasons: ["not_spoken"],
    });

    t.mock.timers.tick(15_000);
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 1);

    const v2 = await runVerifyTool(s, rig.phone, "vf-sil-2");
    assert.equal(v2.level, "match");
    s.arg.callbacks.onmessage({ serverContent: { turnComplete: true } });
    t.mock.timers.tick(1500);
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: v2.speech },
        turnComplete: true,
      },
    });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 1);
    assert.deepEqual(rig.proxy.fidelity, { checked: 2, mismatched: 1 });

    t.mock.timers.tick(20_000);
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 1);
    assert.deepEqual(rig.proxy.fidelity, { checked: 2, mismatched: 1 });

    const fLines = fidelityLines(ledgerPath);
    assert.deepEqual(
      fLines.map((l) => ({ ok: l.ok, reasons: l.reasons })),
      [
        { ok: false, reasons: "not_spoken" },
        { ok: true, reasons: undefined },
      ],
    );
  } finally {
    rig.cleanup();
    t.mock.timers.reset();
  }
});

test("Finnish and Swedish sessions require VERDICT_LEAD openers and accept localized decimal comma strengths", async () => {
  const ledgerPath = useTempLedger("nordic-lead");
  const fiRig = makeDirectRig("sc-fi-1", { lang: "fi" });
  const svRig = makeDirectRig("sc-sv-1", { lang: "sv" });
  try {
    await fiRig.proxy.start();
    const fiSession = liveSessions[0];
    fiRig.phone.msgs.length = 0;

    nextGeneratePayload = BISOPROLOL_DECIMAL_LABEL;
    const fiVerdict1 = await runVerifyTool(fiSession, fiRig.phone, "vf-fi-1");
    assert.equal(fiVerdict1.level, "match");
    assert.equal(fiSession.toolResponses[0].functionResponses[0].response.output.lead, "Oikea pakkaus.");

    fiSession.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Kyllä, Bisoprolol 2,5 mg on listallasi." },
        turnComplete: true,
      },
    });
    const fiCorr = fiRig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(fiCorr.length, 1);
    assert.deepEqual(fiCorr[0], {
      type: "correction",
      speech: fiVerdict1.speech,
      reasons: ["lead_missing"],
    });

    const fiVerdict2 = await runVerifyTool(fiSession, fiRig.phone, "vf-fi-2");
    fiSession.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Oikea pakkaus. Bisoprolol 2,5 mg on lääkelistallasi. Et ole ottanut sitä tänään." },
        turnComplete: true,
      },
    });
    assert.equal(fiRig.phone.msgs.filter((m) => m.type === "correction").length, 1);
    assert.equal(fiVerdict2.level, "match");

    await svRig.proxy.start();
    const svSession = liveSessions[1];
    svRig.phone.msgs.length = 0;

    nextGeneratePayload = IBUPROFEN_LABEL;
    const svVerdict1 = await runVerifyTool(svSession, svRig.phone, "vf-sv-1");
    assert.equal(svVerdict1.level, "warning");
    assert.equal(svSession.toolResponses[0].functionResponses[0].response.output.lead, "Varning.");

    svSession.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Ja, det här är Ibuprofen 400 mg." },
        turnComplete: true,
      },
    });
    const svCorr = svRig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(svCorr.length, 1);
    assert.deepEqual(svCorr[0], {
      type: "correction",
      speech: svVerdict1.speech,
      reasons: ["affirmative_on_caution", "lead_missing"],
    });

    await runVerifyTool(svSession, svRig.phone, "vf-sv-2");
    svSession.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Varning. Det här är Ibuprofen 400 mg. Det finns inte på din läkemedelslista." },
        turnComplete: true,
      },
    });
    assert.equal(svRig.phone.msgs.filter((m) => m.type === "correction").length, 1);

    const fLines = fidelityLines(ledgerPath);
    assert.deepEqual(
      fLines.map((l) => ({ ok: l.ok, level: l.level, reasons: l.reasons })),
      [
        { ok: false, level: "match", reasons: "lead_missing" },
        { ok: true, level: "match", reasons: undefined },
        { ok: false, level: "warning", reasons: "affirmative_on_caution,lead_missing" },
        { ok: true, level: "warning", reasons: undefined },
      ],
    );
  } finally {
    fiRig.cleanup();
    svRig.cleanup();
  }
});

test("find_item scene verdicts also arm expectSpoken and emit correction when Gemini alters scene strength", async () => {
  const ledgerPath = useTempLedger("scene-fidelity");
  const rig = makeDirectRig("sc-scene-1", { features: ["scene"] });
  try {
    await rig.proxy.start();
    const s = liveSessions[0];
    rig.phone.msgs.length = 0;

    nextGeneratePayload = {
      items: [
        { box_2d: [120, 80, 620, 420], read: AMLODIPINE_LABEL, answers_target: true },
        { box_2d: [120, 560, 620, 900], read: IBUPROFEN_LABEL, answers_target: false },
      ],
    };

    const from = rig.phone.msgs.length;
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "fi-scene-1", name: "find_item", args: { target: "amlodipine" } }] },
    });
    await rig.phone.waitFor((m) => m.type === "checking" && m.phase === "end", from);
    const sceneVerdictMsg = rig.phone.msgs.slice(from).find((m) => m.type === "verdict");
    assert.ok(sceneVerdictMsg);

    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "The box on the left is Amlodipine 20 mg." },
        turnComplete: true,
      },
    });
    const corr = rig.phone.msgs.filter((m) => m.type === "correction");
    assert.equal(corr.length, 1);
    assert.equal(corr[0].speech, sceneVerdictMsg.verdict.speech);
    assert.ok(corr[0].reasons.includes("strength_invented"));

    const fLines = fidelityLines(ledgerPath);
    assert.equal(fLines.length, 1);
    assert.equal(fLines[0].ok, false);
    assert.ok(String(fLines[0].reasons).includes("strength_invented"));
  } finally {
    rig.cleanup();
  }
});

test("multi-turn slicing, barge-in interruption, replaced tool calls, voice:false, and stop() prevent stale expectation misfires", async (t) => {
  const ledgerPath = useTempLedger("cleanup-lifecycle");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = makeDirectRig("sc-clean-1");
  const silentRig = makeDirectRig("sc-clean-voice-off", { voice: false });
  try {
    await rig.proxy.start();
    const s = liveSessions[0];
    rig.phone.msgs.length = 0;

    s.arg.callbacks.onmessage({
      serverContent: { outputTranscription: { text: "Hold it steady for 999 mg check... " } },
    });
    nextGeneratePayload = AMLODIPINE_LABEL;
    const vPreSlice = await runVerifyTool(s, rig.phone, "vf-clean-slice");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: vPreSlice.speech },
        turnComplete: true,
      },
    });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(rig.proxy.fidelity, { checked: 1, mismatched: 0 });

    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Let me know if you want to check another package." },
        turnComplete: true,
      },
    });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(rig.proxy.fidelity, { checked: 1, mismatched: 0 });

    await runVerifyTool(s, rig.phone, "vf-clean-barge");
    s.arg.callbacks.onmessage({
      serverContent: { outputTranscription: { text: "Yes, Amlodipine 50 mg" } },
    });
    s.arg.callbacks.onmessage({ serverContent: { interrupted: true } });
    t.mock.timers.tick(15_000);
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Okay, go ahead and ask your next question." },
        turnComplete: true,
      },
    });
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(rig.proxy.fidelity, { checked: 1, mismatched: 0 });

    nextGeneratePayload = AMLODIPINE_LABEL;
    await runVerifyTool(s, rig.phone, "vf-clean-replace-1");
    t.mock.timers.tick(5_000);
    nextGeneratePayload = IBUPROFEN_LABEL;
    const vReplaced = await runVerifyTool(s, rig.phone, "vf-clean-replace-2");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: vReplaced.speech },
        turnComplete: true,
      },
    });
    t.mock.timers.tick(15_000);
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(rig.proxy.fidelity, { checked: 2, mismatched: 0 });

    await silentRig.proxy.start();
    const silentSession = liveSessions[1];
    nextGeneratePayload = AMLODIPINE_LABEL;
    await runVerifyTool(silentSession, silentRig.phone, "vf-voice-off");
    silentSession.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Yes, wrong 99 mg dose" },
        turnComplete: true,
      },
    });
    t.mock.timers.tick(15_000);
    assert.equal(silentRig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(silentRig.proxy.fidelity, { checked: 0, mismatched: 0 });

    await runVerifyTool(s, rig.phone, "vf-clean-stop");
    rig.proxy.stop("user pressed stop");
    s.arg.callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "Yes, Amlodipine 999 mg" },
        turnComplete: true,
      },
    });
    t.mock.timers.tick(15_000);
    assert.equal(rig.phone.msgs.filter((m) => m.type === "correction").length, 0);
    assert.deepEqual(rig.proxy.fidelity, { checked: 2, mismatched: 0 });

    const fLines = fidelityLines(ledgerPath);
    assert.equal(fLines.length, 2);
    assert.ok(fLines.every((l) => l.ok === true));
  } finally {
    rig.cleanup();
    silentRig.cleanup();
    t.mock.timers.reset();
  }
});
