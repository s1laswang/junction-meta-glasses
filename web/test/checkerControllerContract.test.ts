import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientMsg, Med, Profile, ServerMsg, Verdict } from "../../shared/types.ts";

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

  unref() {
    return this;
  }

  ref() {
    return this;
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
    const node = {
      gain: param,
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
    return node;
  }

  createOscillator() {
    const freq = {
      value: 440,
      setTargetAtTime(v: number) {
        freq.value = v;
        env.sonarTargetHz.push(v);
      },
    };
    const osc = {
      type: "sine",
      frequency: freq,
      started: false,
      stopped: false,
      connect(dest: unknown) {
        return dest;
      },
      start() {
        osc.started = true;
        env.oscillatorFreqs.push(freq.value);
      },
      stop() {
        osc.stopped = true;
      },
    };
    return osc;
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
    if (this.src.includes("/phrases/") && !env.allowPhraseAudio) {
      const err = new Error("Phrase audio not cached");
      this.onerror?.(err);
      await this.events.emit("error", err);
      throw err;
    }
    this.paused = false;
    if (this.src.includes("/phrases/")) env.playedPhraseUrls.push(this.src);
  }

  pause() {
    this.paused = true;
  }
}

function createMockCanvas() {
  const canvas = {
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
  return canvas;
}

const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join("/");
const WS_LIVE_PREFIX = ["wss:", "", "holdup.example", "live"].join("/");

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
  allowPhraseAudio: false,
  playedPhraseUrls: [] as string[],
  cacheEntries: new Map<string, string[]>(),
  cameraError: null as { name: string } | null,
  micError: null as { name: string } | null,
  lastCameraStream: null as MockStream | null,
  lastMicStream: null as MockStream | null,
  cameraStarts: 0,
  micStarts: 0,
  devices: [
    { kind: "audioinput", deviceId: "default", label: "Ray-Ban Meta Hands-Free" },
    { kind: "audiooutput", deviceId: "default", label: "Ray-Ban Meta Audio" },
  ] as MediaDeviceInfo[],
  spoken: [] as string[],
  speechCancels: 0,
  vibrations: [] as Array<number | number[]>,
  audioContexts: [] as MockAudioContext[],
  workletNodes: [] as MockAudioWorkletNode[],
  workletModulesLoaded: 0,
  bufferSources: [] as MockBufferSource[],
  oscillatorFreqs: [] as number[],
  sonarTargetHz: [] as number[],
  detectedCodes: [] as DetectedBarcode[],
  frameContrast: 20,
  framePayload: "cGhvbmUtZnJhbWU=",
  mediaSessionHandlers: new Map<string, () => void>(),
};

