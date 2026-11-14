import { HoldUpSessionManager, type WsLike } from "../src/session/sessionManager.ts";
import type {
  ChaosConfig,
  ClientMsg,
  CoachCue,
  Profile,
  ServerMsg,
  TransportMode,
  Verdict
} from "../src/types.ts";

interface MockTimers {
  enable(opts?: { apis?: Array<"Date" | "setTimeout" | "setInterval">; now?: number }): void;
  tick(ms: number): void;
}

interface TestContext {
  mock: {
    timers: MockTimers;
  };
}

type TestFn = (name: string, fn: (t: TestContext) => void | Promise<void>) => Promise<void>;

interface StrictAssert {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
}

const nodeTestModId: string = "node:test";
const nodeAssertModId: string = "node:assert/strict";
const test: TestFn = ((await import(nodeTestModId)) as { test: TestFn }).test;
const assert: StrictAssert = ((await import(nodeAssertModId)) as { default: StrictAssert }).default;

class FakeWs implements WsLike {
  readyState = 0;
  sent: ClientMsg[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
}

const baseProfile: Profile = {
  meds: [
    {
      id: "aml",
      name: "Amlodipine",
      ingredient: "amlodipine",
      strength: "5 mg",
      schedule: ["evening"],
      barcode: "6432100012345"
    }
  ],
  allergies: ["peanut"],
  avoid: ["NSAIDs"],
  doseLog: [],
  lang: "en"
};

const sampleVerdict: Verdict = {
  level: "match",
  headline: "Amlodipine 5 mg, evening pill",
  speech: "Yes. Amlodipine 5 mg, your evening pill.",
  matchedMedId: "aml",
  takenToday: false,
  reasons: ["Matches saved evening medication"],
  read: {
    kind: "medication",
    product: { value: "Amlodipine", confidence: 0.96 },
    ingredient: { value: "amlodipine", confidence: 0.97 },
    strength: { value: "5 mg", confidence: 0.95 },
    dosing: { value: "1 tablet daily", confidence: 0.9 },
    expiry: { value: "2027-05", confidence: 0.88 },
    allergens: { value: null, confidence: 0 },
    barcode: { value: "6432100012345", confidence: 0.99 },
    readability: 0.95
  }
};

const clearChaos: ChaosConfig = {
  forceWsDrop: false,
  forceOffline: false,
  simulateGlassesDoffed: false,
  simulateLowBattery: false
};

function wsUrl(sessionId: string): string {
  return `ws:\x2f\x2ftest.local/live?session=${sessionId}`;
}

test("full live lifecycle: connect, ready, ping/pong RTT, checking start/end, verdict and hud connected", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10_000 });

  const sockets: FakeWs[] = [];
  const checkingEvents: boolean[] = [];
  const verdicts: Array<{ verdict: Verdict; mode: TransportMode }> = [];
  const coaches: Array<{ cue: CoachCue; text: string }> = [];
  const audioChunks: string[] = [];

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-live-1",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    pingIntervalMs: 1_000,
    callbacks: {
      onCheckingChange: (c) => checkingEvents.push(c),
      onVerdict: (verdict, mode) => verdicts.push({ verdict, mode }),
      onCoach: (cue, text) => coaches.push({ cue, text }),
      onAudioChunk: (b64) => audioChunks.push(b64)
    }
  });

  const snapshots: number[] = [];
  const unsub = mgr.subscribe((snap) => {
    snapshots.push(snap.transcripts.length);
  });

  mgr.startSession({ voice: true });
  assert.equal(sockets.length, 1);
  assert.equal(mgr.getSnapshot().liveState, "connecting");
  assert.equal(mgr.getSnapshot().cameraActive, true);
  assert.equal(mgr.getSnapshot().autoStopRemainingSec, 45);

  const ws = sockets[0];
  ws.open();
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, "start");

  ws.receive({ type: "ready", model: "gemini-3.8-live", session: "sess-live-1" });
  assert.equal(mgr.getSnapshot().mode, "live");
  assert.equal(mgr.getSnapshot().liveState, "open");
  assert.equal(mgr.getSnapshot().activeModel, "gemini-3.8-live");

  t.mock.timers.tick(1_000);
  const pingMsg = ws.sent.find((m): m is Extract<ClientMsg, { type: "ping" }> => m.type === "ping");
  assert.ok(pingMsg);

  t.mock.timers.tick(85);
  ws.receive({ type: "pong", t: pingMsg.t });
  assert.equal(mgr.getSnapshot().network.rttMs, 85);
  assert.equal(mgr.getSnapshot().network.targetFps, 1);
  assert.equal(mgr.getSnapshot().network.jpegQuality, 0.8);

  t.mock.timers.tick(915);
  const secondPing = ws.sent.filter((m): m is Extract<ClientMsg, { type: "ping" }> => m.type === "ping")[1];
  assert.ok(secondPing);
  t.mock.timers.tick(850);
  ws.receive({ type: "pong", t: secondPing.t });
  assert.equal(mgr.getSnapshot().network.rttMs, 850);
  assert.equal(mgr.getSnapshot().network.targetFps, 0.5);
  assert.equal(mgr.getSnapshot().network.jpegQuality, 0.5);

  ws.receive({ type: "coach", cue: "rotate_left", text: "Turn it left" });
  assert.deepEqual(mgr.getSnapshot().coach, { cue: "rotate_left", text: "Turn it left" });
  assert.deepEqual(coaches, [{ cue: "rotate_left", text: "Turn it left" }]);

  ws.receive({ type: "audio", data: "UENN" });
  assert.deepEqual(audioChunks, ["UENN"]);

  ws.receive({ type: "checking", phase: "start" });
  assert.equal(mgr.getSnapshot().checking, true);

  ws.receive({ type: "checking", phase: "end" });
  assert.equal(mgr.getSnapshot().checking, false);
  assert.deepEqual(checkingEvents, [true, false]);

  ws.receive({ type: "verdict", verdict: sampleVerdict });
  assert.deepEqual(mgr.getSnapshot().verdict, sampleVerdict);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].mode, "live");
  assert.equal(verdicts[0].verdict.matchedMedId, "aml");

  ws.receive({ type: "hud", connected: true });
  assert.equal(mgr.getSnapshot().hudConnected, true);

  ws.receive({ type: "hud", connected: false });
  assert.equal(mgr.getSnapshot().hudConnected, false);

  assert.ok(snapshots.length > 0);
  unsub();
  mgr.stopSession();
});

