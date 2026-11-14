import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { FunctionResponseScheduling } from "@google/genai";
import type { WebSocket } from "ws";
import type { ServerMsg } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub } from "../src/hub.ts";
import { LiveProxy } from "../src/live.ts";
import { SPEC } from "../src/speculate.ts";

process.env.HOLDUP_QUIET = "1";

type ConnectArg = { model: string; config: { sessionResumption?: { handle?: string } }; callbacks: { onmessage: (m: any) => void; onerror: (e: any) => void; onclose: (e: { code: number; reason?: string }) => void } };

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });
const tr = (role: "user" | "assistant", text: string, final: boolean): ServerMsg => ({ type: "transcript", role, text, final });
const VALID_LABEL = {
  kind: "medication", product: f("Norvasc"), ingredient: f("amlodipine", 0.96), strength: f("5 mg"),
  dosing: f("1 tablet daily", 0.9), expiry: f("2027-08", 0.92), allergens: f(null, 0), barcode: f(null, 0), readability: 0.92,
};

const saved = {
  connect: (ai.live as any).connect, generate: (ai.models as any).generateContent,
  live: [...env.liveModels], verify: [...env.verifyModels], debounce: SPEC.debounceMs, minGap: SPEC.minGapMs,
};

function makeSession(arg: ConnectArg) {
  const toolResponses: any[] = [];
  let closed = false;
  const session = { sendToolResponse: (r: any) => { toolResponses.push(r); }, sendRealtimeInput: () => {}, close: () => { closed = true; } };
  return { arg, toolResponses, get closed() { return closed; }, session };
}

let sessions: ReturnType<typeof makeSession>[] = [];
let genCalls = 0;
const sendTool = (s: ReturnType<typeof makeSession>, ...functionCalls: any[]) => s.arg.callbacks.onmessage({ toolCall: { functionCalls } });

function makeRig(id: string) {
  const hub = new Hub(id);
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"], avoid: ["NSAIDs"], doseLog: [], lang: "en",
  };
  const emitted: ServerMsg[] = [], waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      const msg = JSON.parse(raw) as ServerMsg;
      emitted.push(msg);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    },
  } as unknown as WebSocket);
  const proxy = new LiveProxy(hub, { lang: "en", voice: true });
  hub.live = proxy;
  const waitFor = (pred: (m: ServerMsg) => boolean, from = 0): Promise<ServerMsg> =>
    emitted.slice(from).find(pred) ? Promise.resolve(emitted.slice(from).find(pred)!) : new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for ServerMsg")), 2000);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  return { hub, proxy, emitted, waitFor };
}

async function withRig(id: string, fn: (r: ReturnType<typeof makeRig>) => Promise<void>) {
  const r = makeRig(id);
  try { await fn(r); } finally { r.proxy.stop("test done"); r.hub.dropFrames(); }
}

beforeEach(() => {
  sessions = []; genCalls = 0;
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
  env.verifyModels = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
  (ai.live as any).connect = async (arg: ConnectArg) => { const s = makeSession(arg); sessions.push(s); return s.session; };
  (ai.models as any).generateContent = async () => { genCalls++; return { text: JSON.stringify(VALID_LABEL), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }; };
});

afterEach(() => {
  (ai.live as any).connect = saved.connect; (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.live]; env.verifyModels = [...saved.verify];
  SPEC.debounceMs = saved.debounce; SPEC.minGapMs = saved.minGap;
});

test("connects with ready + open status, streams cumulative transcripts, and flushes on barge-in", () => withRig("lp-1", async ({ hub, proxy, emitted }) => {
  await proxy.start();
  assert.deepEqual(emitted.slice(0, 3), [
    { type: "status", live: "connecting" },
    { type: "ready", model: "gemini-3.8-live", session: hub.id, features: [] },
    { type: "status", live: "open", detail: "gemini-3.8-live" },
  ]);
  const cb = sessions[0].arg.callbacks;
  cb.onmessage({ serverContent: { inputTranscription: { text: "Is this " } } });
  cb.onmessage({ serverContent: { inputTranscription: { text: "my pill?", finished: true } } });
  cb.onmessage({ serverContent: { outputTranscription: { text: "Hold it " } } });
  cb.onmessage({ serverContent: { outputTranscription: { text: "closer" } } });
  cb.onmessage({ serverContent: { inputTranscription: { text: "wait" } } });
  cb.onmessage({ serverContent: { interrupted: true } });
  assert.deepEqual(emitted.slice(3), [
    tr("user", "Is this", false), tr("user", "Is this my pill?", true),
    tr("assistant", "Hold it", false), tr("assistant", "Hold it closer", false),
    tr("user", "wait", false), { type: "interrupted" },
    tr("assistant", "Hold it closer", true), tr("user", "wait", true),
  ]);
}));

test("show_cue emits coach with SILENT response and falls back to hold_still on unknown cue", () => withRig("lp-2", async ({ proxy, emitted }) => {
  await proxy.start();
  const s = sessions[0];
  sendTool(s, { id: "c1", name: "show_cue", args: { cue: "rotate_left", text: "Turn left" } }, { id: "c2", name: "show_cue", args: { cue: "bogus_cue", text: "Keep steady" } });
  await Promise.resolve();
  assert.deepEqual(emitted.slice(3), [{ type: "coach", cue: "rotate_left", text: "Turn left" }, { type: "coach", cue: "hold_still", text: "Keep steady" }]);
  assert.deepEqual(s.toolResponses[0].functionResponses[0], { id: "c1", name: "show_cue", response: { output: { shown: true } }, scheduling: FunctionResponseScheduling.SILENT });
  assert.equal(s.toolResponses[1].functionResponses[0].scheduling, FunctionResponseScheduling.SILENT);
}));