function installGlobals() {
  const local = createStorage();
  const session = createStorage();

  const cachesObj = {
    async keys() {
      return Array.from(env.cacheEntries.keys());
    },
    async has(name: string) {
      return env.cacheEntries.has(name);
    },
    async delete(name: string) {
      return env.cacheEntries.delete(name);
    },
    async match() {
      return undefined;
    },
    async open(name: string) {
      if (!env.cacheEntries.has(name)) env.cacheEntries.set(name, []);
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
    userAgent: "Mozilla/5.0 Linux",
    vibrate(pattern: number | number[]) {
      env.vibrations.push(pattern);
      return true;
    },
    mediaDevices: {
      async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
        if (constraints.video) {
          env.cameraStarts++;
          if (env.cameraError) throw env.cameraError;
          const stream = createMockStream([createMockTrack("video", "Back Camera")], []);
          env.lastCameraStream = stream;
          return stream;
        }
        env.micStarts++;
        if (env.micError) throw env.micError;
        const stream = createMockStream([], [createMockTrack("audio", "Ray-Ban Mic")]);
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
      setActionHandler(action: string, handler: (() => void) | null) {
        if (handler) env.mediaSessionHandlers.set(action, handler);
        else env.mediaSessionHandlers.delete(action);
      },
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

const { Checker, levelWord, localFeatures, medSummary } = await import("../src/lib/checker.ts");
const { onAnnounce } = await import("../src/lib/feedback.ts");
const { setAccessKey } = await import("../src/lib/key.ts");
const { MOCK_HUD_CHANNEL, mockHudChannel } = await import("../src/lib/mock.ts");
const { deleteAllData, demoProfile, loadProfile, loadSettings, saveProfile, saveSettings, takenToday } = await import("../src/lib/storage.ts");

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
  env.allowPhraseAudio = false;
  env.playedPhraseUrls = [];
  env.cacheEntries.clear();
  env.cameraError = null;
  env.micError = null;
  env.lastCameraStream = null;
  env.lastMicStream = null;
  env.cameraStarts = 0;
  env.micStarts = 0;
  env.spoken = [];
  env.speechCancels = 0;
  env.vibrations = [];
  env.audioContexts = [];
  env.workletNodes = [];
  env.workletModulesLoaded = 0;
  env.bufferSources = [];
  env.oscillatorFreqs = [];
  env.sonarTargetHz = [];
  env.detectedCodes = [];
  env.frameContrast = 20;
  env.framePayload = "cGhvbmUtZnJhbWU=";
  env.mediaSessionHandlers.clear();

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

test("levelWord, localFeatures, and medSummary obey display and settings contracts", (t) => {
  setupTestEnv(t);

  assert.equal(levelWord("match"), "Match");
  assert.equal(levelWord("warning"), "Warning");
  assert.equal(levelWord("unsure"), "Not sure");
  assert.equal(levelWord("info"), "Info");

  assert.deepEqual(localFeatures(), ["scene", "datamatrix", "addmed", "sonar"]);

  const base = loadSettings();
  saveSettings({
    ...base,
    features: { scene: true, datamatrix: false, addmed: true, sonar: false },
  });
  assert.deepEqual(localFeatures(), ["scene", "addmed"]);

  saveSettings({
    ...base,
    features: { scene: false, datamatrix: false, addmed: false, sonar: false },
  });
  assert.deepEqual(localFeatures(), []);

  const multiSchedule: Med = {
    id: "metformin",
    name: "Metformin",
    ingredient: "metformin",
    strength: "500 mg",
    schedule: ["morning", "evening"],
  };
  assert.equal(medSummary(multiSchedule), "Metformin 500 mg, morning and evening");

  const singleSchedule: Med = {
    id: "amlodipine",
    name: "Amlodipine",
    ingredient: "amlodipine",
    strength: "5 mg",
    schedule: ["evening"],
  };
  assert.equal(medSummary(singleSchedule), "Amlodipine 5 mg, evening");

  const unscheduled: Med = {
    id: "vitd",
    name: "Vitamin D",
    ingredient: "colecalciferol",
    strength: "",
    schedule: [],
  };
  assert.equal(medSummary(unscheduled), "Vitamin D");
});

test("initial CheckState reflects browser online/visibility/settings and subscribe/get notify immutably", async (t) => {
  const { createChecker } = setupTestEnv(t, { online: true, visibilityState: "visible" });
  const c1 = createChecker();
  const st1 = c1.get();

  assert.equal(st1.running, false);
  assert.equal(st1.mode, "live");
  assert.equal(st1.conn, "idle");
  assert.equal(st1.online, true);
  assert.equal(st1.hidden, false);
  assert.equal(st1.source, "phone");
  assert.equal(st1.camera, "off");
  assert.equal(st1.mic, "off");
  assert.equal(st1.policy.tier, "normal");
  assert.deepEqual(st1.captions, []);
  assert.equal(st1.verdict, null);
  assert.equal(st1.serverFeatures, null);
  assert.equal(st1.readiness, null);
  assert.equal(st1.addProposal, null);
  assert.equal(st1.authNeeded, false);
  assert.match(st1.session, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

  await flushMicrotasks();
  assert.equal(c1.get().health, "ok");
  assert.equal(c1.get().route, "Ray-Ban Meta Audio");

  let notifications = 0;
  let lastSnapshot = c1.get();
  const unsub = c1.subscribe(() => {
    notifications++;
    lastSnapshot = c1.get();
  });

  const beforeRef = c1.get();
  await c1.setSource("glasses");
  assert.ok(notifications >= 1);
  assert.notEqual(lastSnapshot, beforeRef);
  assert.equal(lastSnapshot.source, "glasses");

  const countBeforeUnsub = notifications;
  unsub();
  await c1.setSource("phone");
  assert.equal(notifications, countBeforeUnsub);

  env.online = false;
  env.visibilityState = "hidden";
  saveSettings({ ...loadSettings(), source: "glasses" });
  const c2 = createChecker();
  assert.equal(c2.get().mode, "offline");
  assert.equal(c2.get().online, false);
  assert.equal(c2.get().hidden, true);
  assert.equal(c2.get().source, "glasses");
});

test("start, toggle, mic chunk forwarding, and stop manage live WebSocket, media streams, and assertive announcements", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  const video = makeMockVideo();
  checker.attachVideo(video);

  await checker.start();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().camera, "on");
  assert.equal(checker.get().cameraPerm, "granted");
  assert.equal(checker.get().mic, "on");
  assert.equal(checker.get().micPerm, "granted");
  assert.equal(checker.get().micLabel, "Ray-Ban Mic");
  assert.equal(checker.get().autoStopAt, BASE_NOW + 45_000);
  assert.equal(video.srcObject, env.lastCameraStream);
  assert.equal(video.playCalls, 1);

  assert.ok(
    announcements.some(
      (a) => a.msg === "Check started. Camera and microphone on. Hold the item up in front of you." && a.politeness === "assertive",
    ),
  );

  assert.equal(env.sockets.length, 1);
  const ws = env.sockets[0];
  assert.ok(ws.url.startsWith(WS_LIVE_PREFIX));
  ws.serverOpen();
  assert.equal(checker.get().conn, "open");
  assert.equal(ws.sent[0]?.type, "start");
  if (ws.sent[0]?.type === "start") {
    assert.equal(ws.sent[0].source, "phone");
    assert.equal(ws.sent[0].voice, true);
    assert.deepEqual(ws.sent[0].features, ["scene", "datamatrix", "addmed", "sonar"]);
  }

  const startsBeforeNoop = env.cameraStarts;
  await checker.start();
  assert.equal(env.cameraStarts, startsBeforeNoop);

  const worklet = env.workletNodes[0];
  assert.ok(worklet);
  worklet.emitChunk(new Int16Array([1000, -1000, 500, -500]), 0.42);
  assert.equal(checker.get().micLevel, 0.42);
  assert.ok(ws.sent.some((m) => m.type === "audio" && m.data.length > 0));

  const camTrack = env.lastCameraStream?.videoTracks[0];
  const micTrack = env.lastMicStream?.audioTracks[0];

  await checker.stop();
  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().mic, "off");
  assert.equal(checker.get().conn, "idle");
  assert.equal(checker.get().autoStopAt, null);
  assert.equal(video.srcObject, null);
  assert.ok((camTrack?.stopCalls ?? 0) >= 1);
  assert.ok((micTrack?.stopCalls ?? 0) >= 1);
  assert.ok(ws.sent.some((m) => m.type === "event" && m.name === "stop"));
  assert.ok(announcements.some((a) => a.msg === "Check stopped. Camera and microphone off." && a.politeness === "assertive"));

  checker.toggle();
  await flushMicrotasks();
  assert.equal(checker.get().running, true);
  checker.toggle();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
});

test("primary dispatches start when idle, snapshot in snapshot mode, and stop in live or offline modes", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const chA = new BroadcastChannel("holdup-test");
  const chB = new BroadcastChannel("holdup-test");
  const received: unknown[] = [];
  chB.onmessage = (ev: MessageEvent) => received.push(ev.data);
  chA.postMessage({ type: "hud_event", name: "repeat" });
  assert.deepEqual(received, [{ type: "hud_event", name: "repeat" }]);
  chA.close();
  chB.close();

  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  checker.primary();
  await flushMicrotasks();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "live");

  t.mock.timers.tick(400);
  checker.toggleSnapshotMode();
  assert.equal(checker.get().mode, "snapshot");

  const verifyCallsBefore = env.fetchCalls.filter((c) => c.url === "/api/verify").length;
  checker.primary();
  await flushMicrotasks();
  const verifyCallsAfter = env.fetchCalls.filter((c) => c.url === "/api/verify").length;
  assert.equal(verifyCallsAfter, verifyCallsBefore + 1);
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().verdictVia, "snapshot");

  checker.backToLive();
  assert.equal(checker.get().mode, "live");
  checker.primary();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);

  env.online = false;
  const socketsBeforeOffline = env.sockets.length;
  await checker.start();
  assert.equal(checker.get().running, true);
  assert.equal(checker.get().mode, "offline");
  assert.equal(env.sockets.length, socketsBeforeOffline);
  assert.ok(
    announcements.some(
      (a) =>
        a.msg === "You're offline. I can recognise your saved medicines by barcode, but I can't read new labels." &&
        a.politeness === "assertive",
    ),
  );

  checker.primary();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
});

