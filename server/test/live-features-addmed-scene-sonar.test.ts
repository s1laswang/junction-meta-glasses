import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import WebSocket from "ws";
import type { LabelRead, Med, ServerMsg } from "../../shared/types.ts";
import { ALL_FEATURES, env } from "../src/env.ts";
import { SCENE_SCHEMA } from "../src/find.ts";
import { ai } from "../src/gemini.ts";
import { parseGs1 } from "../src/gs1.ts";
import { getHub, Hub } from "../src/hub.ts";
import { startServer } from "../src/index.ts";
import { leadFor, LiveProxy, speakInstruction, TOOLS, toolsFor } from "../src/live.ts";
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

const AML_GTIN = "09501101530003";
const MET_GTIN = "06410045012349";

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  live: [...env.liveModels],
  verify: [...env.verifyModels],
  features: [...env.features],
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

const sendTool = (s: ReturnType<typeof makeSession>, ...functionCalls: any[]) =>
  s.arg.callbacks.onmessage({ toolCall: { functionCalls } });

function makeRig(id: string, opts: { lang?: string; features?: Iterable<string> } = {}) {
  const hub = new Hub(id);
  const lang = opts.lang ?? "en";
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang,
  };
  if (opts.features) hub.features = new Set(opts.features) as Hub["features"];
  const emitted: ServerMsg[] = [];
  const hudEmitted: ServerMsg[] = [];
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
  hub.huds.add({
    readyState: 1,
    send(raw: string) {
      hudEmitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket);
  const proxy = new LiveProxy(hub, { lang, voice: true });
  hub.live = proxy;
  const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> =>
    emitted.slice(from).find(pred)
      ? Promise.resolve(emitted.slice(from).find(pred)!)
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout waiting for ServerMsg")), 2000);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
        });
  return { hub, proxy, emitted, hudEmitted, waitFor };
}

async function withRig(
  id: string,
  opts: { lang?: string; features?: Iterable<string> },
  fn: (r: ReturnType<typeof makeRig>) => Promise<void>,
) {
  const r = makeRig(id, opts);
  try {
    await fn(r);
  } finally {
    r.proxy.stop("test done");
    r.hub.dropFrames();
  }
}

beforeEach(() => {
  sessions = [];
  genArgs = [];
  delete process.env.HOLDUP_KEY;
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
  env.verifyModels = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
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
    return { text: JSON.stringify(makeRead()), usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 24 } };
  };
});

afterEach(() => {
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.live];
  env.verifyModels = [...saved.verify];
  env.features = [...saved.features];
  SPEC.debounceMs = saved.debounce;
  SPEC.minGapMs = saved.minGap;
  if (saved.holdupKey === undefined) delete process.env.HOLDUP_KEY;
  else process.env.HOLDUP_KEY = saved.holdupKey;
});

test("toolsFor(features) gates M1 tools when empty, find_item only with scene, and add_medication only with addmed", async () => {
  assert.deepEqual(toolsFor(new Set()), TOOLS);
  assert.deepEqual(toolsFor(new Set()).map((t) => t.name), ["verify_label", "show_cue", "log_dose"]);
  assert.deepEqual(toolsFor(new Set(["sonar", "datamatrix"])), TOOLS);
  assert.deepEqual(toolsFor(new Set(["scene"])).map((t) => t.name), ["verify_label", "show_cue", "log_dose", "find_item"]);
  assert.deepEqual(toolsFor(new Set(["addmed"])).map((t) => t.name), ["verify_label", "show_cue", "log_dose", "add_medication"]);
  assert.deepEqual(
    toolsFor(new Set(["scene", "addmed", "sonar", "datamatrix"])).map((t) => t.name),
    ["verify_label", "show_cue", "log_dose", "find_item", "add_medication"],
  );

  await withRig("gate-disabled", { features: [] }, async ({ proxy }) => {
    await proxy.start();
    const s = sessions[0];
    assert.deepEqual(s.arg.config.tools?.[0]?.functionDeclarations?.map((t) => t.name), ["verify_label", "show_cue", "log_dose"]);
    sendTool(
      s,
      { id: "g1", name: "find_item", args: { target: "my evening pill" } },
      { id: "g2", name: "add_medication", args: { schedule: ["evening"] } },
    );
    await Promise.resolve();
    assert.deepEqual(s.toolResponses[0].functionResponses[0].response.output, { error: "unknown tool find_item" });
    assert.deepEqual(s.toolResponses[1].functionResponses[0].response.output, { error: "unknown tool add_medication" });
  });
});

