import { after, afterEach, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMsg } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub } from "../src/hub.ts";
import type { LedgerLine } from "../src/ledger.ts";
import { LiveProxy } from "../src/live.ts";

const originalQuiet = process.env.HOLDUP_QUIET;
process.env.HOLDUP_QUIET = "1";

type ConnectArg = {
  model: string;
  config: { sessionResumption?: { handle?: string } };
  callbacks: {
    onmessage: (m: any) => void;
    onerror: (e: any) => void;
    onclose: (e: { code: number; reason?: string }) => void;
  };
};

const field = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

const VALID_LABEL = {
  kind: "medication",
  product: field("Norvasc"),
  ingredient: field("amlodipine", 0.96),
  strength: field("5 mg"),
  dosing: field("1 tablet daily", 0.9),
  expiry: field("2027-08", 0.92),
  allergens: field(null, 0),
  barcode: field(null, 0),
  readability: 0.92,
};

const shmRoot = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();

const saved = {
  connect: (ai.live as any).connect,
  generate: (ai.models as any).generateContent,
  liveModels: [...env.liveModels],
  verifyModels: [...env.verifyModels],
  idleStopMs: env.idleStopMs,
  ledgerPath: env.ledgerPath,
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
  return {
    arg,
    toolResponses,
    realtimeInputs,
    get closed() { return closed; },
    session,
  };
}

let sessions: ReturnType<typeof makeSession>[] = [];
let tempDirs: string[] = [];

async function flushMicrotasks(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function readLedgerRows(filePath: string): LedgerLine[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerLine);
}

