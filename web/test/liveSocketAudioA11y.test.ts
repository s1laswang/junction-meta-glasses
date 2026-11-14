import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg, Profile, ServerMsg } from "../../shared/types.ts";
import type { ConnState } from "../src/lib/live.ts";

const SLASH2 = "/".repeat(2);
const WS_PREFIX = `ws:${SLASH2}`;
const WSS_PREFIX = `wss:${SLASH2}`;

const storageMap = new Map<string, string>();

const localStorageShim: Storage = {
  get length() {
    return storageMap.size;
  },
  key(index: number): string | null {
    return Array.from(storageMap.keys())[index] ?? null;
  },
  getItem(key: string): string | null {
    return storageMap.has(key) ? storageMap.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, String(value));
  },
  removeItem(key: string): void {
    storageMap.delete(key);
  },
  clear(): void {
    storageMap.clear();
  },
};

const locationShim = {
  protocol: "http:",
  host: "localhost:5173",
  search: "?key=boot-key-1&foo=bar",
  pathname: "/",
  hash: "#check",
};

const replaceStateCalls: Array<{ state: unknown; unused: string; url?: string | URL | null }> = [];

const historyShim = {
  state: { page: 1 },
  replaceState(state: unknown, unused: string, url?: string | URL | null) {
    replaceStateCalls.push({ state, unused, url });
  },
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;
  static onSendHook: ((ws: FakeWebSocket, data: string) => void) | null = null;

  url: string;
  readyState = 0;
  bufferedAmount = 0;
  throwOnSend = false;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    if (FakeWebSocket.throwOnConstruct) {
      throw new Error("WebSocket constructor blocked");
    }
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = false;
    FakeWebSocket.onSendHook = null;
  }

  send(data: string) {
    if (this.throwOnSend) {
      throw new Error("Socket send failed");
    }
    this.sent.push(data);
    FakeWebSocket.onSendHook?.(this, data);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  serverOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  serverRawMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  serverJson(msg: ServerMsg) {
    this.serverRawMessage(JSON.stringify(msg));
  }

  serverError() {
    this.onerror?.(new Event("error"));
  }

  serverClose(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const ch = this.channels[channel];
    if (!ch) throw new RangeError("Invalid channel index");
    return ch;
  }
}

class FakeGainNode {
  gain = { value: 1 };
  connectedTo: unknown[] = [];
  disconnectCount = 0;

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect() {
    this.disconnectCount++;
  }
}

class FakeBufferSourceNode {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  connectedTo: unknown[] = [];
  startedAt: number[] = [];
  stopCount = 0;
  disconnectCount = 0;

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  start(when = 0) {
    this.startedAt.push(when);
  }

  stop() {
    this.stopCount++;
  }

  disconnect() {
    this.disconnectCount++;
  }
}

