import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg, ServerMsg, Verdict } from "../../shared/types.ts";

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

type DetectedBarcode = { rawValue: string; format: string };

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

  serverClose(code = 1006, reason = "Connection lost") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

class MockBroadcastChannel {
  static peers = new Map<string, Set<MockBroadcastChannel>>();
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  private events = makeEventMap();

  constructor(name: string) {
    this.name = name;
    let set = MockBroadcastChannel.peers.get(name);
    if (!set) {
      set = new Set();
      MockBroadcastChannel.peers.set(name, set);
    }
    set.add(this);
  }

  addEventListener(type: string, fn: ListenerFn) {
    this.events.add(type, fn);
  }

  removeEventListener(type: string, fn: ListenerFn) {
    this.events.remove(type, fn);
  }

  postMessage(data: unknown) {
    if (this.closed) return;
    for (const peer of MockBroadcastChannel.peers.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) {
        const ev = { type: "message", data } as MessageEvent;
        peer.onmessage?.(ev);
        void peer.events.emit("message", ev);
      }
    }
  }

  close() {
    this.closed = true;
    this.events.clear();
    MockBroadcastChannel.peers.get(this.name)?.delete(this);
  }
}

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
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = { kind: "destination" };
  audioWorklet = {
    addModule: async (_url: string) => {
      env.workletModulesLoaded++;
    },
  };

  constructor() {
    env.audioContexts.push(this);
  }

  async resume() {
    if (this.state !== "closed") this.state = "running";
  }

  async close() {
    this.state = "closed";
  }

  createGain() {
    const param = {
      value: 1,
      setValueAtTime(v: number) {
        param.value = v;
      },
      linearRampToValueAtTime(v: number) {
        param.value = v;
      },
      exponentialRampToValueAtTime(v: number) {
        param.value = v;
      },
      setTargetAtTime(v: number) {
        param.value = v;
      },
      cancelScheduledValues() {},
    };
    return {
      gain: param,
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
  }

  createOscillator() {
    const freq = {
      value: 440,
      setTargetAtTime(v: number) {
        freq.value = v;
      },
    };
    return {
      type: "sine",
      frequency: freq,
      connect(dest: unknown) {
        return dest;
      },
      start() {},
      stop() {},
    };
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
    return src;
  }
}

class MockBarcodeDetector {
  static async getSupportedFormats() {
    return ["ean_13", "ean_8", "upc_a", "code_128", "data_matrix", "qr_code"];
  }

  formats: string[];
  constructor(opts?: { formats?: string[] }) {
    this.formats = opts?.formats ?? [];
  }

