import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientMsg, CoachCue, Profile, ServerMsg, Verdict, VerdictLevel } from "../../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHRASES_MANIFEST = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../public/phrases/manifest.json"), "utf8"),
) as { phrases: Record<string, Record<string, { file: string; text: string }>> };

type ListenerFn = (...args: unknown[]) => unknown;

function makeEventMap() {
  const map = new Map<string, Set<ListenerFn>>();
  return {
    add(type: string, fn: ListenerFn) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(fn);
    },
    remove(type: string, fn: ListenerFn) {
      map.get(type)?.delete(fn);
    },
    async emit(type: string, ev: unknown = {}) {
      const fns = Array.from(map.get(type) ?? []);
      for (const fn of fns) await fn(ev);
    },
    clear() {
      map.clear();
    },
  };
}

function createStorage(): Storage {
  const proto = {
    get length(): number {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  const store = Object.create(proto) as Record<string, string> & Storage;
  return store;
}

type MockTrack = {
  kind: "video" | "audio";
  label: string;
  readyState: "live" | "ended";
  stopCalls: number;
  stop: () => void;
  addEventListener: (type: string, fn: ListenerFn) => void;
  removeEventListener: (type: string, fn: ListenerFn) => void;
  triggerEnded: () => Promise<void>;
};

function createMockTrack(kind: "video" | "audio", label: string): MockTrack {
  const events = makeEventMap();
  const track: MockTrack = {
    kind,
    label,
    readyState: "live",
    stopCalls: 0,
    stop() {
      track.stopCalls++;
      track.readyState = "ended";
    },
    addEventListener(type: string, fn: ListenerFn) {
      events.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      events.remove(type, fn);
    },
    async triggerEnded() {
      track.readyState = "ended";
      await events.emit("ended", { type: "ended" });
    },
  };
  return track;
}

type MockStream = MediaStream & {
  videoTracks: MockTrack[];
  audioTracks: MockTrack[];
};

function createMockStream(videoTracks: MockTrack[], audioTracks: MockTrack[]): MockStream {
  return {
    getTracks: () => [...videoTracks, ...audioTracks] as unknown as MediaStreamTrack[],
    getVideoTracks: () => videoTracks as unknown as MediaStreamTrack[],
    getAudioTracks: () => audioTracks as unknown as MediaStreamTrack[],
    videoTracks,
    audioTracks,
  } as unknown as MockStream;
}

type FetchRecord = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type FetchReply = {
  status?: number;
  statusText?: string;
  json?: unknown;
  networkError?: boolean;
};

type AudioParamCall = {
  method: "setValueAtTime" | "linearRampToValueAtTime" | "exponentialRampToValueAtTime" | "setTargetAtTime";
  value: number;
  time: number;
};

class MockAudioParam {
  value: number;
  calls: AudioParamCall[] = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  setValueAtTime(value: number, startTime: number) {
    this.value = value;
    this.calls.push({ method: "setValueAtTime", value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number) {
    this.value = value;
    this.calls.push({ method: "linearRampToValueAtTime", value, time: endTime });
  }

  exponentialRampToValueAtTime(value: number, endTime: number) {
    this.value = value;
    this.calls.push({ method: "exponentialRampToValueAtTime", value, time: endTime });
  }

  setTargetAtTime(value: number, startTime: number) {
    this.value = value;
    this.calls.push({ method: "setTargetAtTime", value, time: startTime });
  }

  cancelScheduledValues() {}
}

class MockGainNode {
  gain = new MockAudioParam(1);
  connectedTo: unknown[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  disconnect() {}
}

class MockOscillatorNode {
  type: OscillatorType = "sine";
  frequency = new MockAudioParam(440);
  connectedTo: unknown[] = [];
  startedAt: number[] = [];
  stoppedAt: number[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }

  start(when = 0) {
    this.startedAt.push(when);
  }

  stop(when = 0) {
    this.stoppedAt.push(when);
  }

  disconnect() {}
}

type MockBufferSource = {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect: (dest: unknown) => unknown;
  start: (when?: number) => void;
  stop: (when?: number) => void;
  disconnect: () => void;
};

class MockAudioWorkletNode {
  port: {
    onmessage: ((ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => void) | null;
    close: () => void;
    closed: boolean;
  };

  constructor(_ctx: unknown, _name: string, _opts?: unknown) {
    this.port = {
      onmessage: null,
      closed: false,
      close: () => {
        this.port.closed = true;
      },
    };
    env.workletNodes.push(this);
  }

  connect(dest: unknown) {
    return dest;
  }

  disconnect() {}

  emitChunk(samples: Int16Array, rms: number) {
    const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
    this.port.onmessage?.({ data: { pcm, rms } } as MessageEvent<{ pcm: ArrayBuffer; rms: number }>);
  }
}

class MockAudioContext {
  state: AudioContextState = "suspended";
  currentTime = 3.5;
  destination = { kind: "destination" };
  resumeCount = 0;
  oscillators: MockOscillatorNode[] = [];
  gains: MockGainNode[] = [];
  audioWorklet = {
    addModule: async (_url: string) => {
      env.workletModulesLoaded++;
    },
  };

  constructor() {
    env.audioContexts.push(this);
  }

  async resume() {
    this.resumeCount++;
    if (this.state !== "closed") this.state = "running";
  }

  async close() {
    this.state = "closed";
  }

  createGain(): GainNode {
    const g = new MockGainNode();
    this.gains.push(g);
    env.gains.push(g);
    return g as unknown as GainNode;
  }

  createOscillator(): OscillatorNode {
    const o = new MockOscillatorNode();
    this.oscillators.push(o);
    env.oscillators.push(o);
    return o as unknown as OscillatorNode;
  }

  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 1200 },
      connect(dest: unknown) {
        return dest;
      },
    };
  }

  createMediaStreamSource(_stream: MediaStream) {
    return {
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;
  }

  createBufferSource(): MockBufferSource {
    const src: MockBufferSource = {
      buffer: null,
      onended: null,
      started: false,
      stopped: false,
      connect(dest: unknown) {
        return dest;
      },
      start() {
        src.started = true;
      },
      stop() {
        src.stopped = true;
      },
      disconnect() {},
    };
    env.bufferSources.push(src);
    return src;
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: ClientMsg[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;

  constructor(url: string) {
    this.url = url;
    env.sockets.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket not open");
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
  }

  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({ type: "open" } as Event);
  }

  serverSend(msg: ServerMsg | { type: "pong"; t: number }) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  postMessage() {}
  close() {}
  unref() {
    return this;
  }
}

class MockBarcodeDetector {
  static async getSupportedFormats() {
    return ["ean_13", "data_matrix", "qr_code"];
  }
  async detect() {
    return [];
  }
}

class MockSpeechUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;
  constructor(text = "") {
    this.text = text;
  }
}

class MockMediaMetadata {
  title: string;
  artist: string;
  album: string;
  constructor(init: { title?: string; artist?: string; album?: string } = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
  }
}

class MockAudioElement {
  src: string;
  loop = false;
  paused = true;
  volume = 1;
  currentTime = 0;
  preload = "auto";
  playCalls = 0;
  pauseCalls = 0;
  onended: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private events = makeEventMap();

  constructor(src = "") {
    this.src = src;
    env.audioElements.push(this);
  }

  addEventListener(type: string, fn: ListenerFn) {
    this.events.add(type, fn);
  }

  removeEventListener(type: string, fn: ListenerFn) {
    this.events.remove(type, fn);
  }

  load() {}

  async play() {
    this.playCalls++;
    if (this.src.includes("/phrases/") && !env.allowPhraseAudio) {
      const err = new Error("Phrase audio unavailable");
      this.onerror?.(err);
      await this.events.emit("error", err);
      throw err;
    }
    this.paused = false;
    if (this.src.includes("/phrases/")) {
      env.playedPhraseUrls.push(this.src);
    }
  }

  pause() {
    this.pauseCalls++;
    this.paused = true;
  }
}

function createMockCanvas() {
  return {
    width: 160,
    height: 120,
    getContext() {
      return {
        drawImage() {},
        getImageData(_x: number, _y: number, w: number, h: number) {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            const v = (i / 4) % 2 === 0 ? 40 : 0;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
          }
          return { data };
        },
      };
    },
    toDataURL() {
      return "data:image/jpeg;base64,cGhvbmUtZnJhbWU=";
    },
  };
}

const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join("/");
const persistentObjectBlobs = new Map<string, Blob>();
let objectUrlCreateCount = 0;

const origCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (obj: Blob | MediaSource): string => {
  objectUrlCreateCount++;
  const url = origCreateObjectURL(obj as Blob);
  if (obj instanceof Blob) {
    persistentObjectBlobs.set(url, obj);
  }
  return url;
};

type SpeechEvent =
  | { kind: "cancel" }
  | { kind: "speak"; text: string; lang: string; rate: number; volume: number };

const env = {
  windowEvents: makeEventMap(),
  docEvents: makeEventMap(),
  mediaDeviceEvents: makeEventMap(),
  online: true,
  visibilityState: "visible" as "visible" | "hidden",
  sockets: [] as MockWebSocket[],
  fetchCalls: [] as FetchRecord[],
  verifyReply: (_body: unknown): FetchReply => ({ status: 200, json: makeSampleVerdict() }),
  allowPhraseAudio: true,
  playedPhraseUrls: [] as string[],
  audioElements: [] as MockAudioElement[],
  lastCameraStream: null as MockStream | null,
  lastMicStream: null as MockStream | null,
  cameraStarts: 0,
  micStarts: 0,
  micTrackLabel: "Ray-Ban Meta Hands-Free",
  enumerateDevicesError: false,
  devices: [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta Hands-Free" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[],
  speechEvents: [] as SpeechEvent[],
  spoken: [] as string[],
  vibrations: [] as Array<number | number[]>,
  audioContexts: [] as MockAudioContext[],
  oscillators: [] as MockOscillatorNode[],
  gains: [] as MockGainNode[],
  workletNodes: [] as MockAudioWorkletNode[],
  workletModulesLoaded: 0,
  bufferSources: [] as MockBufferSource[],
  mediaSessionHandlers: new Map<string, () => void>(),
};

const mediaSessionObj = {
  metadata: null as MockMediaMetadata | null,
  playbackState: "none" as MediaSessionPlaybackState,
  setActionHandler(action: string, handler: (() => void) | null) {
    if (handler) env.mediaSessionHandlers.set(action, handler);
    else env.mediaSessionHandlers.delete(action);
  },
};

function installGlobals() {
  const local = createStorage();
  const session = createStorage();

  const cachesObj = {
    async keys() {
      return [] as string[];
    },
    async delete() {
      return false;
    },
  };

  const navigatorObj = {
    get onLine() {
      return env.online;
    },
    language: "en-GB",
    userAgent: "Mozilla/5.0 (Linux; Android 15)",
    vibrate(pattern: number | number[]) {
      env.vibrations.push(Array.isArray(pattern) ? [...pattern] : pattern);
      return true;
    },
    mediaDevices: {
      async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
        if (constraints.video) {
          env.cameraStarts++;
          const stream = createMockStream([createMockTrack("video", "Back Camera")], []);
          env.lastCameraStream = stream;
          return stream;
        }
        env.micStarts++;
        const stream = createMockStream([], [createMockTrack("audio", env.micTrackLabel)]);
        env.lastMicStream = stream;
        return stream;
      },
      async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        if (env.enumerateDevicesError) throw new Error("enumerateDevices failed");
        return env.devices;
      },
      addEventListener(type: string, fn: ListenerFn) {
        env.mediaDeviceEvents.add(type, fn);
      },
      removeEventListener(type: string, fn: ListenerFn) {
        env.mediaDeviceEvents.remove(type, fn);
      },
    },
    mediaSession: mediaSessionObj,
  };

  const documentObj = {
    get visibilityState() {
      return env.visibilityState;
    },
    addEventListener(type: string, fn: ListenerFn) {
      env.docEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      env.docEvents.remove(type, fn);
    },
    createElement() {
      return createMockCanvas();
    },
  };

  const locationObj = {
    protocol: "https:",
    host: "holdup.example",
    origin: ORIGIN_HTTPS,
    pathname: "/",
    search: "",
    hash: "",
  };

  const historyObj = {
    state: null,
    replaceState() {},
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = rawUrl.startsWith(ORIGIN_HTTPS) ? rawUrl.slice(ORIGIN_HTTPS.length) || "/" : rawUrl;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let rawBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        rawBody = JSON.parse(init.body);
      } catch {
        rawBody = init.body;
      }
    }
    env.fetchCalls.push({ url, method, headers, body: rawBody });

    const reply: FetchReply =
      url === "/api/health"
        ? { status: 200, json: { ok: true, gemini: "ok" } }
        : url === "/api/stats"
          ? { status: 200, json: { calls: 0 } }
          : url === "/api/verify"
            ? env.verifyReply(rawBody)
            : url === "/phrases/manifest.json"
              ? { status: 200, json: PHRASES_MANIFEST }
              : { status: 404, statusText: "Not Found", json: { message: "Not Found" } };

    if (reply.networkError) throw new TypeError("Failed to fetch");
    const status = reply.status ?? 200;
    const statusText = reply.statusText ?? (status === 200 ? "OK" : "Error");
    const bodyJson = reply.json ?? {};
    const bodyText = JSON.stringify(bodyJson);
    const makeRes = (): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: new Headers({ "content-type": "application/json" }),
        async json() {
          return bodyJson;
        },
        async text() {
          return bodyText;
        },
        clone() {
          return makeRes();
        },
      }) as unknown as Response;
    return makeRes();
  };

  const windowObj = {
    isSecureContext: true,
    AudioContext: MockAudioContext,
    Audio: MockAudioElement,
    WebSocket: MockWebSocket,
    SpeechSynthesisUtterance: MockSpeechUtterance,
    BarcodeDetector: MockBarcodeDetector,
    BroadcastChannel: MockBroadcastChannel,
    fetch: fetchImpl,
    speechSynthesis: {
      speak(u: MockSpeechUtterance) {
        env.speechEvents.push({
          kind: "speak",
          text: u.text,
          lang: u.lang,
          rate: u.rate,
          volume: u.volume,
        });
        if (u.volume > 0 && u.text.trim()) env.spoken.push(u.text);
      },
      cancel() {
        env.speechEvents.push({ kind: "cancel" });
      },
    },
    caches: cachesObj,
    addEventListener(type: string, fn: ListenerFn) {
      env.windowEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      env.windowEvents.remove(type, fn);
    },
  };

  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: navigatorObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: documentObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: windowObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: locationObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "history", { value: historyObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "caches", { value: cachesObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "WebSocket", { value: MockWebSocket, configurable: true, writable: true });
  Object.defineProperty(globalThis, "fetch", { value: fetchImpl, configurable: true, writable: true });
  Object.defineProperty(globalThis, "AudioContext", { value: MockAudioContext, configurable: true, writable: true });
  Object.defineProperty(globalThis, "AudioWorkletNode", { value: MockAudioWorkletNode, configurable: true, writable: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: MockBroadcastChannel, configurable: true, writable: true });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { value: MockSpeechUtterance, configurable: true, writable: true });
  Object.defineProperty(globalThis, "MediaMetadata", { value: MockMediaMetadata, configurable: true, writable: true });
  Object.defineProperty(globalThis, "Audio", { value: MockAudioElement, configurable: true, writable: true });
}

