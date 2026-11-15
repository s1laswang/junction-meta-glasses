import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg, ServerMsg } from "../../shared/types.ts";

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

function createMockStream(videoTracks: MockTrack[], audioTracks: MockTrack[]): MediaStream {
  return {
    getTracks: () => [...videoTracks, ...audioTracks] as unknown as MediaStreamTrack[],
    getVideoTracks: () => videoTracks as unknown as MediaStreamTrack[],
    getAudioTracks: () => audioTracks as unknown as MediaStreamTrack[],
  } as unknown as MediaStream;
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

  constructor(url: string) {
    this.url = url;
    env.sockets.push(this);
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket not open");
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
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
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    close() {},
  };
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
    addModule: async () => {},
  };

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
    const osc = {
      type: "sine",
      frequency: freq,
      connect(dest: unknown) {
        return dest;
      },
      start() {
        env.oscillatorFrequencies.push(freq.value);
      },
      stop() {},
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

  createMediaStreamSource() {
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

  createBufferSource() {
    return {
      buffer: null as AudioBuffer | null,
      onended: null as (() => void) | null,
      connect(dest: unknown) {
        return dest;
      },
      start() {},
      stop() {},
      disconnect() {},
    };
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
  constructor(src = "") {
    this.src = src;
  }
  addEventListener() {}
  removeEventListener() {}
  load() {}
  async play() {
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
  sockets: [] as MockWebSocket[],
  utterances: [] as Array<{ text: string; lang: string }>,
  speechCancels: 0,
  vibrations: [] as Array<number | number[]>,
  oscillatorFrequencies: [] as number[],
  cameraStarts: 0,
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
    onLine: true,
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
          return createMockStream([createMockTrack("video", "Back Camera")], []);
        }
        return createMockStream([], [createMockTrack("audio", "Ray-Ban Meta HFP Mic")]);
      },
      async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        return [
          { kind: "audioinput", deviceId: "default", label: "Default - Ray-Ban Meta" },
          { kind: "audiooutput", deviceId: "default", label: "Default - Ray-Ban Meta" },
        ] as MediaDeviceInfo[];
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
    visibilityState: "visible" as const,
    addEventListener(type: string, fn: ListenerFn) {
      env.docEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      env.docEvents.remove(type, fn);
    },
    createElement() {
      return {
        width: 160,
        height: 120,
        getContext() {
          return null;
        },
      };
    },
  };

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = rawUrl.startsWith(ORIGIN_HTTPS) ? rawUrl.slice(ORIGIN_HTTPS.length) || "/" : rawUrl;
    const status = url === "/api/health" || url === "/api/stats" ? 200 : 404;
    const bodyJson = url === "/api/health" ? { ok: true, gemini: "ok" } : { calls: 0 };
    const bodyText = JSON.stringify(bodyJson);
    const makeRes = (): Response =>
      ({
        ok: status === 200,
        status,
        statusText: status === 200 ? "OK" : "Not Found",
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
    BroadcastChannel: MockBroadcastChannel,
    fetch: fetchImpl,
    speechSynthesis: {
      speak(u: MockSpeechUtterance) {
        if (u.volume > 0 && u.text.trim()) {
          env.utterances.push({ text: u.text, lang: u.lang });
        }
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
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "https:", host: "holdup.example", origin: ORIGIN_HTTPS, pathname: "/", search: "", hash: "" },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: { state: null, replaceState() {} },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "caches", { value: cachesObj, configurable: true, writable: true });
  Object.defineProperty(globalThis, "WebSocket", { value: MockWebSocket, configurable: true, writable: true });
  Object.defineProperty(globalThis, "fetch", { value: fetchImpl, configurable: true, writable: true });
  Object.defineProperty(globalThis, "AudioContext", { value: MockAudioContext, configurable: true, writable: true });
  Object.defineProperty(globalThis, "AudioWorkletNode", { value: MockAudioWorkletNode, configurable: true, writable: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: MockBroadcastChannel, configurable: true, writable: true });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { value: MockSpeechUtterance, configurable: true, writable: true });
  Object.defineProperty(globalThis, "MediaMetadata", { value: MockMediaMetadata, configurable: true, writable: true });
  Object.defineProperty(globalThis, "Audio", { value: MockAudioElement, configurable: true, writable: true });
  Object.defineProperty(globalThis, "URL", {
    value: Object.assign(URL, { createObjectURL: () => "blob:silent-wav" }),
    configurable: true,
    writable: true,
  });
}

installGlobals();

const { Checker } = await import("../src/lib/checker.ts");
const { onAnnounce } = await import("../src/lib/feedback.ts");
const { loadSettings, saveSettings } = await import("../src/lib/storage.ts");

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const BASE_NOW = 1_763_151_000_000;

function setupCase(t: TestContext, voice: boolean) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASE_NOW });
  env.windowEvents.clear();
  env.docEvents.clear();
  env.mediaDeviceEvents.clear();
  env.sockets = [];
  env.utterances = [];
  env.speechCancels = 0;
  env.vibrations = [];
  env.oscillatorFrequencies = [];
  env.cameraStarts = 0;

  localStorage.clear();
  sessionStorage.clear();
  saveSettings({
    ...loadSettings(),
    source: "glasses",
    voice,
    earcons: true,
    haptics: true,
  });

  const announcements: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const offAnnounce = onAnnounce((msg, politeness) => {
    announcements.push({ msg, politeness });
  });

  const checker = new Checker();
  t.after(async () => {
    offAnnounce();
    checker.dispose();
    await flushMicrotasks();
  });

  return { checker, announcements };
}