test("find_item returns unsure without model call on empty ring, emits scene verdict with scene schema on populated ring, and drops cancelled call", () =>
  withRig("scene-en", { features: ["scene"] }, async ({ hub, proxy, emitted, waitFor }) => {
    const scenePayload = {
      items: [
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
      ],
    };
    (ai.models as any).generateContent = async (arg: GenArg) => {
      genArgs.push(arg);
      return { text: JSON.stringify(scenePayload), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 40 } };
    };

    await proxy.start();
    const s = sessions[0];
    assert.deepEqual(s.arg.config.tools?.[0]?.functionDeclarations?.map((t) => t.name), ["verify_label", "show_cue", "log_dose", "find_item"]);

    let idx = emitted.length;
    sendTool(s, { id: "fi-0", name: "find_item", args: { target: "my evening pill" } });
    await Promise.resolve();
    assert.equal(genArgs.length, 0);
    assert.deepEqual(emitted.slice(idx), []);
    assert.equal(s.toolResponses[0].functionResponses[0].response.output.level, "unsure");
    assert.match(s.toolResponses[0].functionResponses[0].response.output.speech, /can't see the table yet/i);

    hub.ring.push({ data: "scene-frame-1", sharpness: 0.88, ts: Date.now(), bytes: 4096, source: "phone" });
    idx = emitted.length;
    sendTool(s, { id: "fi-1", name: "find_item", args: { target: "which one is my evening pill?" } });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    assert.equal(genArgs.length, 1);
    assert.equal(genArgs[0].config?.responseMimeType, "application/json");
    assert.deepEqual(genArgs[0].config?.responseJsonSchema, SCENE_SCHEMA);

    const slice = emitted.slice(idx);
    assert.deepEqual(slice.map((m) => m.type), ["checking", "verdict", "checking"]);
    assert.deepEqual(slice[0], { type: "checking", phase: "start" });
    assert.deepEqual(slice[2], { type: "checking", phase: "end" });
    assert.equal(slice[1].type, "verdict");
    if (slice[1].type === "verdict") {
      assert.equal(slice[1].verdict.mode, "scene");
      assert.equal(slice[1].verdict.level, "match");
      assert.equal(slice[1].verdict.matchedMedId, "aml");
      assert.deepEqual(slice[1].verdict.items?.map((i) => [i.position, i.level]), [["left", "warning"], ["right", "match"]]);
    }

    const out = s.toolResponses[1].functionResponses[0].response.output;
    assert.equal(out.mode, "scene");
    assert.equal(out.level, "match");
    assert.equal("lead" in out, false);
    assert.equal(out.instruction, speakInstruction("en", "If they pick one up, call verify_label."));
    assert.deepEqual(out.items.map((i: any) => [i.position, i.level]), [["left", "warning"], ["right", "match"]]);

    let markInFlight!: () => void;
    let releaseScene!: () => void;
    const inFlight = new Promise<void>((r) => { markInFlight = r; });
    const gate = new Promise<void>((r) => { releaseScene = r; });
    (ai.models as any).generateContent = async (arg: GenArg) => {
      genArgs.push(arg);
      markInFlight();
      await gate;
      return { text: JSON.stringify(scenePayload), usageMetadata: {} };
    };

    const responsesBeforeCancel = s.toolResponses.length;
    idx = emitted.length;
    sendTool(s, { id: "fi-cancel", name: "find_item", args: { target: "my evening pill" } });
    await inFlight;
    s.arg.callbacks.onmessage({ toolCallCancellation: { ids: ["fi-cancel"] } });
    releaseScene();
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    assert.deepEqual(emitted.slice(idx), [{ type: "checking", phase: "start" }, { type: "checking", phase: "end" }]);
    assert.equal(s.toolResponses.length, responsesBeforeCancel);
  }));