test("camera and microphone permission failures surface recovery banners and assertive announcements", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);

  env.cameraError = { name: "NotAllowedError" };
  env.micError = null;
  const c1 = createChecker();
  await flushMicrotasks();
  await c1.start();

  assert.equal(c1.get().camera, "error");
  assert.equal(c1.get().cameraPerm, "denied");
  assert.equal(c1.get().mic, "on");
  assert.equal(c1.get().banner?.title, "Camera not available");
  assert.equal(c1.get().banner?.action, "settings");
  assert.ok(c1.get().banner?.detail?.includes("You said no to the camera."));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Camera not available. You said no to the camera. That's fine. You can turn it on any time." && a.politeness === "assertive",
    ),
  );
  await c1.stop();

  env.cameraError = { name: "NotFoundError" };
  env.micError = null;
  const c2 = createChecker();
  await c2.start();
  assert.equal(c2.get().cameraPerm, "unavailable");
  assert.equal(c2.get().banner?.action, "snapshot");
  await c2.stop();

  announcements.length = 0;
  env.cameraError = null;
  env.micError = { name: "NotAllowedError" };
  const c3 = createChecker();
  await c3.start();
  assert.equal(c3.get().camera, "on");
  assert.equal(c3.get().mic, "error");
  assert.equal(c3.get().micPerm, "denied");
  assert.equal(c3.get().banner?.title, "Microphone not available");
  assert.equal(c3.get().banner?.action, "settings");
  assert.ok(
    announcements.some(
      (a) => a.msg === "Microphone not available. You can type your question instead." && a.politeness === "assertive",
    ),
  );
  await c3.stop();

  announcements.length = 0;
  env.cameraError = { name: "NotAllowedError" };
  env.micError = { name: "NotAllowedError" };
  const c4 = createChecker();
  await c4.start();
  assert.equal(c4.get().camera, "error");
  assert.equal(c4.get().mic, "error");
  assert.equal(c4.get().banner?.title, "Camera and microphone not available");
  assert.equal(c4.get().banner?.action, "settings");
  assert.ok(c4.get().banner?.detail?.includes("Type your question below"));
  assert.ok(announcements.some((a) => a.msg.startsWith("Camera not available.") && a.politeness === "assertive"));
  assert.ok(announcements.some((a) => a.msg.startsWith("Microphone not available.") && a.politeness === "assertive"));
  await c4.stop();
});

test("45s privacy AUTO_STOP_MS timer re-arms on assistant activity and both client and server auto-stop shut camera off", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws1 = env.sockets[0];
  ws1.serverOpen();
  assert.equal(checker.get().autoStopAt, BASE_NOW + 45_000);

  t.mock.timers.tick(30_000);
  assert.equal(checker.get().running, true);

  ws1.serverSend({ type: "transcript", role: "assistant", text: "Hold the box closer.", final: false });
  assert.equal(checker.get().autoStopAt, BASE_NOW + 30_000 + 45_000);

  t.mock.timers.tick(44_999);
  assert.equal(checker.get().running, true);

  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().mic, "off");
  assert.equal(checker.get().autoStopAt, null);
  assert.ok(env.spoken.some((s) => s === "No label for 45 seconds. I've turned the camera off." || s === "Camera off."));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
    ),
  );

  announcements.length = 0;
  env.spoken.length = 0;
  await checker.start();
  const ws2 = env.sockets[1];
  ws2.serverOpen();

  ws2.serverSend({ type: "status", live: "closed", detail: "Auto-stop after 45s idle" });
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().serverLive, null);
  assert.ok(env.spoken.some((s) => s === "No label for 45 seconds. I've turned the camera off." || s === "Camera off."));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Stopped automatically after 45 seconds without a label. Camera off." && a.politeness === "assertive",
    ),
  );
});

test("onServer ready, cumulative vs final transcripts, user barge-in flush and stopSpeaking, and interrupted work end-to-end", async (t) => {
  const { createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  assert.equal(checker.feature("scene"), true);
  assert.equal(checker.feature("addmed"), true);

  ws.serverSend({ type: "ready", model: "gemini-3.8-live", session: "S999", features: ["scene", "sonar"] });
  assert.equal(checker.get().model, "gemini-3.8-live");
  assert.equal(checker.get().session, "S999");
  assert.deepEqual(checker.get().serverFeatures, ["scene", "sonar"]);
  assert.equal(checker.feature("sonar"), true);
  assert.equal(checker.feature("addmed"), false);
  assert.equal(checker.feature("datamatrix"), false);

  const pcmChunk = Buffer.from(new Int16Array([2000, -2000, 1500, -1500]).buffer).toString("base64");
  ws.serverSend({ type: "audio", data: pcmChunk });
  assert.equal(checker.get().speaking, true);
  const firstSource = env.bufferSources[env.bufferSources.length - 1];
  assert.equal(firstSource.started, true);
  assert.equal(firstSource.stopped, false);

  ws.serverSend({ type: "transcript", role: "assistant", text: "Turn it", final: false });
  assert.equal(checker.get().captions.length, 1);
  const firstId = checker.get().captions[0].id;
  assert.equal(checker.get().captions[0].text, "Turn it");
  assert.equal(checker.get().captions[0].final, false);

  ws.serverSend({ type: "transcript", role: "assistant", text: "Turn it a little left", final: false });
  assert.equal(checker.get().captions.length, 1);
  assert.equal(checker.get().captions[0].id, firstId);
  assert.equal(checker.get().captions[0].text, "Turn it a little left");

  ws.serverSend({ type: "transcript", role: "assistant", text: "Turn it a little left.", final: true });
  assert.equal(checker.get().captions.length, 1);
  assert.equal(checker.get().captions[0].id, firstId);
  assert.equal(checker.get().captions[0].final, true);

  ws.serverSend({ type: "transcript", role: "assistant", text: "Closer now.", final: true });
  assert.equal(checker.get().captions.length, 2);
  assert.equal(checker.get().captions[1].id, firstId + 1);

  const cancelsBeforeWhitespace = env.speechCancels;
  ws.serverSend({ type: "transcript", role: "user", text: "   ", final: false });
  assert.equal(checker.get().speaking, true);
  assert.equal(env.speechCancels, cancelsBeforeWhitespace);

  const cancelsBeforeBargeIn = env.speechCancels;
  ws.serverSend({ type: "transcript", role: "user", text: "Wait, is this evening?", final: true });
  assert.equal(checker.get().speaking, false);
  assert.equal(firstSource.stopped, true);
  assert.equal(env.speechCancels, cancelsBeforeBargeIn + 1);

  ws.serverSend({ type: "audio", data: pcmChunk });
  assert.equal(checker.get().speaking, true);
  ws.serverSend({ type: "interrupted" });
  assert.equal(checker.get().speaking, false);
});

test("onServer coach cues announce when voice is off, checking toggles spinner state, and hud announces connection changes", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  announcements.length = 0;

  ws.serverSend({ type: "coach", cue: "rotate_left", text: "Turn it left" });
  assert.equal(checker.get().cue?.cue, "rotate_left");
  assert.equal(checker.get().cue?.text, "Turn it left");
  assert.ok(!announcements.some((a) => a.msg === "Turn it left"));

  saveSettings({ ...loadSettings(), voice: false });
  ws.serverSend({ type: "coach", cue: "ok", text: "Got it" });
  assert.equal(checker.get().cue?.cue, "ok");
  assert.ok(announcements.some((a) => a.msg === "Got it" && a.politeness === "polite"));

  ws.serverSend({ type: "checking", phase: "start" });
  assert.equal(checker.get().checking, true);
  assert.equal(checker.get().cue, null);
  assert.ok(announcements.some((a) => a.msg === "Checking\u2026" && a.politeness === "polite"));

  ws.serverSend({ type: "checking", phase: "end" });
  assert.equal(checker.get().checking, false);

  announcements.length = 0;
  ws.serverSend({ type: "hud", connected: true });
  assert.equal(checker.get().hudConnected, true);
  assert.equal(announcements.filter((a) => a.msg === "Display connected.").length, 1);

  ws.serverSend({ type: "hud", connected: true });
  assert.equal(announcements.filter((a) => a.msg === "Display connected.").length, 1);

  ws.serverSend({ type: "hud", connected: false });
  assert.equal(checker.get().hudConnected, false);
  assert.ok(announcements.some((a) => a.msg === "Display disconnected."));
});

