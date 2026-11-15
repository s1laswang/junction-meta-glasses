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

type MockBufferSource = {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  disconnected: boolean;
  connect: (dest: unknown) => unknown;
  start: (when?: number) => void;
  stop: (when?: number) => void;
  disconnect: () => void;
};

type OscillatorRecord = {
  type: string;
  frequency: number;
  started: boolean;
  stopped: boolean;
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

  serverSend(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

class MockBroadcastChannel {
  static peers = new Map<string, Set<MockBroadcastChannel>>();
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    let set = MockBroadcastChannel.peers.get(name);
    if (!set) {
      set = new Set();
      MockBroadcastChannel.peers.set(name, set);
    }
    set.add(this);
  }

  postMessage(_data: unknown) {}

  close() {
    this.closed = true;
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
}

class MockAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = { kind: "destination" };
  audioWorklet = {
    addModule: async (_url: string) => {},
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
    const rec: OscillatorRecord = {
      type: "sine",
      frequency: 440,
      started: false,
      stopped: false,
    };
    env.oscillators.push(rec);
    const freq = {
      get value() {
        return rec.frequency;
      },
      set value(v: number) {
        rec.frequency = v;
      },
      setTargetAtTime(v: number) {
        rec.frequency = v;
      },
    };
    return {
      get type() {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: freq,
      connect(dest: unknown) {
        return dest;
      },
      start() {
        rec.started = true;
      },
      stop() {
        rec.stopped = true;
      },
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
      disconnected: false,
      connect(dest: unknown) {
        return dest;
      },
      start() {
        src.started = true;
      },
      stop() {
        src.stopped = true;
      },
      disconnect() {
        src.disconnected = true;
      },
    };
    env.bufferSources.push(src);
    return src;
  }
}

class MockBarcodeDetector {
  static async getSupportedFormats() {
    return ["ean_13", "data_matrix"];
  }
  async detect(_src: unknown): Promise<Array<{ rawValue: string; format: string }>> {
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

const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join("/");

const env = {
  windowEvents: makeEventMap(),
  docEvents: makeEventMap(),
  mediaDeviceEvents: makeEventMap(),
  online: true,
  visibilityState: "visible" as "visible" | "hidden",
  sockets: [] as MockWebSocket[],
  lastCameraStream: null as MockStream | null,
  lastMicStream: null as MockStream | null,
  cameraStarts: 0,
  micStarts: 0,
  micTrackLabel: "Ray-Ban Meta HFP Mic",
  devices: [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[],
  spoken: [] as Array<{ text: string; lang: string }>,
  speechCancels: 0,
  vibrations: [] as Array<number | number[]>,
  audioContexts: [] as MockAudioContext[],
  workletNodes: [] as MockAudioWorkletNode[],
  bufferSources: [] as MockBufferSource[],
  oscillators: [] as OscillatorRecord[],
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
      return {
        width: 160,
        height: 120,
        getContext() {
          return null;
        },
        toDataURL() {
          return "data:image/jpeg;base64,AA==";
        },
      };
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

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = rawUrl.startsWith(ORIGIN_HTTPS) ? rawUrl.slice(ORIGIN_HTTPS.length) || "/" : rawUrl;
    const status = url === "/api/health" || url === "/api/stats" ? 200 : 404;
    const bodyJson = url === "/api/health" ? { ok: true, gemini: "ok" } : url === "/api/stats" ? { calls: 0 } : { message: "Not Found" };
    const bodyText = JSON.stringify(bodyJson);
    const makeRes = (): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Not Found",
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
        if (u.volume > 0 && u.text.trim()) env.spoken.push({ text: u.text, lang: u.lang });
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
const { synthPcmChunks } = await import("../src/lib/audio.ts");
const { onAnnounce } = await import("../src/lib/feedback.ts");
const { setAccessKey } = await import("../src/lib/key.ts");
const { loadSettings, saveSettings } = await import("../src/lib/storage.ts");

function makeWarningVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    level: "warning",
    headline: "Ibuprofen 400 mg",
    speech: "This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs.",
    reasons: ["Not on medication list", "Avoid NSAIDs"],
    read: {
      kind: "medication",
      product: { value: "Ibuprofen", confidence: 0.97 },
      ingredient: { value: "ibuprofen", confidence: 0.96 },
      strength: { value: "400 mg", confidence: 0.95 },
      dosing: { value: null, confidence: 0 },
      expiry: { value: "2028-09", confidence: 0.91 },
      allergens: { value: null, confidence: 0 },
      barcode: { value: null, confidence: 0 },
      readability: 0.93,
    },
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const BASE_NOW = 1_763_160_000_000;
type Announcement = { msg: string; politeness: "polite" | "assertive" };

function setupTestEnv(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW });

  env.windowEvents.clear();
  env.docEvents.clear();
  env.mediaDeviceEvents.clear();
  MockBroadcastChannel.peers.clear();

  env.online = true;
  env.visibilityState = "visible";
  env.sockets = [];
  env.lastCameraStream = null;
  env.lastMicStream = null;
  env.cameraStarts = 0;
  env.micStarts = 0;
  env.micTrackLabel = "Ray-Ban Meta HFP Mic";
  env.devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
  ] as MediaDeviceInfo[];
  env.spoken = [];
  env.speechCancels = 0;
  env.vibrations = [];
  env.audioContexts = [];
  env.workletNodes = [];
  env.bufferSources = [];
  env.oscillators = [];

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

test("live glasses correction flushes Gemini PCM audio immediately, plays alert earcon, speaks checked sentence, announces assertively, and sets warning banner", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses", voice: true, earcons: true, haptics: true });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  assert.ok(ws);
  ws.serverOpen();

  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.equal(env.cameraStarts, 0);
  assert.equal(checker.get().route, "Ray-Ban Meta");

  const verdict = makeWarningVerdict();
  ws.serverSend({ type: "verdict", verdict });

  const chunks = synthPcmChunks([440, 523, 659], 180, 24000);
  for (const data of chunks) ws.serverSend({ type: "audio", data });

  assert.equal(env.bufferSources.length, 3);
  assert.equal(env.bufferSources.every((s) => s.started && !s.stopped), true);
  assert.equal(checker.get().speaking, true);
  assert.equal(env.spoken.length, 0);

  announcements.length = 0;
  env.oscillators = [];
  const cancelsBefore = env.speechCancels;

  ws.serverSend({
    type: "correction",
    speech: verdict.speech,
    reasons: ["affirmative_on_caution", "caution_dropped"],
  });

  assert.equal(checker.get().speaking, false);
  for (const src of env.bufferSources) {
    assert.equal(src.stopped, true);
    assert.equal(src.disconnected, true);
    assert.equal(src.onended, null);
  }

  assert.equal(env.oscillators.length, 2);
  assert.deepEqual(
    env.oscillators.map((o) => ({ type: o.type, frequency: o.frequency, started: o.started, stopped: o.stopped })),
    [
      { type: "triangle", frequency: 440, started: true, stopped: true },
      { type: "triangle", frequency: 349, started: true, stopped: true },
    ],
  );

  assert.equal(env.speechCancels, cancelsBefore + 1);
  assert.deepEqual(env.spoken, [{ text: verdict.speech, lang: "en-GB" }]);

  assert.deepEqual(announcements, [
    { msg: `Corrected answer: ${verdict.speech}`, politeness: "assertive" },
  ]);

  assert.deepEqual(checker.get().banner, {
    tone: "warn",
    title: "Corrected answer",
    detail: "The spoken answer didn't match the check, so HoldUp repeated the checked sentence.",
  });
});

test("user barge-in transcript flushes both PCM audio and browser speech after correction, and stop() cleans up glasses session state", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses", voice: true, earcons: true, haptics: true });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  const [chunk1, chunk2] = synthPcmChunks([392, 494], 180, 24000);
  ws.serverSend({ type: "audio", data: chunk1 });
  assert.equal(checker.get().speaking, true);

  ws.serverSend({
    type: "correction",
    speech: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.",
    reasons: ["strength_invented"],
  });
  assert.equal(checker.get().speaking, false);
  assert.equal(env.spoken.length, 1);

  ws.serverSend({ type: "audio", data: chunk2 });
  assert.equal(checker.get().speaking, true);
  const secondSource = env.bufferSources[env.bufferSources.length - 1];
  assert.equal(secondSource.stopped, false);

  const cancelsBeforeBlank = env.speechCancels;
  ws.serverSend({ type: "transcript", role: "user", text: "   ", final: false });
  assert.equal(checker.get().speaking, true);
  assert.equal(env.speechCancels, cancelsBeforeBlank);

  const cancelsBeforeBargeIn = env.speechCancels;
  ws.serverSend({ type: "transcript", role: "user", text: "Wait hold on", final: false });

  assert.equal(checker.get().speaking, false);
  assert.equal(secondSource.stopped, true);
  assert.equal(secondSource.disconnected, true);
  assert.equal(env.speechCancels, cancelsBeforeBargeIn + 1);
  assert.equal(checker.get().captions.at(-1)?.role, "user");
  assert.equal(checker.get().captions.at(-1)?.text, "Wait hold on");
  assert.equal(checker.get().captions.at(-1)?.final, false);

  ws.serverSend({ type: "transcript", role: "user", text: "Wait hold on please", final: true });
  assert.equal(checker.get().captions.length, 1);
  assert.equal(checker.get().captions.at(-1)?.text, "Wait hold on please");
  assert.equal(checker.get().captions.at(-1)?.final, true);

  ws.serverSend({ type: "audio", data: chunk1 });
  assert.equal(checker.get().speaking, true);
  const micTrack = env.lastMicStream?.audioTracks[0];
  const worklet = env.workletNodes[0];
  assert.ok(micTrack);
  assert.ok(worklet);

  announcements.length = 0;
  await checker.stop();

  assert.equal(checker.get().running, false);
  assert.equal(checker.get().speaking, false);
  assert.equal(checker.get().mic, "off");
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().conn, "idle");
  assert.equal(checker.get().banner, null);
  assert.equal(checker.get().cue, null);
  assert.equal(checker.get().autoStopAt, null);
  assert.equal(micTrack.readyState, "ended");
  assert.equal(worklet.port.closed, true);
  assert.equal(navigator.mediaSession.playbackState, "paused");
  assert.ok(
    announcements.some((a) => a.msg === "Check stopped. Camera and microphone off." && a.politeness === "assertive"),
  );
});

test("quiet or voice-off glasses mode still flushes PCM audio, announces correction assertively, and sets warning banner without invoking browser TTS", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses", voice: false, earcons: true, quiet: true });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  announcements.length = 0;
  env.oscillators = [];

  const checkedSpeech = "It looks like Metformin, but I can't read the strength confidently.";
  ws.serverSend({
    type: "correction",
    speech: checkedSpeech,
    reasons: ["strength_invented"],
  });

  assert.equal(env.spoken.length, 0);
  assert.equal(env.oscillators.length, 2);
  assert.deepEqual(announcements, [
    { msg: `Corrected answer: ${checkedSpeech}`, politeness: "assertive" },
  ]);
  assert.equal(checker.get().banner?.title, "Corrected answer");
  assert.equal(checker.get().banner?.tone, "warn");
});

