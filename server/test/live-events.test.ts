import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { LiveServerMessage } from "@google/genai";
import type { WebSocket } from "ws";
import type { ServerMsg, Verdict } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { Hub } from "../src/hub.ts";
import { LiveProxy } from "../src/live.ts";
import { unreadable, type VerifyResult } from "../src/verify.ts";

process.env.HOLDUP_QUIET = "1";
env.ledgerPath = path.join(os.tmpdir(), `holdup-live-events-${process.pid}.jsonl`);

function makeHub(id = "test-session") {
  const hub = new Hub(id);
  const emitted: ServerMsg[] = [];
  const origEmit = hub.emit.bind(hub);
  hub.emit = (msg, opts) => {
    emitted.push(msg);
    origEmit(msg, opts);
  };
  return { hub, emitted };
}

function addFrame(hub: Hub) {
  hub.ring.push({
    data: "ZmFrZS1qcGVnLWZyYW1l",
    sharpness: 0.9,
    ts: Date.now(),
    bytes: 16,
    source: "phone",
  });
}

function sampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg: match",
    speech: "Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    read: unreadable(),
    matchedMedId: "aml",
    reasons: [],
    takenToday: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const liveMsg = (p: Partial<LiveServerMessage>): LiveServerMessage => ({ text: undefined, data: undefined, ...p });

test("interrupted message is emitted on serverContent interrupted", () => {
  const { hub, emitted } = makeHub();
  const proxy = new LiveProxy(hub, { lang: "en", voice: true });

  proxy.onMessage(liveMsg({ serverContent: { outputTranscription: { text: "Hold it steady" } } }));
  emitted.length = 0;

  proxy.onMessage(liveMsg({ serverContent: { interrupted: true } }));

  assert.deepEqual(emitted[0], { type: "interrupted" });
  assert.deepEqual(emitted[1], { type: "status", live: "open", detail: "interrupted" });
  assert.deepEqual(emitted[2], { type: "transcript", role: "assistant", text: "Hold it steady", final: true });

  emitted.length = 0;
  proxy.onMessage(liveMsg({ serverContent: { outputTranscription: { text: "Clear now" }, turnComplete: true } }));
  assert.equal(emitted.some((m) => m.type === "interrupted"), false);
});

test("checking start and end bracket verify_label on normal completion", async () => {
  const { hub, emitted } = makeHub();
  const emptyProxy = new LiveProxy(hub, { lang: "en", voice: true });
  await emptyProxy.onTool({ id: "fc-empty", name: "verify_label", args: {} });
  assert.equal(emitted.some((m) => m.type === "checking"), false);

  addFrame(hub);
  const gate = deferred<VerifyResult>();
  const verdict = sampleVerdict();
  const proxy = new LiveProxy(hub, {
    lang: "en",
    voice: true,
    verifyFn: () => gate.promise,
  });

  const pending = proxy.onTool({ id: "fc-ok", name: "verify_label", args: { question: "is this my evening pill?" } });
  assert.deepEqual(emitted[0], { type: "checking", phase: "start" });
  assert.equal(emitted.some((m) => m.type === "checking" && m.phase === "end"), false);

  gate.resolve({ verdict, model: "mock-model", latencyMs: 12, frames: 1 });
  await pending;

  assert.deepEqual(emitted, [
    { type: "checking", phase: "start" },
    { type: "coach", cue: "hold_still", text: "Hold still, reading…" },
    { type: "verdict", verdict },
    { type: "checking", phase: "end" },
  ]);
});

test("checking start and end bracket verify_label on cancellation, error, and stop", async () => {
  {
    const { hub, emitted } = makeHub("cancel-session");
    addFrame(hub);
    const gate = deferred<VerifyResult>();
    const proxy = new LiveProxy(hub, { lang: "en", voice: true, verifyFn: () => gate.promise });

    const pending = proxy.onTool({ id: "fc-cancel", name: "verify_label", args: {} });
    assert.deepEqual(emitted[0], { type: "checking", phase: "start" });

    proxy.onMessage(liveMsg({ toolCallCancellation: { ids: ["fc-cancel"] } }));
    gate.resolve({ verdict: sampleVerdict(), model: "mock-model", latencyMs: 8, frames: 1 });
    await pending;

    assert.deepEqual(emitted.at(0), { type: "checking", phase: "start" });
    assert.deepEqual(emitted.at(-1), { type: "checking", phase: "end" });
    assert.equal(emitted.some((m) => m.type === "verdict"), false);
  }

  {
    const { hub, emitted } = makeHub("error-session");
    addFrame(hub);
    const proxy = new LiveProxy(hub, {
      lang: "en",
      voice: true,
      verifyFn: async () => { throw new Error("reader timeout"); },
    });

    await proxy.onTool({ id: "fc-err", name: "verify_label", args: {} });

    assert.deepEqual(emitted.at(0), { type: "checking", phase: "start" });
    assert.deepEqual(emitted.at(-1), { type: "checking", phase: "end" });
    assert.equal(emitted.some((m) => m.type === "verdict"), false);
  }

  {
    const { hub, emitted } = makeHub("stop-session");
    addFrame(hub);
    const gate = deferred<VerifyResult>();
    const proxy = new LiveProxy(hub, { lang: "en", voice: true, verifyFn: () => gate.promise });

    const pending = proxy.onTool({ id: "fc-stop", name: "verify_label", args: {} });
    assert.deepEqual(emitted.at(0), { type: "checking", phase: "start" });

    proxy.stop("stopped by user");
    gate.resolve({ verdict: sampleVerdict(), model: "mock-model", latencyMs: 5, frames: 1 });
    await pending;

    assert.deepEqual(emitted.at(-1), { type: "checking", phase: "end" });
    assert.equal(emitted.some((m) => m.type === "verdict"), false);
  }
});

test("handleEvent log_dose updates doseLog and emits verdict with takenToday true", () => {
  const { hub, emitted } = makeHub("dose-session");
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "en",
  };
  const hudMessages: ServerMsg[] = [];
  const mockHud = {
    readyState: 1,
    send: (raw: string) => { hudMessages.push(JSON.parse(raw) as ServerMsg); },
  } as unknown as WebSocket;
  hub.huds.add(mockHud);

  const proxy = new LiveProxy(hub, { lang: "en", voice: true });

  proxy.handleEvent("log_dose");
  assert.equal(hub.profile.doseLog.length, 0);
  assert.equal(emitted.some((m) => m.type === "error" && m.code === "bad_input"), true);

  const initial = sampleVerdict({ matchedMedId: "aml", takenToday: false });
  hub.emit({ type: "verdict", verdict: initial });
  emitted.length = 0;
  hudMessages.length = 0;

  const before = Date.now();
  proxy.handleEvent("log_dose");
  const after = Date.now();

  assert.equal(hub.profile.doseLog.length, 1);
  assert.equal(hub.profile.doseLog[0].medId, "aml");
  assert.ok(hub.profile.doseLog[0].ts >= before && hub.profile.doseLog[0].ts <= after);

  const expectedVerdict = { ...initial, takenToday: true };
  assert.deepEqual(emitted, [{ type: "verdict", verdict: expectedVerdict }]);
  assert.deepEqual(hudMessages, [{ type: "verdict", verdict: expectedVerdict }]);
  assert.deepEqual(hub.lastVerdict, expectedVerdict);
});