test("find_item includes Finnish and Swedish leadFor and localized speakInstruction when lang is fi or sv", async () => {
  const scenePayload = {
    items: [
      { box_2d: [300, 150, 700, 350], read: makeRead({ product: f("Burana"), ingredient: f("ibuprofen"), strength: f("400 mg") }), answers_target: false },
      { box_2d: [300, 650, 700, 850], read: makeRead(), answers_target: true },
    ],
  };
  (ai.models as any).generateContent = async (arg: GenArg) => {
    genArgs.push(arg);
    return { text: JSON.stringify(scenePayload), usageMetadata: {} };
  };

  for (const lang of ["fi", "sv"] as const) {
    await withRig(`scene-${lang}`, { lang, features: ["scene"] }, async ({ hub, proxy, emitted, waitFor }) => {
      await proxy.start();
      const s = sessions.at(-1)!;
      hub.ring.push({ data: `scene-frame-${lang}`, sharpness: 0.9, ts: Date.now(), bytes: 4096, source: "phone" });
      const idx = emitted.length;
      sendTool(s, { id: `fi-${lang}`, name: "find_item", args: { target: "my evening pill" } });
      await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
      const out = s.toolResponses[0].functionResponses[0].response.output;
      assert.equal(out.mode, "scene");
      assert.equal(out.level, "match");
      assert.equal(out.lead, leadFor(lang, "match").lead);
      assert.equal(out.instruction, speakInstruction(lang, "If they pick one up, call verify_label."));
      assert.match(out.instruction, /^First say `lead` exactly as written/);
    });
  }
});

test("add_medication + resolveProposal enforces read/strength/schedule/duplicate gates, preserves fresh DataMatrix gtin, and only mutates meds on accept", () =>
  withRig("addmed-flow", { features: ["addmed", "datamatrix"] }, async ({ hub, proxy, emitted, waitFor }) => {
    await proxy.start();
    const s = sessions[0];

    sendTool(s, { id: "am-before-verify", name: "add_medication", args: { schedule: ["morning"] } });
    await Promise.resolve();
    assert.equal(s.toolResponses[0].functionResponses[0].response.output.ok, false);
    assert.equal(s.toolResponses[0].functionResponses[0].response.output.reason, "need_clear_read");
    assert.equal(hub.profile.meds.length, 1);

    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ product: f("Glucophage"), ingredient: f("metformin", 0.96), strength: f("500 mg", 0.72) })),
      usageMetadata: {},
    });
    hub.ring.push({ data: "low-strength-frame", sharpness: 0.85, ts: Date.now(), bytes: 4096, source: "phone" });
    let idx = emitted.length;
    sendTool(s, { id: "v-low-conf", name: "verify_label", args: {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    sendTool(s, { id: "am-low-conf", name: "add_medication", args: { schedule: ["morning"] } });
    await Promise.resolve();
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.ok, false);
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.reason, "need_clear_read");

    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead()),
      usageMetadata: {},
    });
    hub.ring.push({ data: "dup-frame", sharpness: 0.9, ts: Date.now(), bytes: 4096, source: "phone" });
    idx = emitted.length;
    sendTool(s, { id: "v-dup", name: "verify_label", args: {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    sendTool(s, { id: "am-empty-sched", name: "add_medication", args: { schedule: [] } });
    await Promise.resolve();
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.ok, false);
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.reason, "need_schedule");

    sendTool(s, { id: "am-blank-sched", name: "add_medication", args: { schedule: ["   "] } });
    await Promise.resolve();
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.ok, false);
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.reason, "need_schedule");

    sendTool(s, { id: "am-dup", name: "add_medication", args: { schedule: ["evening"] } });
    await Promise.resolve();
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.ok, false);
    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.reason, "already_on_list");
    assert.equal(hub.profile.meds.length, 1);

    const metCode = parseGs1(`(01)${MET_GTIN}(17)280600(10)LOT9`);
    assert.ok(metCode);
    hub.setCode(metCode);
    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), strength: f("500 mg", 0.94), expiry: f("2028-06", 0.93) })),
      usageMetadata: {},
    });
    hub.ring.push({ data: "met-frame", sharpness: 0.92, ts: Date.now(), bytes: 4096, source: "phone" });
    idx = emitted.length;
    sendTool(s, { id: "v-met", name: "verify_label", args: {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = emitted.length;
    sendTool(s, { id: "am-propose-accept", name: "add_medication", args: { schedule: ["morning", "evening"] } });
    const addMsg = await waitFor((m) => m.type === "profile_add", idx);
    assert.equal(addMsg.type, "profile_add");
    if (addMsg.type !== "profile_add") throw new Error("expected profile_add");

    assert.equal(s.toolResponses.at(-1)!.functionResponses[0].response.output.ok, true);
    assert.equal(addMsg.med.gtin, MET_GTIN);
    assert.equal(addMsg.med.ingredient, "metformin");
    assert.equal(addMsg.med.strength, "500 mg");
    assert.deepEqual(addMsg.med.schedule, ["morning", "evening"]);
    assert.equal(hub.profile.meds.length, 1);

    const editedMed: Med = {
      id: addMsg.med.id,
      name: "Metformin Orion",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["08:00", "20:00"],
    };
    proxy.resolveProposal(addMsg.proposalId, true, editedMed);
    assert.equal(hub.profile.meds.length, 2);
    assert.deepEqual(hub.profile.meds[1], {
      id: addMsg.med.id,
      name: "Metformin Orion",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["08:00", "20:00"],
      gtin: MET_GTIN,
    });
    assert.ok(s.realtimeInputs.some((r) => typeof r.text === "string" && r.text.includes("Metformin Orion 500 mg")));

    hub.dropFrames();
    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ product: f("Emconcor 2.5 mg"), ingredient: f("bisoprolol", 0.96), strength: f("2.5 mg", 0.94) })),
      usageMetadata: {},
    });
    hub.ring.push({ data: "biso-frame", sharpness: 0.93, ts: Date.now(), bytes: 4096, source: "phone" });
    idx = emitted.length;
    sendTool(s, { id: "v-biso", name: "verify_label", args: {} });
    await waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = emitted.length;
    sendTool(s, { id: "am-propose-decline", name: "add_medication", args: { schedule: ["morning"] } });
    const declineMsg = await waitFor((m) => m.type === "profile_add", idx);
    assert.equal(declineMsg.type, "profile_add");
    if (declineMsg.type !== "profile_add") throw new Error("expected profile_add");
    assert.equal(hub.profile.meds.length, 2);

    proxy.resolveProposal(declineMsg.proposalId, false);
    assert.equal(hub.profile.meds.length, 2);
    proxy.resolveProposal(declineMsg.proposalId, true);
    assert.equal(hub.profile.meds.length, 2);
    assert.ok(s.realtimeInputs.some((r) => typeof r.text === "string" && r.text.includes("declined")));
  }));