test("onServer verdict, hud_event actions (repeat, log_dose, dismiss), and dose_logged mirror without echo", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveProfile(demoProfile());

  const checker = createChecker();
  const profileChanges: Profile[] = [];
  checker.onProfileChange = (p) => profileChanges.push(p);
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  announcements.length = 0;
  env.spoken.length = 0;

  const v = makeSampleVerdict({ matchedMedId: "amlodipine", takenToday: false });
  ws.serverSend({ type: "verdict", verdict: v });

  assert.equal(checker.get().verdict?.headline, "Amlodipine 5 mg");
  assert.equal(checker.get().verdictVia, "live");
  assert.equal(env.spoken.length, 0);
  assert.ok(
    announcements.some(
      (a) => a.msg === "Match. Amlodipine 5 mg. Yes, Amlodipine 5 mg, your evening pill." && a.politeness === "assertive",
    ),
  );

  announcements.length = 0;
  ws.serverSend({ type: "hud_event", name: "repeat" });
  assert.ok(ws.sent.some((m) => m.type === "event" && m.name === "repeat"));
  assert.ok(announcements.some((a) => a.msg === v.speech && a.politeness === "assertive"));

  announcements.length = 0;
  ws.serverSend({ type: "hud_event", name: "log_dose" });
  assert.equal(checker.get().verdict?.takenToday, true);
  assert.equal(takenToday(loadProfile(), "amlodipine"), true);
  assert.equal(profileChanges.length, 1);
  assert.ok(ws.sent.some((m) => m.type === "event" && m.name === "log_dose"));
  assert.ok(announcements.some((a) => a.msg.startsWith("Logged Amlodipine at ") && a.politeness === "assertive"));

  ws.serverSend({ type: "hud_event", name: "dismiss" });
  assert.equal(checker.get().verdict, null);

  const metforminVerdict = makeSampleVerdict({
    headline: "Metformin 500 mg",
    speech: "Yes, Metformin 500 mg.",
    matchedMedId: "metformin",
    takenToday: false,
  });
  ws.serverSend({ type: "verdict", verdict: metforminVerdict });

  const sentCountBeforeVoiceLog = ws.sent.length;
  ws.serverSend({ type: "dose_logged", medId: "metformin", ts: Date.now() });

  assert.equal(ws.sent.length, sentCountBeforeVoiceLog);
  assert.equal(checker.get().verdict?.takenToday, true);
  assert.equal(takenToday(loadProfile(), "metformin"), true);
  assert.equal(profileChanges.length, 2);
});

test("recoverable vs non-recoverable server errors and status transitions govern snapshot fallback and live recovery", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  announcements.length = 0;

  ws.serverSend({ type: "error", code: "quota", message: "Rate limit exceeded.", recoverable: true });
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().lastError, "quota: Rate limit exceeded.");
  assert.ok(announcements.some((a) => a.msg === "The AI service is busy (quota reached)" && a.politeness === "polite"));

  announcements.length = 0;
  ws.serverSend({ type: "error", code: "gemini_unavailable", message: "Upstream 503.", recoverable: false });
  assert.equal(checker.get().mode, "snapshot");
  assert.equal(checker.get().lastError, "gemini_unavailable: Upstream 503.");
  assert.equal(checker.get().banner?.title, "Snapshot mode");
  assert.equal(checker.get().banner?.action, "snapshot");
  assert.ok(
    announcements.some(
      (a) => a.msg === "The live assistant had a problem. Switched to snapshot mode." && a.politeness === "assertive",
    ),
  );

  ws.serverSend({ type: "error", code: "bad_input", message: "Malformed audio.", recoverable: false });
  assert.equal(checker.get().mode, "snapshot");
  assert.equal(checker.get().banner?.tone, "bad");
  assert.equal(checker.get().banner?.title, "The server couldn't use that input");

  announcements.length = 0;
  ws.serverSend({ type: "status", live: "open", detail: "Recovered" });
  assert.equal(checker.get().mode, "live");
  assert.ok(announcements.some((a) => a.msg === "Live assistant is back." && a.politeness === "assertive"));

  ws.serverSend({ type: "status", live: "reconnecting", detail: "Resuming session" });
  assert.equal(checker.get().banner?.title, "Reconnecting to Gemini");
  assert.ok(announcements.some((a) => a.msg === "Reconnecting to the assistant."));

  ws.serverSend({ type: "status", live: "degraded", detail: "Quota" });
  assert.equal(checker.get().mode, "snapshot");
});