class FakeMediaStreamSourceNode {
  stream: MediaStream;
  connectedTo: unknown[] = [];
  disconnectCount = 0;

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect() {
    this.disconnectCount++;
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  context: FakeAudioContext;
  name: string;
  options: AudioWorkletNodeOptions | undefined;
  connectedTo: unknown[] = [];
  disconnectCount = 0;
  port = {
    onmessage: null as ((ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => void) | null,
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };

  constructor(context: FakeAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    this.context = context;
    this.name = name;
    this.options = options;
    FakeAudioWorkletNode.instances.push(this);
  }

  static reset() {
    FakeAudioWorkletNode.instances = [];
  }

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect() {
    this.disconnectCount++;
  }

  emitChunk(pcm: ArrayBuffer, rms: number) {
    this.port.onmessage?.({ data: { pcm, rms } } as MessageEvent<{ pcm: ArrayBuffer; rms: number }>);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = "suspended";

  state: AudioContextState = FakeAudioContext.initialState;
  currentTime = 10.0;
  destination = { kind: "audio-destination" };
  gains: FakeGainNode[] = [];
  sources: FakeBufferSourceNode[] = [];
  mediaSources: FakeMediaStreamSourceNode[] = [];
  buffers: FakeAudioBuffer[] = [];
  addModuleCalls: string[] = [];
  resumeCount = 0;
  closeCount = 0;

  audioWorklet = {
    addModule: async (moduleUrl: string): Promise<void> => {
      this.addModuleCalls.push(moduleUrl);
    },
  };

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  static reset() {
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = "suspended";
    FakeAudioWorkletNode.reset();
  }

  createGain(): GainNode {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g as unknown as GainNode;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    const b = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(b);
    return b as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const s = new FakeBufferSourceNode();
    this.sources.push(s);
    return s as unknown as AudioBufferSourceNode;
  }

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const m = new FakeMediaStreamSourceNode(stream);
    this.mediaSources.push(m);
    return m as unknown as MediaStreamAudioSourceNode;
  }

  async resume(): Promise<void> {
    this.resumeCount++;
    if (this.state !== "closed") {
      this.state = "running";
    }
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.state = "closed";
  }
}

class FakeMediaStreamTrack {
  label: string;
  readyState: MediaStreamTrackState = "live";
  stopCount = 0;

  constructor(label: string) {
    this.label = label;
  }

  stop() {
    this.stopCount++;
    this.readyState = "ended";
  }
}

function makeFakeStream(labels = ["Ray-Ban Meta Hands-Free"]): {
  stream: MediaStream;
  tracks: FakeMediaStreamTrack[];
} {
  const tracks = labels.map((l) => new FakeMediaStreamTrack(l));
  const stream = {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
  return { stream, tracks };
}

const windowShim = {
  AudioContext: FakeAudioContext,
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "history", { value: historyShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true, writable: true });
Object.defineProperty(globalThis, "AudioWorkletNode", {
  value: FakeAudioWorkletNode,
  configurable: true,
  writable: true,
});

const { setAccessKey } = await import("../src/lib/key.ts");
const { liveUrl, LiveClient } = await import("../src/lib/live.ts");
const { bytesToBase64, base64ToBytes, synthPcmChunks, PcmPlayer, MicCapture } = await import("../src/lib/audio.ts");

function makeProfile(lang = "en"): Profile {
  return {
    meds: [{ id: "m1", name: "Amlodipine", ingredient: "amlodipine", strength: "5 mg", schedule: ["evening"] }],
    allergies: ["peanuts"],
    avoid: ["NSAIDs"],
    doseLog: [],
    lang,
  };
}

function makeStartMsg(lang = "en"): ClientMsg {
  return {
    type: "start",
    profile: makeProfile(lang),
    lang,
    voice: true,
    source: "glasses",
    features: ["scene", "datamatrix", "addmed", "sonar"],
  };
}

test("liveUrl selects ws vs wss from location.protocol, URI-encodes session, and appends HOLDUP_KEY via withKey", () => {
  storageMap.clear();
  replaceStateCalls.length = 0;
  locationShim.protocol = "http:";
  locationShim.host = "localhost:5173";
  locationShim.search = "?key=boot-key-1&foo=bar";
  locationShim.pathname = "/";
  locationShim.hash = "#check";

  const initialUrl = liveUrl("sess 1/2?x=y&z=3");
  assert.equal(
    initialUrl,
    `${WS_PREFIX}localhost:5173/live?session=sess%201%2F2%3Fx%3Dy%26z%3D3&key=boot-key-1`,
  );
  assert.equal(storageMap.get("holdup.key"), "boot-key-1");
  assert.equal(replaceStateCalls.length, 1);
  assert.equal(replaceStateCalls[0]?.url, "/?foo=bar#check");

  setAccessKey("");
  assert.equal(storageMap.has("holdup.key"), false);
  assert.equal(liveUrl("plain-session"), `${WS_PREFIX}localhost:5173/live?session=plain-session`);

  locationShim.protocol = "https:";
  locationShim.host = "holdup.trycloudflare.com";
  assert.equal(
    liveUrl("nordic/äö?session=1#frag"),
    `${WSS_PREFIX}holdup.trycloudflare.com/live?session=nordic%2F%C3%A4%C3%B6%3Fsession%3D1%23frag`,
  );

  setAccessKey("  secret key&v=2  ");
  assert.equal(
    liveUrl("s-42"),
    `${WSS_PREFIX}holdup.trycloudflare.com/live?session=s-42&key=secret%20key%26v%3D2`,
  );

  setAccessKey("");
  locationShim.protocol = "http:";
  locationShim.host = "localhost:5173";
});

test("LiveClient start transitions to connecting and sends buildStart strictly BEFORE firing onState(open)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 50_000 });
  FakeWebSocket.reset();
  setAccessKey("");

  const timeline: string[] = [];
  const states: Array<{ s: ConnState; attempt: number; nextRetryMs: number | null; reason?: string }> = [];

  FakeWebSocket.onSendHook = (_ws, data) => {
    const parsed = JSON.parse(data) as ClientMsg;
    timeline.push(`send:${parsed.type}`);
  };

  let clientRef: InstanceType<typeof LiveClient> | null = null;
  const client = new LiveClient({
    session: "order-check",
    mock: false,
    buildStart: () => makeStartMsg("fi"),
    onMessage: () => {},
    onState: (s, info) => {
      timeline.push(`state:${s}`);
      states.push({ s, ...info });
      if (s === "open" && clientRef) {
        assert.equal(clientRef.isOpen, true);
        const wsNow = FakeWebSocket.instances[0]!;
        assert.equal(wsNow.sent.length, 1);
        assert.deepEqual(JSON.parse(wsNow.sent[0]!), makeStartMsg("fi"));
        clientRef.send({ type: "text", text: "queued before ping" });
      }
    },
  });
  clientRef = client;
  t.after(() => client.stop());

  assert.equal(client.state, "idle");
  assert.equal(client.isOpen, false);

  client.start();
  assert.equal(client.state, "connecting");
  assert.equal(client.isOpen, false);
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0]!;
  assert.equal(ws.url, `${WS_PREFIX}localhost:5173/live?session=order-check`);
  assert.equal(client.send({ type: "audio", data: "AAAA" }), false);
  assert.equal(client.sentAudio, 0);

  ws.serverOpen();

  assert.equal(client.state, "open");
  assert.equal(client.isOpen, true);
  assert.deepEqual(timeline, ["state:connecting", "send:start", "state:open", "send:text", "send:ping"]);
  assert.deepEqual(JSON.parse(ws.sent[0]!), makeStartMsg("fi"));
  assert.deepEqual(JSON.parse(ws.sent[1]!), { type: "text", text: "queued before ping" });
  assert.deepEqual(JSON.parse(ws.sent[2]!), { type: "ping", t: 50_000 });
  assert.equal(states[0]?.s, "connecting");
  assert.equal(states[0]?.attempt, 0);
  assert.equal(states[1]?.s, "open");
  assert.equal(states[1]?.attempt, 0);

  client.stop();
});

test("LiveClient measures ping/pong RTT via onRtt, runs 3000 ms ping interval, and ignores non-JSON messages", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  FakeWebSocket.reset();

  const received: ServerMsg[] = [];
  const rtts: number[] = [];
  const client = new LiveClient({
    session: "rtt-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: (m) => received.push(m),
    onState: () => {},
    onRtt: (rtt) => rtts.push(rtt),
  });
  t.after(() => client.stop());

  client.start();
  const ws = FakeWebSocket.instances[0]!;
  ws.serverOpen();

  assert.equal(ws.sent.length, 2);
  assert.deepEqual(JSON.parse(ws.sent[1]!), { type: "ping", t: 100_000 });

  t.mock.timers.tick(64);
  ws.serverJson({ type: "pong", t: 100_000 });
  assert.equal(client.rtt, 64);
  assert.equal(client.lastPongAt, 100_064);
  assert.deepEqual(rtts, [64]);
  assert.equal(received.length, 0);

  ws.serverJson({ type: "pong", t: 200_000 });
  assert.equal(client.rtt, 0);
  assert.deepEqual(rtts, [64, 0]);

  t.mock.timers.tick(2936);
  assert.equal(ws.sent.length, 3);
  assert.deepEqual(JSON.parse(ws.sent[2]!), { type: "ping", t: 103_000 });

  ws.serverRawMessage("{{broken-json");
  ws.serverRawMessage("");
  ws.serverRawMessage(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(received.length, 0);

  const readyMsg: ServerMsg = { type: "ready", model: "gemini-3.8-live", session: "rtt-session" };
  ws.serverJson(readyMsg);
  assert.deepEqual(received, [readyMsg]);

  client.stop();
});

test("LiveClient congested getter enforces strict 524288-byte threshold and send tracks frame and audio counters", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  FakeWebSocket.reset();

  const client = new LiveClient({
    session: "congestion-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: () => {},
    onState: () => {},
  });
  t.after(() => client.stop());

  assert.equal(client.congested, false);

  client.start();
  const ws = FakeWebSocket.instances[0]!;
  ws.serverOpen();

  ws.bufferedAmount = 0;
  assert.equal(client.congested, false);

  ws.bufferedAmount = 524288;
  assert.equal(client.congested, false);

  ws.bufferedAmount = 524289;
  assert.equal(client.congested, true);

  assert.equal(client.send({ type: "frame", data: "f1", w: 640, h: 480, sharpness: 25, ts: 1 }), true);
  assert.equal(client.sentFrames, 1);
  assert.equal(client.sentAudio, 0);

  assert.equal(client.send({ type: "audio", data: "a1" }), true);
  assert.equal(client.sentFrames, 1);
  assert.equal(client.sentAudio, 1);

  ws.throwOnSend = true;
  assert.equal(client.send({ type: "frame", data: "f2", w: 640, h: 480, sharpness: 25, ts: 2 }), false);
  assert.equal(client.sentFrames, 1);

  ws.throwOnSend = false;
  client.stop();
  assert.equal(client.congested, false);
});