  async detect(_src: unknown): Promise<DetectedBarcode[]> {
    return env.detectedCodes;
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
  onended: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private events = makeEventMap();

  constructor(src = "") {
    this.src = src;
  }

  addEventListener(type: string, fn: ListenerFn) {
    this.events.add(type, fn);
  }

  removeEventListener(type: string, fn: ListenerFn) {
    this.events.remove(type, fn);
  }

  load() {}

  async play() {
    if (this.src.includes("/phrases/")) {
      const err = new Error("Phrase audio not cached");
      this.onerror?.(err);
      await this.events.emit("error", err);
      throw err;
    }
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

function createMockCanvas() {
  return {
    width: 160,
    height: 120,
    getContext(_kind: string) {
      return {
        drawImage() {},
        getImageData(_x: number, _y: number, w: number, h: number) {
          const data = new Uint8ClampedArray(w * h * 4);
          const c = env.frameContrast;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = (y * w + x) * 4;
              const v = (x + y) % 2 === 0 ? c : 0;
              data[idx] = v;
              data[idx + 1] = v;
              data[idx + 2] = v;
              data[idx + 3] = 255;
            }
          }
          return { data };
        },
      };
    },
    toDataURL(_type?: string, _quality?: number) {
      return "data:image/jpeg;base64," + env.framePayload;
    },
  };
}

const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join("/");

const env = {
  windowEvents: makeEventMap(),
  docEvents: makeEventMap(),
  mediaDeviceEvents: makeEventMap(),
  online: true,
  visibilityState: "visible" as "visible" | "hidden",
  sockets: [] as MockWebSocket[],
  fetchCalls: [] as FetchRecord[],
  healthReply: (): FetchReply => ({ status: 200, json: { ok: true, gemini: "ok" } }),
  statsReply: (): FetchReply => ({ status: 200, json: { calls: 0 } }),
  verifyReply: (_body: unknown): FetchReply => ({ status: 200, json: makeSampleVerdict() }),
  phrasesReply: (_url: string): FetchReply => ({ status: 404, statusText: "Not Found", json: { message: "Not Found" } }),
  lastCameraStream: null as MockStream | null,
  lastMicStream: null as MockStream | null,
  cameraStarts: 0,
  micStarts: 0,
  micTrackLabel: "Built-in Microphone",
  devices: [
    { kind: "audioinput", deviceId: "default", label: "Built-in Microphone" },
    { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
  ] as MediaDeviceInfo[],
  spoken: [] as string[],
  speechCancels: 0,
  vibrations: [] as Array<number | number[]>,
  audioContexts: [] as MockAudioContext[],
  workletNodes: [] as MockAudioWorkletNode[],
  workletModulesLoaded: 0,
  detectedCodes: [] as DetectedBarcode[],
  frameContrast: 28,
  framePayload: "cGhvbmUtZnJhbWU=",
};

function installGlobals() {
  const local = createStorage();
  const session = createStorage();

  const cachesObj = {
    async keys() {
      return [] as string[];
    },
    async has() {
      return false;
    },
    async delete() {
      return false;
    },
    async match() {
      return undefined;
    },
    async open() {
      return {
        async match() {
          return undefined;
        },
        async put() {},
        async add() {},
        async delete() {
          return false;
        },
        async keys() {
          return [];
        },
      };
    },
  };

  const navigatorObj = {
    get onLine() {
      return env.online;
    },
    language: "en-GB",
    userAgent: "Mozilla/5.0 (Linux; Android 15)",
    vibrate(pattern: number | number[]) {
      env.vibrations.push(pattern);
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
        return env.devices;
      },
      addEventListener(type: string, fn: ListenerFn) {
        env.mediaDeviceEvents.add(type, fn);
      },
      removeEventListener(type: string, fn: ListenerFn) {
        env.mediaDeviceEvents.remove(type, fn);
      },
    },
    mediaSession: {
      metadata: null as unknown,
      playbackState: "none",
      setActionHandler() {},
    },
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
    createElement(_tag: string) {
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
    replaceState(_st: unknown, _title: string, url: string) {
      const qIdx = url.indexOf("?");
      locationObj.search = qIdx >= 0 ? url.slice(qIdx) : "";
    },
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = rawUrl.startsWith(ORIGIN_HTTPS) ? rawUrl.slice(ORIGIN_HTTPS.length) || "/" : rawUrl;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
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

    const reply =
      url === "/api/health"
        ? env.healthReply()
        : url === "/api/stats"
          ? env.statsReply()
          : url === "/api/verify"
            ? env.verifyReply(rawBody)
            : url === "/phrases/manifest.json" || url.startsWith("/phrases/") || url.startsWith("/api/tts")
              ? env.phrasesReply(url)
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
        async arrayBuffer() {
          return new TextEncoder().encode(bodyText).buffer;
        },
        async blob() {
          return new Blob([bodyText]);
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
        if (u.volume > 0 && u.text.trim()) env.spoken.push(u.text);
      },
      cancel() {
        env.speechCancels++;
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
  Object.defineProperty(globalThis, "createImageBitmap", {
    value: async () => ({ width: 320, height: 240, close() {} }),
    configurable: true,
    writable: true,
  });
}

installGlobals();

const { Checker } = await import("../src/lib/checker.ts");
const { audioRoute } = await import("../src/lib/media.ts");
const { barcodeSupported, dataMatrixSupported, detectBarcode, detectCodes } = await import("../src/lib/barcode.ts");
const { verify } = await import("../src/lib/api.ts");
const { onAnnounce } = await import("../src/lib/feedback.ts");
const { setAccessKey } = await import("../src/lib/key.ts");
const { demoProfile, loadProfile, loadSettings, saveProfile, saveSettings } = await import("../src/lib/storage.ts");

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

function makeMockVideo(): HTMLVideoElement & { playCalls: number } {
  const v = {
    srcObject: null as MediaStream | null,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 960,
    playCalls: 0,
    async play() {
      v.playCalls++;
    },
  };
  return v as unknown as HTMLVideoElement & { playCalls: number };
}

async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const BASE_NOW = 1_763_150_000_000;

type Announcement = { msg: string; politeness: "polite" | "assertive" };

function setupTestEnv(t: TestContext, opts: { online?: boolean; visibilityState?: "visible" | "hidden" } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW });

  env.windowEvents.clear();
  env.docEvents.clear();
  env.mediaDeviceEvents.clear();
  MockBroadcastChannel.peers.clear();

  env.online = opts.online ?? true;
  env.visibilityState = opts.visibilityState ?? "visible";
  env.sockets = [];
  env.fetchCalls = [];
  env.healthReply = () => ({ status: 200, json: { ok: true, gemini: "ok" } });
  env.statsReply = () => ({ status: 200, json: { calls: 0 } });
  env.verifyReply = () => ({ status: 200, json: makeSampleVerdict() });
  env.phrasesReply = () => ({ status: 404, statusText: "Not Found", json: { message: "Not Found" } });
  env.lastCameraStream = null;
  env.lastMicStream = null;
  env.cameraStarts = 0;
  env.micStarts = 0;
  env.micTrackLabel = "Built-in Microphone";
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Built-in Microphone" },
    { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
  ] as MediaDeviceInfo[];
  env.spoken = [];
  env.speechCancels = 0;
  env.vibrations = [];
  env.audioContexts = [];
  env.workletNodes = [];
  env.workletModulesLoaded = 0;
  env.detectedCodes = [];
  env.frameContrast = 28;
  env.framePayload = "cGhvbmUtZnJhbWU=";

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

test("setSource('glasses') stops phone camera tracks, sends source message on open /live WS, resets camera and sharpness, and announces transition", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  const phoneTrack = env.lastCameraStream?.videoTracks[0];
  assert.ok(phoneTrack);
  assert.equal(phoneTrack.stopCalls, 0);
  assert.equal(phoneTrack.readyState, "live");

  t.mock.timers.tick(400);
  assert.ok(checker.get().sharpness > 0);
  assert.ok(ws.sent.some((m) => m.type === "frame"));

  announcements.length = 0;
  ws.sent.length = 0;

  await checker.setSource("glasses");

  assert.equal(phoneTrack.stopCalls, 1);
  assert.equal(phoneTrack.readyState, "ended");
  assert.equal(video.srcObject, null);
  assert.equal(checker.get().source, "glasses");
  assert.equal(loadSettings().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().sharpness, 0);
  assert.deepEqual(ws.sent, [{ type: "source", source: "glasses" }]);
  assert.ok(
    announcements.some(
      (a) => a.msg === "Using the glasses camera. The phone camera is off." && a.politeness === "assertive",
    ),
  );

  await checker.setSource("glasses");
  assert.equal(ws.sent.length, 1);

  t.mock.timers.tick(1_500);
  assert.equal(checker.get().fps, 0);
  assert.equal(ws.sent.some((m) => m.type === "frame"), false);
});

test("visibilitychange hidden -> visible keeps glasses stream untouched in background whereas phone camera pauses and resumes", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses" });

  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.equal(env.cameraStarts, 0);

  announcements.length = 0;
  env.visibilityState = "hidden";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, true);
  assert.equal(checker.get().camera, "off");
  assert.equal(env.cameraStarts, 0);

  env.visibilityState = "visible";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(env.cameraStarts, 0);
  assert.equal(announcements.some((a) => a.msg === "Welcome back. Camera resumed."), false);

  await checker.setSource("phone");
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  const phoneTrack = env.lastCameraStream?.videoTracks[0];
  assert.ok(phoneTrack);
  const startsBeforeHide = env.cameraStarts;

  env.visibilityState = "hidden";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, true);
  assert.equal(checker.get().camera, "paused");
  assert.equal(phoneTrack.stopCalls, 1);