test("barge-in interrupted message invokes onInterrupted", () => {
  const sockets: FakeWs[] = [];
  let interruptedCount = 0;

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-barge",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    callbacks: {
      onInterrupted: () => {
        interruptedCount += 1;
      }
    }
  });

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-barge" });
  sockets[0].receive({ type: "interrupted" });

  assert.equal(interruptedCount, 1);
  mgr.stopSession();
});

test("live WS drop degrades to snapshot mode, routes sendQuestion via POST /api/verify, then reconnects to live", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 50_000 });

  const sockets: FakeWs[] = [];
  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const verdicts: Array<{ verdict: Verdict; mode: TransportMode }> = [];
  const announcements: string[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    fetchCalls.push({ url, body });
    return new Response(JSON.stringify(sampleVerdict), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-drop",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    fetchImpl: fakeFetch,
    callbacks: {
      onVerdict: (verdict, mode) => verdicts.push({ verdict, mode }),
      onStateAnnouncement: (msg) => announcements.push(msg)
    }
  });

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-drop" });
  assert.equal(mgr.getSnapshot().mode, "live");

  mgr.sendFrame({ data: "frame-1", w: 768, h: 768, sharpness: 0.7, ts: 1 });
  mgr.sendFrame({ data: "frame-2", w: 768, h: 768, sharpness: 0.8, ts: 2 });
  mgr.sendFrame({ data: "frame-3", w: 768, h: 768, sharpness: 0.9, ts: 3 });
  mgr.sendFrame({ data: "frame-4", w: 768, h: 768, sharpness: 0.95, ts: 4 });

  sockets[0].drop();
  assert.equal(mgr.getSnapshot().mode, "snapshot");
  assert.equal(mgr.getSnapshot().liveState, "reconnecting");
  assert.ok(announcements.some((a) => a.toLowerCase().includes("snapshot")));

  await mgr.sendQuestion("Is this my evening pill?");

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/verify");
  assert.deepEqual(fetchCalls[0].body.frames, ["frame-2", "frame-3", "frame-4"]);
  assert.equal(fetchCalls[0].body.question, "Is this my evening pill?");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].mode, "snapshot");
  assert.deepEqual(mgr.getSnapshot().verdict, sampleVerdict);

  assert.equal(sockets.length, 1);
  t.mock.timers.tick(300);
  assert.equal(sockets.length, 2);

  sockets[1].fail();
  assert.equal(mgr.getSnapshot().mode, "snapshot");
  t.mock.timers.tick(599);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 3);

  sockets[2].open();
  sockets[2].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-drop" });

  assert.equal(mgr.getSnapshot().mode, "live");
  assert.equal(mgr.getSnapshot().liveState, "open");
  assert.equal(mgr.getSnapshot().activeModel, "gemini-3.8-live");

  mgr.stopSession();
});