test("LiveClient drops stalled connecting socket at 7000 ms connect timeout without double-counting late onclose", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 20_000 });
  FakeWebSocket.reset();

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
  });

  const states: Array<{ s: ConnState; attempt: number; nextRetryMs: number | null; reason?: string }> = [];
  const client = new LiveClient({
    session: "timeout-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: () => {},
    onState: (s, info) => states.push({ s, ...info }),
  });
  t.after(() => client.stop());

  client.start();
  const ws1 = FakeWebSocket.instances[0]!;
  assert.equal(client.state, "connecting");

  t.mock.timers.tick(6999);
  assert.equal(client.state, "connecting");
  assert.equal(ws1.closeCalls.length, 0);

  t.mock.timers.tick(1);
  assert.equal(ws1.closeCalls.length, 1);
  assert.equal(client.state, "reconnecting");
  assert.deepEqual(states[states.length - 1], {
    s: "reconnecting",
    attempt: 1,
    nextRetryMs: 500,
    reason: "Connection timed out",
  });

  ws1.serverClose(1006, "Late close after timeout");
  assert.equal(states.length, 2);

  t.mock.timers.tick(500);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.state, "reconnecting");

  client.stop();
});

test("LiveClient scheduleRetry applies exponential backoff capped at 10000 ms and resets attempt on open", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 30_000 });
  FakeWebSocket.reset();

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
  });

  const retryDelays: number[] = [];
  const client = new LiveClient({
    session: "backoff-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: () => {},
    onState: (s, info) => {
      if (s === "reconnecting" && info.nextRetryMs !== null) {
        retryDelays.push(info.nextRetryMs);
      }
    },
  });
  t.after(() => client.stop());

  client.start();
  const expectedDelays = [500, 1000, 2000, 4000, 8000, 10000, 10000];

  for (let i = 0; i < expectedDelays.length; i++) {
    const ws = FakeWebSocket.instances[i]!;
    ws.serverError();
    ws.serverClose(1006, "");
    assert.equal(retryDelays[i], expectedDelays[i]);
    if (i < expectedDelays.length - 1) {
      t.mock.timers.tick(expectedDelays[i]!);
    }
  }

  assert.deepEqual(retryDelays, expectedDelays);

  t.mock.timers.tick(10_000);
  const recoveredWs = FakeWebSocket.instances[expectedDelays.length]!;
  recoveredWs.serverOpen();
  assert.equal(client.state, "open");

  Math.random = () => 0;
  recoveredWs.serverClose(1006, "Drop after recovery");
  assert.equal(retryDelays[retryDelays.length - 1], 375);

  client.stop();
});