test("Checker in live glasses mode with voice ON speaks detector coach (say: true) via speak(), plays earcon + haptic, re-arms auto-stop, and keeps regular live cues silent", async (t) => {
  const { checker, announcements } = setupCase(t, true);
  await flushMicrotasks();

  await checker.start();
  assert.equal(checker.get().mode, "live");
  assert.equal(checker.get().source, "glasses");
  assert.equal(env.cameraStarts, 0);

  const ws = env.sockets[0];
  assert.ok(ws);
  ws.serverOpen();

  t.mock.timers.tick(12_000);
  const autoStopBefore = checker.get().autoStopAt;
  assert.ok(autoStopBefore !== null);

  env.utterances = [];
  env.speechCancels = 0;
  env.vibrations = [];
  env.oscillatorFrequencies = [];
  announcements.length = 0;

  ws.serverSend({
    type: "coach",
    cue: "hold_still",
    text: "Something is covering the dose. Move your thumb.",
    say: true,
  });

  assert.deepEqual(checker.get().cue, {
    cue: "hold_still",
    text: "Something is covering the dose. Move your thumb.",
    ts: BASE_NOW + 12_000,
  });
  assert.deepEqual(env.utterances, [
    { text: "Something is covering the dose. Move your thumb.", lang: "en-GB" },
  ]);
  assert.equal(env.speechCancels, 1);
  assert.equal(announcements.length, 0);
  assert.deepEqual(env.oscillatorFrequencies, [880]);
  assert.deepEqual(env.vibrations, [[200]]);
  assert.equal(checker.get().autoStopAt, BASE_NOW + 12_000 + 45_000);
  assert.ok((checker.get().autoStopAt ?? 0) > (autoStopBefore ?? 0));

  t.mock.timers.tick(5_000);
  env.utterances = [];
  env.oscillatorFrequencies = [];
  env.vibrations = [];

  ws.serverSend({
    type: "coach",
    cue: "closer",
    text: "Move a bit closer.",
  });

  assert.equal(env.utterances.length, 0);
  assert.equal(announcements.length, 0);
  assert.deepEqual(env.oscillatorFrequencies, [880]);
  assert.deepEqual(env.vibrations, [[15, 30, 15, 30, 15, 30, 15]]);
  assert.equal(checker.get().autoStopAt, BASE_NOW + 17_000 + 45_000);

  env.oscillatorFrequencies = [];
  env.vibrations = [];
  ws.serverSend({
    type: "coach",
    cue: "ok",
    text: "Got it, hold still.",
    say: true,
  });
  assert.deepEqual(env.oscillatorFrequencies, [988, 988]);
  assert.deepEqual(env.vibrations, [[40, 40, 120]]);
  assert.deepEqual(env.utterances, [{ text: "Got it, hold still.", lang: "en-GB" }]);
});

test("Checker in live glasses mode with voice OFF announces detector coach (say: true) to screen reader without speechSynthesis and expires fields after 2500ms", async (t) => {
  const { checker, announcements } = setupCase(t, false);
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  assert.ok(ws);
  ws.serverOpen();

  t.mock.timers.tick(8_000);
  const autoStopBefore = checker.get().autoStopAt;
  assert.ok(autoStopBefore !== null);

  env.utterances = [];
  env.vibrations = [];
  env.oscillatorFrequencies = [];
  announcements.length = 0;

  ws.serverSend({
    type: "fields",
    fields: [
      { label: "product", box: [220, 140, 340, 810], score: 0.91 },
      { label: "strength", box: [410, 260, 500, 620], score: 0.87 },
    ],
  });
  assert.equal(checker.get().fields?.length, 2);
  assert.equal(checker.get().fields?.[1]?.label, "strength");

  ws.serverSend({
    type: "coach",
    cue: "other_side",
    text: "Turn the box. The dose is on another side.",
    say: true,
  });

  assert.equal(env.utterances.length, 0);
  assert.deepEqual(announcements, [
    { msg: "Turn the box. The dose is on another side.", politeness: "polite" },
  ]);
  assert.deepEqual(env.oscillatorFrequencies, [880]);
  assert.deepEqual(env.vibrations, [30]);
  assert.equal(checker.get().autoStopAt, BASE_NOW + 8_000 + 45_000);
  assert.ok((checker.get().autoStopAt ?? 0) > (autoStopBefore ?? 0));

  t.mock.timers.tick(2_499);
  assert.equal(checker.get().fields?.length, 2);
  t.mock.timers.tick(1);
  assert.equal(checker.get().fields, null);
});