installGlobals();

const { Checker } = await import("../src/lib/checker.ts");
const { earcon, earconForVerdict, haptic, onAnnounce, speak, stopSpeaking, unlockFeedback } = await import("../src/lib/feedback.ts");
const { audioRoute } = await import("../src/lib/media.ts");
const { setAccessKey } = await import("../src/lib/key.ts");
const { demoProfile, loadSettings, saveProfile, saveSettings } = await import("../src/lib/storage.ts");

unlockFeedback();
const feedbackAudioCtx = env.audioContexts[0];

function makeSampleVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "match",
    headline: "Amlodipine 5 mg",
    speech: "Yes, Amlodipine 5 mg, your evening pill.",
    matchedMedId: "amlodipine",
    takenToday: false,
    reasons: ["Matches your list"],
    read: {
      kind: "medication",
      product: { value: "Amlodipine", confidence: 0.98 },
      ingredient: { value: "amlodipine", confidence: 0.95 },
      strength: { value: "5 mg", confidence: 0.96 },
      dosing: { value: null, confidence: 0 },
      expiry: { value: "2028-06", confidence: 0.9 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: "6416542002149", confidence: 0.99 },
      readability: 0.94,
    },
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 14) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function approxEqual(actual: number, expected: number, eps = 1e-9, msg = "approxEqual") {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const BASE_NOW = 1_763_180_000_000;

type Announcement = { msg: string; politeness: "polite" | "assertive" };

function setupTestEnv(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW });

  env.windowEvents.clear();
  env.docEvents.clear();
  env.mediaDeviceEvents.clear();
  env.online = true;
  env.visibilityState = "visible";
  env.sockets = [];
  env.fetchCalls = [];
  env.verifyReply = () => ({ status: 200, json: makeSampleVerdict() });
  env.allowPhraseAudio = true;
  env.playedPhraseUrls = [];
  env.audioElements = [];
  env.lastCameraStream = null;
  env.lastMicStream = null;
  env.cameraStarts = 0;
  env.micStarts = 0;
  env.micTrackLabel = "Ray-Ban Meta Hands-Free";
  env.enumerateDevicesError = false;
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta Hands-Free" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[];
  env.speechEvents = [];
  env.spoken = [];
  env.vibrations = [];
  env.oscillators = [];
  env.gains = [];
  env.workletNodes = [];
  env.workletModulesLoaded = 0;
  env.bufferSources = [];
  env.mediaSessionHandlers.clear();
  mediaSessionObj.metadata = null;
  mediaSessionObj.playbackState = "none";

  localStorage.clear();
  sessionStorage.clear();
  setAccessKey("");

  const announcements: Announcement[] = [];
  const offAnnounce = onAnnounce((msg, politeness) => {
    announcements.push({ msg, politeness });
  });

  const checkers: Array<InstanceType<typeof Checker>> = [];
  const createChecker = () => {
    const c = new Checker();
    checkers.push(c);
    return c;
  };

  t.after(async () => {
    offAnnounce();
    for (const c of checkers) c.dispose();
    await flushMicrotasks();
  });

  return { announcements, createChecker };
}