test("LiveClient retryNow skips backoff wait when reconnecting and ignores idle, connecting, open, or stopped states", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 40_000 });
  FakeWebSocket.reset();

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
  });

  const client = new LiveClient({
    session: "retry-now-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: () => {},
    onState: () => {},
  });
  t.after(() => client.stop());

  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 0);

  client.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 1);

  const ws1 = FakeWebSocket.instances[0]!;
  ws1.serverOpen();
  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 1);

  ws1.serverClose(1006, "Network switched");
  assert.equal(client.state, "reconnecting");
  assert.equal(FakeWebSocket.instances.length, 1);

  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 2);

  t.mock.timers.tick(5000);
  assert.equal(FakeWebSocket.instances.length, 2);

  FakeWebSocket.instances[1]!.serverOpen();
  client.stop();
  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 2);
});

test("LiveClient resendStart sends buildStart when open, calls start when !want, and calls retryNow when reconnecting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 60_000 });
  FakeWebSocket.reset();

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
  });

  let currentLang = "en";
  const client = new LiveClient({
    session: "resend-session",
    mock: false,
    buildStart: () => makeStartMsg(currentLang),
    onMessage: () => {},
    onState: () => {},
  });
  t.after(() => client.stop());

  assert.equal(client.state, "idle");
  client.resendStart();
  assert.equal(client.state, "connecting");
  assert.equal(FakeWebSocket.instances.length, 1);

  const ws1 = FakeWebSocket.instances[0]!;
  ws1.serverOpen();
  assert.equal(ws1.sent.length, 2);

  currentLang = "sv";
  client.resendStart();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(ws1.sent.length, 3);
  assert.deepEqual(JSON.parse(ws1.sent[2]!), makeStartMsg("sv"));

  ws1.serverClose(1006, "Lost Wi-Fi");
  assert.equal(client.state, "reconnecting");
  assert.equal(FakeWebSocket.instances.length, 1);

  currentLang = "fi";
  client.resendStart();
  assert.equal(FakeWebSocket.instances.length, 2);
  const ws2 = FakeWebSocket.instances[1]!;
  ws2.serverOpen();
  assert.deepEqual(JSON.parse(ws2.sent[0]!), makeStartMsg("fi"));

  client.stop();
  assert.equal(client.state, "closed");
  client.resendStart();
  assert.equal(client.state, "connecting");
  assert.equal(FakeWebSocket.instances.length, 3);

  client.stop();
});