  announcements.length = 0;
  env.visibilityState = "visible";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, false);
  assert.equal(checker.get().camera, "on");
  assert.equal(env.cameraStarts, startsBeforeHide + 1);
  assert.ok(announcements.some((a) => a.msg === "Welcome back. Camera resumed." && a.politeness === "polite"));
});

test("snapshot() when source is glasses posts empty frames with session to /api/verify for Hub ring-buffer verify without failing on empty local FrameRing", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);

  const phoneChecker = createChecker();
  await flushMicrotasks();
  await phoneChecker.start();
  announcements.length = 0;
  await phoneChecker.snapshot();
  assert.equal(env.fetchCalls.filter((c) => c.url === "/api/verify").length, 0);
  assert.ok(
    announcements.some(
      (a) => a.msg === "I don't have a picture yet. Hold the label up to the camera, or take a photo." && a.politeness === "assertive",
    ),
  );
  await phoneChecker.stop();

  saveSettings({ ...loadSettings(), source: "glasses" });
  const glassesChecker = createChecker();
  await flushMicrotasks();
  const camStartsBefore = env.cameraStarts;
  await glassesChecker.start();
  assert.equal(glassesChecker.get().source, "glasses");
  assert.equal(env.cameraStarts, camStartsBefore);

  env.fetchCalls = [];
  announcements.length = 0;
  await glassesChecker.snapshot(undefined, "Is this my evening pill?");

  assert.equal(
    announcements.some((a) => a.msg.startsWith("I don't have a picture yet.")),
    false,
  );
  assert.ok(announcements.some((a) => a.msg === "Checking the label." && a.politeness === "polite"));

  const verifyCalls = env.fetchCalls.filter((c) => c.url === "/api/verify");
  assert.equal(verifyCalls.length, 1);
  const body = verifyCalls[0].body as { frames?: string[]; session?: string; question?: string };
  assert.deepEqual(body.frames ?? [], []);
  assert.equal("frames" in (verifyCalls[0].body as Record<string, unknown>), false);
  assert.equal(body.session, glassesChecker.get().session);
  assert.equal(body.question, "Is this my evening pill?");
  assert.equal(glassesChecker.get().snapshotBusy, false);
  assert.equal(glassesChecker.get().verdictVia, "snapshot");
  assert.equal(glassesChecker.get().verdict?.matchedMedId, "amlodipine");

  env.fetchCalls = [];
  const directVerdict = await verify([], loadProfile(), { session: glassesChecker.get().session, question: "Direct check" });
  assert.equal(directVerdict.level, "match");
  const directCall = env.fetchCalls.find((c) => c.url === "/api/verify");
  assert.ok(directCall);
  assert.deepEqual((directCall.body as { frames?: string[] }).frames ?? [], []);
  assert.equal((directCall.body as { session?: string }).session, glassesChecker.get().session);
});