test("MediaSession temple-tap lifecycle: silentWavUrl generates exact 8044-byte 8 kHz mono 8-bit PCM silence WAV and sets metadata, playbackState, and handlers", async (t) => {
  const { createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses" });

  const checker = createChecker();
  await flushMicrotasks();

  const createCallsBefore = objectUrlCreateCount;
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  assert.equal(objectUrlCreateCount, createCallsBefore + 1);
  assert.equal(env.audioElements.length, 1);

  const silentAudio = env.audioElements[0];
  assert.equal(silentAudio.loop, true);
  assert.equal(silentAudio.paused, false);
  assert.equal(silentAudio.playCalls, 1);
  assert.ok(silentAudio.src.startsWith("blob:"));

  const wavBlob = persistentObjectBlobs.get(silentAudio.src);
  assert.ok(wavBlob);
  assert.equal(wavBlob.type, "audio/wav");
  assert.equal(wavBlob.size, 44 + 8000);

  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
  assert.equal(wavBytes.byteLength, 8044);
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);

  assert.equal(asciiAt(wavBytes, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 8000);
  assert.equal(asciiAt(wavBytes, 8, 8), "WAVEfmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint32(28, true), 8000);
  assert.equal(view.getUint16(32, true), 1);
  assert.equal(view.getUint16(34, true), 8);
  assert.equal(asciiAt(wavBytes, 36, 4), "data");
  assert.equal(view.getUint32(40, true), 8000);

  let nonSilentSampleCount = 0;
  for (let i = 0; i < 8000; i++) {
    if (wavBytes[44 + i] !== 128) nonSilentSampleCount++;
  }
  assert.equal(nonSilentSampleCount, 0);

  assert.ok(mediaSessionObj.metadata);
  assert.equal(mediaSessionObj.metadata.title, "HoldUp check");
  assert.equal(mediaSessionObj.metadata.artist, "Tap to check or stop");
  assert.equal(mediaSessionObj.metadata.album, "HoldUp");
  assert.equal(mediaSessionObj.playbackState, "playing");

  assert.equal(typeof env.mediaSessionHandlers.get("play"), "function");
  assert.equal(typeof env.mediaSessionHandlers.get("pause"), "function");
  assert.equal(typeof env.mediaSessionHandlers.get("stop"), "function");
  assert.equal(env.mediaSessionHandlers.get("play"), env.mediaSessionHandlers.get("pause"));

  await checker.stop();
  assert.equal(silentAudio.paused, true);
  assert.equal(mediaSessionObj.playbackState, "paused");

  await checker.start();
  assert.equal(objectUrlCreateCount, createCallsBefore + 1);
  assert.equal(env.audioElements.length, 1);
  assert.equal(silentAudio.paused, false);
  assert.equal(mediaSessionObj.playbackState, "playing");
});

test("MediaSession temple-tap play, pause, and stop handlers drive primary() across live, glasses snapshot, and stopped states", async (t) => {
  const { createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses" });

  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  env.sockets[0].serverOpen();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().source, "glasses");
  assert.equal(mediaSessionObj.playbackState, "playing");

  const playHandler = env.mediaSessionHandlers.get("play");
  const pauseHandler = env.mediaSessionHandlers.get("pause");
  const stopHandler = env.mediaSessionHandlers.get("stop");
  assert.ok(playHandler && pauseHandler && stopHandler);

  pauseHandler();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
  assert.equal(mediaSessionObj.playbackState, "paused");

  playHandler();
  await flushMicrotasks();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "live");
  assert.equal(mediaSessionObj.playbackState, "playing");

  playHandler();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
  assert.equal(mediaSessionObj.playbackState, "paused");

  pauseHandler();
  await flushMicrotasks();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "live");
  assert.equal(mediaSessionObj.playbackState, "playing");

  checker.toggleSnapshotMode();
  assert.equal(checker.get().mode, "snapshot");
  assert.equal(checker.get().source, "glasses");

  env.fetchCalls = [];
  pauseHandler();
  await flushMicrotasks();

  assert.equal(checker.get().running, true);
  assert.equal(checker.get().verdictVia, "snapshot");
  assert.equal(checker.get().verdict?.matchedMedId, "amlodipine");
  const verifyCallsAfterPause = env.fetchCalls.filter((c) => c.url === "/api/verify");
  assert.equal(verifyCallsAfterPause.length, 1);
  const pauseBody = verifyCallsAfterPause[0].body as { frames?: string[]; session?: string };
  assert.deepEqual(pauseBody.frames ?? [], []);
  assert.equal("frames" in (verifyCallsAfterPause[0].body as Record<string, unknown>), false);
  assert.equal(pauseBody.session, checker.get().session);

  checker.dismissVerdict();
  env.fetchCalls = [];
  playHandler();
  await flushMicrotasks();

  assert.equal(checker.get().running, true);
  assert.equal(checker.get().verdictVia, "snapshot");
  const verifyCallsAfterPlay = env.fetchCalls.filter((c) => c.url === "/api/verify");
  assert.equal(verifyCallsAfterPlay.length, 1);
  const playBody = verifyCallsAfterPlay[0].body as { frames?: string[]; session?: string };
  assert.deepEqual(playBody.frames ?? [], []);
  assert.equal("frames" in (verifyCallsAfterPlay[0].body as Record<string, unknown>), false);
  assert.equal(playBody.session, checker.get().session);

  stopHandler();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
  assert.equal(mediaSessionObj.playbackState, "paused");
  assert.equal(env.audioElements[0]?.paused, true);
});