test("LiveClient simulateDrop closes with code 4000 and reconnects, while stop sends stop event and closes code 1000 cleanly", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 70_000 });
  FakeWebSocket.reset();

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
  });

  const states: Array<{ s: ConnState; attempt: number; nextRetryMs: number | null; reason?: string }> = [];
  const client = new LiveClient({
    session: "drop-stop-session",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: () => {},
    onState: (s, info) => states.push({ s, ...info }),
  });
  t.after(() => client.stop());

  client.simulateDrop();
  assert.equal(FakeWebSocket.instances.length, 0);

  client.start();
  const ws1 = FakeWebSocket.instances[0]!;
  ws1.serverOpen();

  client.simulateDrop();
  assert.deepEqual(ws1.closeCalls, [{ code: 4000, reason: "Simulated drop" }]);
  assert.equal(client.state, "reconnecting");
  assert.deepEqual(states[states.length - 1], {
    s: "reconnecting",
    attempt: 1,
    nextRetryMs: 500,
    reason: "Simulated connection drop",
  });

  ws1.serverClose(4000, "Simulated drop");
  assert.equal(FakeWebSocket.instances.length, 1);

  t.mock.timers.tick(500);
  assert.equal(FakeWebSocket.instances.length, 2);
  const ws2 = FakeWebSocket.instances[1]!;
  ws2.serverOpen();
  assert.equal(client.state, "open");

  const sentBeforeStop = ws2.sent.length;
  client.stop();

  assert.equal(ws2.sent.length, sentBeforeStop + 1);
  assert.deepEqual(JSON.parse(ws2.sent[sentBeforeStop]!), { type: "event", name: "stop" });
  assert.deepEqual(ws2.closeCalls, [{ code: 1000, reason: "User stopped" }]);
  assert.equal(client.state, "closed");
  assert.deepEqual(states[states.length - 1], {
    s: "closed",
    attempt: 0,
    nextRetryMs: null,
    reason: "Stopped",
  });

  ws2.serverClose(1000, "User stopped");
  t.mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(ws2.sent.length, sentBeforeStop + 1);
});

test("bytesToBase64 and base64ToBytes round-trip exact binary payloads across 0x8000 chunk boundaries", () => {
  const emptyB64 = bytesToBase64(new ArrayBuffer(0));
  assert.equal(emptyB64, "");
  assert.equal(base64ToBytes(emptyB64).byteLength, 0);

  const allByteValues = new Uint8Array(256);
  for (let i = 0; i < 256; i++) allByteValues[i] = i;
  const allB64 = bytesToBase64(allByteValues.buffer);
  assert.equal(allB64, Buffer.from(allByteValues).toString("base64"));
  assert.deepEqual(base64ToBytes(allB64), allByteValues);

  for (const size of [1, 2, 3, 0x7fff, 0x8000, 0x8001, 100_000]) {
    const src = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      src[i] = (i * 131 + 17) & 0xff;
    }
    const encoded = bytesToBase64(src.buffer);
    assert.equal(encoded, Buffer.from(src).toString("base64"));
    const decoded = base64ToBytes(encoded);
    assert.equal(decoded.byteLength, size);
    assert.deepEqual(decoded, src);
  }
});

test("synthPcmChunks produces expected sample counts and click-free 400-sample fade-in and fade-out envelope", () => {
  assert.deepEqual(synthPcmChunks([]), []);

  const defaultChunks = synthPcmChunks([392, 523.25]);
  assert.equal(defaultChunks.length, 2);

  const expectedSamples = Math.round((24000 * 180) / 1000);
  assert.equal(expectedSamples, 4320);

  const rawBytes = base64ToBytes(defaultChunks[0]!);
  assert.equal(rawBytes.byteLength, expectedSamples * 2);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

  assert.equal(view.getInt16(0, true), 0);

  const maxAllowedPeak = Math.round(0.18 * 0x7fff);
  let observedPeak = 0;
  for (let i = 0; i < expectedSamples; i++) {
    const sample = Math.abs(view.getInt16(i * 2, true));
    if (sample > observedPeak) observedPeak = sample;
    if (i < 400) {
      const envBound = Math.ceil(((i / 400) * 0.18 * 0x7fff) + 1);
      assert.ok(sample <= envBound, `fade-in sample ${i} exceeded envelope bound`);
    }
    if (i > expectedSamples - 400) {
      const tailBound = Math.ceil((((expectedSamples - i) / 400) * 0.18 * 0x7fff) + 1);
      assert.ok(sample <= tailBound, `fade-out sample ${i} exceeded envelope bound`);
    }
  }
  assert.ok(observedPeak > Math.floor(maxAllowedPeak * 0.95));
  assert.ok(observedPeak <= maxAllowedPeak);

  const customChunks = synthPcmChunks([440], 100, 16000);
  assert.equal(customChunks.length, 1);
  assert.equal(base64ToBytes(customChunks[0]!).byteLength, 1600 * 2);
});