test("chaos.forceOffline switches to offline mode and clears on recovery", () => {
  const sockets: FakeWs[] = [];
  const announcements: string[] = [];

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-offline",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    callbacks: {
      onStateAnnouncement: (msg) => announcements.push(msg)
    }
  });

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-offline" });
  assert.equal(mgr.getSnapshot().mode, "live");
  assert.equal(mgr.getSnapshot().network.online, true);

  mgr.setChaos({ ...clearChaos, forceOffline: true });
  assert.equal(mgr.getSnapshot().mode, "offline");
  assert.equal(mgr.getSnapshot().liveState, "closed");
  assert.equal(mgr.getSnapshot().network.online, false);
  assert.equal(sockets[0].closed, true);
  assert.ok(announcements.some((a) => a.toLowerCase().includes("offline")));

  mgr.setChaos({ ...clearChaos, forceOffline: false });
  assert.notEqual(mgr.getSnapshot().mode, "offline");
  assert.equal(mgr.getSnapshot().network.online, true);
  assert.equal(sockets.length, 2);

  sockets[1].open();
  sockets[1].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-offline" });
  assert.equal(mgr.getSnapshot().mode, "live");
  assert.equal(mgr.getSnapshot().liveState, "open");

  mgr.stopSession();
});

test("glasses connected+worn+streaming selects glasses source, then simulateGlassesDoffed and low battery switch to phone with announcements", () => {
  const sockets: FakeWs[] = [];
  const announcements: string[] = [];

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-glasses",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    callbacks: {
      onStateAnnouncement: (msg) => announcements.push(msg)
    }
  });

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-glasses" });
  assert.equal(mgr.getSnapshot().device.source, "phone");

  sockets[0].receive({
    type: "device",
    device: {
      connected: true,
      worn: true,
      battery: 84,
      streaming: true,
      source: "glasses"
    }
  });
  assert.equal(mgr.getSnapshot().device.source, "glasses");
  assert.equal(mgr.getSnapshot().device.worn, true);

  mgr.setChaos({ ...clearChaos, simulateGlassesDoffed: true });
  assert.equal(mgr.getSnapshot().device.source, "phone");
  assert.equal(mgr.getSnapshot().device.worn, false);
  assert.ok(announcements.some((a) => a.includes("Glasses taken off, switching to phone camera")));

  mgr.setChaos({ ...clearChaos, simulateGlassesDoffed: false });
  assert.equal(mgr.getSnapshot().device.source, "glasses");

  mgr.setChaos({ ...clearChaos, simulateLowBattery: true });
  assert.equal(mgr.getSnapshot().device.source, "phone");
  assert.ok(announcements.some((a) => a.includes("Glasses battery low, switching to phone camera")));

  mgr.stopSession();
});