test("onDevice auto-switches glasses to phone on disconnect or unworn state, tolerates null worn, and warns at battery <= 15%", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses" });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");

  announcements.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: null, battery: 55, streaming: true, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");

  ws.serverSend({
    type: "device",
    device: { connected: true, worn: false, battery: 50, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "phone");
  assert.equal(loadSettings().source, "phone");
  assert.equal(checker.get().camera, "on");
  assert.ok(ws.sent.some((m) => m.type === "source" && m.source === "phone"));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Glasses taken off. Switched to the phone camera." && a.politeness === "assertive",
    ),
  );

  announcements.length = 0;
  await checker.setSource("glasses");
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.ok(ws.sent.some((m) => m.type === "source" && m.source === "glasses"));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Using the glasses camera. The phone camera is off." && a.politeness === "assertive",
    ),
  );

  announcements.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: false, worn: false, battery: 15, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");
  assert.ok(
    announcements.some(
      (a) => a.msg === "Glasses disconnected. Switched to the phone camera." && a.politeness === "assertive",
    ),
  );
  assert.ok(
    announcements.some((a) => a.msg === "Glasses battery low: 15 percent." && a.politeness === "assertive"),
  );

  announcements.length = 0;
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 12, streaming: true, source: "phone" },
  });
  assert.ok(announcements.some((a) => a.msg === "Glasses connected."));
  assert.ok(!announcements.some((a) => a.msg.startsWith("Glasses battery low:")));

  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 30, streaming: true, source: "phone" },
  });
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: true, battery: 9, streaming: true, source: "phone" },
  });
  assert.ok(
    announcements.some((a) => a.msg === "Glasses battery low: 9 percent." && a.politeness === "assertive"),
  );
});

test("onVisibility pauses phone camera when document is hidden and resumes camera when visible again", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  assert.equal(checker.get().camera, "on");
  const initialTrack = env.lastCameraStream?.videoTracks[0];

  env.visibilityState = "hidden";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, true);
  assert.equal(checker.get().camera, "paused");
  assert.equal(initialTrack?.stopCalls, 1);

  announcements.length = 0;
  env.visibilityState = "visible";
  await env.docEvents.emit("visibilitychange");
  assert.equal(checker.get().hidden, false);
  assert.equal(checker.get().camera, "on");
  assert.ok(announcements.some((a) => a.msg === "Welcome back. Camera resumed." && a.politeness === "polite"));

  await checker.setSource("glasses");
  const camStartsBefore = env.cameraStarts;
  env.visibilityState = "hidden";
  await env.docEvents.emit("visibilitychange");
  env.visibilityState = "visible";
  await env.docEvents.emit("visibilitychange");
  assert.equal(env.cameraStarts, camStartsBefore);
});

test("onReadiness enforces quiet, sonar flag, addProposal, 3s post-verdict cooldown, and announces Readable once at >= 0.8", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();
  announcements.length = 0;

  saveSettings({ ...loadSettings(), quiet: true });
  ws.serverSend({ type: "readiness", value: 0.9 });
  assert.equal(checker.get().readiness, null);
  assert.ok(!announcements.some((a) => a.msg === "Readable."));

  saveSettings({
    ...loadSettings(),
    quiet: false,
    features: { ...loadSettings().features, sonar: false },
  });
  ws.serverSend({ type: "readiness", value: 0.9 });
  assert.equal(checker.get().readiness, null);

  saveSettings({
    ...loadSettings(),
    quiet: false,
    sonarVolume: 0.5,
    features: { ...loadSettings().features, sonar: true },
  });

  env.sonarTargetHz.length = 0;
  ws.serverSend({ type: "readiness", value: 0.5 });
  assert.equal(checker.get().readiness, 0.5);
  assert.ok(env.sonarTargetHz.includes(440));
  assert.ok(!announcements.some((a) => a.msg === "Readable."));

  ws.serverSend({ type: "readiness", value: 0.85 });
  assert.equal(checker.get().readiness, 0.85);
  assert.equal(announcements.filter((a) => a.msg === "Readable.").length, 1);

  ws.serverSend({ type: "readiness", value: 0.92 });
  ws.serverSend({ type: "readiness", value: 0.6 });
  ws.serverSend({ type: "readiness", value: 0.88 });
  assert.equal(announcements.filter((a) => a.msg === "Readable.").length, 1);

  t.mock.timers.tick(1_600);
  assert.equal(checker.get().readiness, null);

  t.mock.timers.tick(9_000);
  ws.serverSend({ type: "readiness", value: 0.82 });
  assert.equal(announcements.filter((a) => a.msg === "Readable.").length, 2);

  ws.serverSend({
    type: "profile_add",
    proposalId: "prop-gate",
    med: { id: "lisinopril", name: "Lisinopril", ingredient: "lisinopril", strength: "10 mg", schedule: ["morning"] },
    speech: "I read Lisinopril 10 mg.",
  });
  assert.equal(checker.get().readiness, null);
  ws.serverSend({ type: "readiness", value: 0.9 });
  assert.equal(checker.get().readiness, null);
  checker.answerProposal(false);

  ws.serverSend({ type: "verdict", verdict: makeSampleVerdict() });
  assert.equal(checker.get().readiness, null);

  t.mock.timers.tick(2_500);
  ws.serverSend({ type: "readiness", value: 0.7 });
  assert.equal(checker.get().readiness, null);

  t.mock.timers.tick(501);
  ws.serverSend({ type: "readiness", value: 0.7 });
  assert.equal(checker.get().readiness, 0.7);
});