test("PcmPlayer unlock, PCM16 little-endian decoding, gapless nextTime scheduling, onPlayingChange, flush, and close", async () => {
  FakeAudioContext.reset();

  const player = new PcmPlayer(24000);
  const playingTransitions: boolean[] = [];
  player.onPlayingChange = (p) => playingTransitions.push(p);

  assert.equal(player.context, null);
  assert.equal(player.playing, false);

  const sampleValues = new Int16Array([-32768, -16384, 0, 16384, 32767]);
  const sampleB64 = bytesToBase64(sampleValues.buffer);
  player.enqueue(sampleB64);
  assert.equal(player.playing, false);

  await player.unlock();
  assert.equal(FakeAudioContext.instances.length, 1);
  const ctx = FakeAudioContext.instances[0]!;
  assert.equal(ctx.state, "running");
  assert.equal(ctx.resumeCount, 1);
  assert.equal(ctx.gains.length, 1);
  assert.deepEqual(ctx.gains[0]!.connectedTo, [ctx.destination]);

  ctx.state = "suspended";
  await player.unlock();
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.equal(ctx.resumeCount, 2);

  player.enqueue("");
  player.enqueue(bytesToBase64(new Uint8Array([0x42]).buffer));
  assert.equal(ctx.sources.length, 0);
  assert.deepEqual(playingTransitions, []);

  ctx.currentTime = 10.0;
  player.enqueue(sampleB64);
  assert.equal(player.playing, true);
  assert.deepEqual(playingTransitions, [true]);
  assert.equal(ctx.buffers.length, 1);
  assert.equal(ctx.buffers[0]!.sampleRate, 24000);
  assert.equal(ctx.buffers[0]!.length, 5);

  const ch = ctx.buffers[0]!.getChannelData(0);
  assert.equal(ch[0], -1);
  assert.equal(ch[1], -0.5);
  assert.equal(ch[2], 0);
  assert.equal(ch[3], 0.5);
  assert.ok(Math.abs(ch[4]! - 32767 / 32768) < 1e-6);

  const chunk2400 = bytesToBase64(new Int16Array(2400).buffer);
  player.flush();
  assert.equal(player.playing, false);
  assert.deepEqual(playingTransitions, [true, false]);

  ctx.currentTime = 20.0;
  player.enqueue(chunk2400);
  const s1 = ctx.sources[1]!;
  assert.ok(Math.abs(s1.startedAt[0]! - 20.06) < 1e-9);
  assert.deepEqual(playingTransitions, [true, false, true]);

  ctx.currentTime = 20.03;
  player.enqueue(chunk2400);
  const s2 = ctx.sources[2]!;
  assert.ok(Math.abs(s2.startedAt[0]! - 20.16) < 1e-9);

  ctx.currentTime = 20.05;
  player.enqueue(chunk2400);
  const s3 = ctx.sources[3]!;
  assert.ok(Math.abs(s3.startedAt[0]! - 20.26) < 1e-9);
  assert.deepEqual(playingTransitions, [true, false, true]);

  s1.onended?.();
  assert.equal(player.playing, true);
  assert.deepEqual(playingTransitions, [true, false, true]);

  s2.onended?.();
  s3.onended?.();
  assert.equal(player.playing, false);
  assert.deepEqual(playingTransitions, [true, false, true, false]);

  ctx.currentTime = 30.0;
  player.enqueue(chunk2400);
  player.enqueue(chunk2400);
  const barge1 = ctx.sources[4]!;
  const barge2 = ctx.sources[5]!;
  assert.ok(Math.abs(barge1.startedAt[0]! - 30.06) < 1e-9);
  assert.equal(player.playing, true);

  player.flush();
  assert.equal(barge1.stopCount, 1);
  assert.equal(barge1.disconnectCount, 1);
  assert.equal(barge1.onended, null);
  assert.equal(barge2.stopCount, 1);
  assert.equal(barge2.disconnectCount, 1);
  assert.equal(barge2.onended, null);
  assert.equal(player.playing, false);
  assert.deepEqual(playingTransitions, [true, false, true, false, true, false]);

  player.flush();
  assert.deepEqual(playingTransitions, [true, false, true, false, true, false]);

  player.enqueue(chunk2400);
  await player.close();
  assert.equal(ctx.closeCount, 1);
  assert.equal(ctx.state, "closed");
  assert.equal(player.context, null);
  assert.equal(player.playing, false);
});

