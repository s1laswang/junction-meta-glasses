import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { LiveConnectParameters, LiveServerMessage, Session } from "@google/genai";
import type WebSocket from "ws";
import type { ServerMsg } from "../../shared/types.ts";
import { env } from "../src/env.ts";
import { ai } from "../src/gemini.ts";
import { Hub, addHud, getOrCreateHub, markLatest, resetHubsForTest } from "../src/hub.ts";
import { stats } from "../src/ledger.ts";
import { LiveProxy } from "../src/live.ts";

process.env.HOLDUP_QUIET = "1";

const EXPECTED_LIVE_MODELS = [
  "gemini-3.8-live",
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-latest",
];

const tempLedger = path.join(os.tmpdir(), `holdup-live-fallback-chain-${process.pid}.jsonl`);

type MockLiveSession = {
  model: string;
  config: LiveConnectParameters["config"];
  callbacks: LiveConnectParameters["callbacks"];
  realtimeInputs: Array<Record<string, unknown>>;
  toolResponses: Array<Record<string, unknown>>;
  closed: number;
  throwOnSend: boolean;
  throwOnClose: boolean;
  session: Session;
};

type MockSocket = {
  ws: WebSocket;
  sent: ServerMsg[];
  close: () => void;
};

const origLiveConnect = ai.live.connect.bind(ai.live);
const origGenerateContent = ai.models.generateContent.bind(ai.models);
const origRandom = Math.random;

let prevApiKey = "";
let prevLedger = "";
let prevLiveModels: string[] = [];
let prevIdleStopMs = 45_000;

let connectImpl: ((params: LiveConnectParameters) => Promise<Session>) | null = null;
let liveSessions: MockLiveSession[] = [];
let trackedProxies: LiveProxy[] = [];

function createMockLiveSession(params: LiveConnectParameters): MockLiveSession {
  const entry: MockLiveSession = {
    model: params.model,
    config: params.config,
    callbacks: params.callbacks,
    realtimeInputs: [],
    toolResponses: [],
    closed: 0,
    throwOnSend: false,
    throwOnClose: false,
    session: null as unknown as Session,
  };
  entry.session = {
    sendRealtimeInput(input: Record<string, unknown>) {
      if (entry.throwOnSend) throw new Error("socket closed");
      entry.realtimeInputs.push(input);
    },
    sendToolResponse(resp: Record<string, unknown>) {
      if (entry.throwOnSend) throw new Error("socket closed");
      entry.toolResponses.push(resp);
    },
    close() {
      entry.closed++;
      if (entry.throwOnClose) throw new Error("already closed");
    },
  } as unknown as Session;
  liveSessions.push(entry);
  return entry;
}

function createMockSocket(readyState = 1): MockSocket {
  const sent: ServerMsg[] = [];
  const closeListeners: Array<() => void> = [];
  const raw = {
    readyState,
    send(payload: string) {
      sent.push(JSON.parse(payload) as ServerMsg);
    },
    on(event: string, cb: () => void) {
      if (event === "close") closeListeners.push(cb);
      return raw;
    },
  };
  return {
    ws: raw as unknown as WebSocket,
    sent,
    close() {
      raw.readyState = 3;
      for (const cb of closeListeners) cb();
    },
  };
}

function trackProxy(proxy: LiveProxy): LiveProxy {
  trackedProxies.push(proxy);
  return proxy;
}

function liveMsg(partial: Partial<LiveServerMessage>): LiveServerMessage {
  return { text: undefined, data: undefined, ...partial };
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

function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 2);
  });
}

before(() => {
  process.env.HOLDUP_QUIET = "1";
  prevApiKey = env.apiKey;
  prevLedger = env.ledgerPath;
  prevLiveModels = [...env.liveModels];
  prevIdleStopMs = env.idleStopMs;
  env.apiKey = "";
  env.ledgerPath = tempLedger;
});

beforeEach(() => {
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
  resetHubsForTest();
  liveSessions = [];
  trackedProxies = [];
  env.liveModels = [...EXPECTED_LIVE_MODELS];
  env.idleStopMs = 45_000;
  Math.random = () => 0;

  connectImpl = async (params) => createMockLiveSession(params).session;
  (ai.live as unknown as { connect: (p: LiveConnectParameters) => Promise<Session> }).connect = (params) => {
    if (!connectImpl) throw new Error("unexpected ai.live.connect call");
    return connectImpl(params);
  };
  (ai.models as unknown as { generateContent: () => Promise<unknown> }).generateContent = () => {
    throw new Error("unexpected real or mocked ai.models.generateContent call");
  };
});