test("All 10 earcon contours emit exact frequencies, waveforms, gain envelopes, 0.5x quiet attenuation, and earcons:false mute", (t) => {
  setupTestEnv(t);
  saveSettings({ ...loadSettings(), earcons: true, quiet: false });

  assert.ok(feedbackAudioCtx);
  feedbackAudioCtx.state = "suspended";
  const resumesBefore = feedbackAudioCtx.resumeCount;
  unlockFeedback();
  assert.equal(feedbackAudioCtx.resumeCount, resumesBefore + 1);
  assert.equal(feedbackAudioCtx.state, "running");
  const feedbackCtx = feedbackAudioCtx;

  const expectedContours: Record<
    keyof typeof earcon,
    { freqs: number[]; types: OscillatorType[]; peaks: number[]; durations: number[]; gaps?: number[] }
  > = {
    start: { freqs: [523, 784], types: ["sine", "sine"], peaks: [0.18, 0.18], durations: [0.09, 0.14] },
    stop: { freqs: [784, 523], types: ["sine", "sine"], peaks: [0.18, 0.18], durations: [0.09, 0.14] },
    coach: { freqs: [880], types: ["sine"], peaks: [0.1], durations: [0.05] },
    checking: {
      freqs: [659, 784, 988],
      types: ["sine", "sine", "sine"],
      peaks: [0.07, 0.07, 0.06],
      durations: [0.16, 0.16, 0.28],
      gaps: [0.12, 0.12, 0.03],
    },
    ok: { freqs: [988, 988], types: ["sine", "sine"], peaks: [0.12, 0.12], durations: [0.06, 0.06] },
    match: {
      freqs: [523, 659, 784],
      types: ["sine", "sine", "sine"],
      peaks: [0.18, 0.18, 0.18],
      durations: [0.11, 0.11, 0.22],
    },
    warning: {
      freqs: [330, 330, 262],
      types: ["square", "square", "square"],
      peaks: [0.1, 0.1, 0.1],
      durations: [0.18, 0.18, 0.3],
      gaps: [0.03, 0.08, 0.03],
    },
    unsure: {
      freqs: [587, 523, 587],
      types: ["triangle", "triangle", "triangle"],
      peaks: [0.18, 0.18, 0.18],
      durations: [0.14, 0.14, 0.2],
    },
    info: { freqs: [659], types: ["triangle"], peaks: [0.18], durations: [0.12] },
    alert: { freqs: [440, 349], types: ["triangle", "triangle"], peaks: [0.18, 0.18], durations: [0.1, 0.16] },
  };

  const names = Object.keys(expectedContours) as Array<keyof typeof earcon>;
  assert.equal(names.length, 10);

  const signatures = new Set<string>();
  const normalPeaks: Record<string, number[]> = {};

  for (const name of names) {
    env.oscillators = [];
    env.gains = [];
    earcon[name]();

    const spec = expectedContours[name];
    assert.equal(env.oscillators.length, spec.freqs.length, `oscillator count for ${name}`);
    assert.equal(env.gains.length, spec.freqs.length, `gain count for ${name}`);

    assert.deepEqual(
      env.oscillators.map((o) => o.frequency.value),
      spec.freqs,
      `frequencies for ${name}`,
    );
    assert.deepEqual(
      env.oscillators.map((o) => o.type),
      spec.types,
      `waveforms for ${name}`,
    );

    let noteStart = feedbackCtx.currentTime + 0.01;
    normalPeaks[name] = [];
    for (let i = 0; i < spec.freqs.length; i++) {
      const osc = env.oscillators[i];
      const gain = env.gains[i];
      const dur = spec.durations[i];
      const gap = spec.gaps?.[i] ?? 0.03;

      assert.deepEqual(osc.connectedTo, [gain]);
      assert.equal(gain.connectedTo.length, 1);
      assert.deepEqual(gain.connectedTo[0], { kind: "destination" });
      approxEqual(osc.startedAt[0], noteStart, 1e-9, `${name}[${i}] start`);
      approxEqual(osc.stoppedAt[0], noteStart + dur + 0.02, 1e-9, `${name}[${i}] stop`);

      const setZero = gain.gain.calls.find((c) => c.method === "setValueAtTime");
      const attack = gain.gain.calls.find((c) => c.method === "linearRampToValueAtTime");
      const decay = gain.gain.calls.find((c) => c.method === "exponentialRampToValueAtTime");
      assert.ok(setZero && attack && decay);
      assert.equal(setZero.value, 0);
      approxEqual(setZero.time, noteStart, 1e-9, `${name}[${i}] zero time`);
      approxEqual(attack.value, spec.peaks[i], 1e-9, `${name}[${i}] attack peak`);
      approxEqual(attack.time, noteStart + 0.012, 1e-9, `${name}[${i}] attack time`);
      approxEqual(decay.value, 0.0001, 1e-9, `${name}[${i}] decay floor`);
      approxEqual(decay.time, noteStart + dur, 1e-9, `${name}[${i}] decay time`);

      normalPeaks[name].push(attack.value);
      noteStart += dur + gap;
    }

    signatures.add(env.oscillators.map((o) => `${o.type}:${o.frequency.value}`).join("|"));
  }
  assert.equal(signatures.size, 10);

  for (const level of ["match", "warning", "unsure", "info"] as VerdictLevel[]) {
    env.oscillators = [];
    env.gains = [];
    earconForVerdict(level);
    assert.deepEqual(
      env.oscillators.map((o) => o.frequency.value),
      expectedContours[level].freqs,
    );
    assert.deepEqual(
      env.oscillators.map((o) => o.type),
      expectedContours[level].types,
    );
  }

  saveSettings({ ...loadSettings(), earcons: true, quiet: true });
  for (const name of names) {
    env.oscillators = [];
    env.gains = [];
    earcon[name]();
    const quietPeaks = env.gains.map(
      (g) => g.gain.calls.find((c) => c.method === "linearRampToValueAtTime")!.value,
    );
    assert.equal(quietPeaks.length, normalPeaks[name].length);
    for (let i = 0; i < quietPeaks.length; i++) {
      approxEqual(quietPeaks[i], normalPeaks[name][i] * 0.5, 1e-9, `quiet 0.5x for ${name}[${i}]`);
    }
  }

  saveSettings({ ...loadSettings(), earcons: false, quiet: false });
  env.oscillators = [];
  env.gains = [];
  for (const name of names) earcon[name]();
  earconForVerdict("warning");
  assert.equal(env.oscillators.length, 0);
  assert.equal(env.gains.length, 0);
});

