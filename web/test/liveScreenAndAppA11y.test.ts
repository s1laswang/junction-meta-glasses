import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CoachCue,
  DeviceState,
  FeatureFlag,
  Field,
  LabelRead,
  Med,
  SceneItem,
  Verdict,
} from "../../shared/types.ts";
import type { Banner, Caption, Checker, CheckState } from "../src/lib/checker.ts";

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

const realSetInterval = globalThis.setInterval;
const activeIntervals = new Set<ReturnType<typeof setInterval>>();
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

const storageMap = new Map<string, string>();
const sessionMap = new Map<string, string>();

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

const localStorageShim = makeStorage(storageMap);
const sessionStorageShim = makeStorage(sessionMap);

const locationShim = {
  search: "",
  pathname: "/",
  hash: "",
  protocol: "https:",
  host: "localhost:5173",
};

const historyShim = {
  state: null,
  replaceState() {},
  pushState() {},
  back() {},
};

const documentShim: {
  visibilityState: string;
  title: string;
  createElement: () => { width: number; height: number; getContext: () => null };
  addEventListener: () => void;
  removeEventListener: () => void;
} = {
  visibilityState: "visible",
  title: "",
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  addEventListener() {},
  removeEventListener() {},
};

const navigatorShim: {
  language: string;
  onLine: boolean;
  userAgent: string;
  vibrate: () => boolean;
  mediaDevices: {
    getUserMedia: () => Promise<{ getTracks: () => Array<{ stop: () => void }> }>;
    enumerateDevices: () => Promise<Array<{ kind: string; label: string }>>;
    addEventListener: () => void;
    removeEventListener: () => void;
  };
  permissions: {
    query: () => Promise<{ state: string }>;
  };
} = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile",
  vibrate: () => true,
  mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    enumerateDevices: async () => [{ kind: "audiooutput", label: "Phone speaker" }],
    addEventListener() {},
    removeEventListener() {},
  },
  permissions: {
    query: async () => ({ state: "granted" }),
  },
};

const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  speechSynthesis: {
    cancel() {},
    speak() {},
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
};

let statsHttpStatus = 200;
let healthGeminiStatus: "ok" | "down" = "ok";