function makeRig(
  id: string,
  opts: { lang?: string; voice?: boolean; resume?: { handle: string; model: string; at: number } } = {},
) {
  const hub = new Hub(id);
  hub.profile = {
    meds: [{ id: "aml", name: "Norvasc", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanut"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang: opts.lang ?? "en",
  };
  if (opts.resume) hub.resume = opts.resume;

  const emitted: ServerMsg[] = [];
  const hudEmitted: ServerMsg[] = [];

  hub.clients.add({
    readyState: 1,
    send(raw: string) {
      emitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket);

  hub.huds.add({
    readyState: 1,
    send(raw: string) {
      hudEmitted.push(JSON.parse(raw) as ServerMsg);
    },
  } as unknown as WebSocket);

  const proxy = new LiveProxy(hub, { lang: opts.lang ?? "en", voice: opts.voice ?? true });
  hub.live = proxy;
  return { hub, proxy, emitted, hudEmitted };
}

function enableMockClock(t: TestContext, now: number) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
}

beforeEach(() => {
  sessions = [];
  const dir = fs.mkdtempSync(path.join(shmRoot, "holdup-live-res-"));
  tempDirs.push(dir);
  env.ledgerPath = path.join(dir, "ledger.jsonl");
  env.liveModels = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
  env.verifyModels = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
  env.idleStopMs = 45_000;
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };
  (ai.models as any).generateContent = async () => ({
    text: JSON.stringify(VALID_LABEL),
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
  });
});

afterEach(() => {
  (ai.live as any).connect = saved.connect;
  (ai.models as any).generateContent = saved.generate;
  env.liveModels = [...saved.liveModels];
  env.verifyModels = [...saved.verifyModels];
  env.idleStopMs = saved.idleStopMs;
  env.ledgerPath = saved.ledgerPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  if (originalQuiet === undefined) delete process.env.HOLDUP_QUIET;
  else process.env.HOLDUP_QUIET = originalQuiet;
});

test("stale resumption handle (<10 min) clears handle and retries same model fresh before advancing modelIdx", async (t) => {
  enableMockClock(t, 1_000_000);
  const attempts: { model: string; handle: string | undefined }[] = [];
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const handle = arg.config.sessionResumption?.handle;
    attempts.push({ model: arg.model, handle });
    if (handle === "stale-handle-1") {
      arg.callbacks.onclose({ code: 1006, reason: "stale resumption handle" });
      throw new Error("stale resumption handle rejected");
    }
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };

  const r1 = makeRig("lrae-stale-1", {
    resume: { handle: "stale-handle-1", model: "gemini-3.1-flash-live-preview", at: Date.now() - (10 * 60_000 - 1) },
  });
  try {
    await r1.proxy.start();
    assert.deepEqual(attempts, [
      { model: "gemini-3.1-flash-live-preview", handle: "stale-handle-1" },
      { model: "gemini-3.1-flash-live-preview", handle: undefined },
    ]);
    assert.deepEqual(r1.emitted[0], { type: "status", live: "reconnecting", detail: "resuming" });
    assert.equal(r1.proxy.currentModel, "gemini-3.1-flash-live-preview");
    assert.ok(r1.emitted.some((m) => m.type === "status" && m.live === "open" && m.detail === "gemini-3.1-flash-live-preview"));
  } finally {
    r1.proxy.stop("test cleanup");
    r1.hub.dropFrames();
  }

  const chainAttempts: { model: string; handle: string | undefined }[] = [];
  (ai.live as any).connect = async (arg: ConnectArg) => {
    const handle = arg.config.sessionResumption?.handle;
    chainAttempts.push({ model: arg.model, handle });
    if (arg.model === "gemini-3.1-flash-live-preview") {
      throw new Error("503 backend unavailable");
    }
    const s = makeSession(arg);
    sessions.push(s);
    return s.session;
  };

  const r2 = makeRig("lrae-stale-2", {
    resume: { handle: "stale-handle-2", model: "gemini-3.1-flash-live-preview", at: Date.now() - 60_000 },
  });
  try {
    await r2.proxy.start();
    assert.deepEqual(chainAttempts, [
      { model: "gemini-3.1-flash-live-preview", handle: "stale-handle-2" },
      { model: "gemini-3.1-flash-live-preview", handle: undefined },
      { model: "gemini-2.5-flash-native-audio-latest", handle: undefined },
    ]);
    assert.equal(r2.proxy.currentModel, "gemini-2.5-flash-native-audio-latest");
  } finally {
    r2.proxy.stop("test cleanup");
    r2.hub.dropFrames();
  }
});

test("constructor ignores hub.resume when handle is older than 10 minutes", async (t) => {
  enableMockClock(t, 2_000_000);
  const rOld = makeRig("lrae-expired-1", {
    resume: { handle: "old-handle-11m", model: "gemini-3.1-flash-live-preview", at: Date.now() - (11 * 60_000) },
  });
  try {
    await rOld.proxy.start();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].arg.model, "gemini-3.8-live");
    assert.deepEqual(sessions[0].arg.config.sessionResumption, {});
    assert.deepEqual(rOld.emitted[0], { type: "status", live: "connecting" });
  } finally {
    rOld.proxy.stop("test cleanup");
    rOld.hub.dropFrames();
  }

  const rBoundary = makeRig("lrae-expired-boundary", {
    resume: { handle: "boundary-handle-10m", model: "gemini-2.5-flash-native-audio-latest", at: Date.now() - 10 * 60_000 },
  });
  try {
    await rBoundary.proxy.start();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].arg.model, "gemini-3.8-live");
    assert.deepEqual(sessions[1].arg.config.sessionResumption, {});
  } finally {
    rBoundary.proxy.stop("test cleanup");
    rBoundary.hub.dropFrames();
  }
});