test("Haptic verdict and coach patterns, haptics:false suppression, and speak() locale mapping, interrupt cancel, and voice:false mute", (t) => {
  setupTestEnv(t);
  saveSettings({ ...loadSettings(), haptics: true, voice: true });

  haptic.start();
  haptic.stop();
  assert.deepEqual(env.vibrations, [60, [40, 60, 40]]);

  const expectedVerdictHaptics: Record<VerdictLevel, number | number[]> = {
    match: [90, 70, 90],
    warning: [300, 120, 300, 120, 300],
    unsure: [160, 120, 60],
    info: 60,
  };
  for (const level of Object.keys(expectedVerdictHaptics) as VerdictLevel[]) {
    env.vibrations = [];
    haptic.verdict(level);
    assert.deepEqual(env.vibrations, [expectedVerdictHaptics[level]]);
  }

  const expectedCoachHaptics: Record<CoachCue, number | number[]> = {
    rotate_left: [30, 40, 30],
    rotate_right: [30, 40, 30, 40, 30],
    closer: [15, 30, 15, 30, 15, 30, 15],
    farther: [120],
    hold_still: [200],
    ok: [40, 40, 120],
    more_light: 30,
    other_side: 30,
  };
  for (const cue of Object.keys(expectedCoachHaptics) as CoachCue[]) {
    env.vibrations = [];
    haptic.coach(cue);
    assert.deepEqual(env.vibrations, [expectedCoachHaptics[cue]]);
  }

  saveSettings({ ...loadSettings(), haptics: false });
  env.vibrations = [];
  haptic.start();
  haptic.stop();
  haptic.verdict("match");
  haptic.verdict("warning");
  haptic.coach("closer");
  haptic.coach("rotate_right");
  haptic.pattern([80, 40, 80]);
  assert.equal(env.vibrations.length, 0);

  saveSettings({ ...loadSettings(), haptics: true, voice: true });
  const baseProfile: Profile = demoProfile();

  const localeMappings: Array<{ lang: string; expected: string; sample: string }> = [
    { lang: "en", expected: "en-GB", sample: "Hold the box steady." },
    { lang: "fi", expected: "fi-FI", sample: "Pidä pakkaus paikallaan." },
    { lang: "sv", expected: "sv-SE", sample: "Håll förpackningen stilla." },
    { lang: "de", expected: "en-GB", sample: "Fallback English locale." },
  ];

  for (const { lang, expected, sample } of localeMappings) {
    env.speechEvents = [];
    saveProfile({ ...baseProfile, lang });
    speak(sample);
    assert.deepEqual(env.speechEvents, [
      { kind: "cancel" },
      { kind: "speak", text: sample, lang: expected, rate: 1, volume: 1 },
    ]);
  }

  env.speechEvents = [];
  saveProfile({ ...baseProfile, lang: "en" });
  speak("Queued verdict speech", { interrupt: false });
  assert.deepEqual(env.speechEvents, [
    { kind: "speak", text: "Queued verdict speech", lang: "en-GB", rate: 1, volume: 1 },
  ]);

  env.speechEvents = [];
  speak("Interrupting warning", { interrupt: true, lang: "fi-FI" });
  assert.deepEqual(env.speechEvents, [
    { kind: "cancel" },
    { kind: "speak", text: "Interrupting warning", lang: "fi-FI", rate: 1, volume: 1 },
  ]);

  env.speechEvents = [];
  stopSpeaking();
  assert.deepEqual(env.speechEvents, [{ kind: "cancel" }]);

  saveSettings({ ...loadSettings(), voice: false });
  env.speechEvents = [];
  speak("Muted default");
  speak("Muted queued", { interrupt: false });
  assert.equal(env.speechEvents.length, 0);
});

