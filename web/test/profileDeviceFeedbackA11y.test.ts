import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoachCue, FeatureFlag, Profile as ProfileType, VerdictLevel } from "../../shared/types.ts";
import type { Checker, CheckState } from "../src/lib/checker.ts";

const storageMap = new Map<string, string>();

const localStorageShim = {
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

type AudioParamCall = {
  method: "setValueAtTime" | "linearRampToValueAtTime" | "exponentialRampToValueAtTime";
  value: number;
  time: number;
};

class MockAudioParam {
  value = 0;
  calls: AudioParamCall[] = [];

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
}

class MockConnectable {
  connectedTo: unknown[] = [];

  connect<T>(dest: T): T {
    this.connectedTo.push(dest);
    return dest;
  }
}

class MockOscillatorNode extends MockConnectable {
  type: OscillatorType = "sine";
  frequency = new MockAudioParam();
  startedAt: number[] = [];
  stoppedAt: number[] = [];

  start(when = 0) {
    this.startedAt.push(when);
  }

  stop(when = 0) {
    this.stoppedAt.push(when);
  }
}

class MockGainNode extends MockConnectable {
  gain = new MockAudioParam();
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static initialState: AudioContextState = "suspended";
  static throwOnConstruct = false;

  state: AudioContextState = MockAudioContext.initialState;
  currentTime = 2.0;
  destination = { kind: "destination" };
  oscillators: MockOscillatorNode[] = [];
  gains: MockGainNode[] = [];
  resumeCount = 0;

  constructor() {
    if (MockAudioContext.throwOnConstruct) {
      throw new Error("AudioContext blocked");
    }
    MockAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    const osc = new MockOscillatorNode();
    this.oscillators.push(osc);
    return osc as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    const gain = new MockGainNode();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  resetNodes() {
    this.oscillators = [];
    this.gains = [];
  }

  async resume(): Promise<void> {
    this.resumeCount++;
    this.state = "running";
  }
}

class MockSpeechSynthesisUtterance {
  text: string;
  lang = "";
  rate = 1;
  volume = 1;

  constructor(text: string) {
    this.text = text;
  }
}

type SpeechEvent =
  | { kind: "cancel" }
  | { kind: "speak"; text: string; lang: string; rate: number; volume: number };

const speechEvents: SpeechEvent[] = [];
let speechThrowOnCancel = false;
let speechThrowOnSpeak = false;

const mockSpeechSynthesis = {
  cancel() {
    if (speechThrowOnCancel) throw new Error("cancel failed");
    speechEvents.push({ kind: "cancel" });
  },
  speak(u: MockSpeechSynthesisUtterance) {
    if (speechThrowOnSpeak) throw new Error("speak failed");
    speechEvents.push({
      kind: "speak",
      text: u.text,
      lang: u.lang,
      rate: u.rate,
      volume: u.volume,
    });
  },
};

const vibrateCalls: Array<number | number[]> = [];
let vibrateShouldThrow = false;

const windowShim: Record<string, unknown> = {
  isSecureContext: true,
  AudioContext: MockAudioContext,
  speechSynthesis: mockSpeechSynthesis,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
};

const navigatorShim: Record<string, unknown> = {
  language: "en-US",
  onLine: true,
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile",
  vibrate(pattern: number | number[]) {
    if (vibrateShouldThrow) throw new Error("vibrate blocked");
    vibrateCalls.push(Array.isArray(pattern) ? [...pattern] : pattern);
    return true;
  },
};

const locationShim = {
  search: "",
  pathname: "/",
  hash: "",
};

const historyShim = {
  state: null,
  replaceState() {},
};

Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "window", { value: windowShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: navigatorShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "history", { value: historyShim, configurable: true, writable: true });
Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
  value: MockSpeechSynthesisUtterance,
  configurable: true,
  writable: true,
});

const {
  announce,
  earcon,
  earconForVerdict,
  haptic,
  onAnnounce,
  primeSpeech,
  speak,
  stopSpeaking,
  unlockFeedback,
} = await import("../src/lib/feedback.ts");
const { demoProfile, loadSettings, saveSettings } = await import("../src/lib/storage.ts");
const { accessKey, setAccessKey } = await import("../src/lib/key.ts");
const { Profile } = await import("../src/screens/Profile.tsx");
const { AccessKey } = await import("../src/screens/AccessKey.tsx");
const { DevicePanel } = await import("../src/components/DevicePanel.tsx");