test("onProfileAdd and answerProposal enforce explicit confirmation, save/reject, replacement, flag gating, and 60s timeout", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveProfile(demoProfile());

  const checker = createChecker();
  const updatedProfiles: Profile[] = [];
  checker.onProfileChange = (p) => updatedProfiles.push(p);
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  saveSettings({
    ...loadSettings(),
    features: { ...loadSettings().features, addmed: false },
  });
  ws.serverSend({
    type: "profile_add",
    proposalId: "p-disabled",
    med: { id: "ramipril", name: "Ramipril", ingredient: "ramipril", strength: "5 mg", schedule: ["morning"] },
    speech: "Ramipril 5 mg.",
  });
  assert.equal(checker.get().addProposal, null);
  assert.ok(ws.sent.some((m) => m.type === "profile_add_result" && m.proposalId === "p-disabled" && m.accepted === false));

  saveSettings({
    ...loadSettings(),
    features: { ...loadSettings().features, addmed: true },
  });
  announcements.length = 0;

  const collidingMed: Med = {
    id: "amlodipine",
    name: "Lisinopril",
    ingredient: "lisinopril",
    strength: "10 mg",
    schedule: ["morning"],
    gtin: "06416542005218",
  };
  ws.serverSend({
    type: "profile_add",
    proposalId: "p-accept",
    med: collidingMed,
    speech: "I read Lisinopril 10 mg, taken in the morning.",
  });

  assert.equal(checker.get().addProposal?.proposalId, "p-accept");
  assert.equal(checker.get().addProposal?.expiresAt, Date.now() + 60_000);
  assert.equal(loadProfile().meds.length, 3);
  assert.ok(
    announcements.some(
      (a) =>
        a.msg === "I read Lisinopril 10 mg, taken in the morning. Add Lisinopril 10 mg, morning to your list? Double-tap Add to confirm, or Cancel." &&
        a.politeness === "assertive",
    ),
  );

  announcements.length = 0;
  checker.answerProposal(true);
  assert.equal(checker.get().addProposal, null);
  const afterAccept = loadProfile();
  assert.equal(afterAccept.meds.length, 4);
  const savedMed = afterAccept.meds[3];
  assert.equal(savedMed.name, "Lisinopril");
  assert.notEqual(savedMed.id, "amlodipine");
  assert.match(savedMed.id, /^lisinopril-[a-z0-9]{4}$/);
  assert.equal(updatedProfiles.length, 1);
  assert.ok(
    announcements.some(
      (a) => a.msg.startsWith("Added Lisinopril 10 mg, morning to your list. Saved on this phone only.") && a.politeness === "assertive",
    ),
  );
  assert.ok(
    ws.sent.some(
      (m) => m.type === "profile_add_result" && m.proposalId === "p-accept" && m.accepted === true && m.med?.id === savedMed.id,
    ),
  );

  announcements.length = 0;
  ws.serverSend({
    type: "profile_add",
    proposalId: "p-reject",
    med: { id: "warfarin", name: "Warfarin", ingredient: "warfarin", strength: "3 mg", schedule: ["evening"] },
    speech: "Warfarin 3 mg.",
  });
  checker.answerProposal(false);
  assert.equal(loadProfile().meds.length, 4);
  assert.ok(announcements.some((a) => a.msg === "Not added." && a.politeness === "assertive"));
  assert.ok(ws.sent.some((m) => m.type === "profile_add_result" && m.proposalId === "p-reject" && m.accepted === false));

  ws.serverSend({
    type: "profile_add",
    proposalId: "p-first",
    med: { id: "med-a", name: "Med A", ingredient: "a", strength: "1 mg", schedule: [] },
    speech: "Med A.",
  });
  ws.serverSend({
    type: "profile_add",
    proposalId: "p-second",
    med: { id: "med-b", name: "Med B", ingredient: "b", strength: "2 mg", schedule: [] },
    speech: "Med B.",
  });
  assert.ok(ws.sent.some((m) => m.type === "profile_add_result" && m.proposalId === "p-first" && m.accepted === false));
  assert.equal(checker.get().addProposal?.proposalId, "p-second");

  announcements.length = 0;
  t.mock.timers.tick(30_000);
  ws.serverSend({ type: "transcript", role: "assistant", text: "Tap Add on your phone if that looks right.", final: true });
  t.mock.timers.tick(30_000);
  assert.equal(checker.get().addProposal, null);
  assert.equal(loadProfile().meds.length, 4);
  assert.ok(announcements.some((a) => a.msg === "No answer, so I didn't add it." && a.politeness === "assertive"));
  assert.ok(ws.sent.some((m) => m.type === "profile_add_result" && m.proposalId === "p-second" && m.accepted === false));

  ws.serverSend({
    type: "profile_add",
    proposalId: "p-on-stop",
    med: { id: "med-c", name: "Med C", ingredient: "c", strength: "5 mg", schedule: [] },
    speech: "Med C.",
  });
  assert.equal(checker.get().addProposal?.proposalId, "p-on-stop");
  await checker.stop();
  assert.equal(checker.get().addProposal, null);
  assert.equal(loadProfile().meds.length, 4);
});

test("injectCode and camera barcode scan match offline barcodes and GS1 DataMatrix GTINs and send online datamatrix frames", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t, { online: false });
  saveProfile(demoProfile());

  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  assert.equal(checker.get().mode, "offline");

  const validGs1 = "01064165420021491728123110BATCH7\x1d21SER42";
  checker.injectCode(validGs1);
  assert.equal(checker.get().lastCode?.gtin, "06416542002149");
  assert.equal(checker.get().lastCode?.expiry, "2028-12-31");
  assert.equal(checker.get().lastCode?.batch, "BATCH7");
  assert.equal(checker.get().lastCode?.serial, "SER42");
  assert.equal(checker.get().verdict?.level, "match");
  assert.equal(checker.get().verdict?.matchedMedId, "amlodipine");
  assert.equal(checker.get().verdictVia, "offline");
  assert.equal(checker.get().verdict?.crossCheck?.source, "datamatrix");

  const expiredGs1 = "01064165420021491724011510OLD1";
  checker.injectCode(expiredGs1);
  assert.equal(checker.get().verdict?.level, "warning");
  assert.ok(checker.get().verdict?.headline.includes("expired"));

  const unknownGs1 = "010999999999999917290500";
  checker.injectCode(unknownGs1);
  assert.equal(checker.get().verdict?.level, "unsure");
  assert.equal(checker.get().verdict?.headline, "Pack code not on your list");

  announcements.length = 0;
  env.detectedCodes = [{ rawValue: "6416542003375", format: "ean_13" }];
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(checker.get().verdict?.level, "match");
  assert.equal(checker.get().verdict?.matchedMedId, "metformin");
  assert.equal(checker.get().verdict?.headline, "Metformin 500 mg (barcode match)");
  const matchAnnouncements = announcements.filter((a) => a.msg.includes("Metformin 500 mg")).length;
  assert.equal(matchAnnouncements, 1);

  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(announcements.filter((a) => a.msg.includes("Metformin 500 mg")).length, 1);

  env.detectedCodes = [{ rawValue: "1234567890128", format: "ean_13" }];
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(checker.get().verdict?.level, "unsure");
  assert.equal(checker.get().verdict?.headline, "Not one of your saved barcodes");
  env.detectedCodes = [];

  await checker.stop();

  env.online = true;
  const onlineChecker = createChecker();
  await flushMicrotasks();
  await onlineChecker.start();
  const ws = env.sockets[env.sockets.length - 1];
  ws.serverOpen();
  announcements.length = 0;

  const onlinePackCode = "01064165420048601727080010LOT9";
  onlineChecker.injectCode(onlinePackCode);
  assert.equal(onlineChecker.get().lastCode?.gtin, "06416542004860");
  assert.equal(onlineChecker.get().lastCode?.expiry, "2027-08");
  assert.ok(ws.sent.some((m) => m.type === "datamatrix" && m.raw === onlinePackCode));
  assert.ok(
    announcements.some(
      (a) => a.msg === "Pack code read, expiry 2027-08. Double-checking the label." && a.politeness === "polite",
    ),
  );
});