test("Bluetooth HFP audioRoute() label detection and Checker devicechange hot-swap with mic disconnect recovery", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);

  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Built-in Microphone" },
    { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
  ] as MediaDeviceInfo[];
  env.micTrackLabel = "Built-in Microphone";

  assert.deepEqual(await audioRoute(), {
    input: "Built-in Microphone",
    output: "Phone Speaker",
    bluetooth: false,
  });

  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[];
  assert.deepEqual(await audioRoute(), {
    input: "Ray-Ban Meta",
    output: "Ray-Ban Meta",
    bluetooth: true,
  });

  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Hands-Free AG Audio" },
    { kind: "audiooutput", deviceId: "default", label: "Hands-Free AG Audio" },
  ] as MediaDeviceInfo[];
  assert.deepEqual(await audioRoute(), {
    input: "Hands-Free AG Audio",
    output: "Hands-Free AG Audio",
    bluetooth: true,
  });

  env.devices = [
    { kind: "audioinput", deviceId: "bt-1", label: "BT Glasses Audio" },
  ] as MediaDeviceInfo[];
  assert.deepEqual(await audioRoute(), {
    input: "BT Glasses Audio",
    output: "",
    bluetooth: true,
  });

  env.enumerateDevicesError = true;
  assert.deepEqual(await audioRoute(), { input: "", output: "", bluetooth: false });
  env.enumerateDevicesError = false;

  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Built-in Microphone" },
    { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
  ] as MediaDeviceInfo[];

  const checker = createChecker();
  await flushMicrotasks();
  assert.equal(checker.get().route, "Phone Speaker");

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  assert.equal(checker.get().mic, "on");
  assert.equal(checker.get().micLabel, "Built-in Microphone");
  assert.equal(env.micStarts, 1);

  const phoneMicTrack = env.lastMicStream?.audioTracks[0];
  assert.ok(phoneMicTrack);
  phoneMicTrack.readyState = "ended";

  env.micTrackLabel = "Ray-Ban Meta Hands-Free";
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta Hands-Free" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[];
  announcements.length = 0;

  await env.mediaDeviceEvents.emit("devicechange");
  await flushMicrotasks();

  assert.equal(checker.get().route, "Ray-Ban Meta");
  assert.ok(
    announcements.some((a) => a.msg === "Audio now through Ray-Ban Meta." && a.politeness === "assertive"),
  );
  assert.ok(
    announcements.some((a) => a.msg === "Microphone changed. Switching microphone." && a.politeness === "polite"),
  );
  assert.equal(env.micStarts, 2);
  assert.equal(checker.get().mic, "on");
  assert.equal(checker.get().micLabel, "Ray-Ban Meta Hands-Free");

  const glassesWorklet = env.workletNodes[env.workletNodes.length - 1];
  assert.ok(glassesWorklet);
  ws.sent.length = 0;
  glassesWorklet.emitChunk(new Int16Array([1400, -1400, 700, -700]), 0.38);
  assert.equal(checker.get().micLevel, 0.38);
  assert.ok(ws.sent.some((m) => m.type === "audio" && m.data.length > 0));

  announcements.length = 0;
  await env.mediaDeviceEvents.emit("devicechange");
  await flushMicrotasks();
  assert.equal(announcements.length, 0);
  assert.equal(env.micStarts, 2);

  const glassesMicTrack = env.lastMicStream?.audioTracks[0];
  assert.ok(glassesMicTrack);
  env.micTrackLabel = "Built-in Microphone";
  announcements.length = 0;

  await glassesMicTrack.triggerEnded();
  await flushMicrotasks();

  assert.ok(
    announcements.some((a) => a.msg === "Microphone disconnected. Switching microphone." && a.politeness === "polite"),
  );
  assert.equal(env.micStarts, 3);
  assert.equal(checker.get().mic, "on");
  assert.equal(checker.get().micLabel, "Built-in Microphone");
});