test("stopSession clears buffered frames immediately and 45s auto-stop enforces privacy timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 100_000 });

  const sockets: FakeWs[] = [];
  let verifyCalls = 0;
  const announcements: string[] = [];

  const fakeFetch: typeof fetch = async () => {
    verifyCalls += 1;
    return new Response(JSON.stringify(sampleVerdict), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-privacy",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    fetchImpl: fakeFetch,
    callbacks: {
      onStateAnnouncement: (msg) => announcements.push(msg)
    }
  });

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-3.8-live", session: "sess-privacy" });

  mgr.sendFrame({ data: "secret-frame-1", w: 768, h: 768, sharpness: 0.9, ts: 1 });
  mgr.sendFrame({ data: "secret-frame-2", w: 768, h: 768, sharpness: 0.9, ts: 2 });
  assert.deepEqual(mgr.getBufferedFrames(), ["secret-frame-1", "secret-frame-2"]);

  mgr.stopSession("Manual stop");
  assert.deepEqual(mgr.getBufferedFrames(), []);
  assert.equal(mgr.getSnapshot().cameraActive, false);
  assert.equal(mgr.getSnapshot().autoStopRemainingSec, null);

  mgr.setChaos({ ...clearChaos, forceWsDrop: true });
  mgr.startSession();
  assert.equal(mgr.getSnapshot().mode, "snapshot");

  await mgr.sendQuestion("What is this?");
  assert.equal(verifyCalls, 0);
  assert.equal(mgr.getSnapshot().lastError?.code, "no_frames");

  t.mock.timers.tick(10_000);
  assert.equal(mgr.getSnapshot().autoStopRemainingSec, 35);

  mgr.sendFrame({ data: "fresh-frame-1", w: 768, h: 768, sharpness: 0.9, ts: 3 });
  await mgr.sendQuestion("Check again");
  assert.equal(verifyCalls, 1);
  assert.equal(mgr.getSnapshot().autoStopRemainingSec, 45);

  t.mock.timers.tick(45_000);
  assert.equal(mgr.getSnapshot().cameraActive, false);
  assert.equal(mgr.getSnapshot().autoStopRemainingSec, null);
  assert.deepEqual(mgr.getBufferedFrames(), []);
  assert.ok(announcements.includes("Auto-stopped after 45s"));
});

test("profile sync, permissions, transcripts, events, audio send, and applyLocalVerdict", async () => {
  const sockets: FakeWs[] = [];
  const verdicts: Array<{ verdict: Verdict; mode: TransportMode }> = [];

  const mgr = new HoldUpSessionManager({
    sessionId: "sess-methods",
    initialProfile: baseProfile,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    callbacks: {
      onVerdict: (verdict, mode) => verdicts.push({ verdict, mode })
    }
  });

  mgr.setPermissions({ camera: "granted", microphone: "denied" });
  assert.deepEqual(mgr.getSnapshot().permissions, { camera: "granted", microphone: "denied" });

  mgr.startSession();
  const ws = sockets[0];
  ws.open();
  ws.receive({ type: "ready", model: "gemini-3.8-live", session: "sess-methods" });

  mgr.sendAudio("cGNtMTY=");
  assert.ok(ws.sent.some((m) => m.type === "audio" && m.data === "cGNtMTY="));

  const updatedProfile: Profile = {
    ...baseProfile,
    allergies: ["peanut", "hazelnut"]
  };
  mgr.updateProfile(updatedProfile);
  const startMsgs = ws.sent.filter((m) => m.type === "start");
  assert.equal(startMsgs.length, 2);
  assert.deepEqual(startMsgs[1].type === "start" ? startMsgs[1].profile.allergies : [], ["peanut", "hazelnut"]);

  ws.receive({ type: "transcript", role: "assistant", text: "Turn it", final: false });
  ws.receive({ type: "transcript", role: "assistant", text: "Turn it slightly left.", final: true });
  assert.equal(mgr.getSnapshot().transcripts.length, 1);
  assert.equal(mgr.getSnapshot().transcripts[0].text, "Turn it slightly left.");
  assert.equal(mgr.getSnapshot().transcripts[0].final, true);

  await mgr.sendQuestion("Is this safe?");
  assert.ok(ws.sent.some((m) => m.type === "text" && m.text === "Is this safe?"));

  mgr.sendEvent("log_dose");
  assert.ok(ws.sent.some((m) => m.type === "event" && m.name === "log_dose"));

  mgr.setOnline(false);
  assert.equal(mgr.getSnapshot().mode, "offline");

  mgr.applyLocalVerdict(sampleVerdict);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].mode, "offline");

  mgr.sendEvent("repeat");
  assert.equal(verdicts.length, 2);

  mgr.sendEvent("stop");
  assert.equal(mgr.getSnapshot().cameraActive, false);
  assert.equal(mgr.getSnapshot().liveState, "closed");
});