test("snapshot uses sharpest phone FrameRing pictures, sends 0-frame session verify for glasses, and handles AuthError", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  announcements.length = 0;

  await checker.snapshot();
  assert.equal(env.fetchCalls.filter((c) => c.url === "/api/verify").length, 0);
  assert.ok(
    announcements.some(
      (a) => a.msg === "I don't have a picture yet. Hold the label up to the camera, or take a photo." && a.politeness === "assertive",
    ),
  );

  env.frameContrast = 5;
  env.framePayload = "frame-low";
  t.mock.timers.tick(400);

  env.frameContrast = 30;
  env.framePayload = "frame-sharpest";
  t.mock.timers.tick(1_000);

  env.frameContrast = 18;
  env.framePayload = "frame-second";
  t.mock.timers.tick(1_000);

  await checker.snapshot(undefined, "Is this my evening pill?");
  assert.equal(checker.get().snapshotBusy, false);
  const verifyCallPhone = env.fetchCalls.find((c) => c.url === "/api/verify");
  assert.ok(verifyCallPhone);
  const phoneBody = verifyCallPhone.body as { frames?: string[]; session?: string; question?: string };
  assert.deepEqual(phoneBody.frames, ["frame-sharpest", "frame-second"]);
  assert.equal(phoneBody.session, checker.get().session);
  assert.equal(phoneBody.question, "Is this my evening pill?");
  assert.equal(checker.get().verdictVia, "snapshot");

  await checker.setSource("glasses");
  env.fetchCalls = [];
  await checker.snapshot(undefined, "Check from glasses");
  const verifyCallGlasses = env.fetchCalls.find((c) => c.url === "/api/verify");
  assert.ok(verifyCallGlasses);
  const glassesBody = verifyCallGlasses.body as Record<string, unknown>;
  assert.equal("frames" in glassesBody, false);
  assert.equal(glassesBody.session, checker.get().session);
  assert.equal(glassesBody.question, "Check from glasses");

  env.verifyReply = () => ({ networkError: true });
  await checker.snapshot();
  assert.equal(checker.get().mode, "offline");
  assert.equal(checker.get().banner?.title, "Offline mode");

  env.online = true;
  await env.windowEvents.emit("online");
  await flushMicrotasks();

  announcements.length = 0;
  env.verifyReply = () => ({ status: 401, json: { message: "Unauthorized" } });
  await checker.snapshot();
  await flushMicrotasks();
  assert.equal(checker.get().authNeeded, true);
  assert.equal(checker.get().health, "unreachable");
  assert.equal(checker.get().running, false);
  assert.ok(
    announcements.some(
      (a) => a.msg === "Access key needed. This HoldUp server only accepts people with its link." && a.politeness === "assertive",
    ),
  );
});

test("checkHealth and retryKey detect HOLDUP_KEY requirement via /api/stats, recover with key, and fall back offline after 2 failures", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  env.statsReply = () => ({ status: 403, json: { message: "Key required" } });

  const checker = createChecker();
  await flushMicrotasks();

  assert.equal(checker.get().authNeeded, true);
  assert.equal(checker.get().health, "unreachable");
  assert.ok(
    announcements.some(
      (a) => a.msg === "Access key needed. This HoldUp server only accepts people with its link." && a.politeness === "assertive",
    ),
  );

  setAccessKey("gate-pass");
  env.statsReply = () => ({ status: 200, json: { calls: 1 } });
  env.fetchCalls = [];

  await checker.retryKey();
  assert.equal(checker.get().authNeeded, false);
  assert.equal(checker.get().health, "ok");
  const statsCall = env.fetchCalls.find((c) => c.url === "/api/stats");
  assert.equal(statsCall?.headers["x-holdup-key"], "gate-pass");

  env.healthReply = () => ({ status: 200, json: { ok: true, gemini: "down" } });
  await checker.checkHealth();
  assert.equal(checker.get().health, "down");

  env.healthReply = () => ({ networkError: true });
  await checker.checkHealth();
  assert.equal(checker.get().health, "unreachable");
  assert.equal(checker.get().mode, "live");

  await checker.checkHealth();
  assert.equal(checker.get().health, "unreachable");
  assert.equal(checker.get().mode, "offline");

  env.healthReply = () => ({ status: 200, json: { ok: true, gemini: "ok" } });
  await checker.checkHealth();
  assert.equal(checker.get().health, "ok");
  assert.equal(checker.get().online, true);
  assert.equal(checker.get().mode, "snapshot");
});

test("onConn reconnect escalation, onRtt adaptive FramePolicy announcements, and sendText across live, snapshot, and offline modes", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  const checker = createChecker();
  const video = makeMockVideo();
  checker.attachVideo(video);
  await flushMicrotasks();

  await checker.start();
  const ws1 = env.sockets[0];

  checker.sendText("  Is this my evening pill?  ");
  assert.equal(checker.get().captions.length, 1);
  assert.equal(checker.get().captions[0].text, "Is this my evening pill?");

  ws1.serverOpen();
  assert.equal(ws1.sent[0]?.type, "start");
  assert.deepEqual(ws1.sent[1], { type: "text", text: "Is this my evening pill?" });

  announcements.length = 0;
  ws1.serverSend({ type: "pong", t: Date.now() - 1_700 });
  assert.equal(checker.get().policy.tier, "very-slow");
  assert.ok(announcements.some((a) => a.msg === "Slow connection. Sending fewer pictures to keep up."));

  ws1.serverSend({ type: "pong", t: Date.now() - 120 });
  assert.equal(checker.get().policy.tier, "normal");
  assert.ok(announcements.some((a) => a.msg === "Connection is fast again."));

  announcements.length = 0;
  ws1.serverClose(1006, "Drop 1");
  assert.equal(checker.get().conn, "reconnecting");
  assert.equal(checker.get().connAttempt, 1);
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().banner?.title, "Connection lost, reconnecting");
  assert.ok(announcements.some((a) => a.msg === "Connection lost. Reconnecting."));

  t.mock.timers.tick(1_000);
  const ws2 = env.sockets[1];
  assert.ok(ws2);
  ws2.serverClose(1006, "Drop 2");
  assert.equal(checker.get().connAttempt, 2);
  assert.equal(checker.get().mode, "snapshot");
  assert.ok(
    announcements.some(
      (a) => a.msg === "Connection lost. Switched to snapshot mode. I'll keep trying to reconnect." && a.politeness === "assertive",
    ),
  );

  t.mock.timers.tick(400);
  const verifyBeforeText = env.fetchCalls.filter((c) => c.url === "/api/verify").length;
  checker.sendText("Check strength please");
  await flushMicrotasks();
  assert.equal(env.fetchCalls.filter((c) => c.url === "/api/verify").length, verifyBeforeText + 1);

  t.mock.timers.tick(2_000);
  const ws3 = env.sockets[env.sockets.length - 1];
  ws3.serverOpen();
  assert.equal(checker.get().mode, "live");

  env.online = false;
  await env.windowEvents.emit("offline");
  await flushMicrotasks();
  assert.equal(checker.get().mode, "offline");
  const capsBeforeOfflineText = checker.get().captions.length;
  checker.sendText("What is this box?");
  assert.equal(checker.get().captions.length, capsBeforeOfflineText + 2);
  assert.equal(
    checker.get().captions[checker.get().captions.length - 1].text,
    "Offline: I can only check your saved medicines by barcode right now.",
  );
});