test("device message tolerates nullable DAT sensors, falls back to phone on worn:false or connected:false, and warns once on battery crossing <= 15%", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses" });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  announcements.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.equal(env.cameraStarts, 0);
  assert.equal(announcements.length, 0);

  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 20, streaming: true, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "glasses");
  assert.equal(announcements.some((a) => a.msg.startsWith("Glasses battery low:")), false);

  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 15, streaming: true, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(
    announcements.filter((a) => a.msg === "Glasses battery low: 15 percent." && a.politeness === "assertive").length,
    1,
  );

  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 12, streaming: true, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(announcements.filter((a) => a.msg.startsWith("Glasses battery low:")).length, 1);

  announcements.length = 0;
  ws.sent.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: false, battery: 12, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  assert.ok(ws.sent.some((m) => m.type === "source" && m.source === "phone"));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Glasses taken off. Switched to the phone camera." && a.politeness === "assertive",
    ),
  );

  await checker.setSource("glasses");
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");

  announcements.length = 0;
  ws.sent.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: false, worn: null, battery: null, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  assert.ok(ws.sent.some((m) => m.type === "source" && m.source === "phone"));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Glasses disconnected. Switched to the phone camera." && a.politeness === "assertive",
    ),
  );
});

test("entering offline mode while source is glasses auto-switches to phone camera, decodes GS1 DataMatrix GTIN + expiry vs unknown pack code, and enforces 8s duplicate suppression unless forced", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveProfile(demoProfile());
  saveSettings({ ...loadSettings(), source: "glasses" });

  assert.equal(barcodeSupported, true);
  assert.equal(await dataMatrixSupported(), true);

  const probeVideo = makeMockVideo();
  env.detectedCodes = [
    { rawValue: "010641654200214917281231", format: "data_matrix" },
    { rawValue: "6416542002149", format: "ean_13" },
  ];
  const codes = await detectCodes(probeVideo);
  assert.equal(codes.length, 2);
  assert.equal(codes[0].format, "data_matrix");
  assert.equal(await detectBarcode(probeVideo), "010641654200214917281231");
  env.detectedCodes = [];
  assert.equal(await detectBarcode(probeVideo), null);

  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");

  announcements.length = 0;
  env.online = false;
  await env.windowEvents.emit("offline");
  await flushMicrotasks();

  assert.equal(checker.get().mode, "offline");
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  assert.ok(
    announcements.some(
      (a) =>
        a.msg === "Offline: the glasses camera needs the server. Switched to the phone camera for barcode checks." &&
        a.politeness === "assertive",
    ),
  );

  const savedPackGs1 = "01064165420021491728123110BATCH7\x1d21SER42";
  env.detectedCodes = [{ rawValue: savedPackGs1, format: "data_matrix" }];
  announcements.length = 0;
  t.mock.timers.tick(500);
  await flushMicrotasks();

  assert.equal(checker.get().lastCode?.gtin, "06416542002149");
  assert.equal(checker.get().lastCode?.expiry, "2028-12-31");
  assert.equal(checker.get().verdict?.level, "match");
  assert.equal(checker.get().verdict?.matchedMedId, "amlodipine");
  assert.equal(checker.get().verdictVia, "offline");
  assert.equal(checker.get().verdict?.crossCheck?.source, "datamatrix");

  checker.dismissVerdict();
  assert.equal(checker.get().verdict, null);
  announcements.length = 0;

  t.mock.timers.tick(4_000);
  await flushMicrotasks();
  assert.equal(checker.get().verdict, null);

  t.mock.timers.tick(3_500);
  await flushMicrotasks();
  assert.equal(checker.get().verdict, null);
  assert.equal(announcements.length, 0);

  checker.injectCode(savedPackGs1);
  assert.equal(checker.get().verdict?.level, "match");
  assert.equal(checker.get().verdict?.matchedMedId, "amlodipine");

  checker.dismissVerdict();
  assert.equal(checker.get().verdict, null);

  t.mock.timers.tick(7_500);
  await flushMicrotasks();
  assert.equal(checker.get().verdict, null);

  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  assert.equal(checker.get().verdict?.level, "match");
  assert.equal(checker.get().verdict?.matchedMedId, "amlodipine");

  const unknownPackGs1 = "010999999999999917290500";
  env.detectedCodes = [{ rawValue: unknownPackGs1, format: "data_matrix" }];
  t.mock.timers.tick(500);
  await flushMicrotasks();

  assert.equal(checker.get().lastCode?.gtin, "09999999999999");
  assert.equal(checker.get().lastCode?.expiry, "2029-05");
  assert.equal(checker.get().verdict?.level, "unsure");
  assert.equal(checker.get().verdict?.headline, "Pack code not on your list");
  assert.equal(checker.get().verdict?.crossCheck?.source, "datamatrix");
});