test("Hub.updateReadiness stays silent when sonar off or live inactive, emits phone-only 0..1 values, blends spec readability, throttles 250ms and 0.05 delta, and decays stale cache", async () => {
  const realNow = Date.now;
  let fakeNow = 100_000;
  const hub = new Hub("sonar-hub");
  const phoneMsgs: ServerMsg[] = [];
  const hudMsgs: ServerMsg[] = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) { phoneMsgs.push(JSON.parse(raw) as ServerMsg); },
  } as unknown as WebSocket);
  hub.huds.add({
    readyState: 1,
    send(raw: string) { hudMsgs.push(JSON.parse(raw) as ServerMsg); },
  } as unknown as WebSocket);

  try {
    Date.now = () => fakeNow;

    hub.live = { active: true, handleEvent() {}, stop() {} };
    hub.updateReadiness(0.8);
    assert.equal(phoneMsgs.length, 0);

    hub.features = new Set(["sonar"]);
    hub.live = { active: false, handleEvent() {}, stop() {} };
    hub.updateReadiness(0.8);
    assert.equal(phoneMsgs.length, 0);

    hub.live = { active: true, handleEvent() {}, stop() {} };
    hub.emit({ type: "status", live: "open" });
    assert.equal(hudMsgs.length, 1);
    phoneMsgs.length = 0;

    hub.updateReadiness(0.5);
    assert.deepEqual(phoneMsgs, [{ type: "readiness", value: 0.3 }]);
    assert.equal(hudMsgs.length, 1);

    fakeNow += 100;
    hub.updateReadiness(1.0);
    assert.equal(phoneMsgs.length, 1);

    fakeNow += 150;
    hub.updateReadiness(1.0);
    assert.equal(phoneMsgs.length, 2);
    assert.deepEqual(phoneMsgs[1], { type: "readiness", value: 0.6 });

    fakeNow += 300;
    hub.updateReadiness(0.95);
    assert.equal(phoneMsgs.length, 2);

    fakeNow += 300;
    hub.updateReadiness(0.8);
    assert.equal(phoneMsgs.length, 3);
    assert.deepEqual(phoneMsgs[2], { type: "readiness", value: 0.48 });

    SPEC.debounceMs = 1;
    SPEC.minGapMs = 0;
    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ readability: 0.92 })),
      usageMetadata: {},
    });
    fakeNow += 300;
    const specFrameTs = fakeNow;
    hub.ring.push({ data: "sonar-spec-frame", sharpness: 0.8, ts: specFrameTs, bytes: 4096, source: "phone" });
    (hub.spec as any).kick();
    const deadline = realNow() + 1000;
    while (!hub.spec.latest() && realNow() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(hub.spec.latest());

    assert.equal(phoneMsgs.length, 4);
    assert.deepEqual(phoneMsgs[3], { type: "readiness", value: 0.88 });
    for (const m of phoneMsgs) {
      assert.equal(m.type, "readiness");
      if (m.type === "readiness") assert.ok(m.value >= 0 && m.value <= 1);
    }

    fakeNow = specFrameTs + 5500;
    hub.updateReadiness(0.8);
    assert.equal(phoneMsgs.length, 5);
    assert.deepEqual(phoneMsgs[4], { type: "readiness", value: 0.58 });

    fakeNow = specFrameTs + 8500;
    hub.updateReadiness(0.8);
    assert.equal(phoneMsgs.length, 6);
    assert.deepEqual(phoneMsgs[5], { type: "readiness", value: 0.48 });

    assert.equal(hudMsgs.some((m) => m.type === "readiness"), false);
  } finally {
    Date.now = realNow;
    hub.dropFrames();
  }
});

