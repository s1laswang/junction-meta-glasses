import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClientMsg,
  DeviceState,
  Field,
  LabelRead,
  ServerMsg,
  Verdict,
} from "../../shared/types.ts";
import { decode, letterbox, SPOT_LABELS, type FieldBox } from "../../server/src/spotter.ts";
import type { CheckState, Checker as CheckerType } from "../src/lib/checker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const STYLES_CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const LIVE_SRC = readFileSync(resolve(HERE, "../src/screens/Live.tsx"), "utf8");
const CHECKER_SRC = readFileSync(resolve(HERE, "../src/lib/checker.ts"), "utf8");
const EM_DASH = "\u2014";
const SLASH = "/";
const STAR = "*";

const req = createRequire(import.meta.url);
const reactCjs = req("react") as {
  useSyncExternalStore: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
};
const origUseSyncExternalStore = reactCjs.useSyncExternalStore;
reactCjs.useSyncExternalStore = <T,>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T => origUseSyncExternalStore(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot);

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

function makeStorage(backing: Map<string, string>) {
  return {
    get length() {
      return backing.size;
    },
    key(index: number): string | null {
      return Array.from(backing.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return backing.has(key) ? backing.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      backing.set(key, String(value));
    },
    removeItem(key: string): void {
      backing.delete(key);
    },
    clear(): void {
      backing.clear();
    },
  };
}

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const activeIntervals = new Set<ReturnType<typeof setInterval>>();
type TrackedTimeout = {
  id: number;
  delay: number;
  cleared: boolean;
  fired: boolean;
  cb: () => void;
  nativeHandle: ReturnType<typeof setTimeout>;
};
let nextTimerId = 1;
const trackedTimeouts = new Map<number, TrackedTimeout>();

Object.defineProperty(globalThis, "setInterval", {
  value: (...args: Parameters<typeof setInterval>): ReturnType<typeof setInterval> => {
    const handle = realSetInterval(...args);
    (handle as unknown as { unref?: () => void }).unref?.();
    activeIntervals.add(handle);
    return handle;
  },
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "clearInterval", {
  value: (handle: ReturnType<typeof setInterval>) => {
    activeIntervals.delete(handle);
    realClearInterval(handle);
  },
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "setTimeout", {
  value: (fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): ReturnType<typeof setTimeout> => {
    const delay = typeof ms === "number" ? ms : 0;
    const id = nextTimerId++;
    const entry: TrackedTimeout = {
      id,
      delay,
      cleared: false,
      fired: false,
      cb: () => {
        if (entry.cleared || entry.fired) return;
        entry.fired = true;
        fn(...rest);
      },
      nativeHandle: null as unknown as ReturnType<typeof setTimeout>,
    };
    const nativeHandle = realSetTimeout(() => {
      entry.cb();
    }, delay);
    (nativeHandle as unknown as { unref?: () => void }).unref?.();
    entry.nativeHandle = nativeHandle;
    trackedTimeouts.set(id, entry);
    return id as unknown as ReturnType<typeof setTimeout>;
  },
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "clearTimeout", {
  value: (handle: ReturnType<typeof setTimeout>) => {
    const id = Number(handle);
    const entry = trackedTimeouts.get(id);
    if (entry) {
      entry.cleared = true;
      realClearTimeout(entry.nativeHandle);
      return;
    }
    realClearTimeout(handle);
  },
  configurable: true,
  writable: true,
});

function firePendingTimeoutsByDelay(delayMs: number): number {
  let count = 0;
  for (const entry of Array.from(trackedTimeouts.values())) {
    if (entry.delay === delayMs && !entry.cleared && !entry.fired) {
      realClearTimeout(entry.nativeHandle);
      entry.cb();
      count++;
    }
  }
  return count;
}

function activeTimeoutsByDelay(delayMs: number): TrackedTimeout[] {
  return Array.from(trackedTimeouts.values()).filter((e) => e.delay === delayMs && !e.cleared && !e.fired);
}

const localMap = new Map<string, string>();
const sessionMap = new Map<string, string>();
const localStorageShim = makeStorage(localMap);
const sessionStorageShim = makeStorage(sessionMap);

const locationShim = {
  search: "",
  pathname: "/",
  hash: "",
  protocol: "https:",
  host: "holdup.example",
  origin: ["https:", "", "holdup.example"].join("/"),
};

const historyShim = {
  state: null,
  replaceState() {},
  pushState() {},
  back() {},
};

const windowEvents = makeEventMap();
const docEvents = makeEventMap();
const mediaEvents = makeEventMap();

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
            const v = (i / 4) % 2 === 0 ? 200 : 20;
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
      return "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAE=";
    },
  };
}

const documentShim = {
  visibilityState: "visible",
  title: "",
  createElement(tag: string) {
    if (tag === "canvas") return createMockCanvas();
    return {
      width: 0,
      height: 0,
      style: {},
      setAttribute() {},
      remove() {},
      click() {},
      focus() {},
      getContext: () => null,
    };
  },
  getElementById() {
    return { textContent: "" };
  },
  body: {
    appendChild() {},
    classList: { add() {}, remove() {} },
  },
  addEventListener(type: string, fn: ListenerFn) {
    docEvents.add(type, fn);
  },
  removeEventListener(type: string, fn: ListenerFn) {
    docEvents.remove(type, fn);
  },
};

type MockTrack = {
  kind: "video" | "audio";
  label: string;
  readyState: "live" | "ended";
  stopCalls: number;
  stop: () => void;
  addEventListener: (type: string, fn: ListenerFn) => void;
  removeEventListener: (type: string, fn: ListenerFn) => void;
};

function createTrack(kind: "video" | "audio", label: string): MockTrack {
  const trackEvents = makeEventMap();
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
      trackEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      trackEvents.remove(type, fn);
    },
  };
  return track;
}