test("45s privacy auto-stop timer re-arms on user barge-in, assistant transcript, coach cue, and verdict, then stops and plays /phrases/<lang>/camera_off.mp3", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses", voice: true });
  saveProfile({ ...demoProfile(), lang: "en" });

  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws1 = env.sockets[0];
  ws1.serverOpen();
  assert.equal(checker.get().autoStopAt, BASE_NOW + 45_000);

  t.mock.timers.tick(20_000);
  ws1.serverSend({ type: "transcript", role: "user", text: "   ", final: false });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 45_000);

  ws1.serverSend({ type: "transcript", role: "user", text: "Is this my evening pill?", final: true });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 20_000 + 45_000);

  t.mock.timers.tick(30_000);
  assert.equal(checker.get().running, true);
  ws1.serverSend({ type: "transcript", role: "assistant", text: "Hold the box a little closer.", final: false });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 50_000 + 45_000);

  t.mock.timers.tick(30_000);
  assert.equal(checker.get().running, true);
  ws1.serverSend({ type: "coach", cue: "closer", text: "A bit closer." });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 80_000 + 45_000);

  t.mock.timers.tick(30_000);
  assert.equal(checker.get().running, true);
  ws1.serverSend({ type: "verdict", verdict: makeSampleVerdict() });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 110_000 + 45_000);

  announcements.length = 0;
  env.playedPhraseUrls = [];

  t.mock.timers.tick(44_999);
  assert.equal(checker.get().running, true);

  t.mock.timers.tick(1);
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().mic, "off");
  assert.equal(checker.get().autoStopAt, null);
  assert.equal(mediaSessionObj.playbackState, "paused");
  assert.ok(
    announcements.some(
      (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
    ),
  );
  assert.deepEqual(env.playedPhraseUrls, ["/phrases/en/camera_off.mp3"]);

  saveProfile({ ...demoProfile(), lang: "fi" });
  announcements.length = 0;
  env.playedPhraseUrls = [];

  await checker.start();
  const ws2 = env.sockets[1];
  ws2.serverOpen();

  ws2.serverSend({ type: "status", live: "closed", detail: "auto-stop" });
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().mic, "off");
  assert.equal(checker.get().serverLive, null);
  assert.ok(
    announcements.some(
      (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
    ),
  );
  assert.deepEqual(env.playedPhraseUrls, ["/phrases/fi/camera_off.mp3"]);

  saveProfile({ ...demoProfile(), lang: "sv" });
  announcements.length = 0;
  env.playedPhraseUrls = [];

  await checker.start();
  const ws3 = env.sockets[2];
  ws3.serverOpen();

  t.mock.timers.tick(45_000);
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.ok(
    announcements.some(
      (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
    ),
  );
  assert.deepEqual(env.playedPhraseUrls, ["/phrases/sv/camera_off.mp3"]);

  saveProfile({ ...demoProfile(), lang: "en" });
  env.allowPhraseAudio = false;
  env.spoken = [];
  env.playedPhraseUrls = [];

  await checker.start();
  const ws4 = env.sockets[3];
  ws4.serverOpen();

  t.mock.timers.tick(45_000);
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.equal(env.playedPhraseUrls.length, 0);
  assert.ok(env.spoken.includes("No label for 45 seconds. I've turned the camera off."));
});