test("MicCapture prime, single worklet load, zero-gain sink isolation, onChunk forwarding, and stop(true) vs stop(false)", async () => {
  FakeAudioContext.reset();

  const captured: Array<{ b64: string; rms: number }> = [];
  const mic = new MicCapture((b64, rms) => captured.push({ b64, rms }));

  assert.equal(mic.active, false);
  assert.equal(mic.label, "");
  assert.equal(mic.chunks, 0);
  assert.equal(mic.level, 0);

  mic.prime();
  assert.equal(FakeAudioContext.instances.length, 1);
  const ctx1 = FakeAudioContext.instances[0]!;
  assert.equal(ctx1.resumeCount, 1);
  assert.equal(ctx1.state, "running");

  const { stream: stream1, tracks: tracks1 } = makeFakeStream(["Ray-Ban Meta Mic"]);
  await mic.start(stream1);

  assert.equal(FakeAudioContext.instances.length, 1);
  assert.deepEqual(ctx1.addModuleCalls, ["/pcm-capture-worklet.js"]);
  assert.equal(FakeAudioWorkletNode.instances.length, 1);
  const node1 = FakeAudioWorkletNode.instances[0]!;
  assert.equal(node1.name, "pcm-capture");
  assert.deepEqual(node1.options, { processorOptions: { outRate: 16000, chunkMs: 100 } });

  assert.equal(ctx1.mediaSources.length, 1);
  assert.deepEqual(ctx1.mediaSources[0]!.connectedTo, [node1]);

  assert.equal(ctx1.gains.length, 1);
  const sink1 = ctx1.gains[0]!;
  assert.equal(sink1.gain.value, 0);
  assert.equal((node1.connectedTo as unknown[]).includes(ctx1.destination), false);
  assert.deepEqual(node1.connectedTo, [sink1]);
  assert.deepEqual(sink1.connectedTo, [ctx1.destination]);

  assert.equal(mic.active, true);
  assert.equal(mic.label, "Ray-Ban Meta Mic");

  const pcmSamples = new Int16Array([100, -200, 300, -400]);
  node1.emitChunk(pcmSamples.buffer, 0.125);
  assert.equal(mic.chunks, 1);
  assert.equal(mic.level, 0.125);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.rms, 0.125);
  assert.deepEqual(base64ToBytes(captured[0]!.b64), new Uint8Array(pcmSamples.buffer));

  await mic.stop(true);
  assert.equal(mic.active, false);
  assert.equal(mic.level, 0);
  assert.equal(tracks1[0]!.stopCount, 1);
  assert.equal(ctx1.mediaSources[0]!.disconnectCount, 1);
  assert.equal(node1.disconnectCount, 1);
  assert.equal(node1.port.closeCount, 1);
  assert.equal(ctx1.closeCount, 0);
  assert.equal(ctx1.state, "running");

  const { stream: stream2, tracks: tracks2 } = makeFakeStream(["Phone Built-In Mic"]);
  await mic.start(stream2);
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.deepEqual(ctx1.addModuleCalls, ["/pcm-capture-worklet.js"]);
  assert.equal(FakeAudioWorkletNode.instances.length, 2);
  assert.equal(mic.active, true);
  assert.equal(mic.label, "Phone Built-In Mic");

  await mic.stop(false);
  assert.equal(mic.active, false);
  assert.equal(tracks2[0]!.stopCount, 1);
  assert.equal(ctx1.closeCount, 1);
  assert.equal(ctx1.state, "closed");

  const { stream: stream3 } = makeFakeStream(["Glasses Swap Mic"]);
  await mic.start(stream3);
  assert.equal(FakeAudioContext.instances.length, 2);
  const ctx2 = FakeAudioContext.instances[1]!;
  assert.deepEqual(ctx2.addModuleCalls, ["/pcm-capture-worklet.js"]);
  await mic.stop(false);
  assert.equal(ctx2.closeCount, 1);
});

test("LiveClient handles synchronous WebSocket constructor throw, ignores stale socket events, and formats close reasons", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 80_000 });
  FakeWebSocket.reset();
  FakeWebSocket.throwOnConstruct = true;

  const origRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = origRandom;
    FakeWebSocket.reset();
  });

  const received: ServerMsg[] = [];
  const states: Array<{ s: ConnState; attempt: number; nextRetryMs: number | null; reason?: string }> = [];
  const client = new LiveClient({
    session: "ctor-and-stale",
    mock: false,
    buildStart: () => makeStartMsg(),
    onMessage: (m) => received.push(m),
    onState: (s, info) => states.push({ s, ...info }),
  });
  t.after(() => client.stop());

  client.start();
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(client.state, "reconnecting");
  assert.deepEqual(states, [
    { s: "connecting", attempt: 0, nextRetryMs: null, reason: undefined },
    { s: "reconnecting", attempt: 1, nextRetryMs: 500, reason: "Error: WebSocket constructor blocked" },
  ]);

  FakeWebSocket.throwOnConstruct = false;
  t.mock.timers.tick(500);
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws1 = FakeWebSocket.instances[0]!;
  ws1.serverOpen();
  assert.equal(client.state, "open");

  client.simulateDrop();
  client.retryNow();
  assert.equal(FakeWebSocket.instances.length, 2);
  const ws2 = FakeWebSocket.instances[1]!;

  ws1.serverOpen();
  ws1.serverJson({ type: "ready", model: "stale-model", session: "ctor-and-stale" });
  ws1.serverClose(1006, "Stale close");
  assert.equal(client.state, "reconnecting");
  assert.equal(received.length, 0);

  ws2.serverOpen();
  assert.equal(client.state, "open");

  ws2.serverClose(1006, "");
  assert.equal(states[states.length - 1]?.reason, "Connection lost (1006)");

  client.retryNow();
  const ws3 = FakeWebSocket.instances[2]!;
  ws3.serverOpen();
  ws3.serverClose(1000, "");
  assert.equal(states[states.length - 1]?.reason, "Closed");

  client.retryNow();
  const ws4 = FakeWebSocket.instances[3]!;
  ws4.serverOpen();
  ws4.serverClose(1012, "Gateway restarting");
  assert.equal(states[states.length - 1]?.reason, "Gateway restarting");

  client.stop();
});