test("detector coach cues with say:true speak in live glasses mode while normal live cues do not, and FieldSpotter fields expire after 2500 ms", async (t) => {
  const { announcements, createChecker } = setupTestEnv(t);
  saveSettings({ ...loadSettings(), source: "glasses", voice: true, earcons: true, haptics: true });

  const checker = createChecker();
  await flushMicrotasks();
  await checker.start();
  const ws = env.sockets[0];
  ws.serverOpen();

  env.spoken = [];
  ws.serverSend({ type: "coach", cue: "closer", text: "Move the box closer" });
  assert.equal(checker.get().cue?.cue, "closer");
  assert.equal(checker.get().cue?.text, "Move the box closer");
  assert.equal(env.spoken.length, 0);

  ws.serverSend({
    type: "coach",
    cue: "other_side",
    text: "Your fingers may be covering the dose.",
    say: true,
  });
  assert.equal(checker.get().cue?.cue, "other_side");
  assert.deepEqual(env.spoken, [{ text: "Your fingers may be covering the dose.", lang: "en-GB" }]);

  saveSettings({ ...loadSettings(), source: "glasses", voice: false });
  announcements.length = 0;
  env.spoken = [];
  ws.serverSend({
    type: "coach",
    cue: "rotate_left",
    text: "Turn the box slightly left.",
    say: true,
  });
  assert.equal(env.spoken.length, 0);
  assert.deepEqual(announcements, [{ msg: "Turn the box slightly left.", politeness: "polite" }]);

  const firstFields = [
    { label: "product" as const, box: [120, 140, 380, 820] as [number, number, number, number], score: 0.92 },
  ];
  const updatedFields = [
    { label: "product" as const, box: [115, 145, 375, 815] as [number, number, number, number], score: 0.94 },
    { label: "strength" as const, box: [410, 220, 520, 490] as [number, number, number, number], score: 0.88 },
  ];

  ws.serverSend({ type: "fields", fields: firstFields });
  assert.deepEqual(checker.get().fields, firstFields);

  t.mock.timers.tick(1500);
  assert.deepEqual(checker.get().fields, firstFields);

  ws.serverSend({ type: "fields", fields: updatedFields });
  assert.deepEqual(checker.get().fields, updatedFields);

  t.mock.timers.tick(2000);
  assert.deepEqual(checker.get().fields, updatedFields);

  t.mock.timers.tick(500);
  assert.equal(checker.get().fields, null);
});
