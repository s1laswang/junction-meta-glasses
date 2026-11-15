import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import type { ClientMsg, ServerMsg } from "../../shared/types.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(TEST_DIR, "..");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const MANIFEST_PATH = path.join(PUBLIC_DIR, "phrases", "manifest.json");
const SW_PATH = path.join(PUBLIC_DIR, "sw.js");
const SLASH = "\x2f";
const ORIGIN_HTTPS = ["https:", "", "holdup.example"].join(SLASH);

const EXPECTED_LANGS = ["en", "fi", "sv"] as const;
const EXPECTED_PHRASE_IDS = [
  "already_taken",
  "back_online",
  "camera_off",
  "glasses_off",
  "not_sure",
  "offline",
  "unknown_offline",
] as const;

type PhraseEntry = { file: string; text: string };
type PhraseManifest = {
  model: string;
  generated: string;
  phrases: Record<string, Record<string, PhraseEntry>>;
};

const REAL_MANIFEST_TEXT = fs.readFileSync(MANIFEST_PATH, "utf8");
const REAL_MANIFEST = JSON.parse(REAL_MANIFEST_TEXT) as PhraseManifest;

type ListenerFn = (...args: unknown[]) => unknown;

function makeEventMap() {
  const map = new Map<string, Set<ListenerFn>>();
  return {
    add(type: string, fn: ListenerFn) {
      const set = map.get(type) ?? new Set<ListenerFn>();
      set.add(fn);
      map.set(type, set);
    },
    remove(type: string, fn: ListenerFn) {
      map.get(type)?.delete(fn);
    },
    async emit(type: string, ev: unknown = {}) {
      for (const fn of [...(map.get(type) ?? [])]) {
        await fn(ev);
      }
    },
    clear() {
      map.clear();
    },
  };
}

function createStorage(): Storage {
  const store: Record<string, string> = Object.create(null);
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
  return Object.setPrototypeOf(store, proto) as Storage;
}

class TrackedAudioElement {
  src: string;
  loop = false;
  volume = 1;
  playbackRate = 1;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  throwOnCurrentTimeReset = false;
  private timeValue = 0;

  constructor(src = "") {
    this.src = src;
    env.audioElements.push(this);
    if (src.includes(`${SLASH}phrases${SLASH}`)) {
      env.phraseAudioElements.push(this);
    }
  }

  get currentTime(): number {
    return this.timeValue;
  }

  set currentTime(next: number) {
    if (this.throwOnCurrentTimeReset && next === 0) {
      throw new Error("InvalidStateError: media metadata not loaded");
    }
    this.timeValue = next;
  }

  async play(): Promise<void> {
    this.playCalls++;
    if (this.src.includes(`${SLASH}phrases${SLASH}`) && env.rejectPhrasePlay) {
      this.paused = true;
      throw new Error("NotAllowedError: play rejected");
    }
    this.paused = false;
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
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

  constructor(url: string) {
    this.url = url;
    env.sockets.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("Socket not open");
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    const ev = Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }) as CloseEvent;
    this.onclose?.(ev);
  }

  serverOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverSend(msg: ServerMsg | { type: "pong"; t: number }): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}

class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(_data: unknown): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => void) | null,
    close() {},
  };

  connect(dest: unknown) {
    return dest;
  }

  disconnect(): void {}
}

class MockAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};
  audioWorklet = {
    async addModule(_url: string): Promise<void> {},
  };

  async resume(): Promise<void> {
    if (this.state !== "closed") this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource() {
    return {
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createGain() {
    return {
      gain: {
        value: 1,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        setTargetAtTime() {},
        cancelScheduledValues() {},
      },
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 440, setTargetAtTime() {} },
      connect: (dest: unknown) => dest,
      disconnect() {},
      start() {},
      stop() {},
    };
  }

  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 1200 },
      connect: (dest: unknown) => dest,
      disconnect() {},
    };
  }

  createBuffer(_channels: number, samples: number, sampleRate: number) {
    return {
      duration: samples / sampleRate,
      getChannelData: () => new Float32Array(samples),
    };
  }

  createBufferSource() {
    return {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      connect: (dest: unknown) => dest,
      disconnect() {},
      start() {},
      stop() {},
    };
  }

  async decodeAudioData() {
    return this.createBuffer(1, 240, 24000);
  }
}

class MockSpeechUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;

  constructor(text: string) {
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

class MockBarcodeDetector {
  static async getSupportedFormats(): Promise<string[]> {
    return ["ean_13", "data_matrix", "qr_code"];
  }

  async detect(): Promise<Array<{ rawValue: string; format: string }>> {
    return [];
  }
}

function makeMockTrack(kind: "video" | "audio", label: string) {
  return {
    kind,
    label,
    readyState: "live",
    stop() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeMockStream(video: boolean, audio: boolean) {
  const tracks = [
    ...(video ? [makeMockTrack("video", "Phone Camera")] : []),
    ...(audio ? [makeMockTrack("audio", "Ray-Ban Mic")] : []),
  ];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((tr) => tr.kind === "video"),
    getAudioTracks: () => tracks.filter((tr) => tr.kind === "audio"),
  };
}

const env = {
  onLine: true,
  visibilityState: "visible" as "visible" | "hidden",
  rejectPhrasePlay: false,
  manifestMode: "ok" as "ok" | "http503" | "throw",
  manifestFetchCount: 0,
  audioElements: [] as TrackedAudioElement[],
  phraseAudioElements: [] as TrackedAudioElement[],
  sockets: [] as MockWebSocket[],
  spoken: [] as string[],
  speechCancels: 0,
  windowEvents: makeEventMap(),
  docEvents: makeEventMap(),
  mediaDeviceEvents: makeEventMap(),
  localStorage: createStorage(),
  sessionStorage: createStorage(),
};

function installBrowserGlobals(): void {
  const cachesShim = {
    async open() {
      return {
        async put() {},
        async match() {
          return undefined;
        },
      };
    },
    async keys(): Promise<string[]> {
      return [];
    },
    async delete(): Promise<boolean> {
      return true;
    },
  };

  const fetchShim = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const pathname = raw.startsWith(ORIGIN_HTTPS) ? raw.slice(ORIGIN_HTTPS.length) || SLASH : raw;
    if (pathname === `${SLASH}phrases${SLASH}manifest.json`) {
      env.manifestFetchCount++;
      if (env.manifestMode === "throw") {
        throw new TypeError("Failed to fetch");
      }
      if (env.manifestMode === "http503") {
        return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      return new Response(REAL_MANIFEST_TEXT, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname === `${SLASH}api${SLASH}health`) {
      return new Response(
        JSON.stringify({
          ok: true,
          gemini: "ok",
          models: { live: "gemini-3.8-live", verify: "gemini-3.8-flash" },
          version: "0.1.0",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (pathname === `${SLASH}api${SLASH}stats`) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  const navigatorShim = {
    get onLine() {
      return env.onLine;
    },
    set onLine(v: boolean) {
      env.onLine = v;
    },
    language: "en-US",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0",
    vibrate() {
      return true;
    },
    mediaDevices: {
      async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
        return makeMockStream(Boolean(constraints.video), Boolean(constraints.audio));
      },
      async enumerateDevices() {
        return [
          { kind: "audioinput", deviceId: "default", label: "Ray-Ban Meta Hands-Free" },
          { kind: "audiooutput", deviceId: "default", label: "Ray-Ban Meta Hands-Free" },
        ];
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

  const documentShim = {
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
      return {
        width: 320,
        height: 240,
        getContext() {
          return {
            drawImage() {},
            getImageData(_x: number, _y: number, w: number, h: number) {
              return { data: new Uint8ClampedArray(w * h * 4) };
            },
          };
        },
        toDataURL() {
          return "data:image/jpeg;base64,AA==";
        },
      };
    },
  };

  const locationShim = {
    protocol: "https:",
    host: "holdup.example",
    origin: ORIGIN_HTTPS,
    pathname: SLASH,
    search: "",
    hash: "",
  };

  const windowShim = {
    isSecureContext: true,
    AudioContext: MockAudioContext,
    Audio: TrackedAudioElement,
    WebSocket: MockWebSocket,
    SpeechSynthesisUtterance: MockSpeechUtterance,
    BarcodeDetector: MockBarcodeDetector,
    BroadcastChannel: MockBroadcastChannel,
    fetch: fetchShim,
    caches: cachesShim,
    speechSynthesis: {
      speak(u: MockSpeechUtterance) {
        if (u.volume > 0 && u.text.trim()) env.spoken.push(u.text);
      },
      cancel() {
        env.speechCancels++;
      },
    },
    addEventListener(type: string, fn: ListenerFn) {
      env.windowEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      env.windowEvents.remove(type, fn);
    },
  };

  const globals: Record<string, unknown> = {
    localStorage: env.localStorage,
    sessionStorage: env.sessionStorage,
    navigator: navigatorShim,
    document: documentShim,
    window: windowShim,
    location: locationShim,
    history: { state: null, replaceState() {}, pushState() {}, back() {} },
    caches: cachesShim,
    WebSocket: MockWebSocket,
    fetch: fetchShim,
    AudioContext: MockAudioContext,
    AudioWorkletNode: MockAudioWorkletNode,
    BroadcastChannel: MockBroadcastChannel,
    SpeechSynthesisUtterance: MockSpeechUtterance,
    MediaMetadata: MockMediaMetadata,
    Audio: TrackedAudioElement,
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

installBrowserGlobals();

const phrasesMod = await import("../src/lib/phrases.ts");
const { Checker } = await import("../src/lib/checker.ts");
const { MockSocket } = await import("../src/lib/mock.ts");
const { demoProfile, loadSettings, saveProfile, saveSettings } = await import("../src/lib/storage.ts");

type PhrasesModule = typeof phrasesMod;

async function importFreshPhrases(tag: string): Promise<PhrasesModule> {
  const baseHref = new URL("../src/lib/phrases.ts", import.meta.url).href;
  return (await import(`${baseHref}?case=${tag}`)) as PhrasesModule;
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function resetEnv(): void {
  phrasesMod.stopPhrase();
  env.onLine = true;
  env.visibilityState = "visible";
  env.rejectPhrasePlay = false;
  env.manifestMode = "ok";
  env.manifestFetchCount = 0;
  env.audioElements = [];
  env.phraseAudioElements = [];
  env.sockets = [];
  env.spoken = [];
  env.speechCancels = 0;
  env.windowEvents.clear();
  env.docEvents.clear();
  env.mediaDeviceEvents.clear();
  env.localStorage.clear();
  env.sessionStorage.clear();
  saveProfile(demoProfile());
}

function isValidMp3Header(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

class SwRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string;

  constructor(input: string | SwRequest, init?: { method?: string; mode?: string; cache?: string }) {
    if (typeof input === "string") {
      this.url = new URL(input, ORIGIN_HTTPS).href;
      this.method = (init?.method ?? "GET").toUpperCase();
      this.mode = init?.mode ?? "cors";
      this.cache = init?.cache ?? "default";
    } else {
      this.url = input.url;
      this.method = (init?.method ?? input.method).toUpperCase();
      this.mode = init?.mode ?? input.mode;
      this.cache = init?.cache ?? input.cache;
    }
  }
}

test("web/public/phrases/manifest.json schema, EN/FI/SV parity across all 7 phrase IDs, and MP3 file integrity (> 1000 bytes)", () => {
  assert.equal(typeof REAL_MANIFEST.model, "string");
  assert.ok(REAL_MANIFEST.model.trim().length > 0);
  assert.equal(typeof REAL_MANIFEST.generated, "string");
  assert.equal(Number.isNaN(Date.parse(REAL_MANIFEST.generated)), false);
  assert.ok(REAL_MANIFEST.phrases && typeof REAL_MANIFEST.phrases === "object");

  const langs = Object.keys(REAL_MANIFEST.phrases).sort();
  assert.deepEqual(langs, [...EXPECTED_LANGS]);

  const expectedIdSet = new Set<string>(EXPECTED_PHRASE_IDS);
  const enIds = Object.keys(REAL_MANIFEST.phrases.en ?? {}).sort();
  const seenPaths = new Set<string>();
  for (const lang of EXPECTED_LANGS) {
    const bucket = REAL_MANIFEST.phrases[lang];
    assert.ok(bucket && typeof bucket === "object", `Missing language bucket for ${lang}`);
    const ids = Object.keys(bucket).sort();
    assert.deepEqual(ids, enIds, `Phrase ID parity mismatch between en and ${lang}`);
    for (const reqId of EXPECTED_PHRASE_IDS) {
      assert.equal(ids.includes(reqId), true, `Missing required safety phrase ID ${lang}.${reqId}`);
    }
    for (const extraId of ids) {
      if (!expectedIdSet.has(extraId)) {
        assert.match(extraId, /^cue_[a-z_]+$/, `Unexpected extra phrase ID ${lang}.${extraId}`);
        const cueEntry = bucket[extraId];
        assert.ok(cueEntry, `Missing cue entry ${lang}.${extraId}`);
        assert.match(cueEntry.file, new RegExp(`^${SLASH}phrases${SLASH}${lang}${SLASH}${extraId}\\.(wav|mp3)$`));
        assert.equal(typeof cueEntry.text, "string");
        assert.ok(cueEntry.text.trim().length >= 4);
        const cueDiskPath = path.join(PUBLIC_DIR, cueEntry.file.slice(1));
        assert.equal(fs.existsSync(cueDiskPath), true, `Missing cue audio file on disk: ${cueEntry.file}`);
        assert.ok(fs.statSync(cueDiskPath).size > 1000, `Expected ${cueEntry.file} size > 1000 bytes`);
      }
    }

    for (const id of EXPECTED_PHRASE_IDS) {
      const entry = bucket[id];
      assert.ok(entry, `Missing entry ${lang}.${id}`);
      const expectedWebPath = `${SLASH}phrases${SLASH}${lang}${SLASH}${id}.mp3`;
      assert.equal(entry.file, expectedWebPath);
      assert.equal(typeof entry.text, "string");
      assert.ok(entry.text.trim().length >= 8, `Expected non-empty safety/offline text for ${lang}.${id}`);

      const diskPath = path.join(PUBLIC_DIR, entry.file.slice(1));
      assert.equal(fs.existsSync(diskPath), true, `Missing MP3 file on disk: ${entry.file}`);
      const stat = fs.statSync(diskPath);
      assert.equal(stat.isFile(), true);
      assert.ok(stat.size > 1000, `Expected ${entry.file} size > 1000 bytes, got ${stat.size}`);

      const mp3Bytes = fs.readFileSync(diskPath);
      assert.equal(isValidMp3Header(mp3Bytes), true, `Expected valid MP3 header in ${entry.file}`);
      seenPaths.add(entry.file);
    }
  }

  assert.equal(seenPaths.size, 21);

  for (const id of EXPECTED_PHRASE_IDS) {
    const enText = REAL_MANIFEST.phrases.en[id].text;
    const fiText = REAL_MANIFEST.phrases.fi[id].text;
    const svText = REAL_MANIFEST.phrases.sv[id].text;
    assert.notEqual(enText, fiText, `Expected localized Finnish text for ${id}`);
    assert.notEqual(enText, svText, `Expected localized Swedish text for ${id}`);
    assert.notEqual(fiText, svText, `Expected distinct Finnish and Swedish text for ${id}`);
  }
});

test("web/public/sw.js precaches /phrases/manifest.json and all 21 EN/FI/SV MP3 paths during install and serves them offline", async () => {
  const swSource = fs.readFileSync(SW_PATH, "utf8");
  const cacheNameMatch = swSource.match(/const\s+CACHE\s*=\s*"([^"]+)"/);
  assert.ok(cacheNameMatch?.[1], "Expected CACHE constant in sw.js");
  const cacheName = cacheNameMatch[1];

  const cacheStore = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  let networkOnline = true;

  const normalizeKey = (reqOrUrl: string | SwRequest): string =>
    typeof reqOrUrl === "string" ? new URL(reqOrUrl, ORIGIN_HTTPS).href : reqOrUrl.url;

  const sandboxFetch = async (input: string | SwRequest, init?: { cache?: string; method?: string; mode?: string }): Promise<Response> => {
    if (!networkOnline) {
      throw new TypeError("Failed to fetch");
    }
    const req = input instanceof SwRequest && !init ? input : new SwRequest(input, init);
    const pathname = new URL(req.url).pathname;
    if (pathname === `${SLASH}phrases${SLASH}manifest.json`) {
      return new Response(REAL_MANIFEST_TEXT, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith(`${SLASH}phrases${SLASH}`) && (pathname.endsWith(".mp3") || pathname.endsWith(".wav"))) {
      const diskPath = path.join(PUBLIC_DIR, pathname.slice(1));
      if (!fs.existsSync(diskPath)) {
        return new Response("Not Found", { status: 404 });
      }
      const bytes = fs.readFileSync(diskPath);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": pathname.endsWith(".wav") ? "audio/wav" : "audio/mpeg" },
      });
    }
    if (pathname === SLASH || pathname === `${SLASH}index.html` || pathname === `${SLASH}hud${SLASH}`) {
      return new Response("<!doctype html><html><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("asset", { status: 200 });
  };

  const cachesApi = {
    async open(name: string) {
      let bucket = cacheStore.get(name);
      if (!bucket) {
        bucket = new Map<string, Response>();
        cacheStore.set(name, bucket);
      }
      return {
        async add(reqOrUrl: string | SwRequest) {
          const req = reqOrUrl instanceof SwRequest ? reqOrUrl : new SwRequest(reqOrUrl);
          const res = await sandboxFetch(req);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          bucket.set(normalizeKey(req), res.clone());
        },
        async put(reqOrUrl: string | SwRequest, res: Response) {
          bucket.set(normalizeKey(reqOrUrl), res);
        },
        async match(reqOrUrl: string | SwRequest) {
          const hit = bucket.get(normalizeKey(reqOrUrl));
          return hit ? hit.clone() : undefined;
        },
      };
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(name: string) {
      return cacheStore.delete(name);
    },
    async match(reqOrUrl: string | SwRequest) {
      const key = normalizeKey(reqOrUrl);
      for (const bucket of cacheStore.values()) {
        const hit = bucket.get(key);
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };

  const selfObj = {
    location: new URL(`${SLASH}sw.js`, ORIGIN_HTTPS),
    caches: cachesApi,
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type: string, handler: (ev: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
  };

  const ctx = vm.createContext({
    self: selfObj,
    caches: cachesApi,
    location: selfObj.location,
    fetch: sandboxFetch,
    Request: SwRequest,
    Response,
    URL,
    Promise,
  });

  vm.runInContext(swSource, ctx, { filename: "sw.js" });

  const installPromises: Array<Promise<unknown>> = [];
  for (const fn of listeners.get("install") ?? []) {
    fn({
      waitUntil(p: Promise<unknown>) {
        installPromises.push(p);
      },
    });
  }
  await Promise.all(installPromises);
  await flushMicrotasks();

  const shellBucket = cacheStore.get(cacheName);
  assert.ok(shellBucket, `Expected service worker cache bucket ${cacheName}`);

  const manifestHref = new URL(`${SLASH}phrases${SLASH}manifest.json`, ORIGIN_HTTPS).href;
  assert.equal(shellBucket.has(manifestHref), true, "Expected /phrases/manifest.json in precache");

  const expectedMp3Paths: string[] = [];
  for (const lang of EXPECTED_LANGS) {
    for (const id of EXPECTED_PHRASE_IDS) {
      const mp3Path = `${SLASH}phrases${SLASH}${lang}${SLASH}${id}.mp3`;
      expectedMp3Paths.push(mp3Path);
      const href = new URL(mp3Path, ORIGIN_HTTPS).href;
      assert.equal(shellBucket.has(href), true, `Expected precached MP3 path ${mp3Path}`);
    }
  }
  assert.equal(expectedMp3Paths.length, 21);

  networkOnline = false;

  const dispatchSwFetch = async (urlPath: string): Promise<Response> => {
    let responded: Promise<Response> | null = null;
    const req = new SwRequest(urlPath, { method: "GET", mode: "cors" });
    for (const fn of listeners.get("fetch") ?? []) {
      fn({
        request: req,
        respondWith(p: Promise<Response>) {
          responded = p;
        },
      });
    }
    assert.ok(responded, `Expected sw.js fetch handler to intercept ${urlPath}`);
    return await responded;
  };

  const cachedManifestRes = await dispatchSwFetch(`${SLASH}phrases${SLASH}manifest.json`);
  assert.equal(cachedManifestRes.status, 200);
  const cachedManifestJson = (await cachedManifestRes.json()) as PhraseManifest;
  assert.deepEqual(Object.keys(cachedManifestJson.phrases).sort(), [...EXPECTED_LANGS]);

  for (const mp3Path of expectedMp3Paths) {
    const res = await dispatchSwFetch(mp3Path);
    assert.equal(res.status, 200, `Expected offline cached 200 response for ${mp3Path}`);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 1000, `Expected cached MP3 ${mp3Path} > 1000 bytes`);
  }
});

test("playPhrase and sayPhrase play exact en, fi, and sv clips, fall back to en for unsupported language, and speak fallback for unknown ID", async () => {
  resetEnv();
  const fresh = await importFreshPhrases("lang-routing");

  assert.equal(await fresh.playPhrase("offline", "en"), true);
  assert.equal(env.phraseAudioElements.length, 1);
  assert.equal(env.phraseAudioElements[0].src, `${SLASH}phrases${SLASH}en${SLASH}offline.mp3`);
  assert.equal(env.phraseAudioElements[0].playCalls, 1);
  assert.equal(env.phraseAudioElements[0].paused, false);

  assert.equal(await fresh.playPhrase("not_sure", "fi"), true);
  assert.equal(env.phraseAudioElements.length, 2);
  assert.equal(env.phraseAudioElements[1].src, `${SLASH}phrases${SLASH}fi${SLASH}not_sure.mp3`);
  assert.equal(env.phraseAudioElements[0].paused, true);

  assert.equal(await fresh.playPhrase("already_taken", "sv"), true);
  assert.equal(env.phraseAudioElements.length, 3);
  assert.equal(env.phraseAudioElements[2].src, `${SLASH}phrases${SLASH}sv${SLASH}already_taken.mp3`);
  assert.equal(env.manifestFetchCount, 1, "Expected manifest.json fetched once and cached across calls");

  const fallbackCalls: string[] = [];
  await fresh.sayPhrase("camera_off", "de", (txt) => fallbackCalls.push(txt), "Camera off fallback");
  assert.equal(fallbackCalls.length, 0);
  assert.equal(env.phraseAudioElements.at(-1)?.src, `${SLASH}phrases${SLASH}en${SLASH}camera_off.mp3`);

  await fresh.sayPhrase("back_online", undefined, (txt) => fallbackCalls.push(txt), "Back online fallback");
  assert.equal(fallbackCalls.length, 0);
  assert.equal(env.phraseAudioElements.at(-1)?.src, `${SLASH}phrases${SLASH}en${SLASH}back_online.mp3`);

  assert.equal(await fresh.playPhrase("unregistered_phrase", "fi"), false);
  await fresh.sayPhrase("unregistered_phrase", "sv", (txt) => fallbackCalls.push(txt), "Speak fallback line");
  assert.deepEqual(fallbackCalls, ["Speak fallback line"]);

  fresh.stopPhrase();
});

test("playPhrase and sayPhrase fall back to speak callback when manifest fetch fails or Audio.play() rejects", async () => {
  resetEnv();
  env.manifestMode = "throw";
  const fetchThrowMod = await importFreshPhrases("fetch-throw");
  const spokenOnFetchThrow: string[] = [];
  assert.equal(await fetchThrowMod.playPhrase("offline", "en"), false);
  await fetchThrowMod.sayPhrase("offline", "fi", (txt) => spokenOnFetchThrow.push(txt), "Offline fallback when fetch throws");
  assert.deepEqual(spokenOnFetchThrow, ["Offline fallback when fetch throws"]);
  assert.equal(env.phraseAudioElements.length, 0);

  resetEnv();
  env.manifestMode = "http503";
  const fetch503Mod = await importFreshPhrases("fetch-503");
  const spokenOn503: string[] = [];
  await fetch503Mod.sayPhrase("not_sure", "sv", (txt) => spokenOn503.push(txt), "Unsure fallback on HTTP 503");
  assert.deepEqual(spokenOn503, ["Unsure fallback on HTTP 503"]);
  assert.equal(env.phraseAudioElements.length, 0);

  resetEnv();
  env.manifestMode = "ok";
  env.rejectPhrasePlay = true;
  const playRejectMod = await importFreshPhrases("play-reject");
  const spokenOnPlayReject: string[] = [];
  await playRejectMod.sayPhrase("glasses_off", "en", (txt) => spokenOnPlayReject.push(txt), "Glasses off fallback on autoplay block");
  assert.deepEqual(spokenOnPlayReject, ["Glasses off fallback on autoplay block"]);
  assert.equal(env.phraseAudioElements.length, 1);
  assert.equal(env.phraseAudioElements[0].playCalls, 1);

  const pauseBeforeStop = env.phraseAudioElements[0].pauseCalls;
  playRejectMod.stopPhrase();
  assert.equal(env.phraseAudioElements[0].pauseCalls, pauseBeforeStop);
});

test("playPhrase pauses previous Audio clip when a second phrase plays, and stopPhrase pauses, resets currentTime, and clears active Audio immediately", async () => {
  resetEnv();
  const fresh = await importFreshPhrases("overlap-and-stop");

  assert.equal(await fresh.playPhrase("offline", "en"), true);
  const firstClip = env.phraseAudioElements[0];
  firstClip.currentTime = 1.75;
  assert.equal(firstClip.paused, false);
  assert.equal(firstClip.pauseCalls, 0);

  assert.equal(await fresh.playPhrase("unknown_offline", "sv"), true);
  const secondClip = env.phraseAudioElements[1];
  assert.equal(firstClip.paused, true);
  assert.equal(firstClip.pauseCalls, 1);
  assert.equal(secondClip.paused, false);
  assert.equal(secondClip.src, `${SLASH}phrases${SLASH}sv${SLASH}unknown_offline.mp3`);

  secondClip.currentTime = 2.9;
  fresh.stopPhrase();
  assert.equal(secondClip.paused, true);
  assert.equal(secondClip.pauseCalls, 1);
  assert.equal(secondClip.currentTime, 0);

  fresh.stopPhrase();
  assert.equal(secondClip.pauseCalls, 1, "Expected cleared current Audio not to be paused twice");

  assert.equal(await fresh.playPhrase("already_taken", "fi"), true);
  const thirdClip = env.phraseAudioElements[2];
  thirdClip.throwOnCurrentTimeReset = true;
  assert.doesNotThrow(() => fresh.stopPhrase());
  assert.equal(thirdClip.paused, true);
  assert.equal(thirdClip.pauseCalls, 1);

  const countBeforeCancel = env.phraseAudioElements.length;
  const cancelledFallbacks: string[] = [];
  const inFlight = fresh.sayPhrase("offline", "en", (txt) => cancelledFallbacks.push(txt), "Should not speak after stopPhrase");
  fresh.stopPhrase();
  await inFlight;
  assert.equal(env.phraseAudioElements.length, countBeforeCancel);
  assert.deepEqual(cancelledFallbacks, []);
});

test("Checker user transcript barge-in silences active pre-rendered phrase Audio immediately while ignoring whitespace-only transcripts", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 10, 14, 21, 0, 0) });
  resetEnv();

  saveProfile({ ...demoProfile(), lang: "fi" });
  saveSettings({ ...loadSettings(), voice: true, source: "glasses" });

  const checker = new Checker();
  t.after(() => checker.dispose());
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  assert.ok(ws, "Expected live WebSocket on Checker.start()");
  ws.serverOpen();
  await flushMicrotasks();

  env.phraseAudioElements = [];
  ws.serverSend({
    type: "device",
    device: { connected: true, worn: false, battery: 84, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();

  assert.equal(env.phraseAudioElements.length, 1, "Expected glasses_off pre-rendered clip to play");
  const activeClip = env.phraseAudioElements[0];
  assert.equal(activeClip.src, `${SLASH}phrases${SLASH}fi${SLASH}glasses_off.mp3`);
  assert.equal(activeClip.paused, false);
  activeClip.currentTime = 1.4;

  ws.serverSend({ type: "transcript", role: "user", text: "   ", final: false });
  assert.equal(activeClip.paused, false, "Whitespace user transcript must not barge-in");
  assert.equal(activeClip.pauseCalls, 0);

  ws.serverSend({ type: "transcript", role: "user", text: "Onko tama iltalaakkeeni?", final: false });
  assert.equal(activeClip.paused, true, "Non-empty user transcript must silence active phrase Audio immediately");
  assert.equal(activeClip.pauseCalls, 1);
  assert.equal(activeClip.currentTime, 0);

  await checker.stop();
  checker.dispose();
});

test("Checker stop() and start() silence active pre-rendered phrase Audio immediately across offline and online transitions", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 10, 14, 21, 15, 0) });
  resetEnv();

  saveProfile({ ...demoProfile(), lang: "sv" });
  saveSettings({ ...loadSettings(), voice: true, source: "phone" });

  const checker = new Checker();
  t.after(() => checker.dispose());
  await flushMicrotasks();

  await checker.start();
  const ws = env.sockets[0];
  assert.ok(ws);
  ws.serverOpen();
  await flushMicrotasks();

  env.phraseAudioElements = [];
  env.onLine = false;
  await env.windowEvents.emit("offline");
  await flushMicrotasks();

  assert.equal(checker.get().mode, "offline");
  assert.equal(env.phraseAudioElements.length, 1, "Expected offline Swedish phrase clip to start");
  const offlineClip = env.phraseAudioElements[0];
  assert.equal(offlineClip.src, `${SLASH}phrases${SLASH}sv${SLASH}offline.mp3`);
  assert.equal(offlineClip.paused, false);
  offlineClip.currentTime = 3.2;

  const stopPromise = checker.stop();
  assert.equal(offlineClip.paused, true, "checker.stop() must pause active phrase Audio synchronously");
  assert.equal(offlineClip.pauseCalls, 1);
  assert.equal(offlineClip.currentTime, 0);
  await stopPromise;
  assert.equal(checker.get().running, false);

  env.phraseAudioElements = [];
  env.onLine = true;
  await env.windowEvents.emit("online");
  await flushMicrotasks();

  assert.equal(env.phraseAudioElements.length, 1, "Expected back_online Swedish phrase clip to start");
  const backOnlineClip = env.phraseAudioElements[0];
  assert.equal(backOnlineClip.src, `${SLASH}phrases${SLASH}sv${SLASH}back_online.mp3`);
  assert.equal(backOnlineClip.paused, false);
  backOnlineClip.currentTime = 0.9;

  const startPromise = checker.start();
  assert.equal(backOnlineClip.paused, true, "checker.start() must pause active phrase Audio synchronously on user gesture");
  assert.equal(backOnlineClip.pauseCalls, 1);
  assert.equal(backOnlineClip.currentTime, 0);
  await startPromise;

  await checker.stop();
  checker.dispose();
});

test("Auto-stop 45s timer and server auto-stop status stop prior phrase and keep camera_off playing, and MockSocket.close works without global CloseEvent", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 10, 14, 21, 30, 0) });
  resetEnv();

  saveProfile({ ...demoProfile(), lang: "fi" });
  saveSettings({ ...loadSettings(), voice: true, source: "glasses" });

  const checker = new Checker();
  t.after(() => checker.dispose());
  await flushMicrotasks();

  await checker.start();
  const ws1 = env.sockets[0];
  assert.ok(ws1);
  ws1.serverOpen();
  await flushMicrotasks();

  env.phraseAudioElements = [];
  ws1.serverSend({
    type: "device",
    device: { connected: true, worn: false, battery: 80, streaming: false, source: "glasses" },
  });
  await flushMicrotasks();
  assert.equal(env.phraseAudioElements.length, 1);
  const priorClip = env.phraseAudioElements[0];
  assert.equal(priorClip.src, `${SLASH}phrases${SLASH}fi${SLASH}glasses_off.mp3`);
  assert.equal(priorClip.paused, false);

  t.mock.timers.tick(45_000);
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.equal(priorClip.paused, true, "Prior phrase must be stopped on 45s auto-stop");
  const timerCameraOff = env.phraseAudioElements.at(-1);
  assert.ok(timerCameraOff);
  assert.equal(timerCameraOff.src, `${SLASH}phrases${SLASH}fi${SLASH}camera_off.mp3`);
  assert.equal(timerCameraOff.paused, false, "camera_off phrase must remain playing after stop()");

  await checker.start();
  assert.equal(timerCameraOff.paused, true, "Subsequent start() must stop camera_off phrase");
  const ws2 = env.sockets[1];
  assert.ok(ws2);
  ws2.serverOpen();
  await flushMicrotasks();

  env.phraseAudioElements = [];
  ws2.serverSend({ type: "status", live: "closed", detail: "Auto-stop after 45s idle" });
  await flushMicrotasks();

  assert.equal(checker.get().running, false);
  assert.equal(env.phraseAudioElements.length, 1);
  assert.equal(env.phraseAudioElements[0].src, `${SLASH}phrases${SLASH}fi${SLASH}camera_off.mp3`);
  assert.equal(env.phraseAudioElements[0].paused, false);
  phrasesMod.stopPhrase();

  const savedCloseEvent = (globalThis as { CloseEvent?: unknown }).CloseEvent;
  Object.defineProperty(globalThis, "CloseEvent", { value: undefined, configurable: true, writable: true });
  try {
    const sock = new MockSocket();
    t.mock.timers.tick(260);
    assert.equal(sock.readyState, 1);
    let closedEv: CloseEvent | null = null;
    sock.onclose = (ev) => {
      closedEv = ev;
    };
    sock.close(1000, "normal closure");
    t.mock.timers.tick(10);
    assert.ok(closedEv);
    assert.equal((closedEv as CloseEvent).code, 1000);
    assert.equal((closedEv as CloseEvent).reason, "normal closure");
    assert.equal((closedEv as CloseEvent).wasClean, true);
  } finally {
    Object.defineProperty(globalThis, "CloseEvent", { value: savedCloseEvent, configurable: true, writable: true });
  }
});