type BarcodeModule = typeof import("../src/lib/barcode.ts");
type FeedbackModule = typeof import("../src/lib/feedback.ts");

async function loadBarcodeModule(tag: string): Promise<BarcodeModule> {
  const url = new URL(`../src/lib/barcode.ts?case=${tag}`, import.meta.url).href;
  return (await import(url)) as BarcodeModule;
}

async function loadFeedbackModule(tag: string): Promise<FeedbackModule> {
  const url = new URL(`../src/lib/feedback.ts?case=${tag}`, import.meta.url).href;
  return (await import(url)) as FeedbackModule;
}

function approxEqual(actual: number, expected: number, epsilon = 1e-9, label = "value") {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected} (+/- ${epsilon}), got ${actual}`,
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

function resetEnv() {
  localStorageShim.clear();
  speechEvents.length = 0;
  speechThrowOnCancel = false;
  speechThrowOnSpeak = false;
  vibrateCalls.length = 0;
  vibrateShouldThrow = false;
  windowShim.AudioContext = MockAudioContext;
  delete windowShim.webkitAudioContext;
  delete windowShim.BarcodeDetector;
  windowShim.speechSynthesis = mockSpeechSynthesis;
  navigatorShim.vibrate = (pattern: number | number[]) => {
    if (vibrateShouldThrow) throw new Error("vibrate blocked");
    vibrateCalls.push(Array.isArray(pattern) ? [...pattern] : pattern);
    return true;
  };
  setAccessKey("");
}

function makeStubChecker(enabled: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"]): Checker {
  const set = new Set<FeatureFlag>(enabled);
  return {
    feature(flag: FeatureFlag) {
      return set.has(flag);
    },
    simulateDrop() {},
    injectCode() {},
    toggleSnapshotMode() {},
  } as unknown as Checker;
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
    session: "ABCD",
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
    route: "",
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

test("feedback.ts unlockFeedback resumes suspended AudioContext and earcon plays 10 distinct frequency/waveform contours", () => {
  resetEnv();
  MockAudioContext.instances = [];
  MockAudioContext.initialState = "suspended";

  unlockFeedback();
  assert.equal(MockAudioContext.instances.length, 1);
  const ctx = MockAudioContext.instances[0];
  assert.equal(ctx.resumeCount, 1);
  assert.equal(ctx.state, "running");

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
    match: { freqs: [523, 659, 784], types: ["sine", "sine", "sine"], peaks: [0.18, 0.18, 0.18], durations: [0.11, 0.11, 0.22] },
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

  const contourKeys = Object.keys(expectedContours) as Array<keyof typeof earcon>;
  assert.equal(contourKeys.length, 10);
  const signatures: string[] = [];

  for (const name of contourKeys) {
    ctx.resetNodes();
    earcon[name]();

    const spec = expectedContours[name];
    assert.equal(ctx.oscillators.length, spec.freqs.length, `oscillator count for ${name}`);
    assert.equal(ctx.gains.length, spec.freqs.length, `gain count for ${name}`);

    assert.deepEqual(
      ctx.oscillators.map((o) => o.frequency.value),
      spec.freqs,
      `frequencies for ${name}`,
    );
    assert.deepEqual(
      ctx.oscillators.map((o) => o.type),
      spec.types,
      `waveforms for ${name}`,
    );

    let expectedStart = ctx.currentTime + 0.01;
    for (let i = 0; i < spec.freqs.length; i++) {
      const osc = ctx.oscillators[i];
      const gain = ctx.gains[i];
      const dur = spec.durations[i];
      const gap = spec.gaps?.[i] ?? 0.03;

      assert.deepEqual(osc.connectedTo, [gain]);
      assert.deepEqual(gain.connectedTo, [ctx.destination]);
      approxEqual(osc.startedAt[0], expectedStart, 1e-9, `${name} note ${i} start`);
      approxEqual(osc.stoppedAt[0], expectedStart + dur + 0.02, 1e-9, `${name} note ${i} stop`);

      const setZero = gain.gain.calls.find((c) => c.method === "setValueAtTime");
      const rampUp = gain.gain.calls.find((c) => c.method === "linearRampToValueAtTime");
      const rampDown = gain.gain.calls.find((c) => c.method === "exponentialRampToValueAtTime");
      assert.ok(setZero && rampUp && rampDown);
      assert.equal(setZero.value, 0);
      approxEqual(rampUp.value, spec.peaks[i], 1e-9, `${name} note ${i} peak gain`);
      approxEqual(rampUp.time, expectedStart + 0.012, 1e-9, `${name} note ${i} attack time`);
      approxEqual(rampDown.value, 0.0001, 1e-9, `${name} note ${i} decay floor`);
      approxEqual(rampDown.time, expectedStart + dur, 1e-9, `${name} note ${i} decay end`);

      expectedStart += dur + gap;
    }

    const sig = ctx.oscillators.map((o) => `${o.type}:${o.frequency.value}`).join("|");
    signatures.push(sig);
  }

  assert.equal(new Set(signatures).size, 10, "All 10 earcons must have pairwise-distinct waveform/frequency contours");

  const verdictLevels: VerdictLevel[] = ["match", "warning", "unsure", "info"];
  for (const level of verdictLevels) {
    ctx.resetNodes();
    earconForVerdict(level);
    assert.deepEqual(
      ctx.oscillators.map((o) => o.frequency.value),
      expectedContours[level].freqs,
    );
    assert.deepEqual(
      ctx.oscillators.map((o) => o.type),
      expectedContours[level].types,
    );
  }
});

test("feedback.ts earcon halves gain (0.5x) when quiet is true, mutes when earcons is false, and supports webkitAudioContext", async () => {
  resetEnv();
  const ctx = MockAudioContext.instances[0];
  assert.ok(ctx);

  const contourNames = Object.keys(earcon) as Array<keyof typeof earcon>;
  const normalPeaksByEarcon: Record<string, number[]> = {};

  saveSettings({ ...loadSettings(), earcons: true, quiet: false });
  for (const name of contourNames) {
    ctx.resetNodes();
    earcon[name]();
    normalPeaksByEarcon[name] = ctx.gains.map(
      (g) => g.gain.calls.find((c) => c.method === "linearRampToValueAtTime")!.value,
    );
  }

  saveSettings({ ...loadSettings(), earcons: true, quiet: true });
  for (const name of contourNames) {
    ctx.resetNodes();
    earcon[name]();
    const quietPeaks = ctx.gains.map(
      (g) => g.gain.calls.find((c) => c.method === "linearRampToValueAtTime")!.value,
    );
    assert.equal(quietPeaks.length, normalPeaksByEarcon[name].length);
    for (let i = 0; i < quietPeaks.length; i++) {
      approxEqual(quietPeaks[i], normalPeaksByEarcon[name][i] * 0.5, 1e-9, `quiet 0.5x gain for ${name}[${i}]`);
    }
  }

  saveSettings({ ...loadSettings(), earcons: false, quiet: false });
  ctx.resetNodes();
  for (const name of contourNames) {
    earcon[name]();
  }
  earconForVerdict("warning");
  assert.equal(ctx.oscillators.length, 0);
  assert.equal(ctx.gains.length, 0);

  saveSettings({ ...loadSettings(), earcons: true, quiet: false });
  delete windowShim.AudioContext;
  windowShim.webkitAudioContext = MockAudioContext;
  MockAudioContext.initialState = "running";
  const countBefore = MockAudioContext.instances.length;
  const webkitFeedback = await loadFeedbackModule("webkit");
  webkitFeedback.earcon.match();
  assert.equal(MockAudioContext.instances.length, countBefore + 1);
  assert.equal(MockAudioContext.instances.at(-1)?.oscillators.length, 3);

  delete windowShim.webkitAudioContext;
  const silentFeedback = await loadFeedbackModule("no-audio");
  silentFeedback.unlockFeedback();
  silentFeedback.earcon.warning();
  windowShim.AudioContext = MockAudioContext;
});

test("feedback.ts haptic emits distinct navigator.vibrate patterns for VerdictLevel and CoachCue and mutes when haptics is false", () => {
  resetEnv();
  saveSettings({ ...loadSettings(), haptics: true });

  haptic.start();
  haptic.stop();
  assert.deepEqual(vibrateCalls, [60, [40, 60, 40]]);

  const expectedVerdicts: Record<VerdictLevel, number | number[]> = {
    match: [90, 70, 90],
    warning: [300, 120, 300, 120, 300],
    unsure: [160, 120, 60],
    info: 60,
  };
  const verdictSignatures: string[] = [];
  for (const level of Object.keys(expectedVerdicts) as VerdictLevel[]) {
    vibrateCalls.length = 0;
    haptic.verdict(level);
    assert.equal(vibrateCalls.length, 1);
    assert.deepEqual(vibrateCalls[0], expectedVerdicts[level], `haptic.verdict(${level})`);
    verdictSignatures.push(JSON.stringify(vibrateCalls[0]));
  }
  assert.equal(new Set(verdictSignatures).size, 4, "Every VerdictLevel must have a distinct vibration pattern");

  const expectedCoachCues: Record<CoachCue, number | number[]> = {
    rotate_left: [30, 40, 30],
    rotate_right: [30, 40, 30, 40, 30],
    closer: [15, 30, 15, 30, 15, 30, 15],
    farther: [120],
    hold_still: [200],
    ok: [40, 40, 120],
    more_light: 30,
    other_side: 30,
  };
  const directionalCues: CoachCue[] = ["rotate_left", "rotate_right", "closer", "farther", "hold_still", "ok"];
  const directionalSignatures: string[] = [];

  for (const cue of Object.keys(expectedCoachCues) as CoachCue[]) {
    vibrateCalls.length = 0;
    haptic.coach(cue);
    assert.equal(vibrateCalls.length, 1);
    assert.deepEqual(vibrateCalls[0], expectedCoachCues[cue], `haptic.coach(${cue})`);
    if (directionalCues.includes(cue)) {
      directionalSignatures.push(JSON.stringify(vibrateCalls[0]));
    }
  }
  assert.equal(new Set(directionalSignatures).size, directionalCues.length);
  assert.ok(!directionalSignatures.includes(JSON.stringify(expectedCoachCues.more_light)));

  saveSettings({ ...loadSettings(), haptics: false });
  vibrateCalls.length = 0;
  haptic.start();
  haptic.stop();
  haptic.verdict("warning");
  haptic.coach("closer");
  haptic.pattern([50, 50]);
  assert.equal(vibrateCalls.length, 0);

  saveSettings({ ...loadSettings(), haptics: true });
  vibrateShouldThrow = true;
  haptic.verdict("match");
  delete navigatorShim.vibrate;
  haptic.coach("rotate_left");
});

test("feedback.ts speak, primeSpeech, and stopSpeaking map profile.lang (en/fi/sv), enforce interrupt cancel, and mute when voice is false", () => {
  resetEnv();

  primeSpeech();
  assert.deepEqual(speechEvents, [{ kind: "speak", text: " ", lang: "", rate: 1, volume: 0 }]);

  primeSpeech();
  assert.equal(speechEvents.length, 1, "primeSpeech must only prime once");

  const langCases: Array<{ profileLang: string; expectedBcp47: string }> = [
    { profileLang: "en", expectedBcp47: "en-GB" },
    // app-generated speech is English text, so it is read with an English voice whatever the profile language
    // (FI/SV come from pre-rendered clips and the live Gemini voice; judge panel OC-04)
    { profileLang: "fi", expectedBcp47: "en-GB" },
    { profileLang: "sv", expectedBcp47: "en-GB" },
    { profileLang: "de", expectedBcp47: "en-GB" },
  ];

  for (const { profileLang, expectedBcp47 } of langCases) {
    speechEvents.length = 0;
    localStorageShim.setItem("holdup.profile", JSON.stringify({ ...demoProfile(), lang: profileLang }));
    speak("Amlodipine 5 mg");
    assert.deepEqual(speechEvents, [
      { kind: "cancel" },
      { kind: "speak", text: "Amlodipine 5 mg", lang: expectedBcp47, rate: 1, volume: 1 },
    ]);
  }

  speechEvents.length = 0;
  localStorageShim.setItem("holdup.profile", "{corrupt-json");
  speak("Fallback language check");
  assert.deepEqual(speechEvents, [
    { kind: "cancel" },
    { kind: "speak", text: "Fallback language check", lang: "en-GB", rate: 1, volume: 1 },
  ]);

  speechEvents.length = 0;
  localStorageShim.setItem("holdup.profile", JSON.stringify({ ...demoProfile(), lang: "en" }));
  speak("Explicit Swedish", { lang: "sv-SE" });
  assert.deepEqual(speechEvents, [
    { kind: "cancel" },
    { kind: "speak", text: "Explicit Swedish", lang: "sv-SE", rate: 1, volume: 1 },
  ]);

  speechEvents.length = 0;
  speak("Queued guidance", { interrupt: false });
  assert.deepEqual(speechEvents, [
    { kind: "speak", text: "Queued guidance", lang: "en-GB", rate: 1, volume: 1 },
  ]);

  speechEvents.length = 0;
  speak("");
  assert.equal(speechEvents.length, 0);

  saveSettings({ ...loadSettings(), voice: false });
  speechEvents.length = 0;
  speak("Should stay silent");
  speak("Still silent", { interrupt: false });
  assert.equal(speechEvents.length, 0);

  saveSettings({ ...loadSettings(), voice: true });
  speechEvents.length = 0;
  stopSpeaking();
  assert.deepEqual(speechEvents, [{ kind: "cancel" }]);

  speechThrowOnCancel = true;
  speechThrowOnSpeak = true;
  stopSpeaking();
  speak("Safe when speechSynthesis throws");

  const heard: Array<{ msg: string; politeness: "polite" | "assertive" }> = [];
  const off = onAnnounce((msg, politeness) => heard.push({ msg, politeness }));
  announce("Profile updated");
  announce("Pack expired", "assertive");
  off();
  announce("After unsubscribe");
  assert.deepEqual(heard, [
    { msg: "Profile updated", politeness: "polite" },
    { msg: "Pack expired", politeness: "assertive" },
  ]);
});

test("barcode.ts returns [] / null / false when BarcodeDetector is absent or throws and filters formats via window.BarcodeDetector", async () => {
  resetEnv();
  const fakeCanvas = {} as CanvasImageSource;

  delete windowShim.BarcodeDetector;
  const absentMod = await loadBarcodeModule("absent");
  assert.equal(absentMod.barcodeSupported, false);
  assert.equal(await absentMod.dataMatrixSupported(), false);
  assert.deepEqual(await absentMod.detectCodes(fakeCanvas), []);
  assert.equal(await absentMod.detectBarcode(fakeCanvas), null);

  const constructedFormats: Array<string[] | undefined> = [];
  let currentDetections = [
    { rawValue: "6416542002149", format: "ean_13" },
    { rawValue: "]d201064165420021491727083110A1234", format: "data_matrix" },
  ];

  class MockBarcodeDetector {
    constructor(opts?: { formats?: string[] }) {
      constructedFormats.push(opts?.formats);
    }

    async detect() {
      return currentDetections;
    }

    static async getSupportedFormats() {
      return ["qr_code", "pdf417", "ean_13", "data_matrix", "aztec"];
    }
  }

  windowShim.BarcodeDetector = MockBarcodeDetector;
  const supportedMod = await loadBarcodeModule("supported");
  assert.equal(supportedMod.barcodeSupported, true);
  assert.equal(await supportedMod.dataMatrixSupported(), true);

  const codes = await supportedMod.detectCodes(fakeCanvas);
  assert.equal(constructedFormats.length, 1);
  assert.deepEqual(constructedFormats[0], ["ean_13", "data_matrix", "qr_code"]);
  assert.deepEqual(codes, currentDetections);

  const firstBarcode = await supportedMod.detectBarcode(fakeCanvas);
  assert.equal(constructedFormats.length, 1, "Detector instance should be cached across calls");
  assert.equal(firstBarcode, "6416542002149");

  currentDetections = [];
  assert.equal(await supportedMod.detectBarcode(fakeCanvas), null);
  assert.deepEqual(await supportedMod.detectCodes(fakeCanvas), []);

  class ThrowingBarcodeDetector {
    async detect(): Promise<never> {
      throw new Error("InvalidStateError: source not ready");
    }

    static async getSupportedFormats() {
      return ["ean_13", "code_128"];
    }
  }

  windowShim.BarcodeDetector = ThrowingBarcodeDetector;
  const throwingMod = await loadBarcodeModule("throws");
  assert.equal(throwingMod.barcodeSupported, true);
  assert.equal(await throwingMod.dataMatrixSupported(), false);
  assert.deepEqual(await throwingMod.detectCodes(fakeCanvas), []);
  assert.equal(await throwingMod.detectBarcode(fakeCanvas), null);

  const fallbackConstructed: Array<string[] | undefined> = [];
  class FormatsThrowDetector {
    constructor(opts?: { formats?: string[] }) {
      fallbackConstructed.push(opts?.formats);
    }

    async detect() {
      return [{ rawValue: "7312345678901", format: "ean_13" }];
    }

    static async getSupportedFormats(): Promise<string[]> {
      throw new Error("getSupportedFormats unsupported");
    }
  }

  windowShim.BarcodeDetector = FormatsThrowDetector;
  const fallbackMod = await loadBarcodeModule("formats-throw");
  assert.equal(await fallbackMod.dataMatrixSupported(), false);
  assert.equal(await fallbackMod.detectBarcode(fakeCanvas), "7312345678901");
  assert.deepEqual(fallbackConstructed[0], [
    "ean_13",
    "ean_8",
    "upc_a",
    "upc_e",
    "code_128",
    "data_matrix",
    "qr_code",
  ]);
  delete windowShim.BarcodeDetector;
});

test("Profile.tsx SSR exposes 5 aria-labelledby landmarks, explicit htmlFor + aria-describedby controls, EN/FI/SV option lang attributes, and Edit/Remove aria-labels", () => {
  resetEnv();
  const base = demoProfile();
  const profileWithLog: ProfileType = {
    ...base,
    lang: "fi",
    doseLog: [
      { medId: "deleted-pill", ts: Date.now() - 3_600_000 },
      { medId: "amlodipine", ts: Date.now() },
    ],
  };

  const html = renderToStaticMarkup(
    createElement(Profile, {
      profile: profileWithLog,
      onChange: () => {},
      onSetupByVoice: () => {},
    }),
  );
  const text = decodeHtml(html);

  const expectedLandmarks: Array<[string, string]> = [
    ["meds-h", "My medicines"],
    ["allergies-h", "Allergies"],
    ["avoid-h", "Avoid"],
    ["lang-h", "Language"],
    ["log-h", "Dose log"],
  ];
  for (const [headingId, headingTitle] of expectedLandmarks) {
    assert.match(html, new RegExp(`<section[^>]*aria-labelledby="${headingId}"[^>]*>`));
    assert.ok(html.includes(`<h2 id="${headingId}">${headingTitle}</h2>`));
  }

  assert.ok(html.includes('aria-label="Edit Amlodipine 5 mg"'));
  assert.ok(html.includes('aria-label="Edit Metformin 500 mg"'));
  assert.ok(html.includes('aria-label="Edit Atorvastatin 20 mg"'));
  assert.ok(text.includes("barcode saved"));
  assert.ok(text.includes("pack code saved"));
  assert.ok(text.includes("taken today"));

  assert.ok(html.includes('aria-label="Remove tree nuts"'));
  assert.ok(html.includes('aria-label="Remove peanut"'));
  assert.ok(html.includes('aria-label="Remove NSAIDs"'));

  assert.ok(html.includes('<label class="sr-only" for="allergies-in">Add to Allergies</label>'));
  assert.match(html, /<input[^>]*id="allergies-in"[^>]*aria-describedby="allergies-help"[^>]*>/);
  assert.ok(html.includes('<p id="allergies-help" class="sr-only">For example: peanut, tree nuts, lactose, penicillin</p>'));

  assert.ok(html.includes('<label class="sr-only" for="avoid-in">Add to Avoid</label>'));
  assert.match(html, /<input[^>]*id="avoid-in"[^>]*aria-describedby="avoid-help"[^>]*>/);
  assert.ok(html.includes('<p id="avoid-help" class="sr-only">Medicine groups your doctor told you to avoid, for example NSAIDs</p>'));

  assert.ok(html.includes('<label for="lang">Language HoldUp speaks</label>'));
  assert.match(html, /<select[^>]*id="lang"[^>]*aria-describedby="lang-help"[^>]*>/);
  assert.ok(html.includes('<p id="lang-help" class="help">Used for spoken coaching and answers. The screens are in English for now.</p>'));

  assert.match(html, /<option value="en" lang="en">English<\/option>/);
  assert.match(html, /<option value="fi" selected="" lang="fi">Suomi<\/option>|<option value="fi" lang="fi" selected="">Suomi<\/option>/);
  assert.match(html, /<option value="sv" lang="sv">Svenska<\/option>/);

  assert.match(html, /<button[^>]*aria-describedby="voice-setup-help"[^>]*>[\s\S]*?Set up by voice<\/button>/);
  assert.ok(html.includes('<p id="voice-setup-help" class="muted">'));

  assert.ok(html.includes("<strong>Amlodipine 5 mg</strong>"));
  assert.ok(html.includes("<strong>deleted-pill</strong>"));

  const emptyProfile: ProfileType = {
    meds: [],
    allergies: [],
    avoid: [],
    doseLog: [],
    lang: "sv",
  };
  saveSettings({ ...loadSettings(), features: { ...loadSettings().features, addmed: false } });
  const emptyHtml = renderToStaticMarkup(
    createElement(Profile, {
      profile: emptyProfile,
      onChange: () => {},
      onSetupByVoice: () => {},
    }),
  );
  const emptyText = decodeHtml(emptyHtml);
  assert.ok(emptyText.includes("No medicines yet. Add the ones you take so HoldUp can tell you if a box is yours."));
  assert.ok(emptyText.includes('No doses logged yet. After a match, press "I took it".'));
  assert.ok(!emptyHtml.includes('id="voice-setup-help"'));
  assert.match(emptyHtml, /<option value="sv" selected="" lang="sv">Svenska<\/option>|<option value="sv" lang="sv" selected="">Svenska<\/option>/);
});

test("AccessKey.tsx SSR renders focusable h1 tabIndex=-1, htmlFor=key input with autoComplete/spellCheck off, and had vs fresh copy", () => {
  resetEnv();
  setAccessKey("");
  assert.equal(accessKey(), null);

  const freshHtml = renderToStaticMarkup(createElement(AccessKey, { onSave: () => {} }));
  const freshText = decodeHtml(freshHtml);

  assert.ok(freshHtml.startsWith('<main class="onb">'));
  assert.ok(freshHtml.includes('<h1 tabindex="-1">Access key needed</h1>'));
  assert.ok(freshText.includes("This HoldUp server only lets in people who have its private link."));
  assert.ok(!freshText.includes("The access key saved on this phone wasn't accepted."));
  assert.ok(freshHtml.includes('<label for="key">Access key</label>'));
  assert.match(
    freshHtml,
    /<input(?=[^>]*\bid="key")(?=[^>]*\btype="text")(?=[^>]*\bautoComplete="off")(?=[^>]*\bautoCapitalize="off")(?=[^>]*\bspellCheck="false")[^>]*>/,
  );
  assert.match(freshHtml, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save and try again<\/button>/);
  assert.ok(freshText.includes("The key is kept only on this phone and sent only to this HoldUp server."));
  assert.ok(freshHtml.includes('aria-hidden="true"'));
  assert.ok(freshHtml.includes('focusable="false"'));

  setAccessKey("rejected-key-42");
  assert.equal(accessKey(), "rejected-key-42");

  const hadHtml = renderToStaticMarkup(createElement(AccessKey, { onSave: () => {} }));
  const hadText = decodeHtml(hadHtml);
  assert.ok(hadHtml.includes('<h1 tabindex="-1">Access key needed</h1>'));
  assert.ok(hadText.includes("The access key saved on this phone wasn't accepted."));
  assert.ok(!hadText.includes("This HoldUp server only lets in people who have its private link."));
  setAccessKey("");
});

test("DevicePanel.tsx SSR renders details/summary disclosure, paired dl/dt/dd state rows, and disables demo buttons when !s.running", () => {
  resetEnv();
  const checker = makeStubChecker(["scene", "datamatrix", "sonar"]);

  const idleState = makeCheckState({ running: false, mode: "live", lastError: null });
  const closedHtml = renderToStaticMarkup(
    createElement(DevicePanel, {
      s: idleState,
      checker,
      open: false,
      onToggle: () => {},
    }),
  );
  const closedText = decodeHtml(closedHtml);

  assert.match(closedHtml, /^<details class="panel"><summary>Device state<\/summary><dl class="kv">/);
  assert.ok(!closedHtml.startsWith('<details class="panel" open'));

  const expectedIdleLabels = [
    "Mode",
    "Camera source",
    "Camera",
    "Mic",
    "Audio route",
    "Network",
    "RTT",
    "Live socket",
    "Gemini Live",
    "Frames sent",
    "Glasses",
    "Display (HUD)",
    "Features",
    "Readiness",
    "Pack code",
    "Auto-stop",
    "Session",
    "Barcode",
  ];
  for (const dtLabel of expectedIdleLabels) {
    assert.ok(closedHtml.includes(`<dt>${dtLabel}</dt>`), `Missing <dt>${dtLabel}</dt>`);
  }
  assert.ok(!closedHtml.includes("<dt>Last error</dt>"));

  const idleDtCount = (closedHtml.match(/<dt>/g) ?? []).length;
  const idleDdCount = (closedHtml.match(/<dd(?:\s[^>]*)?>/g) ?? []).length;
  assert.equal(idleDtCount, 18);
  assert.equal(idleDdCount, 18);

  assert.ok(closedText.includes("phone rear camera"));
  assert.ok(closedText.includes("no state yet"));
  assert.ok(closedText.includes("scene on · datamatrix on · addmed off · sonar on (server not asked yet)"));

  assert.ok(closedHtml.includes("<h3>Demo controls</h3>"));
  assert.match(closedHtml, /<button[^>]*disabled=""[^>]*>Drop connection<\/button>/);
  assert.match(closedHtml, /<button[^>]*disabled=""[^>]*>Simulate pack code<\/button>/);
  assert.match(closedHtml, /<button[^>]*disabled=""[^>]*>Force snapshot<\/button>/);

  const runningState = makeCheckState({
    running: true,
    mode: "snapshot",
    source: "glasses",
    camera: "on",
    mic: "on",
    micLevel: 0.1,
    micLabel: "Ray-Ban Mic",
    route: "Ray-Ban Meta",
    speaking: true,
    online: true,
    health: "ok",
    rtt: 180,
    conn: "open",
    serverLive: "open",
    model: "gemini-3.8-live",
    fps: 1,
    framesSent: 14,
    sharpness: 0.82,
    device: { connected: true, worn: true, battery: 82, streaming: true, source: "glasses" },
    hudConnected: true,
    serverFeatures: ["scene", "datamatrix", "sonar"],
    readiness: 0.84,
    lastCode: { raw: "]d201064165420021491727083110A1234", gtin: "06416542002149", expiry: "2027-08-31", batch: "A1234" },
    autoStopAt: Date.now() + 30_000,
    lastError: "Transient network hiccup",
  });

  const openHtml = renderToStaticMarkup(
    createElement(DevicePanel, {
      s: runningState,
      checker,
      open: true,
      onToggle: () => {},
    }),
  );
  const openText = decodeHtml(openHtml);

  assert.match(openHtml, /^<details class="panel" open=""><summary>Device state<\/summary><dl class="kv">/);
  const runningDtCount = (openHtml.match(/<dt>/g) ?? []).length;
  const runningDdCount = (openHtml.match(/<dd(?:\s[^>]*)?>/g) ?? []).length;
  assert.equal(runningDtCount, 19);
  assert.equal(runningDdCount, 19);

  assert.ok(openHtml.includes('<dt>Last error</dt><dd class="bad">Transient network hiccup</dd>'));
  assert.ok(openText.includes("glasses (via bridge)"));
  assert.ok(openText.includes("180 ms · normal"));
  assert.ok(openText.includes("connected · worn · battery 82% · streaming · glasses"));
  assert.ok(openText.includes("84% (ducked)"));
  assert.ok(openText.includes("GTIN 06416542002149 · exp 2027-08-31 · batch A1234"));
  assert.ok(!openText.includes("(server not asked yet)"));

  assert.match(openHtml, /<button class="btn small">Drop connection<\/button>/);
  assert.match(openHtml, /<button class="btn small">Simulate pack code<\/button>/);
  assert.match(openHtml, /<button class="btn small">Back to live<\/button>/);
  assert.ok(!openHtml.includes("disabled="));
});