let createdVideoTracks: MockTrack[] = [];

const navigatorShim = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile",
  vibrate: () => true,
  mediaSession: {
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler() {},
  },
  mediaDevices: {
    async getUserMedia(constraints: { video?: unknown; audio?: unknown }) {
      const vTracks = constraints.video ? [createTrack("video", "Back Camera")] : [];
      const aTracks = constraints.audio ? [createTrack("audio", "Phone Mic")] : [];
      createdVideoTracks.push(...vTracks);
      return {
        getTracks: () => [...vTracks, ...aTracks],
        getVideoTracks: () => vTracks,
        getAudioTracks: () => aTracks,
      };
    },
    async enumerateDevices() {
      return [
        { kind: "audioinput", deviceId: "default", label: "Phone Mic" },
        { kind: "audiooutput", deviceId: "default", label: "Phone Speaker" },
      ];
    },
    addEventListener(type: string, fn: ListenerFn) {
      mediaEvents.add(type, fn);
    },
    removeEventListener(type: string, fn: ListenerFn) {
      mediaEvents.remove(type, fn);
    },
  },
  permissions: {
    query: async () => ({ state: "granted" }),
  },
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

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
    sockets.push(this);
  }

  send(data: string) {
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
    async addModule() {},
  };
  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
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
      connect(dest: unknown) {
        return dest;
      },
      disconnect() {},
    };
  }
  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 440, setTargetAtTime() {} },
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
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      onended: null,
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
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  constructor(src = "") {
    this.src = src;
  }
  addEventListener() {}
  removeEventListener() {}
  load() {}
  async play() {
    if (this.src.includes("/phrases/")) {
      const err = new Error("No cached clip");
      this.onerror?.(err);
      throw err;
    }
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
}

let sockets: MockWebSocket[] = [];
const checkersToDispose: CheckerType[] = [];

const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  location: locationShim,
  speechSynthesis: {
    speaking: false,
    cancel() {},
    speak() {},
    getVoices: () => [],
  },
  AudioContext: MockAudioContext,
  AudioWorkletNode: MockAudioWorkletNode,
  addEventListener(type: string, fn: ListenerFn) {
    windowEvents.add(type, fn);
  },
  removeEventListener(type: string, fn: ListenerFn) {
    windowEvents.remove(type, fn);
  },
  dispatchEvent() {
    return true;
  },
};