test("unexpected camera and mic track termination, audio route changes, offlineCheckImage, and startSetupByVoice recover cleanly", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveProfile(demoProfile());

  const checker = createChecker();
  await flushMicrotasks();

  await checker.startSetupByVoice();
  assert.equal(checker.get().running, true);
  const ws = env.sockets[0];
  ws.serverOpen();
  assert.ok(
    ws.sent.some(
      (m) => m.type === "text" && m.text === "I want to add my medicines to my list. I'll hold up each box and tell you when I take it.",
    ),
  );

  announcements.length = 0;
  const camTrack = env.lastCameraStream?.videoTracks[0];
  await camTrack?.triggerEnded();
  assert.equal(checker.get().camera, "error");
  assert.equal(checker.get().cameraMsg, "The camera stopped. Another app may have taken it.");
  assert.ok(announcements.some((a) => a.msg === "The camera stopped." && a.politeness === "assertive"));

  announcements.length = 0;
  const micStartsBefore = env.micStarts;
  const micTrack = env.lastMicStream?.audioTracks[0];
  await micTrack?.triggerEnded();
  await flushMicrotasks();
  assert.equal(env.micStarts, micStartsBefore + 1);
  assert.equal(checker.get().mic, "on");
  assert.ok(announcements.some((a) => a.msg === "Microphone disconnected. Switching microphone."));

  announcements.length = 0;
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Phone Mic" },
    { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
  ] as MediaDeviceInfo[];
  await env.mediaDeviceEvents.emit("devicechange");
  assert.equal(checker.get().route, "Phone Speaker");
  assert.ok(announcements.some((a) => a.msg === "Audio now through Phone Speaker." && a.politeness === "assertive"));

  const fakeFile = new Blob(["fake-image"], { type: "image/jpeg" }) as unknown as File;
  env.detectedCodes = [];
  announcements.length = 0;
  await checker.offlineCheckImage(fakeFile);
  assert.ok(
    announcements.some(
      (a) => a.msg === "I couldn't find a barcode in that photo. Try the side of the box with the stripes." && a.politeness === "assertive",
    ),
  );

  env.detectedCodes = [{ rawValue: "6416542004860", format: "ean_13" }];
  await checker.offlineCheckImage(fakeFile);
  await flushMicrotasks();
  assert.equal(checker.get().verdict?.matchedMedId, "atorvastatin");
  assert.equal(checker.get().verdictVia, "offline");
});

test("mediaSession Bluetooth actions, profileChanged start sync, simulateDrop, MOCK_HUD_CHANNEL hud_hello, and shell cache cleanup", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveProfile(demoProfile());

  assert.equal(MOCK_HUD_CHANNEL, "holdup-hud-mock");
  const phoneHud = mockHudChannel();
  assert.ok(phoneHud);
  const lateHud = new BroadcastChannel(MOCK_HUD_CHANNEL);
  const hudReplayed: Array<{ type?: string }> = [];
  lateHud.onmessage = (ev: MessageEvent) => {
    hudReplayed.push(ev.data as { type?: string });
  };
  lateHud.postMessage({ type: "hud_hello" });
  await flushMicrotasks();
  for (const m of hudReplayed) {
    assert.ok(m.type === "status" || m.type === "device" || m.type === "coach" || m.type === "verdict");
  }
  lateHud.close();
  phoneHud.close();

  const swPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/sw.js");
  const swSource = fs.readFileSync(swPath, "utf8");
  const swCacheMatch = swSource.match(/const\s+CACHE\s*=\s*["'](holdup-shell-v\d+)["']/);
  assert.ok(swCacheMatch);
  await caches.open(swCacheMatch[1]);
  assert.equal(env.cacheEntries.has(swCacheMatch[1]), true);
  await deleteAllData();
  assert.equal(env.cacheEntries.size, 0);

  saveProfile(demoProfile());
  const checker = createChecker();
  await flushMicrotasks();

  await checker.start();
  assert.equal(env.mediaSessionHandlers.has("play"), true);
  assert.equal(env.mediaSessionHandlers.has("pause"), true);
  assert.equal(env.mediaSessionHandlers.has("stop"), true);

  const ws1 = env.sockets[0];
  ws1.serverOpen();
  const startsBeforeProfileChange = ws1.sent.filter((m) => m.type === "start").length;
  const updatedProfile = { ...loadProfile(), allergies: [...loadProfile().allergies, "penicillin"] };
  saveProfile(updatedProfile);
  checker.profileChanged();
  const startMsgs = ws1.sent.filter((m) => m.type === "start");
  assert.equal(startMsgs.length, startsBeforeProfileChange + 1);
  const latestStart = startMsgs[startMsgs.length - 1];
  if (latestStart?.type === "start") {
    assert.ok(latestStart.profile.allergies.includes("penicillin"));
  }

  announcements.length = 0;
  checker.logDose();
  assert.ok(
    announcements.some((a) => a.msg === "There is no matched medicine to log." && a.politeness === "assertive"),
  );

  checker.toggleSnapshotMode();
  assert.equal(checker.get().mode, "snapshot");
  const unsureSpeech = "I'm not sure. I won't guess a dose. Turn the box slowly, or ask a pharmacist.";
  env.verifyReply = () => ({
    status: 200,
    json: makeSampleVerdict({
      level: "unsure",
      matchedMedId: undefined,
      headline: "Metformin (strength unclear)",
      speech: unsureSpeech,
    }),
  });
  env.spoken.length = 0;
  await checker.snapshot({ data: "c25hcA==", w: 640, h: 480, sharpness: 24, ts: Date.now() });
  await flushMicrotasks();
  assert.equal(checker.get().verdict?.level, "unsure");
  assert.ok(env.spoken.includes(unsureSpeech));

  env.spoken.length = 0;
  checker.repeat();
  await flushMicrotasks();
  assert.ok(env.spoken.includes(unsureSpeech));

  checker.backToLive();
  assert.equal(checker.get().mode, "live");
  checker.simulateDrop();
  assert.equal(ws1.closeCode, 4000);
  assert.equal(checker.get().conn, "reconnecting");

  env.mediaSessionHandlers.get("stop")?.();
  await flushMicrotasks();
  assert.equal(checker.get().running, false);
});