test("log_dose appends valid medId + emits dose_logged, and returns ok: false on unknown medId", () => withRig("lp-3", async ({ hub, proxy, emitted }) => {
  await proxy.start();
  const s = sessions[0];
  sendTool(s, { id: "d1", name: "log_dose", args: { medId: "aml" } }, { id: "d2", name: "log_dose", args: { medId: "unknown" } });
  await Promise.resolve();
  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  const tail = emitted.slice(3);
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.type, "dose_logged");
  if (tail[0]?.type === "dose_logged") assert.equal(tail[0].medId, "aml");
  assert.deepEqual(s.toolResponses[0].functionResponses[0].response.output, { ok: true, med: "Norvasc" });
  assert.equal(s.toolResponses[1].functionResponses[0].response.output.ok, false);
}));

test("verify_label returns unsure without calling reader when hub.ring is empty", () => withRig("lp-4", async ({ hub, proxy, emitted, waitFor }) => {
  await proxy.start();
  assert.equal(hub.ring.length, 0);
  const idx = emitted.length;
  sendTool(sessions[0], { id: "v0", name: "verify_label", args: {} });
  await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
  assert.deepEqual(emitted.slice(idx), [{ type: "checking", phase: "start" }, { type: "checking", phase: "end" }]);
  assert.equal(genCalls, 0);
  assert.equal(sessions[0].toolResponses[0].functionResponses[0].response.output.level, "unsure");
}));

test("verify_label uses fresh hub.spec cached read and falls back to hub.ring + generateContent on miss", () => withRig("lp-5", async ({ hub, proxy, emitted, waitFor }) => {
  SPEC.debounceMs = 5; SPEC.minGapMs = 0;
  await proxy.start();
  const s = sessions[0];
  hub.addFrame({ data: "frame-jpeg-1", sharpness: 0.9, ts: Date.now(), bytes: 4096, source: "phone" });
  const deadline = Date.now() + 1000;
  while (!(hub.spec as any).cache && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(genCalls, 1);
  genCalls = 0;
  let idx = emitted.length;
  sendTool(s, { id: "v1", name: "verify_label", args: { question: "evening pill?" } });
  await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
  assert.equal(genCalls, 0);
  assert.equal(hub.spec.hits, 1);
  assert.deepEqual(emitted.slice(idx).map((m) => m.type), ["checking", "verdict", "checking"]);
  assert.equal(s.toolResponses[0].functionResponses[0].response.output.level, "match");
  hub.spec.clear();
  idx = emitted.length;
  sendTool(s, { id: "v2", name: "verify_label", args: { question: "evening pill?" } });
  await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
  assert.equal(genCalls, 1);
  assert.deepEqual(emitted.slice(idx).map((m) => m.type), ["checking", "coach", "verdict", "checking"]);
  assert.equal(s.toolResponses[1].functionResponses[0].response.output.level, "match");
}));

test("verify_label drops cancelled fc.id on toolCallCancellation before verdict or sendToolResponse", () => withRig("lp-6", async ({ hub, proxy, emitted, waitFor }) => {
  await proxy.start();
  hub.ring.push({ data: "frame-jpeg-2", sharpness: 0.9, ts: Date.now(), bytes: 4096, source: "phone" });
  let markInFlight!: () => void, releaseRead!: () => void;
  const inFlight = new Promise<void>((r) => { markInFlight = r; }), gate = new Promise<void>((r) => { releaseRead = r; });
  (ai.models as any).generateContent = async () => { markInFlight(); await gate; return { text: JSON.stringify(VALID_LABEL), usageMetadata: {} }; };
  const idx = emitted.length;
  sendTool(sessions[0], { id: "vc", name: "verify_label", args: {} });
  await inFlight;
  sessions[0].arg.callbacks.onmessage({ toolCallCancellation: { ids: ["vc"] } });
  releaseRead();
  await waitFor((m) => m.type === "checking" && m.phase === "end", idx);
  assert.deepEqual(emitted.slice(idx).map((m) => m.type), ["checking", "coach", "checking"]);
  assert.equal(sessions[0].toolResponses.length, 0);
}));

test("sessionResumptionUpdate + goAway persists hub.resume and reconnects passing sessionResumption.handle", () => withRig("lp-7", async ({ hub, proxy, emitted, waitFor }) => {
  await proxy.start();
  assert.deepEqual(sessions[0].arg.config.sessionResumption, {});
  sessions[0].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "res-handle-7" } });
  assert.equal(hub.resume?.handle, "res-handle-7");
  assert.equal(hub.resume?.model, "gemini-3.8-live");
  const idx = emitted.length;
  sessions[0].arg.callbacks.onmessage({ goAway: { timeLeft: "5s" } });
  await waitFor((m) => m.type === "status" && m.live === "open", idx);
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[1].arg.config.sessionResumption, { handle: "res-handle-7" });
  assert.deepEqual(emitted[idx], { type: "status", live: "reconnecting", detail: "resuming" });
}));

test("3-model connect failure emits degraded status and gemini_unavailable error", () => withRig("lp-8", async ({ proxy, emitted }) => {
  const tried: string[] = [];
  (ai.live as any).connect = async (arg: ConnectArg) => { tried.push(arg.model); throw new Error("503 service unavailable"); };
  await proxy.start();
  assert.deepEqual(tried, ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"]);
  assert.ok(emitted.some((m) => m.type === "status" && m.live === "degraded"));
  assert.ok(emitted.some((m) => m.type === "error" && m.code === "gemini_unavailable" && m.recoverable === true));
  assert.equal(proxy.active, false);
}));