test("audioRoute() and devicechange recognize 'Default - Ray-Ban Meta' as bluetooth, announce route, and restart MicCapture if active audio track ended", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);

  const initialRoute = await audioRoute();
  assert.deepEqual(initialRoute, {
    input: "Built-in Microphone",
    output: "Phone Speaker",
    bluetooth: false,
  });

  const checker = createChecker();
  await flushMicrotasks();
  assert.equal(checker.get().route, "Phone Speaker");

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  assert.equal(checker.get().mic, "on");
  assert.equal(env.micStarts, 1);

  const firstMicTrack = env.lastMicStream?.audioTracks[0];
  assert.ok(firstMicTrack);
  assert.equal(firstMicTrack.readyState, "live");

  env.micTrackLabel = "Ray-Ban Meta HFP Mic";
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[];

  const glassesRoute = await audioRoute();
  assert.deepEqual(glassesRoute, {
    input: "Ray-Ban Meta",
    output: "Ray-Ban Meta",
    bluetooth: true,
  });

  firstMicTrack.readyState = "ended";
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
  assert.ok(firstMicTrack.stopCalls >= 1);
  assert.equal(env.micStarts, 2);
  assert.equal(checker.get().mic, "on");
  assert.equal(checker.get().micLabel, "Ray-Ban Meta HFP Mic");

  const latestWorklet = env.workletNodes[env.workletNodes.length - 1];
  assert.ok(latestWorklet);
  ws.sent.length = 0;
  latestWorklet.emitChunk(new Int16Array([1200, -1200, 800, -800]), 0.35);
  assert.equal(checker.get().micLevel, 0.35);
  assert.ok(ws.sent.some((m) => m.type === "audio" && m.data.length > 0));

  announcements.length = 0;
  await env.mediaDeviceEvents.emit("devicechange");
  await flushMicrotasks();
  assert.equal(announcements.length, 0);
  assert.equal(env.micStarts, 2);
});