test("MicCapture hot mic-swap reuses context and reflects ended Bluetooth track, while PcmPlayer handles odd bytes and underruns", async () => {
  FakeAudioContext.reset();

  const mic = new MicCapture(() => {});
  const { stream: phoneStream, tracks: phoneTracks } = makeFakeStream(["Phone Mic"]);
  await mic.start(phoneStream);
  assert.equal(mic.active, true);
  assert.equal(mic.label, "Phone Mic");
  const ctx = FakeAudioContext.instances[0]!;
  const firstNode = FakeAudioWorkletNode.instances[0]!;

  const { stream: glassesStream, tracks: glassesTracks } = makeFakeStream(["Ray-Ban Bluetooth Hands-Free"]);
  await mic.start(glassesStream);
  assert.equal(phoneTracks[0]!.stopCount, 1);
  assert.equal(firstNode.disconnectCount, 1);
  assert.equal(firstNode.port.closeCount, 1);
  assert.equal(FakeAudioContext.instances.length, 1);
  assert.deepEqual(ctx.addModuleCalls, ["/pcm-capture-worklet.js"]);
  assert.equal(mic.active, true);
  assert.equal(mic.label, "Ray-Ban Bluetooth Hands-Free");

  glassesTracks[0]!.stop();
  assert.equal(mic.active, false);
  await mic.stop(false);

  FakeAudioContext.reset();
  const player = new PcmPlayer(24000);
  await player.unlock();
  const pCtx = FakeAudioContext.instances[0]!;

  const oddFiveBytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff]);
  pCtx.currentTime = 5.0;
  player.enqueue(bytesToBase64(oddFiveBytes.buffer));
  assert.equal(pCtx.buffers.length, 1);
  assert.equal(pCtx.buffers[0]!.length, 2);
  assert.equal(pCtx.buffers[0]!.getChannelData(0)[0], 0.5);
  assert.equal(pCtx.buffers[0]!.getChannelData(0)[1], -0.5);
  assert.ok(Math.abs(pCtx.sources[0]!.startedAt[0]! - 5.06) < 1e-9);

  pCtx.currentTime = 12.0;
  const chunk2400 = bytesToBase64(new Int16Array(2400).buffer);
  player.enqueue(chunk2400);
  assert.ok(Math.abs(pCtx.sources[1]!.startedAt[0]! - 12.06) < 1e-9);

  await player.close();
});

test("pcm-capture AudioWorkletProcessor downmixes stereo 48 kHz to 16 kHz 100 ms Int16 chunks with clamping and RMS", () => {
  const workletSource = readFileSync(new URL("../public/pcm-capture-worklet.js", import.meta.url), "utf8");

  type PostedChunk = { pcm: ArrayBuffer; rms: number };
  type WorkletInstance = {
    port: { postMessage: (msg: PostedChunk, transfer?: Transferable[]) => void };
    process: (inputs: Float32Array[][]) => boolean;
  };
  type WorkletCtor = new (options?: { processorOptions?: { outRate?: number; chunkMs?: number } }) => WorkletInstance;

  let registeredName = "";
  let RegisteredCtor: WorkletCtor | null = null;
  const posted: PostedChunk[] = [];

  class BaseWorkletProcessor {
    port = {
      postMessage(msg: PostedChunk) {
        posted.push(msg);
      },
    };
  }

  runInNewContext(workletSource, {
    AudioWorkletProcessor: BaseWorkletProcessor,
    sampleRate: 48000,
    Float32Array,
    Int16Array,
    Math,
    registerProcessor(name: string, ctor: WorkletCtor) {
      registeredName = name;
      RegisteredCtor = ctor;
    },
  });

  assert.equal(registeredName, "pcm-capture");
  assert.ok(RegisteredCtor);
  const Ctor = RegisteredCtor as WorkletCtor;

  const cancelProc = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  assert.equal(cancelProc.process([]), true);
  assert.equal(cancelProc.process([[]]), true);
  assert.equal(posted.length, 0);

  const left = new Float32Array(128).fill(0.5);
  const right = new Float32Array(128).fill(-0.5);
  for (let b = 0; b < 38; b++) {
    assert.equal(cancelProc.process([[left, right]]), true);
  }
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.pcm.byteLength, 1600 * 2);
  assert.equal(posted[0]!.rms, 0);
  const zeroSamples = new Int16Array(posted[0]!.pcm);
  assert.equal(zeroSamples.length, 1600);
  assert.ok(zeroSamples.every((v) => v === 0));

  posted.length = 0;
  const clipPosProc = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  const overPos = new Float32Array(4804).fill(1.75);
  clipPosProc.process([[overPos]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.rms, 1);
  const maxPosSamples = new Int16Array(posted[0]!.pcm);
  assert.equal(maxPosSamples.length, 1600);
  assert.ok(maxPosSamples.every((v) => v === 0x7fff));

  posted.length = 0;
  const clipNegProc = new Ctor({ processorOptions: { outRate: 16000, chunkMs: 100 } });
  const overNeg = new Float32Array(4804).fill(-1.75);
  clipNegProc.process([[overNeg]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.rms, 1);
  const maxNegSamples = new Int16Array(posted[0]!.pcm);
  assert.equal(maxNegSamples.length, 1600);
  assert.ok(maxNegSamples.every((v) => v === -0x8000));
});