const fetchShim = async (input: unknown): Promise<Response> => {
  const url = String(input);
  if (url.includes("/api/health")) {
    return new Response(JSON.stringify({ ok: true, gemini: healthGeminiStatus }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/api/stats")) {
    return new Response(
      JSON.stringify(statsHttpStatus === 200 ? { calls: 0 } : { message: "Access key required" }),
      {
        status: statsHttpStatus,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response("{}", {
    status: 200,
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

const { CueArrow, Icon, Logo } = await import("../src/components/Icons.tsx");
const { Live } = await import("../src/screens/Live.tsx");
const { demoProfile, emptyMed, loadSettings, saveConsent, saveSettings } = await import("../src/lib/storage.ts");
const { emptyRead, matchVerdict, mockScene } = await import("../src/lib/verdicts.ts");
const { setAccessKey } = await import("../src/lib/key.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_CSS = readFileSync(resolve(HERE, "../src/styles.css"), "utf8");
const LIVE_SRC = readFileSync(resolve(HERE, "../src/screens/Live.tsx"), "utf8");
const APP_SRC = readFileSync(resolve(HERE, "../src/App.tsx"), "utf8");

after(() => {
  for (const h of activeIntervals) clearInterval(h);
  activeIntervals.clear();
});

type AppModule = typeof import("../src/App.tsx");
type LiveModule = typeof import("../src/screens/Live.tsx");

async function loadAppModule(tag: string): Promise<AppModule> {
  const url = new URL(`../src/App.tsx?case=${tag}`, import.meta.url).href;
  return (await import(url)) as AppModule;
}

async function loadLiveModule(tag: string): Promise<LiveModule> {
  const url = new URL(`../src/screens/Live.tsx?case=${tag}`, import.meta.url).href;
  return (await import(url)) as LiveModule;
}

function resetEnv(): void {
  localStorageShim.clear();
  sessionStorageShim.clear();
  locationShim.search = "";
  locationShim.pathname = "/";
  locationShim.hash = "";
  documentShim.visibilityState = "visible";
  documentShim.title = "";
  navigatorShim.onLine = true;
  navigatorShim.language = "en-US";
  statsHttpStatus = 200;
  healthGeminiStatus = "ok";
  setAccessKey("");
}

const f = <T,>(value: T | null, confidence = 0.95): Field<T> => ({ value, confidence });

function makeRead(overrides: Partial<LabelRead> = {}): LabelRead {
  return {
    ...emptyRead("medication"),
    product: f("Amlodipine", 0.97),
    ingredient: f("amlodipine", 0.94),
    strength: f("5 mg", 0.96),
    readability: 0.92,
    ...overrides,
  };
}

function makeCheckState(overrides: Partial<CheckState> = {}): CheckState {
  return {
    running: false,
    mode: "live",
    conn: "idle",
    connAttempt: 0,
    nextRetryMs: null,
    serverLive: null,
    serverDetail: "",
    model: null,
    session: "K7M2",
    online: true,
    health: "ok",
    rtt: null,
    policy: { fps: 1, quality: 0.7, longSide: 768, tier: "normal" },
    fps: 0,
    framesSent: 0,
    camera: "off",
    cameraPerm: "granted",
    cameraMsg: "",
    mic: "off",
    micPerm: "granted",
    micMsg: "",
    micLabel: "",
    micLevel: 0,
    route: "Phone speaker",
    source: "phone",
    device: null,
    captions: [],
    cue: null,
    verdict: null,
    verdictVia: null,
    autoStopAt: null,
    snapshotBusy: false,
    checking: false,
    hudConnected: null,
    authNeeded: false,
    speaking: false,
    sharpness: 0,
    serverFeatures: null,
    lastCode: null,
    readiness: null,
    addProposal: null,
    banner: null,
    lastError: null,
    hidden: false,
    ...overrides,
  };
}

function makeStubChecker(
  state: CheckState,
  enabledFeatures: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"],
): Checker {
  const featureSet = new Set<FeatureFlag>(enabledFeatures);
  return {
    subscribe: () => () => {},
    get: () => state,
    attachVideo() {},
    primary() {},
    start: async () => {},
    stop: async () => {},
    snapshot: async () => {},
    offlineCheckImage: async () => {},
    backToLive() {},
    repeat() {},
    logDose() {},
    dismissVerdict() {},
    setSource: async () => {},
    sendText() {},
    answerProposal() {},
    feature: (flag: FeatureFlag) => featureSet.has(flag),
    simulateDrop() {},
    injectCode() {},
    toggleSnapshotMode() {},
  } as unknown as Checker;
}

function noop(): void {}

function renderLive(stateOverrides: Partial<CheckState> = {}, consented = true): string {
  const state = makeCheckState(stateOverrides);
  const checker = makeStubChecker(state);
  return renderToStaticMarkup(
    createElement(Live, {
      checker,
      consented,
      onReviewConsent: noop,
      onFixPermissions: noop,
    }),
  );
}

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function assertAllSvgsDecorative(html: string): void {
  const svgOpenTags = html.match(/<svg\b[^>]*>/g) ?? [];
  assert.ok(svgOpenTags.length >= 1, "expected at least one SVG element");
  for (const tag of svgOpenTags) {
    assert.match(tag, /\baria-hidden="true"/, `SVG missing aria-hidden="true": ${tag}`);
    assert.match(tag, /\bfocusable="false"/, `SVG missing focusable="false": ${tag}`);
  }
}

function assertAriaReferencesAndUniqueIds(html: string): void {
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
  assert.equal(ids.length, new Set(ids).size, `duplicate IDs found: ${ids.join(", ")}`);
  const idSet = new Set(ids);

  for (const attr of ["aria-labelledby", "aria-describedby", "for"]) {
    const refs = Array.from(html.matchAll(new RegExp(`\\b${attr}="([^"]+)"`, "g")), (m) => m[1]);
    for (const refValue of refs) {
      for (const token of refValue.trim().split(/\s+/)) {
        assert.ok(idSet.has(token), `${attr}="${refValue}" references missing id="${token}"`);
      }
    }
  }

  const hashHrefs = Array.from(html.matchAll(/\bhref="#([^"]+)"/g), (m) => m[1]);
  for (const targetId of hashHrefs) {
    assert.ok(idSet.has(targetId), `href="#${targetId}" references missing id="${targetId}"`);
  }
}

function assertButtonsAccessible(html: string): void {
  const buttonMatches = Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g));
  assert.ok(buttonMatches.length >= 1, "expected at least one button");
  for (const [, attrs, inner] of buttonMatches) {
    const ariaLabel = attrs.match(/\baria-label="([^"]+)"/)?.[1]?.trim() ?? "";
    const textContent = decodeHtml(inner.replaceAll(/<[^>]+>/g, "")).trim();
    assert.ok(
      ariaLabel.length > 0 || textContent.length > 0,
      `button lacks accessible name: <button${attrs}>${inner}</button>`,
    );
  }
}

test("Live unconsented privacy gate blocks viewfinder, video, captions, and check controls until user agrees", () => {
  resetEnv();
  const html = renderLive({ running: true, camera: "on", sharpness: 0.9 }, false);
  const text = decodeHtml(html);

  assert.match(html, /^<section class="card stack" aria-labelledby="needconsent">/);
  assert.match(html, /<h2 id="needconsent">HoldUp needs your OK first<\/h2>/);
  assert.ok(
    text.includes(
      "Before the camera can be used, please read what HoldUp captures and where it goes. You can still look at and edit your profile.",
    ),
  );
  assert.match(html, /<button class="btn primary">Review and agree<\/button>/);

  assert.doesNotMatch(html, /class="viewfinder"/);
  assert.doesNotMatch(html, /<video\b/);
  assert.doesNotMatch(html, /CAMERA ON/);
  assert.doesNotMatch(html, /class="bigbtn/);
  assert.doesNotMatch(html, /class="captions"/);
  assert.doesNotMatch(html, /class="panel"/);
  assertAriaReferencesAndUniqueIds(html);
  assertButtonsAccessible(html);
});

test("CueArrow, Logo, and Icon helpers render pairwise-distinct decorative SVGs hidden from screen readers", () => {
  const cues: Array<CoachCue | null> = [
    "rotate_left",
    "rotate_right",
    "closer",
    "farther",
    "more_light",
    "hold_still",
    "other_side",
    "ok",
    null,
  ];
  const renderedSvgs = new Set<string>();

  for (const cue of cues) {
    const svg = renderToStaticMarkup(createElement(CueArrow, { cue }));
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /\bwidth="56"/);
    assert.match(svg, /\bheight="56"/);
    assert.match(svg, /\baria-hidden="true"/);
    assert.match(svg, /\bfocusable="false"/);
    renderedSvgs.add(svg);
  }
  assert.equal(renderedSvgs.size, 9, "all 8 CoachCue values plus null default must render distinct SVG paths");

  const hudArrow = renderToStaticMarkup(createElement(CueArrow, { cue: "closer", size: 104 }));
  assert.match(hudArrow, /\bwidth="104" height="104"/);

  const logoHtml = renderToStaticMarkup(createElement(Logo, { size: 30 }));
  assert.match(logoHtml, /\bwidth="30" height="30"/);
  assertAllSvgsDecorative(logoHtml);

  for (const key of Object.keys(Icon) as Array<keyof typeof Icon>) {
    const iconHtml = renderToStaticMarkup(createElement(Icon[key], { size: 24 }));
    assert.match(iconHtml, /\bwidth="24" height="24"/, `Icon.${key} size`);
    assertAllSvgsDecorative(iconHtml);
  }
});

test("Live cue card enforces verdict > checking > active cue > mode-specific idle guidance priority", () => {
  resetEnv();

  const idleStopped = decodeHtml(renderLive({ running: false, mode: "live" }));
  assert.ok(idleStopped.includes("Press Start, then hold the box up in front of you."));
  assert.match(renderLive({ running: false }), /<div class="cue idle">/);

  const idleSnapshot = decodeHtml(renderLive({ running: true, mode: "snapshot" }));
  assert.ok(idleSnapshot.includes("Hold the label steady, then press Check label."));

  const idleOffline = decodeHtml(renderLive({ running: true, mode: "offline" }));
  assert.ok(idleOffline.includes("Show me the barcode side of your medicine box."));

  const idleSpeaking = decodeHtml(renderLive({ running: true, mode: "live", speaking: true }));
  assert.ok(idleSpeaking.includes("Listening and watching\u2026"));

  const idleWatching = decodeHtml(renderLive({ running: true, mode: "live", speaking: false }));
  assert.ok(idleWatching.includes("Ask: \u201cIs this my evening pill?\u201d"));

  const activeCueHtml = renderLive({
    running: true,
    mode: "live",
    cue: { cue: "rotate_left", text: "Turn the box slightly left", ts: 1_000 },
  });
  assert.match(activeCueHtml, /<div class="cue ">/);
  assert.doesNotMatch(activeCueHtml, /class="cue idle"/);
  assert.match(activeCueHtml, /<p class="text">Turn the box slightly left<\/p>/);
  const rotateLeftSvg = renderToStaticMarkup(createElement(CueArrow, { cue: "rotate_left" }));
  assert.ok(activeCueHtml.includes(rotateLeftSvg));

  const checkingHtml = renderLive({
    running: true,
    checking: true,
    cue: { cue: "closer", text: "Move closer", ts: 1_000 },
  });
  assert.match(checkingHtml, /<div class="cue checking" aria-busy="true">/);
  assert.match(checkingHtml, /<span class="spinner" aria-hidden="true"><\/span>/);
  assert.match(checkingHtml, /<p class="text">Checking the label\u2026<\/p>/);
  assert.doesNotMatch(checkingHtml, /Move closer/);

  const profile = demoProfile();
  const verdict = matchVerdict(profile, profile.meds[0]);
  const verdictHtml = renderLive({
    running: true,
    checking: true,
    cue: { cue: "closer", text: "Move closer", ts: 1_000 },
    verdict,
    verdictVia: "live",
  });
  assert.match(verdictHtml, /<section class="verdict match" aria-labelledby="verdict-h">/);
  assert.match(verdictHtml, /<h2 id="verdict-h" class="headline" tabindex="-1">/);
  assert.doesNotMatch(verdictHtml, /class="cue\b/);
  assert.doesNotMatch(verdictHtml, /Checking the label\u2026/);
});

test("Live status banner exposes region landmark, non-color tone icons, and conditional recovery buttons", () => {
  resetEnv();
  assert.doesNotMatch(renderLive({ banner: null }), /class="banner\b/);

  const alertSvg = renderToStaticMarkup(createElement(Icon.alert, {}));
  const wifiOffSvg = renderToStaticMarkup(createElement(Icon.wifiOff, {}));
  const checkSvg = renderToStaticMarkup(createElement(Icon.check, {}));
  const infoSvg = renderToStaticMarkup(createElement(Icon.info, {}));

  const badBanner: Banner = {
    tone: "bad",
    title: "Snapshot failed",
    detail: "Server unreachable.",
    action: "retry",
  };
  const badHtml = renderLive({ running: true, mode: "offline", banner: badBanner });
  assert.match(badHtml, /<div class="banner bad" role="region" aria-label="Status">/);
  assert.ok(badHtml.includes(alertSvg), "bad tone prioritizes alert icon even when offline");
  assert.match(badHtml, /<strong>Snapshot failed<\/strong><span>Server unreachable\.<\/span>/);
  assert.match(badHtml, /<button class="btn small">Try again<\/button>/);
  assert.doesNotMatch(badHtml, /How to turn it on|Try live again/);

  const offlineHtml = renderLive({
    running: true,
    mode: "offline",
    online: false,
    banner: { tone: "info", title: "Offline mode", detail: "Barcode scan active." },
  });
  assert.match(offlineHtml, /<div class="banner info" role="region" aria-label="Status">/);
  assert.ok(offlineHtml.includes(wifiOffSvg));
  assert.doesNotMatch(offlineHtml, /<div class="actions">/);

  const goodHtml = renderLive({
    running: true,
    mode: "live",
    banner: { tone: "good", title: "Live assistant connected" },
  });
  assert.match(goodHtml, /<div class="banner good" role="region" aria-label="Status">/);
  assert.ok(goodHtml.includes(checkSvg));
  assert.match(goodHtml, /<strong>Live assistant connected<\/strong><\/div><\/div>/);

  const settingsAndCamErrorHtml = renderLive({
    running: true,
    mode: "live",
    camera: "error",
    banner: { tone: "warn", title: "Camera not available", detail: "Blocked in browser.", action: "settings" },
  });
  assert.match(settingsAndCamErrorHtml, /<div class="banner warn" role="region" aria-label="Status">/);
  assert.ok(settingsAndCamErrorHtml.includes(infoSvg));
  assert.match(settingsAndCamErrorHtml, /<button class="btn small">How to turn it on<\/button>/);
  const photoBtnsOnError = settingsAndCamErrorHtml.match(/Take a photo instead/g) ?? [];
  assert.equal(photoBtnsOnError.length, 2, "renders banner photo recovery plus conversation photo fallback");

  const snapshotOnlineHtml = renderLive({
    running: true,
    mode: "snapshot",
    online: true,
    banner: { tone: "warn", title: "Snapshot mode", action: "snapshot" },
  });
  assert.match(snapshotOnlineHtml, /<button class="btn small">Try live again<\/button>/);

  const snapshotOfflineHtml = renderLive({
    running: true,
    mode: "snapshot",
    online: false,
    banner: { tone: "warn", title: "Snapshot mode", action: "snapshot" },
  });
  assert.doesNotMatch(snapshotOfflineHtml, /Try live again/);
});

test("Live phone viewfinder announces camera state via role=img aria-label and gates CAMERA ON, sharp brackets, and readiness tag", () => {
  resetEnv();

  const offHtml = renderLive({ source: "phone", camera: "off" });
  assert.match(offHtml, /<div class="viewfinder" aria-label="Camera off\." role="img">/);
  assert.match(offHtml, /<video playsInline="" muted="" autoPlay="" aria-hidden="true"><\/video>/);
  assert.match(offHtml, /<div class="placeholder">Camera off\. Press Start check\.<\/div>/);
  assert.doesNotMatch(offHtml, /CAMERA ON/);
  assert.doesNotMatch(offHtml, /class="brackets/);
  assert.doesNotMatch(offHtml, /class="sharpmeter/);

  const startingHtml = renderLive({ source: "phone", camera: "starting" });
  assert.match(startingHtml, /aria-label="Camera off\."/);
  assert.match(startingHtml, /<div class="placeholder">Starting camera\u2026<\/div>/);
  assert.doesNotMatch(startingHtml, /CAMERA ON/);

  const pausedHtml = renderLive({ source: "phone", camera: "paused" });
  assert.match(pausedHtml, /<div class="viewfinder" aria-label="Camera paused\." role="img">/);
  assert.match(pausedHtml, /<div class="placeholder">Camera paused while HoldUp is in the background<\/div>/);
  assert.doesNotMatch(pausedHtml, /CAMERA ON/);

  const errorCustomHtml = renderLive({
    source: "phone",
    camera: "error",
    cameraMsg: "Another app is using the camera.",
  });
  assert.match(errorCustomHtml, /<div class="viewfinder" aria-label="Camera unavailable\." role="img">/);
  assert.match(errorCustomHtml, /<div class="placeholder">Another app is using the camera\.<\/div>/);
  assert.doesNotMatch(errorCustomHtml, /CAMERA ON/);

  const errorDefaultHtml = renderLive({ source: "phone", camera: "error", cameraMsg: "" });
  assert.match(errorDefaultHtml, /<div class="placeholder">Camera unavailable<\/div>/);

  const onUnsharpHtml = renderLive({
    source: "phone",
    camera: "on",
    sharpness: 0.55,
    readiness: null,
  });
  assert.match(onUnsharpHtml, /<div class="viewfinder" aria-label="Camera on\. Picture sharpness 55 percent\." role="img">/);
  assert.match(onUnsharpHtml, /<div class="camon"><span class="dot" aria-hidden="true"><\/span> CAMERA ON<\/div>/);
  assert.match(onUnsharpHtml, /<div class="brackets " aria-hidden="true">/);
  assert.match(onUnsharpHtml, /<div class="sharpmeter " aria-hidden="true"><span style="width:55%"><\/span><\/div>/);
  assert.doesNotMatch(onUnsharpHtml, /class="readytag"/);
  assert.doesNotMatch(onUnsharpHtml, /class="placeholder"/);

  const onSharpReadyHtml = renderLive({
    source: "phone",
    camera: "on",
    sharpness: 0.726,
    readiness: 0.844,
  });
  assert.match(onSharpReadyHtml, /aria-label="Camera on\. Picture sharpness 73 percent\."/);
  assert.match(onSharpReadyHtml, /<div class="brackets sharp" aria-hidden="true">/);
  assert.match(onSharpReadyHtml, /<div class="sharpmeter ready" aria-hidden="true"><span style="width:84%"><\/span><\/div>/);
  assert.match(onSharpReadyHtml, /<div class="readytag" aria-hidden="true">Readable 84%<\/div>/);
});

test("Live glasses viewfinder omits phone video and CAMERA ON badge while describing all 5 DAT bridge states", () => {
  resetEnv();

  const cases: Array<{
    name: string;
    device: DeviceState | null;
    expectedAria: string;
    expectedMuted: string;
  }> = [
    {
      name: "null bridge state",
      device: null,
      expectedAria: "Using glasses camera. Waiting for the glasses.",
      expectedMuted: "Waiting for the glasses bridge",
    },
    {
      name: "disconnected glasses",
      device: { connected: false, worn: false, battery: 64, streaming: false, source: "glasses" },
      expectedAria: "Using glasses camera. Glasses not connected.",
      expectedMuted: "Glasses not connected",
    },
    {
      name: "doffed glasses",
      device: { connected: true, worn: false, battery: 64, streaming: false, source: "glasses" },
      expectedAria: "Using glasses camera. Glasses not worn.",
      expectedMuted: "Glasses are not being worn",
    },
    {
      name: "streaming with known battery",
      device: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" },
      expectedAria: "Using glasses camera. Glasses streaming.",
      expectedMuted: "Glasses streaming \u00b7 battery 82%",
    },
    {
      name: "streaming with unknown worn and battery",
      device: { connected: true, worn: null, battery: null, streaming: true, source: "glasses" },
      expectedAria: "Using glasses camera. Glasses streaming.",
      expectedMuted: "Glasses streaming",
    },
  ];

  for (const c of cases) {
    const html = renderLive({ source: "glasses", camera: "on", device: c.device });
    assert.ok(html.includes(`aria-label="${c.expectedAria}"`), c.name);
    assert.ok(decodeHtml(html).includes(`<span class="muted">${c.expectedMuted}</span>`), c.name);
    assert.ok(html.includes("<strong>Using glasses camera</strong>"), c.name);
    assert.doesNotMatch(html, /<video\b/, c.name);
    assert.doesNotMatch(html, /CAMERA ON/, c.name);
    assertAllSvgsDecorative(html);
  }
});

test("Live scene mode renders aria-hidden spatial bounding boxes scaled from 0..1000 only when phone camera is active", () => {
  resetEnv();
  const profile = demoProfile();
  const baseScene = mockScene(profile);
  const items: SceneItem[] = [
    {
      position: "left",
      level: "unsure",
      headline: "Faded strip",
      box: [100, 50, 500, 300],
      read: emptyRead("unreadable"),
    },
    {
      position: "center",
      level: "warning",
      headline: "Ibuprofen 400 mg",
      box: [150, 350, 650, 650],
      read: makeRead({ product: f("Ibuprofen", 0.96) }),
    },
    {
      position: "right",
      level: "match",
      headline: "Amlodipine 5 mg",
      matchedMedId: "amlodipine",
      box: [120, 700, 620, 950],
      read: makeRead(),
    },
    {
      position: "far_right",
      level: "info",
      headline: "Unboxed leaflet",
      read: emptyRead("other"),
    },
  ];
  const sceneVerdict: Verdict = { ...baseScene, mode: "scene", items };

  const activeHtml = renderLive({
    source: "phone",
    camera: "on",
    running: true,
    verdict: sceneVerdict,
    verdictVia: "live",
  });
  const decoded = decodeHtml(activeHtml);

  assert.match(
    activeHtml,
    /<div aria-hidden="true"><div class="scene-box unsure" style="top:10%;left:5%;height:40%;width:25%"><span>\? Left<\/span><\/div><div class="scene-box warning" style="top:15%;left:35%;height:50%;width:30%"><span>\u26a0 Middle<\/span><\/div><div class="scene-box match" style="top:12%;left:70%;height:50%;width:25%"><span>\u2713 Right<\/span><\/div><\/div>/,
  );
  assert.ok(!decoded.includes("? Far right"), "items without box coordinates are omitted from overlay");

  const cameraOffHtml = renderLive({
    source: "phone",
    camera: "off",
    verdict: sceneVerdict,
  });
  assert.doesNotMatch(cameraOffHtml, /class="scene-box/);

  const glassesHtml = renderLive({
    source: "glasses",
    camera: "on",
    verdict: sceneVerdict,
  });
  assert.doesNotMatch(glassesHtml, /class="scene-box/);
});

test("Live camera source segmented toggle exposes role=group and mutually exclusive aria-pressed states", () => {
  resetEnv();

  const phoneHtml = renderLive({ source: "phone" });
  assert.match(
    phoneHtml,
    /<div class="seg" role="group" aria-label="Camera source"><button aria-pressed="true">Phone camera<\/button><button aria-pressed="false">Glasses camera<\/button><\/div>/,
  );

  const glassesHtml = renderLive({ source: "glasses" });
  assert.match(
    glassesHtml,
    /<div class="seg" role="group" aria-label="Camera source"><button aria-pressed="false">Phone camera<\/button><button aria-pressed="true">Glasses camera<\/button><\/div>/,
  );
});

test("Live conversation section prevents screen-reader caption flooding via polite final-only sr-only line and aria-live=off log", () => {
  resetEnv();

  const emptyHtml = renderLive({ captions: [] });
  assert.match(emptyHtml, /<section aria-labelledby="caps-h" class="stack"/);
  assert.match(emptyHtml, /<h2 id="caps-h" class="sr-only">Conversation<\/h2>/);
  assert.match(emptyHtml, /<p class="sr-only" aria-live="polite" aria-atomic="true"><\/p>/);
  assert.doesNotMatch(emptyHtml, /role="log"/);

  const partialAndUserOnly: Caption[] = [
    { id: 1, role: "user", text: "Is this my evening pill?", final: true },
    { id: 2, role: "assistant", text: "Turn it a little", final: false },
  ];
  const partialHtml = renderLive({ captions: partialAndUserOnly });
  assert.match(partialHtml, /<p class="sr-only" aria-live="polite" aria-atomic="true"><\/p>/);
  assert.match(
    partialHtml,
    /<div class="captions" role="log" aria-live="off" aria-label="Conversation captions" tabindex="0">/,
  );
  assert.match(partialHtml, /<p class="user "><span class="who">You:<\/span>Is this my evening pill\?<\/p>/);
  assert.match(partialHtml, /<p class="assistant partial"><span class="who">HoldUp:<\/span>Turn it a little<\/p>/);

  const withFinalAssistant: Caption[] = [
    ...partialAndUserOnly,
    { id: 3, role: "assistant", text: "Turn it a little left.", final: true },
    { id: 4, role: "assistant", text: "Holding...", final: false },
    { id: 5, role: "user", text: "Okay", final: true },
  ];
  const assistantLiveHtml = renderLive({ captions: withFinalAssistant });
  assert.match(
    assistantLiveHtml,
    /<p class="sr-only" aria-live="polite" aria-atomic="true">HoldUp: Turn it a little left\.<\/p>/,
  );

  const withFinalSystem: Caption[] = [
    ...withFinalAssistant,
    { id: 6, role: "system", text: "Offline: barcode checks only.", final: true },
  ];
  const systemLiveHtml = renderLive({ captions: withFinalSystem });
  assert.match(
    systemLiveHtml,
    /<p class="sr-only" aria-live="polite" aria-atomic="true">Note: Offline: barcode checks only\.<\/p>/,
  );
  assert.match(systemLiveHtml, /<p class="system "><span class="who">Note:<\/span>Offline: barcode checks only\.<\/p>/);
});

test("Live text-question fallback form pairs explicit label with #ask input and hides raw file capture input from Tab/AT", () => {
  resetEnv();
  const html = renderLive({});

  assert.match(html, /<label for="ask" class="asklabel">Or type a question<\/label>/);
  assert.match(
    html,
    /<form class="textask"><input(?=[^>]*\bid="ask")(?=[^>]*\btype="text")(?=[^>]*\bplaceholder="Is this my evening pill\?")(?=[^>]*\bautoComplete="off")(?=[^>]*\benterKeyHint="send")(?=[^>]*\bvalue="")[^>]*\/><button class="btn" type="submit" disabled="">Ask<\/button><\/form>/,
  );
  assert.match(html, /<button class="btn small"><svg\b[^>]*>[\s\S]*?<\/svg> Take a photo instead<\/button>/);
  assert.match(
    html,
    /<input type="file" accept="image\/[*]" capture="environment" hidden="" aria-hidden="true" tabindex="-1"\/>/,
  );
});

test("Live primary bigbtn wires aria-describedby=#big-hint and adapts across idle, live, offline, and snapshot states", () => {
  resetEnv();

  const idleHtml = renderLive({ running: false, mode: "live" });
  assert.match(idleHtml, /<button class="bigbtn " aria-describedby="big-hint">Start check<\/button>/);
  assert.match(
    idleHtml,
    /<p id="big-hint" class="sr-only">Shortcut: Space or Enter, or tap your Bluetooth glasses or headset\.<\/p>/,
  );
  assert.doesNotMatch(idleHtml, /Stop check/);

  const runningLiveHtml = renderLive({ running: true, mode: "live" });
  assert.match(
    runningLiveHtml,
    /<button class="bigbtn stop" aria-describedby="big-hint"><span class="dot"[^>]*aria-hidden="true"><\/span>Stop<\/button>/,
  );
  assert.doesNotMatch(runningLiveHtml, /Stop check/);

  const runningOfflineHtml = renderLive({ running: true, mode: "offline" });
  assert.match(
    runningOfflineHtml,
    /<button class="bigbtn stop" aria-describedby="big-hint"><span class="dot"[^>]*aria-hidden="true"><\/span>Stop<\/button>/,
  );

  const snapshotIdleHtml = renderLive({ running: true, mode: "snapshot", snapshotBusy: false });
  assert.match(snapshotIdleHtml, /<button class="bigbtn " aria-describedby="big-hint">Check label<\/button>/);
  assert.doesNotMatch(snapshotIdleHtml, /class="bigbtn stop"/);
  assert.match(snapshotIdleHtml, /<button class="btn small ghost wide">Stop check<\/button>/);

  const snapshotBusyHtml = renderLive({ running: true, mode: "snapshot", snapshotBusy: true });
  assert.match(
    snapshotBusyHtml,
    /<button class="bigbtn " aria-describedby="big-hint" disabled="">Checking\u2026<\/button>/,
  );
  assert.match(snapshotBusyHtml, /<button class="btn small ghost wide">Stop check<\/button>/);
});

test("Live integrates AddSheet dialog proposal and honors settings.showPanel and ?debug=1 for DevicePanel disclosure", async () => {
  resetEnv();
  const med: Med = {
    ...emptyMed(),
    id: "lisinopril",
    name: "Lisinopril",
    ingredient: "lisinopril",
    strength: "10 mg",
    schedule: ["morning"],
    gtin: "06416542005218",
  };

  saveSettings({ ...loadSettings(), showPanel: false });
  const closedNoProposalHtml = renderLive({ addProposal: null });
  assert.doesNotMatch(closedNoProposalHtml, /<dialog class="addsheet"/);
  assert.match(closedNoProposalHtml, /<details class="panel"><summary>Device state<\/summary>/);

  saveSettings({ ...loadSettings(), showPanel: true });
  const openWithProposalHtml = renderLive({
    addProposal: {
      proposalId: "p1",
      med,
      speech: "I read Lisinopril 10 milligrams, taken in the morning.",
      expiresAt: Date.now() + 55_000,
    },
  });
  assert.match(openWithProposalHtml, /<details class="panel" open=""><summary>Device state<\/summary>/);
  assert.match(
    openWithProposalHtml,
    /<dialog class="addsheet" aria-labelledby="add-h" aria-describedby="add-d">/,
  );
  assert.match(openWithProposalHtml, /<h2 id="add-h" class="add-title">Add Lisinopril 10 mg, morning, to your list\?<\/h2>/);

  saveSettings({ ...loadSettings(), showPanel: false });
  locationShim.search = "?debug=1";
  const debugLiveMod = await loadLiveModule("debug-panel");
  const debugHtml = renderToStaticMarkup(
    createElement(debugLiveMod.Live, {
      checker: makeStubChecker(makeCheckState()),
      consented: true,
      onReviewConsent: noop,
      onFixPermissions: noop,
    }),
  );
  assert.match(debugHtml, /<details class="panel" open=""><summary>Device state<\/summary>/);
  locationShim.search = "";
});

test("Live wires Bluetooth/media-key shortcuts, typing-target keyboard guards, and verdict heading focus handoff", () => {
  for (const keyName of [
    "MediaPlayPause",
    "MediaPlay",
    "MediaPause",
    "AudioVolumeUp",
    "AudioVolumeDown",
    "MediaStop",
  ]) {
    assert.ok(LIVE_SRC.includes(`"${keyName}"`), `missing media shortcut key ${keyName}`);
  }
  assert.ok(LIVE_SRC.includes('if (!consented) return;'));
  assert.ok(LIVE_SRC.includes('input, textarea, select, button, a, summary, [contenteditable=true], dialog'));
  assert.ok(LIVE_SRC.includes('!isTypingTarget(e.target) && !e.repeat'));
  assert.ok(LIVE_SRC.includes('if (e.key === "MediaStop") void checker.stop();'));
  assert.ok(LIVE_SRC.includes("else checker.primary();"));
  assert.ok(
    LIVE_SRC.includes(
      "if (s.verdict && s.verdict !== lastVerdict.current && s.verdict.headline !== lastVerdict.current?.headline) verdictRef.current?.focus();",
    ),
  );
});

test("App unconsented first-run renders Announcer live regions and Consent onboarding without mounting topbar, tabs, or camera", async () => {
  resetEnv();
  const { App } = await loadAppModule("unconsented");
  const html = renderToStaticMarkup(createElement(App));
  const text = decodeHtml(html);

  assert.ok(html.includes('<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>'));
  assert.ok(html.includes('<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>'));
  assert.ok(html.includes('<main class="onb">'));
  assert.ok(html.includes('<h1 tabindex="-1">HoldUp</h1>'));
  assert.ok(text.includes("First, three short things about your privacy."));

  assert.doesNotMatch(html, /class="topbar"/);
  assert.doesNotMatch(html, /class="tabs"/);
  assert.doesNotMatch(html, /class="viewfinder"/);
  assertAllSvgsDecorative(html);
  assertAriaReferencesAndUniqueIds(html);
  assertButtonsAccessible(html);

  localStorageShim.setItem("holdup.consent", JSON.stringify({ version: 0, ts: 123 }));
  const { App: OutdatedConsentApp } = await loadAppModule("outdated-consent");
  const outdatedHtml = renderToStaticMarkup(createElement(OutdatedConsentApp));
  assert.ok(outdatedHtml.includes('<main class="onb">'));
  assert.doesNotMatch(outdatedHtml, /class="tabs"/);
});

test("App consented shell renders skip link, Announcer, topbar mode chip, sr-only #main h1, and aria-current=page tabs", async () => {
  resetEnv();
  saveConsent();

  const { App: OnlineApp } = await loadAppModule("consented-online");
  const onlineHtml = renderToStaticMarkup(createElement(OnlineApp));

  assert.match(onlineHtml, /^<div class="app"><a class="skip" href="#main">Skip to content<\/a>/);
  assert.ok(onlineHtml.includes('<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>'));
  assert.ok(onlineHtml.includes('<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>'));
  assert.match(onlineHtml, /<header class="topbar"><span class="wordmark"><svg\b[^>]*>[\s\S]*?<\/svg>HoldUp<\/span>/);
  assert.match(
    onlineHtml,
    /<span class="chip live" aria-label="Mode: live"><span class="dot" aria-hidden="true"><\/span>Ready<\/span>/,
  );
  assert.doesNotMatch(onlineHtml, /class="chip mock"/);
  assert.match(onlineHtml, /<main id="main"><h1 tabindex="-1" class="sr-only">Check a label<\/h1>/);
  assert.match(onlineHtml, /<nav class="tabs" aria-label="Main">/);
  assert.match(onlineHtml, /<button aria-current="page"><svg\b[^>]*>[\s\S]*?<\/svg>Check<\/button>/);
  assert.match(onlineHtml, /<button><svg\b[^>]*>[\s\S]*?<\/svg>Profile<\/button>/);
  assert.match(onlineHtml, /<button><svg\b[^>]*>[\s\S]*?<\/svg>Privacy<\/button>/);

  navigatorShim.onLine = false;
  const { App: OfflineApp } = await loadAppModule("consented-offline");
  const offlineHtml = renderToStaticMarkup(createElement(OfflineApp));
  assert.match(
    offlineHtml,
    /<span class="chip offline" aria-label="Mode: offline"><span class="dot" aria-hidden="true"><\/span>Offline<\/span>/,
  );

  assert.ok(APP_SRC.includes("h1.current?.focus();"));
  assert.ok(APP_SRC.includes("document.title = `${TITLES[screen]} \u00b7 HoldUp`;"));
});

test("App HOLDUP_KEY auth gate switches to AccessKey screen when /api/stats returns 401", async () => {
  resetEnv();
  saveConsent();
  statsHttpStatus = 401;

  const { App: AuthGatedApp } = await loadAppModule("auth-needed");
  renderToStaticMarkup(createElement(AuthGatedApp));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  const gatedHtml = renderToStaticMarkup(createElement(AuthGatedApp));
  const gatedText = decodeHtml(gatedHtml);

  assert.ok(gatedHtml.includes('<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>'));
  assert.ok(gatedHtml.includes('<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>'));
  assert.ok(gatedHtml.includes('<main class="onb">'));
  assert.ok(gatedHtml.includes('<h1 tabindex="-1">Access key needed</h1>'));
  assert.ok(gatedHtml.includes('<label for="key">Access key</label>'));
  assert.ok(gatedText.includes("Save and try again"));
  assert.doesNotMatch(gatedHtml, /class="tabs"/);
  assert.doesNotMatch(gatedHtml, /class="viewfinder"/);
  assertAllSvgsDecorative(gatedHtml);
  assertAriaReferencesAndUniqueIds(gatedHtml);
  assertButtonsAccessible(gatedHtml);
});

test("WCAG structural audit: unique IDs, valid ARIA/label/skip references, decorative SVGs, and named buttons across full composite state", async () => {
  resetEnv();
  saveConsent();
  saveSettings({ ...loadSettings(), showPanel: true });

  const profile = demoProfile();
  const compositeLiveHtml = renderLive({
    running: true,
    mode: "snapshot",
    online: true,
    camera: "on",
    source: "phone",
    sharpness: 0.81,
    readiness: 0.9,
    banner: {
      tone: "warn",
      title: "Snapshot mode",
      detail: "Hold steady and press Check label.",
      action: "snapshot",
    },
    verdict: matchVerdict(profile, profile.meds[0]),
    verdictVia: "snapshot",
    captions: [
      { id: 1, role: "user", text: "Is this my evening pill?", final: true },
      { id: 2, role: "assistant", text: "Yes, Amlodipine 5 mg.", final: true },
    ],
    addProposal: {
      proposalId: "prop-7",
      med: {
        id: "atorvastatin-new",
        name: "Atorvastatin",
        ingredient: "atorvastatin",
        strength: "20 mg",
        schedule: ["evening"],
      },
      speech: "Add Atorvastatin 20 mg?",
      expiresAt: Date.now() + 45_000,
    },
  });

  assertAllSvgsDecorative(compositeLiveHtml);
  assertAriaReferencesAndUniqueIds(compositeLiveHtml);
  assertButtonsAccessible(compositeLiveHtml);

  const { App: FullShellApp } = await loadAppModule("composite-shell");
  const fullShellHtml = renderToStaticMarkup(createElement(FullShellApp));
  assertAllSvgsDecorative(fullShellHtml);
  assertAriaReferencesAndUniqueIds(fullShellHtml);
  assertButtonsAccessible(fullShellHtml);
});

test("Live escapes untrusted strings across captions, banners, cues, errors, and proposals, and styles.css enforces WCAG 2.2 tokens", () => {
  resetEnv();
  const xss = '<img src=x onerror="alert(1)"><script>evil()</script>';

  const escapedCueAndErrorHtml = renderLive({
    running: true,
    camera: "error",
    cameraMsg: `Cam ${xss}`,
    banner: { tone: "bad", title: `Title ${xss}`, detail: `Detail ${xss}`, action: "retry" },
    cue: { cue: "other_side", text: `Cue ${xss}`, ts: 500 },
    captions: [
      { id: 1, role: "assistant", text: `Spoken ${xss}`, final: true },
      { id: 2, role: "user", text: `Asked ${xss}`, final: false },
    ],
    addProposal: {
      proposalId: "xss-prop",
      med: { id: "m1", name: `Med ${xss}`, ingredient: `Ing ${xss}`, strength: `5 mg ${xss}`, schedule: ["evening"] },
      speech: `Proposal ${xss}`,
      expiresAt: Date.now() + 30_000,
    },
  });

  assert.doesNotMatch(escapedCueAndErrorHtml, /<script>/i);
  assert.doesNotMatch(escapedCueAndErrorHtml, /<img\b/i);
  assert.match(escapedCueAndErrorHtml, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);

  assert.match(STYLES_CSS, /--tap:\s*56px/);
  assert.match(STYLES_CSS, /\.bigbtn\s*\{[^}]*min-height:\s*104px/s);
  assert.match(STYLES_CSS, /\.tabs button\s*\{[^}]*min-height:\s*64px/s);
  assert.match(STYLES_CSS, /\.btn\.small\s*\{[^}]*min-height:\s*48px/s);
  assert.match(STYLES_CSS, /\.skip:focus\s*\{[^}]*top:\s*var\(--s2\)/s);
  assert.match(STYLES_CSS, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/s);
  assert.match(STYLES_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:\s*none\s*!important/s);
  assert.match(STYLES_CSS, /@media\s*\(prefers-contrast:\s*more\)/);
});