test("WS /live routes datamatrix into hub.setCode + hub.freshCode(10_000) + verify_label crossCheck and routes profile_add_result", async () => {
  const server: http.Server = await startServer(0);
  const sockets: WebSocket[] = [];
  const sessionId = "ws-feat-t1";

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
    const close = async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { ws, open, received, waitFor, close };
  }

  try {
    const client = connectLive(`/live?session=${sessionId}`);
    await client.open;

    client.ws.send(JSON.stringify({
      type: "start",
      profile: {
        meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"], gtin: AML_GTIN }],
        allergies: [],
        avoid: [],
        doseLog: [],
        lang: "en",
      },
      lang: "en",
      voice: true,
      source: "phone",
      features: ["datamatrix", "addmed", "scene", "sonar"],
    }));

    const readyMsg = await client.waitFor((m) => m.type === "ready");
    assert.equal(readyMsg.type, "ready");
    if (readyMsg.type === "ready") {
      assert.deepEqual(new Set(readyMsg.features), new Set(["datamatrix", "addmed", "scene", "sonar"]));
    }
    await client.waitFor((m) => m.type === "status" && m.live === "open");

    const hub = getHub(sessionId);
    assert.ok(hub);

    client.ws.send(JSON.stringify({ type: "datamatrix", raw: `(01)${AML_GTIN}(17)270831(10)BATCH7`, ts: Date.now() }));
    client.ws.send(JSON.stringify({ type: "ping", t: 101 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 101);

    assert.equal(hub.lastCode?.code.gtin, AML_GTIN);
    assert.equal(hub.freshCode(10_000)?.gtin, AML_GTIN);
    assert.equal(hub.freshCode(10_000)?.expiry, "2027-08-31");

    const freshTs = hub.lastCode!.ts;
    hub.lastCode!.ts = Date.now() - 10_001;
    assert.equal(hub.freshCode(10_000), undefined);
    hub.lastCode!.ts = freshTs;
    assert.equal(hub.freshCode(10_000)?.gtin, AML_GTIN);

    client.ws.send(JSON.stringify({
      type: "frame",
      data: "J".repeat(160),
      w: 640,
      h: 480,
      sharpness: 0.91,
      ts: Date.now(),
    }));
    client.ws.send(JSON.stringify({ type: "ping", t: 102 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 102);

    const s = sessions[0];
    let idx = client.received.length;
    sendTool(s, { id: "ws-verify-1", name: "verify_label", args: { question: "is this my evening pill?" } });
    const verdictMsg = await client.waitFor((m) => m.type === "verdict", idx);
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    assert.equal(verdictMsg.type, "verdict");
    if (verdictMsg.type === "verdict") {
      assert.equal(verdictMsg.verdict.level, "match");
      assert.equal(verdictMsg.verdict.crossCheck?.source, "datamatrix");
      assert.equal(verdictMsg.verdict.crossCheck?.agrees, true);
      assert.equal(verdictMsg.verdict.crossCheck?.code.gtin, AML_GTIN);
      assert.match(verdictMsg.verdict.speech, /double-checked with the pack's code/);
    }

    client.ws.send(JSON.stringify({ type: "datamatrix", raw: `(01)${MET_GTIN}(17)280600(10)MET1`, ts: Date.now() }));
    client.ws.send(JSON.stringify({
      type: "frame",
      data: "M".repeat(160),
      w: 640,
      h: 480,
      sharpness: 0.94,
      ts: Date.now(),
    }));
    client.ws.send(JSON.stringify({ type: "ping", t: 103 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 103);

    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ product: f("Glucophage 500 mg"), ingredient: f("metformin", 0.96), strength: f("500 mg", 0.95), expiry: f("2028-06", 0.93) })),
      usageMetadata: {},
    });

    idx = client.received.length;
    sendTool(s, { id: "ws-verify-2", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = client.received.length;
    sendTool(s, { id: "ws-add-1", name: "add_medication", args: { schedule: ["morning"] } });
    const propMsg = await client.waitFor((m) => m.type === "profile_add", idx);
    assert.equal(propMsg.type, "profile_add");
    if (propMsg.type !== "profile_add") throw new Error("expected profile_add");
    assert.equal(propMsg.med.gtin, MET_GTIN);
    assert.equal(hub.profile.meds.length, 1);

    client.ws.send(JSON.stringify({
      type: "profile_add_result",
      proposalId: propMsg.proposalId,
      accepted: true,
      med: {
        id: propMsg.med.id,
        name: "Glucophage Morning",
        ingredient: "metformin",
        strength: "500 mg",
        schedule: ["08:00"],
      },
    }));
    client.ws.send(JSON.stringify({ type: "ping", t: 104 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 104);

    assert.equal(hub.profile.meds.length, 2);
    assert.deepEqual(hub.profile.meds[1], {
      id: propMsg.med.id,
      name: "Glucophage Morning",
      ingredient: "metformin",
      strength: "500 mg",
      schedule: ["08:00"],
      gtin: MET_GTIN,
    });

    (ai.models as any).generateContent = async () => ({
      text: JSON.stringify(makeRead({ product: f("Emconcor 2.5 mg"), ingredient: f("bisoprolol", 0.96), strength: f("2.5 mg", 0.95) })),
      usageMetadata: {},
    });
    client.ws.send(JSON.stringify({
      type: "frame",
      data: "B".repeat(160),
      w: 640,
      h: 480,
      sharpness: 0.95,
      ts: Date.now(),
    }));
    client.ws.send(JSON.stringify({ type: "ping", t: 105 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 105);

    idx = client.received.length;
    sendTool(s, { id: "ws-verify-3", name: "verify_label", args: {} });
    await client.waitFor((m) => m.type === "checking" && m.phase === "end", idx);

    idx = client.received.length;
    sendTool(s, { id: "ws-add-2", name: "add_medication", args: { schedule: ["morning"] } });
    const propMsg2 = await client.waitFor((m) => m.type === "profile_add", idx);
    assert.equal(propMsg2.type, "profile_add");
    if (propMsg2.type !== "profile_add") throw new Error("expected profile_add");

    client.ws.send(JSON.stringify({
      type: "profile_add_result",
      proposalId: propMsg2.proposalId,
      accepted: false,
    }));
    client.ws.send(JSON.stringify({ type: "ping", t: 106 }));
    await client.waitFor((m) => m.type === "pong" && m.t === 106);
    assert.equal(hub.profile.meds.length, 2);

    await client.close();
  } finally {
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