test("remote onClose matching 429, RESOURCE_EXHAUSTED, or quota emits quota error, clears handle, and advances model", async (t) => {
  enableMockClock(t, 3_000_000);
  const r = makeRig("lrae-quota");
  try {
    await r.proxy.start();
    assert.equal(sessions[0].arg.model, "gemini-3.8-live");
    sessions[0].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-q1" } });

    let idx = r.emitted.length;
    sessions[0].arg.callbacks.onclose({ code: 1011, reason: "HTTP 429 Too Many Requests" });
    assert.deepEqual(r.emitted[idx], {
      type: "error",
      code: "quota",
      message: "Gemini quota reached, trying a backup model.",
      recoverable: true,
    });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].arg.model, "gemini-3.1-flash-live-preview");
    assert.deepEqual(sessions[1].arg.config.sessionResumption, {});

    sessions[1].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-q2" } });
    idx = r.emitted.length;
    sessions[1].arg.callbacks.onclose({ code: 1011, reason: "RESOURCE_EXHAUSTED on project" });
    assert.deepEqual(r.emitted[idx], {
      type: "error",
      code: "quota",
      message: "Gemini quota reached, trying a backup model.",
      recoverable: true,
    });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 3);
    assert.equal(sessions[2].arg.model, "gemini-2.5-flash-native-audio-latest");
    assert.deepEqual(sessions[2].arg.config.sessionResumption, {});

    sessions[2].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-q3" } });
    idx = r.emitted.length;
    sessions[2].arg.callbacks.onclose({ code: 1011, reason: "Per-minute quota exceeded" });
    assert.deepEqual(r.emitted[idx], {
      type: "error",
      code: "quota",
      message: "Gemini quota reached, trying a backup model.",
      recoverable: true,
    });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(r.proxy.active, false);
    assert.ok(r.emitted.slice(idx).some((m) => m.type === "status" && m.live === "degraded"));
    assert.ok(r.emitted.slice(idx).some((m) => m.type === "error" && m.code === "gemini_unavailable" && m.recoverable === true));
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("remote onClose with code 1007 or 1008 emits bad_input error, clears handle, and retries same model fresh", async (t) => {
  enableMockClock(t, 4_000_000);
  const r = makeRig("lrae-1007-1008");
  try {
    await r.proxy.start();
    assert.equal(sessions[0].arg.model, "gemini-3.8-live");
    sessions[0].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-1007" } });

    let idx = r.emitted.length;
    sessions[0].arg.callbacks.onclose({ code: 1007, reason: "Invalid audio chunk" });
    assert.deepEqual(r.emitted[idx], {
      type: "error",
      code: "bad_input",
      message: "Gemini rejected the input, restarting the session.",
      recoverable: true,
    });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].arg.model, "gemini-3.8-live");
    assert.deepEqual(sessions[1].arg.config.sessionResumption, {});

    sessions[1].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-1008" } });
    idx = r.emitted.length;
    sessions[1].arg.callbacks.onclose({ code: 1008, reason: "Policy violation" });
    assert.deepEqual(r.emitted[idx], {
      type: "error",
      code: "bad_input",
      message: "Gemini rejected the input, restarting the session.",
      recoverable: true,
    });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 3);
    assert.equal(sessions[2].arg.model, "gemini-3.8-live");
    assert.deepEqual(sessions[2].arg.config.sessionResumption, {});
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("more than 3 rapid drops (<30s open) clears handle and advances modelIdx while >30s open resets counter", async (t) => {
  enableMockClock(t, 5_000_000);
  const r = makeRig("lrae-rapid-drops");
  try {
    await r.proxy.start();
    sessions[0].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-rapid" } });

    for (let drop = 1; drop <= 3; drop++) {
      t.mock.timers.tick(3000);
      r.proxy.frame(`keepalive-rapid-${drop}`);
      sessions[drop - 1].arg.callbacks.onclose({ code: 1006, reason: "socket reset" });
      t.mock.timers.tick(4000);
      await flushMicrotasks();
      assert.equal(sessions.length, drop + 1);
      assert.equal(sessions[drop].arg.model, "gemini-3.8-live");
      assert.deepEqual(sessions[drop].arg.config.sessionResumption, { handle: "h-rapid" });
    }

    t.mock.timers.tick(3000);
    r.proxy.frame("keepalive-rapid-4");
    sessions[3].arg.callbacks.onclose({ code: 1006, reason: "fourth rapid drop" });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 5);
    assert.equal(sessions[4].arg.model, "gemini-3.1-flash-live-preview");
    assert.deepEqual(sessions[4].arg.config.sessionResumption, {});

    sessions[4].arg.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h-healthy" } });
    t.mock.timers.tick(15_000);
    r.proxy.frame("keepalive-mid");
    t.mock.timers.tick(15_001);
    r.proxy.frame("keepalive-after-30s");

    sessions[4].arg.callbacks.onclose({ code: 1006, reason: "drop after healthy window" });
    t.mock.timers.tick(4000);
    await flushMicrotasks();
    assert.equal(sessions.length, 6);
    assert.equal(sessions[5].arg.model, "gemini-3.1-flash-live-preview");
    assert.deepEqual(sessions[5].arg.config.sessionResumption, { handle: "h-healthy" });

    for (let extra = 0; extra < 2; extra++) {
      t.mock.timers.tick(2000);
      r.proxy.frame(`keepalive-post-reset-${extra}`);
      sessions[5 + extra].arg.callbacks.onclose({ code: 1006, reason: "rapid after reset" });
      t.mock.timers.tick(4000);
      await flushMicrotasks();
      assert.equal(sessions[6 + extra].arg.model, "gemini-3.1-flash-live-preview");
      assert.deepEqual(sessions[6 + extra].arg.config.sessionResumption, { handle: "h-healthy" });
    }
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("privacy 45s camera auto-stop emits coach + closed status, closes session, and writes live ledger metrics", async (t) => {
  enableMockClock(t, 6_000_000);
  assert.equal(env.idleStopMs, 45_000);
  (ai.models as any).generateContent = async () => {
    t.mock.timers.tick(300);
    return { text: JSON.stringify(VALID_LABEL), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 } };
  };

  const r = makeRig("lrae-autostop");
  try {
    await r.proxy.start();
    const cb = sessions[0].arg.callbacks;

    t.mock.timers.tick(1000);
    cb.onmessage({ serverContent: { inputTranscription: { text: "What box is this?", finished: true } } });
    t.mock.timers.tick(1200);
    cb.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] } } });

    t.mock.timers.tick(800);
    cb.onmessage({ serverContent: { inputTranscription: { text: "Read it please", finished: true } } });
    t.mock.timers.tick(400);
    cb.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "BBB=", mimeType: "audio/pcm;rate=24000" } }] } } });

    t.mock.timers.tick(600);
    r.proxy.text("Check the expiry too");
    t.mock.timers.tick(800);
    cb.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "CCC=", mimeType: "audio/pcm;rate=24000" } }] } } });

    cb.onmessage({ toolCall: { functionCalls: [{ id: "cue-1", name: "show_cue", args: { cue: "closer", text: "Move closer" } }] } });
    await flushMicrotasks();

    r.hub.ring.push({ data: "frame-ring-only", sharpness: 0.91, ts: Date.now(), bytes: 4096, source: "phone" });
    cb.onmessage({ toolCall: { functionCalls: [{ id: "ver-1", name: "verify_label", args: { question: "my evening pill?" } }] } });
    await flushMicrotasks();

    const elapsedSoFar = Date.now() - 6_000_000;
    t.mock.timers.tick(44_000 - elapsedSoFar);
    assert.equal(r.proxy.active, true);
    assert.equal(sessions[0].closed, false);

    const idx = r.emitted.length;
    const hudIdx = r.hudEmitted.length;
    t.mock.timers.tick(2000);

    assert.equal(r.proxy.active, false);
    assert.equal(sessions[0].closed, true);
    assert.deepEqual(r.emitted.slice(idx), [
      { type: "coach", cue: "ok", text: "Camera stopped" },
      { type: "status", live: "closed", detail: "auto-stopped: no camera frames for 45 s" },
    ]);
    assert.deepEqual(r.hudEmitted.slice(hudIdx), [
      { type: "coach", cue: "ok", text: "Camera stopped" },
      { type: "status", live: "closed", detail: "auto-stopped: no camera frames for 45 s" },
    ]);

    const rows = readLedgerRows(env.ledgerPath);
    const liveRow = rows.find((row) => row.feature === "live");
    assert.ok(liveRow);
    assert.equal(liveRow.model, "gemini-3.8-live");
    assert.equal(liveRow.ok, true);
    assert.equal(liveRow.first_audio_s, 1.2);
    assert.equal(liveRow.first_audio_p50_s, 0.8);
    assert.equal(liveRow.turns, 3);
    assert.equal(liveRow.tool_calls, 2);
    assert.deepEqual(liveRow.tool_latencies_s, [0.3]);
    assert.equal(liveRow.reason, "auto-stopped: no camera frames for 45 s");
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("opts.voice = false suppresses audio messages while still recording first_audio_s latency", async (t) => {
  enableMockClock(t, 7_000_000);
  const r = makeRig("lrae-silent-voice", { voice: false });
  try {
    await r.proxy.start();
    const s = sessions[0];
    const cb = s.arg.callbacks;

    r.proxy.audio("cGNtMTZjaHVuaw==");
    assert.deepEqual(s.realtimeInputs[0], {
      audio: { data: "cGNtMTZjaHVuaw==", mimeType: "audio/pcm;rate=16000" },
    });

    t.mock.timers.tick(500);
    cb.onmessage({ serverContent: { inputTranscription: { text: "Is this Norvasc?", finished: true } } });
    t.mock.timers.tick(450);
    cb.onmessage({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: "chunk-1", mimeType: "audio/pcm;rate=24000" } },
            { inlineData: { data: "chunk-2", mimeType: "audio/pcm;rate=24000" } },
          ],
        },
        outputTranscription: { text: "Checking the label." },
        turnComplete: true,
      },
    });

    t.mock.timers.tick(1000);
    r.proxy.text("What strength is it?");
    t.mock.timers.tick(650);
    cb.onmessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "chunk-3", mimeType: "audio/pcm;rate=24000" } }] },
        turnComplete: true,
      },
    });

    assert.equal(r.emitted.some((m) => m.type === "audio"), false);
    assert.equal(r.emitted.some((m) => m.type === "transcript" && m.role === "assistant" && m.text === "Checking the label."), true);

    r.proxy.stop("silent check finished");
    const liveRow = readLedgerRows(env.ledgerPath).find((row) => row.feature === "live");
    assert.ok(liveRow);
    assert.equal(liveRow.first_audio_s, 0.45);
    assert.equal(liveRow.first_audio_p50_s, 0.65);
    assert.equal(liveRow.turns, 2);
    assert.equal(liveRow.reason, "silent check finished");
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("frame() rate-limits sendRealtimeInput video frames (~900ms) while refreshing lastFrameAt against auto-stop", async (t) => {
  enableMockClock(t, 8_000_000);
  const r = makeRig("lrae-frame-throttle");
  try {
    await r.proxy.start();
    const s = sessions[0];

    r.proxy.frame("jpeg-0");
    assert.equal(s.realtimeInputs.length, 1);
    assert.deepEqual(s.realtimeInputs[0], { video: { data: "jpeg-0", mimeType: "image/jpeg" } });

    t.mock.timers.tick(450);
    r.proxy.frame("jpeg-450");
    assert.equal(s.realtimeInputs.length, 1);

    t.mock.timers.tick(449);
    r.proxy.frame("jpeg-899");
    assert.equal(s.realtimeInputs.length, 1);

    t.mock.timers.tick(1);
    r.proxy.frame("jpeg-900");
    assert.equal(s.realtimeInputs.length, 2);
    assert.deepEqual(s.realtimeInputs[1], { video: { data: "jpeg-900", mimeType: "image/jpeg" } });

    t.mock.timers.tick(39_600);
    r.proxy.frame("jpeg-40500");
    assert.equal(s.realtimeInputs.length, 3);

    t.mock.timers.tick(800);
    r.proxy.frame("jpeg-41300-throttled");
    assert.equal(s.realtimeInputs.length, 3);

    t.mock.timers.tick(44_700);
    assert.equal(Date.now(), 8_086_000);
    assert.equal(r.proxy.active, true);
    assert.equal(s.closed, false);

    t.mock.timers.tick(2000);
    assert.equal(r.proxy.active, false);
    assert.equal(s.closed, true);
    assert.ok(r.emitted.some((m) => m.type === "coach" && m.cue === "ok" && m.text === "Camera stopped"));
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});

test("handleEvent handles repeat, log_dose error + matched HUD update, and stop", async (t) => {
  enableMockClock(t, 9_000_000);
  const r = makeRig("lrae-events");
  try {
    await r.proxy.start();
    const s = sessions[0];

    let idx = r.emitted.length;
    r.proxy.handleEvent("log_dose");
    assert.deepEqual(r.emitted.slice(idx), [
      { type: "error", code: "bad_input", message: "No matched medicine to log yet.", recoverable: true },
    ]);
    assert.equal(r.hub.profile.doseLog.length, 0);
    assert.equal(s.realtimeInputs.length, 0);

    r.hub.emit({
      type: "verdict",
      verdict: {
        level: "unsure",
        headline: "Hold steady",
        speech: "I cannot read the strength clearly.",
        read: VALID_LABEL as any,
        reasons: ["low confidence"],
      },
    });
    idx = r.emitted.length;
    r.proxy.handleEvent("log_dose");
    assert.deepEqual(r.emitted.slice(idx), [
      { type: "error", code: "bad_input", message: "No matched medicine to log yet.", recoverable: true },
    ]);
    assert.equal(r.hub.profile.doseLog.length, 0);

    r.hub.ring.push({ data: "matched-frame", sharpness: 0.94, ts: Date.now(), bytes: 4096, source: "phone" });
    s.arg.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "v-match", name: "verify_label", args: { question: "evening pill?" } }] },
    });
    await flushMicrotasks();
    assert.equal(r.hub.lastVerdict?.matchedMedId, "aml");
    assert.equal(r.hub.lastVerdict?.takenToday, false);

    idx = r.emitted.length;
    let hudIdx = r.hudEmitted.length;
    let rtIdx = s.realtimeInputs.length;
    r.proxy.handleEvent("repeat");
    assert.equal(r.emitted.slice(idx).length, 1);
    assert.deepEqual(r.emitted[idx], { type: "verdict", verdict: r.hub.lastVerdict });
    assert.deepEqual(r.hudEmitted.slice(hudIdx), [{ type: "verdict", verdict: r.hub.lastVerdict }]);
    assert.deepEqual(s.realtimeInputs.slice(rtIdx), [
      { text: "(The user pressed Repeat. Repeat your last answer briefly, word for word.)" },
    ]);

    idx = r.emitted.length;
    hudIdx = r.hudEmitted.length;
    rtIdx = s.realtimeInputs.length;
    t.mock.timers.tick(250);
    r.proxy.handleEvent("log_dose");
    assert.equal(r.hub.profile.doseLog.length, 1);
    assert.deepEqual(r.hub.profile.doseLog[0], { medId: "aml", ts: 9_000_250 });
    assert.equal(r.hub.lastVerdict?.takenToday, true);
    assert.deepEqual(r.emitted.slice(idx), []);
    assert.equal(r.hudEmitted.slice(hudIdx).length, 1);
    const hudVerdict = r.hudEmitted[hudIdx];
    assert.equal(hudVerdict.type, "verdict");
    if (hudVerdict.type === "verdict") {
      assert.equal(hudVerdict.verdict.matchedMedId, "aml");
      assert.equal(hudVerdict.verdict.takenToday, true);
    }
    assert.deepEqual(s.realtimeInputs.slice(rtIdx), [
      { text: "(The user just logged a dose of Norvasc. Confirm in three or four words.)" },
    ]);

    idx = r.emitted.length;
    hudIdx = r.hudEmitted.length;
    r.proxy.handleEvent("stop");
    assert.equal(r.proxy.active, false);
    assert.equal(s.closed, true);
    assert.deepEqual(r.emitted.slice(idx), [
      { type: "status", live: "closed", detail: "stopped by user" },
    ]);
    assert.deepEqual(r.hudEmitted.slice(hudIdx), [
      { type: "status", live: "closed", detail: "stopped by user" },
    ]);
    const liveRow = readLedgerRows(env.ledgerPath).find((row) => row.feature === "live");
    assert.ok(liveRow);
    assert.equal(liveRow.reason, "stopped by user");
  } finally {
    r.proxy.stop("test cleanup");
    r.hub.dropFrames();
  }
});