const fetchShim = async (input: unknown): Promise<Response> => {
  const url = String(input);
  if (url.includes("/api/health")) {
    return new Response(JSON.stringify({ ok: true, gemini: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/api/stats")) {
    return new Response(JSON.stringify({ calls: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
};

const ReactMod = await import("react");
const React = ReactMod.default;
const { createElement } = ReactMod;
const { renderToStaticMarkup } = await import("react-dom/server");

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: sessionStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "history", { value: historyShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "document", { value: documentShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: navigatorShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "fetch", { value: fetchShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "WebSocket", { value: MockWebSocket, configurable: true, writable: true });
Object.defineProperty(globalThis, "AudioContext", { value: MockAudioContext, configurable: true, writable: true });
Object.defineProperty(globalThis, "AudioWorkletNode", { value: MockAudioWorkletNode, configurable: true, writable: true });
Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { value: MockSpeechUtterance, configurable: true, writable: true });
Object.defineProperty(globalThis, "MediaMetadata", { value: MockMediaMetadata, configurable: true, writable: true });
Object.defineProperty(globalThis, "Audio", { value: MockAudioElement, configurable: true, writable: true });
if (typeof URL.createObjectURL !== "function") {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:holdup-silent", configurable: true, writable: true });
}

const { Checker } = await import("../src/lib/checker.ts");
const { Live } = await import("../src/screens/Live.tsx");
const { demoProfile, saveConsent, saveProfile, saveSettings, loadSettings } = await import("../src/lib/storage.ts");
const { emptyRead, matchVerdict, mockScene } = await import("../src/lib/verdicts.ts");
const { policyForRtt } = await import("../src/lib/frames.ts");

const fieldVal = <T,>(value: T | null, confidence = 0.96): Field<T> => ({ value, confidence });

function sampleRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    ...emptyRead("medication"),
    product: fieldVal("Norvasc", 0.98),
    ingredient: fieldVal("amlodipine", 0.97),
    strength: fieldVal("5 mg", 0.96),
    dosing: fieldVal("1 tablet daily", 0.92),
    expiry: fieldVal("2027-08", 0.94),
    readability: 0.95,
    ...overrides,
  };
}

function makeState(overrides: Partial<CheckState> = {}): CheckState {
  return {
    running: true,
    mode: "live",
    conn: "open",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: "open",
    serverDetail: "",
    model: "gemini-3.8-live",
    session: "SPOT01",
    online: true,
    health: "ok",
    rtt: 35,
    policy: policyForRtt(35),
    fps: 1,
    framesSent: 4,
    camera: "on",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "on",
    micPerm: "granted",
    micMsg: "",
    micLabel: "Phone Mic",
    micLevel: 0.1,
    route: "Phone Speaker",
    source: "phone",
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: null,
    autoStopAt: Date.now() + 40_000,
    snapshotBusy: false,
    checking: false,
    hudConnected: false,
    authNeeded: false,
    speaking: false,
    sharpness: 0.72,
    serverFeatures: ["scene", "datamatrix", "addmed", "sonar"],
    lastCode: null,
    readiness: 0.85,
    fields: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
}

function makeFakeChecker(state: CheckState): CheckerType {
  return {
    subscribe: () => () => {},
    get: () => state,
    attachVideo() {},
    primary() {},
    stop: async () => {},
    start: async () => {},
    toggle() {},
    setSource: async () => {},
    sendText() {},
    snapshot: async () => {},
    offlineCheckImage: async () => {},
    dismissVerdict() {},
    repeat() {},
    logDose() {},
    answerProposal() {},
    backToLive() {},
    simulateDrop() {},
    toggleSnapshotMode() {},
    injectCode() {},
    feature: () => true,
  } as unknown as CheckerType;
}

function renderLiveWithState(state: CheckState, consented = true): string {
  return renderToStaticMarkup(
    createElement(Live, {
      checker: makeFakeChecker(state),
      consented,
      onReviewConsent() {},
      onFixPermissions() {},
    }),
  );
}

function renderLiveWithChecker(checker: CheckerType, consented = true): string {
  return renderToStaticMarkup(
    createElement(Live, {
      checker,
      consented,
      onReviewConsent() {},
      onFixPermissions() {},
    }),
  );
}

interface ParsedFieldBox {
  classes: string[];
  style: string;
  topPct: number;
  leftPct: number;
  heightPct: number;
  widthPct: number;
  text: string;
}

function extractRenderedFieldBoxes(html: string): ParsedFieldBox[] {
  const pattern = /<div class="(field-box[^"]*)" style="([^"]+)"><span>([^<]*)<\/span><\/div>/g;
  const out: ParsedFieldBox[] = [];
  for (const match of html.matchAll(pattern)) {
    const classes = match[1].trim().split(/\s+/);
    const style = match[2];
    const text = match[3];
    const topMatch = /top:([+-]?\d+(?:\.\d+)?)%/.exec(style);
    const leftMatch = /left:([+-]?\d+(?:\.\d+)?)%/.exec(style);
    const heightMatch = /height:([+-]?\d+(?:\.\d+)?)%/.exec(style);
    const widthMatch = /width:([+-]?\d+(?:\.\d+)?)%/.exec(style);
    assert.ok(topMatch && leftMatch && heightMatch && widthMatch, `Unexpected field-box style: ${style}`);
    out.push({
      classes,
      style,
      topPct: Number(topMatch[1]),
      leftPct: Number(leftMatch[1]),
      heightPct: Number(heightMatch[1]),
      widthPct: Number(widthMatch[1]),
      text,
    });
  }
  return out;
}

function scanZeroComments(source: string): number {
  let comments = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (ch === SLASH && next === SLASH) {
      comments++;
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === SLASH && next === STAR) {
      comments++;
      i += 2;
      while (i + 1 < source.length && !(source[i] === STAR && source[i + 1] === SLASH)) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            if (depth > 0) i++;
          }
          i++;
          continue;
        }
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "/" && i > 0) {
      let prevIdx = i - 1;
      while (prevIdx >= 0 && /\s/.test(source[prevIdx])) prevIdx--;
      const prev = prevIdx >= 0 ? source[prevIdx] : "";
      if ("=(,:!&|?[{;".includes(prev)) {
        i++;
        let inCharClass = false;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "[") inCharClass = true;
          else if (source[i] === "]") inCharClass = false;
          else if (source[i] === "/" && !inCharClass) {
            i++;
            while (i < source.length && /[a-z]/i.test(source[i])) i++;
            break;
          }
          i++;
        }
        continue;
      }
    }
    i++;
  }
  return comments;
}

const SAMPLE_FIELDS: FieldBox[] = [
  { label: "strength", box: [410, 120, 495, 360], score: 0.94 },
  { label: "product", box: [180, 100, 310, 740], score: 0.91 },
  { label: "expiry", box: [760, 520, 835, 860], score: 0.82 },
  { label: "allergens", box: [610, 110, 705, 680], score: 0.77 },
];

beforeEach(() => {
  localStorageShim.clear();
  sessionStorageShim.clear();
  sockets = [];
  createdVideoTracks = [];
  windowEvents.clear();
  docEvents.clear();
  mediaEvents.clear();
  navigatorShim.onLine = true;
  documentShim.visibilityState = "visible";
  saveConsent();
  saveProfile(demoProfile());
  saveSettings({ ...loadSettings(), source: "phone", voice: false, showPanel: false });
});

afterEach(async () => {
  while (checkersToDispose.length > 0) {
    const c = checkersToDispose.pop()!;
    c.dispose();
  }
  for (const t of Array.from(trackedTimeouts.values())) {
    if (!t.cleared && !t.fired) {
      t.cleared = true;
      realClearTimeout(t.nativeHandle);
    }
  }
  trackedTimeouts.clear();
});

after(() => {
  for (const h of activeIntervals) realClearInterval(h);
  activeIntervals.clear();
});

test("1. Checker handles { type: 'fields', fields } over /live, notifies subscribers, refreshes the 2500 ms staleness timer on newer frames, and clears stale boxes", async () => {
  const checker = new Checker();
  checkersToDispose.push(checker);

  assert.equal(checker.get().fields, null);

  const observedSnapshots: Array<CheckState["fields"]> = [];
  const unsubscribe = checker.subscribe(() => {
    observedSnapshots.push(checker.get().fields);
  });

  await checker.start();
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSend({
    type: "ready",
    model: "gemini-3.8-live",
    session: checker.get().session,
    features: ["scene", "datamatrix", "addmed", "sonar"],
  });
  ws.serverSend({ type: "status", live: "open" });

  assert.equal(checker.get().camera, "on");
  assert.equal(checker.get().source, "phone");

  const firstBatch: FieldBox[] = [
    { label: "product", box: [200, 140, 320, 700], score: 0.89 },
  ];
  ws.serverSend({ type: "fields", fields: firstBatch });
  assert.deepEqual(checker.get().fields, firstBatch);
  assert.equal(activeTimeoutsByDelay(2500).length, 1);
  const firstTimer = activeTimeoutsByDelay(2500)[0];

  const secondBatch: FieldBox[] = [
    { label: "strength", box: [420, 150, 500, 390], score: 0.95 },
    { label: "product", box: [200, 140, 320, 700], score: 0.91 },
  ];
  ws.serverSend({ type: "fields", fields: secondBatch });
  assert.equal(firstTimer.cleared, true, "Previous 2500 ms fieldsTimer must be cleared when a newer fields frame arrives");
  assert.deepEqual(checker.get().fields, secondBatch);
  assert.equal(activeTimeoutsByDelay(2500).length, 1);

  const firedCount = firePendingTimeoutsByDelay(2500);
  assert.equal(firedCount, 1);
  assert.equal(checker.get().fields, null, "Stale FieldSpotter boxes must clear to null after 2500 ms without new detections");

  ws.serverSend({ type: "fields", fields: SAMPLE_FIELDS });
  assert.equal(checker.get().fields?.length, 4);
  ws.serverSend({ type: "fields", fields: [] });
  assert.deepEqual(checker.get().fields, []);

  unsubscribe();
  assert.ok(observedSnapshots.some((snap) => Array.isArray(snap) && snap.length === 2));
  assert.ok(observedSnapshots.includes(null));
});

test("2. Checker + Live integration across source switch to 'glasses', device fallback, scene/item verdicts, and stop()", async () => {
  const checker = new Checker();
  checkersToDispose.push(checker);

  await checker.start();
  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSend({ type: "status", live: "open" });

  ws.serverSend({ type: "fields", fields: SAMPLE_FIELDS });
  const livePhoneHtml = renderLiveWithChecker(checker);
  const phoneBoxes = extractRenderedFieldBoxes(livePhoneHtml);
  assert.equal(phoneBoxes.length, 4);
  assert.equal(phoneBoxes[0].text, "Dose");

  await checker.setSource("glasses");
  assert.equal(checker.get().source, "glasses");
  assert.equal(checker.get().camera, "off");
  assert.equal(checker.get().sharpness, 0);
  assert.ok(
    ws.sent.some((m) => m.type === "source" && m.source === "glasses"),
    "Switching to glasses must notify /live with { type: 'source', source: 'glasses' }",
  );
  assert.ok(createdVideoTracks.length >= 1 && createdVideoTracks[0].stopCalls >= 1);

  const glassesHtml = renderLiveWithChecker(checker);
  assert.equal(extractRenderedFieldBoxes(glassesHtml).length, 0, "FieldSpotter boxes must never render while source is glasses");
  assert.match(glassesHtml, /Using glasses camera/);

  const doffedDevice: DeviceState = {
    connected: true,
    worn: false,
    battery: 78,
    streaming: false,
    source: "glasses",
  };
  ws.serverSend({ type: "device", device: doffedDevice });
  await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  assert.equal(checker.get().source, "phone");
  assert.equal(checker.get().camera, "on");

  ws.serverSend({ type: "fields", fields: SAMPLE_FIELDS });
  assert.equal(extractRenderedFieldBoxes(renderLiveWithChecker(checker)).length, 4);

  const sceneVerdict = mockScene(demoProfile());
  ws.serverSend({ type: "verdict", verdict: sceneVerdict });
  const sceneHtml = renderLiveWithChecker(checker);
  assert.equal(
    extractRenderedFieldBoxes(sceneHtml).length,
    0,
    "Scene ('Which one?') verdict must suppress FieldSpotter field-box overlay so scene-box markers do not collide",
  );
  assert.match(sceneHtml, /class="scene-box /);

  checker.dismissVerdict();
  assert.equal(checker.get().verdict, null);

  const itemVerdict: Verdict = {
    ...matchVerdict(demoProfile(), demoProfile().meds[0]),
    read: sampleRead(),
    mode: "item",
  };
  ws.serverSend({ type: "verdict", verdict: itemVerdict });
  assert.equal(checker.get().verdict?.headline, itemVerdict.headline);
  assert.equal(checker.get().checking, false);
  assert.equal(checker.get().cue, null);

  firePendingTimeoutsByDelay(2500);
  assert.equal(checker.get().fields, null, "Once the detector quiets after a verdict, stale boxes expire cleanly to null");
  assert.equal(extractRenderedFieldBoxes(renderLiveWithChecker(checker)).length, 0);

  ws.serverSend({ type: "fields", fields: SAMPLE_FIELDS });
  assert.equal(extractRenderedFieldBoxes(renderLiveWithChecker(checker)).length, 4);
  await checker.stop();
  assert.equal(checker.get().running, false);
  assert.equal(checker.get().camera, "off");
  const stoppedHtml = renderLiveWithChecker(checker);
  assert.equal(
    extractRenderedFieldBoxes(stoppedHtml).length,
    0,
    "Stopping a check turns camera off and immediately hides FieldSpotter boxes",
  );
  firePendingTimeoutsByDelay(2500);
  assert.equal(checker.get().fields, null);
});

test("3. Live renders Dose highlighted vs Name/Expiry/Allergens inside aria-hidden='true' without spamming screen readers, and hides boxes when camera is off/paused/error or unconsented", () => {
  const html = renderLiveWithState(makeState({ fields: SAMPLE_FIELDS }));
  const boxes = extractRenderedFieldBoxes(html);
  assert.equal(boxes.length, 4);

  assert.deepEqual(
    boxes.map((b) => ({ classes: b.classes, text: b.text })),
    [
      { classes: ["field-box", "strength"], text: "Dose" },
      { classes: ["field-box", "product"], text: "Name" },
      { classes: ["field-box", "expiry"], text: "Expiry" },
      { classes: ["field-box", "allergens"], text: "Allergens" },
    ],
  );

  const ariaHiddenWrapperPattern = /<div aria-hidden="true">(?:<div class="field-box [^"]+" style="[^"]+"><span>[^<]+<\/span><\/div>){4}<\/div>/;
  assert.match(
    html,
    ariaHiddenWrapperPattern,
    "All FieldSpotter boxes must sit inside an aria-hidden='true' wrapper so TalkBack/VoiceOver is not spammed",
  );

  const politeRegions = [...html.matchAll(/<p class="sr-only" aria-live="polite"[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  assert.equal(politeRegions.length, 1);
  assert.equal(politeRegions[0], "", "FieldSpotter box labels must never leak into the polite live region");
  assert.match(html, /class="viewfinder" aria-label="Camera on\. Picture sharpness 72 percent\." role="img"/);

  const baseRuleMatch = /\.field-box\s*\{([^}]+)\}/.exec(STYLES_CSS);
  const strengthRuleMatch = /\.field-box\.strength\s*\{([^}]+)\}/.exec(STYLES_CSS);
  const spanRuleMatch = /\.field-box span\s*\{([^}]+)\}/.exec(STYLES_CSS);
  const strengthSpanRuleMatch = /\.field-box\.strength span\s*\{([^}]+)\}/.exec(STYLES_CSS);

  assert.ok(baseRuleMatch, "styles.css must define .field-box");
  assert.ok(strengthRuleMatch, "styles.css must define .field-box.strength highlight rule");
  assert.ok(spanRuleMatch, "styles.css must define .field-box span badge rule");
  assert.ok(strengthSpanRuleMatch, "styles.css must define .field-box.strength span highlight badge rule");

  assert.match(baseRuleMatch[1], /border:\s*2px\s+dashed\s+var\(--muted\)/);
  assert.match(baseRuleMatch[1], /pointer-events:\s*none/);
  assert.match(strengthRuleMatch[1], /border:\s*4px\s+solid\s+var\(--accent\)/);
  assert.match(spanRuleMatch[1], /background:\s*var\(--muted\)/);
  assert.match(strengthSpanRuleMatch[1], /background:\s*var\(--accent\)/);

  for (const nonActiveCamera of ["off", "starting", "paused", "error"] as const) {
    const camHtml = renderLiveWithState(makeState({ camera: nonActiveCamera, fields: SAMPLE_FIELDS }));
    assert.equal(
      extractRenderedFieldBoxes(camHtml).length,
      0,
      `FieldSpotter boxes must be hidden when camera state is '${nonActiveCamera}'`,
    );
  }

  const glassesStateHtml = renderLiveWithState(
    makeState({
      source: "glasses",
      camera: "on",
      fields: SAMPLE_FIELDS,
      device: { connected: true, worn: true, battery: 90, streaming: true, source: "glasses" },
    }),
  );
  assert.equal(
    extractRenderedFieldBoxes(glassesStateHtml).length,
    0,
    "FieldSpotter boxes must remain hidden whenever source === 'glasses' even if camera flag were 'on'",
  );

  const emptyFieldsHtml = renderLiveWithState(makeState({ fields: [] }));
  assert.equal(extractRenderedFieldBoxes(emptyFieldsHtml).length, 0);

  const nullFieldsHtml = renderLiveWithState(makeState({ fields: null }));
  assert.equal(extractRenderedFieldBoxes(nullFieldsHtml).length, 0);

  const unconsentedHtml = renderLiveWithState(makeState({ fields: SAMPLE_FIELDS }), false);
  assert.equal(extractRenderedFieldBoxes(unconsentedHtml).length, 0);
  assert.match(unconsentedHtml, /HoldUp needs your OK first/);
});

test("4. Percentage coordinate mapping ([ymin, xmin, ymax, xmax] in 0..1000 -> 0..100%) is clamped by spotter.decode() and rendered accurately in Live", () => {
  const w = 1280;
  const h = 720;
  const rgba = new Uint8Array(w * h * 4).fill(128);
  const lb = letterbox(rgba, w, h);

  const anchors = 4;
  const nc = SPOT_LABELS.length;
  const raw = new Float32Array((4 + nc) * anchors);

  const setAnchor = (
    idx: number,
    cx: number,
    cy: number,
    bw: number,
    bh: number,
    cls: number,
    score: number,
  ) => {
    raw[idx] = cx;
    raw[anchors + idx] = cy;
    raw[2 * anchors + idx] = bw;
    raw[3 * anchors + idx] = bh;
    raw[(4 + cls) * anchors + idx] = score;
  };

  setAnchor(0, -40, -20, 260, 240, 1, 0.96);
  setAnchor(1, 680, 660, 300, 300, 0, 0.92);
  setAnchor(2, 320, 320, 160, 80, 2, 0.88);
  setAnchor(3, 480, 260, 120, 60, 3, 0.84);

  const decoded = decode(raw, anchors, lb, w, h);
  assert.equal(decoded.length, 4);

  for (const d of decoded) {
    const [ymin, xmin, ymax, xmax] = d.box;
    assert.equal(Number.isInteger(ymin), true);
    assert.equal(Number.isInteger(xmin), true);
    assert.equal(Number.isInteger(ymax), true);
    assert.equal(Number.isInteger(xmax), true);
    assert.ok(ymin >= 0 && ymin <= 1000, `ymin out of range: ${ymin}`);
    assert.ok(xmin >= 0 && xmin <= 1000, `xmin out of range: ${xmin}`);
    assert.ok(ymax >= ymin && ymax <= 1000, `ymax out of range: ${ymax} (ymin=${ymin})`);
    assert.ok(xmax >= xmin && xmax <= 1000, `xmax out of range: ${xmax} (xmin=${xmin})`);
  }

  const topLeftClamped = decoded.find((d) => d.label === "strength")!;
  assert.equal(topLeftClamped.box[0], 0, "Overflow above top edge must clamp ymin to 0");
  assert.equal(topLeftClamped.box[1], 0, "Overflow past left edge must clamp xmin to 0");

  const bottomRightClamped = decoded.find((d) => d.label === "product")!;
  assert.equal(bottomRightClamped.box[2], 1000, "Overflow past bottom edge must clamp ymax to 1000");
  assert.equal(bottomRightClamped.box[3], 1000, "Overflow past right edge must clamp xmax to 1000");

  const precisionBoxes: FieldBox[] = [
    { label: "strength", box: [0, 0, 1000, 1000], score: 0.99 },
    { label: "product", box: [125, 250, 375, 875], score: 0.93 },
    { label: "expiry", box: [412, 108, 498, 364], score: 0.87 },
    { label: "allergens", box: [500, 500, 500, 500], score: 0.81 },
    ...decoded,
  ];

  const html = renderLiveWithState(makeState({ fields: precisionBoxes }));
  const rendered = extractRenderedFieldBoxes(html);
  assert.equal(rendered.length, precisionBoxes.length);

  assert.equal(rendered[0].style, "top:0%;left:0%;height:100%;width:100%");
  assert.equal(rendered[1].style, "top:12.5%;left:25%;height:25%;width:62.5%");
  assert.equal(rendered[2].style, "top:41.2%;left:10.8%;height:8.6%;width:25.6%");
  assert.equal(rendered[3].style, "top:50%;left:50%;height:0%;width:0%");

  for (let i = 0; i < precisionBoxes.length; i++) {
    const [ymin, xmin, ymax, xmax] = precisionBoxes[i].box;
    const r = rendered[i];
    assert.ok(Math.abs(r.topPct - ymin / 10) < 1e-9);
    assert.ok(Math.abs(r.leftPct - xmin / 10) < 1e-9);
    assert.ok(Math.abs(r.heightPct - (ymax - ymin) / 10) < 1e-9);
    assert.ok(Math.abs(r.widthPct - (xmax - xmin) / 10) < 1e-9);
    assert.ok(r.topPct >= 0 && r.topPct <= 100);
    assert.ok(r.leftPct >= 0 && r.leftPct <= 100);
    assert.ok(r.heightPct >= 0 && r.topPct + r.heightPct <= 100 + 1e-9);
    assert.ok(r.widthPct >= 0 && r.leftPct + r.widthPct <= 100 + 1e-9);
  }
});

test("5. Source contract: Live.tsx + checker.ts FieldSpotter wiring intact, and test file contains zero comments, zero em dashes, and zero git invocations", () => {
  assert.match(CHECKER_SRC, /case "fields":/);
  assert.match(CHECKER_SRC, /2500/);
  assert.match(LIVE_SRC, /const FIELD_WORD:\s*Record<string,\s*string>\s*=\s*\{\s*strength:\s*"Dose",\s*product:\s*"Name",\s*expiry:\s*"Expiry",\s*allergens:\s*"Allergens"\s*\}/);
  assert.match(LIVE_SRC, /cameraOn && s\.fields\?\.length && s\.verdict\?\.mode !== "scene"/);

  const selfSrc = readFileSync(SELF_PATH, "utf8");
  assert.equal(selfSrc.includes(EM_DASH), false);
  assert.equal(scanZeroComments(selfSrc), 0);
  const forbiddenExecSync = ["exec", "Sync"].join("");
  const forbiddenChildProc = ["node:child", "_process"].join("");
  const forbiddenGitStatus = ["git ", "status"].join("");
  assert.equal(selfSrc.includes(forbiddenExecSync), false);
  assert.equal(selfSrc.includes(forbiddenChildProc), false);
  assert.equal(selfSrc.includes(forbiddenGitStatus), false);
});