afterEach(async () => {
  for (const proxy of trackedProxies) {
    proxy.stop("test cleanup");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  Math.random = origRandom;
  connectImpl = null;
  resetHubsForTest();
});

after(() => {
  (ai.live as unknown as { connect: typeof origLiveConnect }).connect = origLiveConnect;
  (ai.models as unknown as { generateContent: typeof origGenerateContent }).generateContent = origGenerateContent;
  Math.random = origRandom;
  env.apiKey = prevApiKey;
  env.ledgerPath = prevLedger;
  env.liveModels = prevLiveModels;
  env.idleStopMs = prevIdleStopMs;
  try {
    fs.rmSync(tempLedger, { force: true });
  } catch {}
});

test("env.liveModels defines the 3-model Live chain and LiveProxy walks fallbacks on 429 and 503 rejections", async () => {
  if (!process.env.LIVE_MODEL) {
    assert.deepEqual(prevLiveModels, EXPECTED_LIVE_MODELS);
  }
  assert.deepEqual(env.liveModels, EXPECTED_LIVE_MODELS);

  const triedStep2: string[] = [];
  connectImpl = async (params) => {
    triedStep2.push(params.model);
    if (params.model === "gemini-3.8-live") {
      const err = Object.assign(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"), { status: 429 });
      throw err;
    }
    return createMockLiveSession(params).session;
  };

  const hub2 = getOrCreateHub("sess-fb-2");
  const phone2 = createMockSocket();
  const hud2 = createMockSocket();
  hub2.clients.add(phone2.ws);
  addHud(hud2.ws, "sess-fb-2");
  phone2.sent.length = 0;
  hud2.sent.length = 0;

  const proxy2 = trackProxy(new LiveProxy(hub2, { lang: "en", voice: true }));
  await proxy2.start();

  assert.deepEqual(triedStep2, ["gemini-3.8-live", "gemini-3.1-flash-live-preview"]);
  assert.equal(proxy2.active, true);
  assert.deepEqual(phone2.sent, [
    { type: "status", live: "connecting" },
    { type: "ready", model: "gemini-3.1-flash-live-preview", session: "sess-fb-2" },
    { type: "status", live: "open", detail: "gemini-3.1-flash-live-preview" },
  ]);
  assert.deepEqual(hud2.sent, [
    { type: "status", live: "connecting" },
    { type: "status", live: "open", detail: "gemini-3.1-flash-live-preview" },
  ]);
  proxy2.stop("done-fb-2");

  const triedStep3: string[] = [];
  connectImpl = async (params) => {
    triedStep3.push(params.model);
    if (params.model === "gemini-3.8-live") {
      throw new Error("429 quota exceeded on primary");
    }
    if (params.model === "gemini-3.1-flash-live-preview") {
      const err = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
      throw err;
    }
    return createMockLiveSession(params).session;
  };

  const hub3 = getOrCreateHub("sess-fb-3");
  const phone3 = createMockSocket();
  const hud3 = createMockSocket();
  hub3.clients.add(phone3.ws);
  addHud(hud3.ws, "sess-fb-3");
  phone3.sent.length = 0;
  hud3.sent.length = 0;

  const proxy3 = trackProxy(new LiveProxy(hub3, { lang: "en", voice: true }));
  await proxy3.start();

  assert.deepEqual(triedStep3, EXPECTED_LIVE_MODELS);
  assert.equal(proxy3.active, true);
  assert.deepEqual(phone3.sent, [
    { type: "status", live: "connecting" },
    { type: "ready", model: "gemini-2.5-flash-native-audio-latest", session: "sess-fb-3" },
    { type: "status", live: "open", detail: "gemini-2.5-flash-native-audio-latest" },
  ]);
  assert.deepEqual(hud3.sent, [
    { type: "status", live: "connecting" },
    { type: "status", live: "open", detail: "gemini-2.5-flash-native-audio-latest" },
  ]);
  proxy3.stop("done-fb-3");
});

test("LiveProxy emits status degraded and recoverable gemini_unavailable error when all 3 Live models fail", async () => {
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const activeIntervals = new Set<NodeJS.Timeout>();

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = origSetInterval(...args);
    activeIntervals.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: NodeJS.Timeout) => {
    if (id !== undefined) activeIntervals.delete(id);
    return origClearInterval(id);
  }) as typeof clearInterval;

  try {
    const failures: Record<string, string> = {
      "gemini-3.8-live": "429 RESOURCE_EXHAUSTED",
      "gemini-3.1-flash-live-preview": "503 UNAVAILABLE",
      "gemini-2.5-flash-native-audio-latest": "404 model not found or unavailable",
    };
    const attempted: string[] = [];

    connectImpl = async (params) => {
      attempted.push(params.model);
      throw new Error(failures[params.model] ?? "unavailable");
    };

    const hub = getOrCreateHub("sess-all-fail");
    const phone = createMockSocket();
    const explicitHud = createMockSocket();
    const floatingHud = createMockSocket();
    hub.clients.add(phone.ws);
    addHud(explicitHud.ws, "sess-all-fail");
    addHud(floatingHud.ws);
    markLatest(hub);
    phone.sent.length = 0;
    explicitHud.sent.length = 0;
    floatingHud.sent.length = 0;

    const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
    await proxy.start();

    assert.deepEqual(attempted, EXPECTED_LIVE_MODELS);
    assert.equal(proxy.active, false);
    assert.equal(activeIntervals.size, 0);

    assert.deepEqual(phone.sent, [
      { type: "status", live: "connecting" },
      { type: "status", live: "degraded", detail: "Gemini Live unavailable, use snapshot mode" },
      {
        type: "error",
        code: "gemini_unavailable",
        message: "Live voice is unavailable right now. Snapshot mode still works.",
        recoverable: true,
      },
    ]);

    const expectedHud: ServerMsg[] = [
      { type: "status", live: "connecting" },
      { type: "status", live: "degraded", detail: "Gemini Live unavailable, use snapshot mode" },
    ];
    assert.deepEqual(explicitHud.sent, expectedHud);
    assert.deepEqual(floatingHud.sent, expectedHud);
    assert.deepEqual(hub.lastStatus, {
      type: "status",
      live: "degraded",
      detail: "Gemini Live unavailable, use snapshot mode",
    });

    const summary = stats(tempLedger);
    const connectFeature = summary.features.live_connect as Record<string, unknown> | undefined;
    const liveFeature = summary.features.live as Record<string, unknown> | undefined;
    assert.ok(connectFeature);
    assert.equal(connectFeature.calls, 3);
    assert.equal(connectFeature.errors, 3);
    assert.ok(liveFeature);
    assert.equal(liveFeature.calls, 1);
    assert.equal(liveFeature.ok, 0);
    assert.equal(liveFeature.errors, 1);
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

test("sessionResumptionUpdate persists onto hub.resume and passes handle on goAway reconnect while fencing stale callbacks", async () => {
  const hub = getOrCreateHub("sess-goaway");
  const phone = createMockSocket();
  const hud = createMockSocket();
  hub.clients.add(phone.ws);
  addHud(hud.ws, "sess-goaway");

  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
  await proxy.start();

  assert.equal(liveSessions.length, 1);
  const s1 = liveSessions[0];
  assert.equal(s1.model, "gemini-3.8-live");
  assert.deepEqual(s1.config?.sessionResumption, {});
  const readResume = () => hub.resume;
  assert.equal(readResume(), undefined);

  const beforeHandleTs = Date.now();
  s1.callbacks.onmessage(
    liveMsg({
      sessionResumptionUpdate: { resumable: true, newHandle: "handle-v1" },
    }),
  );
  const afterHandleTs = Date.now();

  const r1 = readResume();
  assert.ok(r1);
  assert.equal(r1.handle, "handle-v1");
  assert.equal(r1.model, "gemini-3.8-live");
  assert.ok(r1.at >= beforeHandleTs && r1.at <= afterHandleTs);

  s1.callbacks.onmessage(
    liveMsg({
      sessionResumptionUpdate: { resumable: false },
    }),
  );
  assert.equal(readResume()?.handle, "handle-v1");

  s1.callbacks.onmessage(
    liveMsg({
      sessionResumptionUpdate: { resumable: true, newHandle: "handle-v2" },
    }),
  );
  assert.equal(readResume()?.handle, "handle-v2");

  phone.sent.length = 0;
  hud.sent.length = 0;

  s1.callbacks.onmessage(liveMsg({ goAway: { timeLeft: "3s" } }));
  await waitFor(() => liveSessions.length === 2, "goAway reconnect");

  assert.equal(s1.closed, 1);
  const s2 = liveSessions[1];
  assert.equal(s2.model, "gemini-3.8-live");
  assert.deepEqual(s2.config?.sessionResumption, { handle: "handle-v2" });
  assert.deepEqual(phone.sent, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "ready", model: "gemini-3.8-live", session: "sess-goaway" },
    { type: "status", live: "open", detail: "gemini-3.8-live" },
  ]);
  assert.deepEqual(hud.sent, [
    { type: "status", live: "reconnecting", detail: "resuming" },
    { type: "status", live: "open", detail: "gemini-3.8-live" },
  ]);

  const msgCountBeforeStale = phone.sent.length;
  s1.callbacks.onmessage(liveMsg({ serverContent: { interrupted: true } }));
  s1.callbacks.onclose?.({ code: 1006, reason: "closed after goAway" } as CloseEvent);
  assert.equal(phone.sent.length, msgCountBeforeStale);
  assert.equal(liveSessions.length, 2);

  proxy.stop("done");
});

test("unexpected upstream close resumes with handle, steps down on repeated/quota closes, and honors hub.resume 10m TTL", async () => {
  const hub = getOrCreateHub("sess-close-resume");
  const phone = createMockSocket();
  hub.clients.add(phone.ws);

  const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
  await proxy.start();
  assert.equal(liveSessions.length, 1);

  liveSessions[0].callbacks.onmessage(
    liveMsg({
      sessionResumptionUpdate: { resumable: true, newHandle: "handle-drop-1" },
    }),
  );

  phone.sent.length = 0;
  liveSessions[0].callbacks.onclose?.({ code: 1006, reason: "network reset" } as CloseEvent);
  await waitFor(() => liveSessions.length === 2, "1006 reconnect #1 with handle");

  assert.equal(liveSessions[1].model, "gemini-3.8-live");
  assert.deepEqual(liveSessions[1].config?.sessionResumption, { handle: "handle-drop-1" });
  assert.equal(
    phone.sent.some((m) => m.type === "status" && m.live === "reconnecting" && m.detail === "resuming"),
    true,
  );

  liveSessions[1].callbacks.onclose?.({ code: 1006, reason: "network reset 2" } as CloseEvent);
  await waitFor(() => liveSessions.length === 3, "1006 reconnect #2 with handle");
  assert.equal(liveSessions[2].model, "gemini-3.8-live");
  assert.deepEqual(liveSessions[2].config?.sessionResumption, { handle: "handle-drop-1" });

  liveSessions[2].callbacks.onclose?.({ code: 1006, reason: "network reset 3" } as CloseEvent);
  await waitFor(() => liveSessions.length === 4, "1006 reconnect #3 with handle");
  assert.equal(liveSessions[3].model, "gemini-3.8-live");
  assert.deepEqual(liveSessions[3].config?.sessionResumption, { handle: "handle-drop-1" });

  liveSessions[3].callbacks.onclose?.({ code: 1006, reason: "network reset 4" } as CloseEvent);
  await waitFor(() => liveSessions.length === 5, "1006 reconnect #4 steps down to fallback model 2");
  assert.equal(liveSessions[4].model, "gemini-3.1-flash-live-preview");
  assert.deepEqual(liveSessions[4].config?.sessionResumption, {});

  liveSessions[4].callbacks.onmessage(
    liveMsg({
      sessionResumptionUpdate: { resumable: true, newHandle: "handle-m2" },
    }),
  );
  assert.deepEqual(hub.resume?.model, "gemini-3.1-flash-live-preview");
  assert.equal(hub.resume?.handle, "handle-m2");

  liveSessions[4].callbacks.onclose?.({ code: 1008, reason: "policy violation" } as CloseEvent);
  await waitFor(() => liveSessions.length === 6, "1008 bad_input clears handle on same model");
  assert.equal(liveSessions[5].model, "gemini-3.1-flash-live-preview");
  assert.deepEqual(liveSessions[5].config?.sessionResumption, {});
  assert.equal(phone.sent.some((m) => m.type === "error" && m.code === "bad_input"), true);

  liveSessions[5].callbacks.onclose?.({ code: 1011, reason: "429 RESOURCE_EXHAUSTED" } as CloseEvent);
  await waitFor(() => liveSessions.length === 7, "quota close steps down to fallback model 3");
  assert.equal(liveSessions[6].model, "gemini-2.5-flash-native-audio-latest");
  assert.deepEqual(liveSessions[6].config?.sessionResumption, {});
  assert.equal(phone.sent.some((m) => m.type === "error" && m.code === "quota"), true);
  proxy.stop("done-close-matrix");

  const warmHub = new Hub("sess-warm-resume");
  warmHub.resume = {
    handle: "warm-handle-77",
    model: "gemini-3.1-flash-live-preview",
    at: Date.now() - 60_000,
  };
  let warmCalls = 0;
  connectImpl = async (params) => {
    warmCalls++;
    if (warmCalls === 1) {
      assert.equal(params.model, "gemini-3.1-flash-live-preview");
      assert.deepEqual(params.config?.sessionResumption, { handle: "warm-handle-77" });
      throw new Error("resumption token rejected");
    }
    return createMockLiveSession(params).session;
  };
  const warmProxy = trackProxy(new LiveProxy(warmHub, { lang: "en", voice: true }));
  await warmProxy.start();
  assert.equal(warmCalls, 2);
  assert.equal(liveSessions[7].model, "gemini-3.1-flash-live-preview");
  assert.deepEqual(liveSessions[7].config?.sessionResumption, {});
  warmProxy.stop("done-warm");

  connectImpl = async (params) => createMockLiveSession(params).session;
  const staleHub = new Hub("sess-stale-resume");
  staleHub.resume = {
    handle: "expired-handle-99",
    model: "gemini-2.5-flash-native-audio-latest",
    at: Date.now() - (10 * 60_000 + 1),
  };
  const staleProxy = trackProxy(new LiveProxy(staleHub, { lang: "en", voice: true }));
  await staleProxy.start();
  assert.equal(liveSessions[8].model, "gemini-3.8-live");
  assert.deepEqual(liveSessions[8].config?.sessionResumption, {});
  staleProxy.stop("done-stale");
});

test("proxy.frame enforces >= 900 ms rate limit, refreshes 45s idle auto-stop, and stop() tears down cleanly", async () => {
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origNow = Date.now;

  const activeIntervals = new Set<NodeJS.Timeout>();
  let capturedIdleTick: (() => void) | undefined;
  let fakeNow = 100_000;

  Date.now = () => fakeNow;
  globalThis.setInterval = ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = origSetInterval(cb, ms, ...rest);
    activeIntervals.add(id);
    if (ms === 2000) capturedIdleTick = () => cb();
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: NodeJS.Timeout) => {
    if (id !== undefined) activeIntervals.delete(id);
    return origClearInterval(id);
  }) as typeof clearInterval;

  try {
    const hub = getOrCreateHub("sess-fps-idle");
    const phone = createMockSocket();
    const hud = createMockSocket();
    hub.clients.add(phone.ws);
    addHud(hud.ws, "sess-fps-idle");

    const proxy = trackProxy(new LiveProxy(hub, { lang: "en", voice: true }));
    await proxy.start();
    assert.equal(activeIntervals.size, 1);
    assert.ok(capturedIdleTick);
    const live = liveSessions[0];

    proxy.frame("f-100000");
    fakeNow = 100_100;
    proxy.frame("f-100100-drop");
    fakeNow = 100_899;
    proxy.frame("f-100899-drop");
    fakeNow = 100_900;
    proxy.frame("f-100900");
    fakeNow = 101_799;
    proxy.frame("f-101799-drop");
    fakeNow = 101_800;
    proxy.frame("f-101800");

    assert.deepEqual(live.realtimeInputs, [
      { video: { data: "f-100000", mimeType: "image/jpeg" } },
      { video: { data: "f-100900", mimeType: "image/jpeg" } },
      { video: { data: "f-101800", mimeType: "image/jpeg" } },
    ]);

    live.realtimeInputs.length = 0;
    const sentTimestamps: number[] = [];
    const origSendRealtime = live.session.sendRealtimeInput.bind(live.session);
    live.session.sendRealtimeInput = ((input: Record<string, unknown>) => {
      sentTimestamps.push(fakeNow);
      origSendRealtime(input);
    }) as Session["sendRealtimeInput"];

    for (let i = 0; i < 100; i++) {
      fakeNow = 200_000 + i * 100;
      proxy.frame(`burst-${i}`);
    }
    assert.equal(sentTimestamps.length, 12);
    for (let i = 1; i < sentTimestamps.length; i++) {
      assert.ok(sentTimestamps[i] - sentTimestamps[i - 1] >= 900);
    }

    const lastSentAt = sentTimestamps.at(-1)!;
    fakeNow = lastSentAt + 500;
    proxy.frame("throttled-keepalive");
    const lastFrameSeenAt = fakeNow;

    fakeNow = lastFrameSeenAt + env.idleStopMs;
    capturedIdleTick();
    assert.equal(proxy.active, true);
    assert.equal(live.closed, 0);

    phone.sent.length = 0;
    hud.sent.length = 0;
    fakeNow = lastFrameSeenAt + env.idleStopMs + 1;
    capturedIdleTick();

    assert.equal(proxy.active, false);
    assert.equal(live.closed, 1);
    assert.equal(activeIntervals.size, 0);
    const expectedIdleStop: ServerMsg[] = [
      { type: "coach", cue: "ok", text: "Camera stopped" },
      { type: "status", live: "closed", detail: "auto-stopped: no camera frames for 45 s" },
    ];
    assert.deepEqual(phone.sent, expectedIdleStop);
    assert.deepEqual(hud.sent, expectedIdleStop);

    const stopHub = getOrCreateHub("sess-explicit-stop");
    const stopPhone = createMockSocket();
    stopHub.clients.add(stopPhone.ws);
    const stopProxy = trackProxy(new LiveProxy(stopHub, { lang: "en", voice: true }));
    await stopProxy.start();
    const stopLive = liveSessions[1];
    assert.equal(activeIntervals.size, 1);

    fakeNow = 400_000;
    stopLive.throwOnSend = true;
    assert.doesNotThrow(() => stopProxy.frame("safe-when-send-throws"));
    stopLive.throwOnSend = false;

    stopLive.throwOnClose = true;
    stopPhone.sent.length = 0;
    assert.doesNotThrow(() => stopProxy.handleEvent("stop"));
    assert.equal(stopProxy.active, false);
    assert.equal(stopLive.closed, 1);
    assert.equal(activeIntervals.size, 0);
    assert.deepEqual(stopPhone.sent, [{ type: "status", live: "closed", detail: "stopped by user" }]);

    stopProxy.stop("duplicate stop");
    assert.equal(stopLive.closed, 1);
    assert.equal(stopPhone.sent.length, 1);

    fakeNow = 410_000;
    stopProxy.frame("ignored-after-stop");
    stopProxy.audio("cGNt");
    stopProxy.text("ignored");
    assert.equal(stopLive.realtimeInputs.length, 0);

    const inflight = deferred<Session>();
    let lateClosed = 0;
    connectImpl = () => inflight.promise;
    const cancelHub = new Hub("sess-cancel-connect");
    const cancelPhone = createMockSocket();
    cancelHub.clients.add(cancelPhone.ws);
    const cancelProxy = trackProxy(new LiveProxy(cancelHub, { lang: "en", voice: true }));
    const starting = cancelProxy.start();
    cancelProxy.stop("aborted during connect");
    inflight.resolve({
      sendRealtimeInput() {},
      sendToolResponse() {},
      close() {
        lateClosed++;
      },
    } as unknown as Session);
    await starting;
    assert.equal(cancelProxy.active, false);
    assert.equal(lateClosed, 1);
    assert.equal(activeIntervals.size, 0);
    assert.equal(cancelPhone.sent.some((m) => m.type === "ready"), false);
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    Date.now = origNow;
  }
});

test("live-fallback-chain.test.ts contains zero comments, em dashes, trailers, or API keys", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, "utf8");
  const slash = String.fromCharCode(47);
  const star = String.fromCharCode(42);
  const emDash = String.fromCharCode(0x2014);
  const coAuthored = new RegExp(["Co", "Authored", "By"].join("-"), "i");
  const keyPattern = new RegExp(`AIza[0-9A-Za-z_-]{20,}`);

  assert.equal(src.includes(slash + slash), false);
  assert.equal(src.includes(slash + star), false);
  assert.equal(src.includes(emDash), false);
  assert.equal(coAuthored.test(src), false);
  assert.equal(keyPattern.test(src), false);
});
