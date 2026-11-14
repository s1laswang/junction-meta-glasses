import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EarconKind } from "../src/audio/earcons.ts";
import { HoldUpSessionManager, type WsLike } from "../src/session/sessionManager.ts";
import {
  DEFAULT_CHAOS,
  NOOP_AUDIO_BRIDGE,
  arrayBufferToBase64,
  createControllerSessionCallbacks,
  cycleThemeMode,
  dispatchControllerShortcut,
  formatVerdictAnnouncement,
  hasBrowserCameraApi,
  resolveDefaultCameraSource,
  resolveVerdictFeedbackPlan,
  syncDocumentTheme,
  useHoldUpController,
  type AudioStreamBridge,
  type HoldUpController
} from "../src/session/useHoldUpController.ts";
import { DEMO_PROFILE, createMemoryStorage, saveConsent, saveTheme } from "../src/storage/profileStore.ts";
import type {
  ClientMsg,
  ServerMsg,
  ThemeMode,
  Verdict,
  VerdictLevel
} from "../src/types.ts";

type TestFn = (name: string, fn: () => void | Promise<void>) => Promise<void>;

type StrictAssert = {
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: T, expected: T, message?: string): void;
  notEqual<T>(actual: T, expected: T, message?: string): void;
  deepEqual<T>(actual: T, expected: T, message?: string): void;
  doesNotThrow(block: () => unknown, message?: string): void;
  match(value: string, regExp: RegExp, message?: string): void;
};

const nodeTestSpec: string = "node:test";
const nodeAssertSpec: string = "node:assert/strict";
const { test } = (await import(nodeTestSpec)) as { test: TestFn };
const assert: StrictAssert = ((await import(nodeAssertSpec)) as { default: StrictAssert }).default;

class FakeWs implements WsLike {
  readyState = 0;
  sent: ClientMsg[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMsg);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function makeVerdict(level: VerdictLevel, headline: string, speech: string): Verdict {
  const empty = { value: null, confidence: 0 };
  return {
    level,
    headline,
    speech,
    matchedMedId: level === "match" ? "aml" : undefined,
    takenToday: false,
    reasons: [`test-${level}`],
    read: {
      kind: "medication",
      product: { value: "Amlodipin", confidence: 0.96 },
      ingredient: { value: "amlodipine", confidence: 0.97 },
      strength: { value: "5 mg", confidence: 0.95 },
      dosing: empty,
      expiry: empty,
      allergens: { value: null, confidence: 0 },
      barcode: { value: "6432100012345", confidence: 0.99 },
      readability: 0.95
    }
  };
}

function wsUrl(sessionId: string): string {
  return `ws:\x2f\x2ftest.local/live?session=${sessionId}`;
}

test("cycleThemeMode loops cleanly across dark, light, and high-contrast", () => {
  const step1 = cycleThemeMode("dark");
  assert.equal(step1, "light");

  const step2 = cycleThemeMode(step1);
  assert.equal(step2, "high-contrast");

  const step3 = cycleThemeMode(step2);
  assert.equal(step3, "dark");

  let cur: ThemeMode = "dark";
  const sequence: ThemeMode[] = [];
  for (let i = 0; i < 6; i += 1) {
    cur = cycleThemeMode(cur);
    sequence.push(cur);
  }
  assert.deepEqual(sequence, [
    "light",
    "high-contrast",
    "dark",
    "light",
    "high-contrast",
    "dark"
  ]);
});

test("syncDocumentTheme sets data-theme on documentElement and stays safe in headless environments", () => {
  const recorded: Array<[string, string]> = [];
  const mockDoc = {
    documentElement: {
      setAttribute(k: string, v: string) {
        recorded.push([k, v]);
      }
    }
  };

  syncDocumentTheme("dark", mockDoc);
  syncDocumentTheme("light", mockDoc);
  syncDocumentTheme("high-contrast", mockDoc);

  assert.deepEqual(recorded, [
    ["data-theme", "dark"],
    ["data-theme", "light"],
    ["data-theme", "high-contrast"]
  ]);

  assert.doesNotThrow(() => syncDocumentTheme("light", {}));
  assert.doesNotThrow(() => syncDocumentTheme("high-contrast", undefined));

  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  try {
    delete g.document;
    assert.doesNotThrow(() => syncDocumentTheme("dark"));

    const globalRecorded: Array<[string, string]> = [];
    g.document = {
      documentElement: {
        setAttribute(k: string, v: string) {
          globalRecorded.push([k, v]);
        }
      }
    };
    syncDocumentTheme("high-contrast");
    assert.deepEqual(globalRecorded, [["data-theme", "high-contrast"]]);
  } finally {
    if (prevDoc !== undefined) {
      g.document = prevDoc;
    } else {
      delete g.document;
    }
  }
});

test("hasBrowserCameraApi and resolveDefaultCameraSource select demo when camera is unavailable", () => {
  assert.equal(hasBrowserCameraApi(null), false);
  assert.equal(hasBrowserCameraApi({}), false);
  assert.equal(hasBrowserCameraApi({ mediaDevices: {} }), false);
  assert.equal(
    hasBrowserCameraApi({ mediaDevices: { getUserMedia: async () => ({}) } }),
    true
  );

  assert.equal(resolveDefaultCameraSource(false, null), "demo");
  assert.equal(resolveDefaultCameraSource(false, "phone"), "demo");
  assert.equal(resolveDefaultCameraSource(false, "glasses"), "glasses");
  assert.equal(resolveDefaultCameraSource(false, "demo"), "demo");

  assert.equal(resolveDefaultCameraSource(true, null), "phone");
  assert.equal(resolveDefaultCameraSource(true, "phone"), "phone");
  assert.equal(resolveDefaultCameraSource(true, "demo"), "demo");
  assert.equal(resolveDefaultCameraSource(true, "glasses"), "glasses");
  assert.equal(resolveDefaultCameraSource(true, "unknown"), "phone");
});

test("resolveVerdictFeedbackPlan routes earcons, assertive announcements, and fallback TTS by mode and mute state", () => {
  const levels: Array<[VerdictLevel, EarconKind]> = [
    ["match", "match"],
    ["warning", "warning"],
    ["unsure", "unsure"],
    ["info", "info"]
  ];

  for (const [level, expectedEarcon] of levels) {
    const verdict = makeVerdict(level, `Headline ${level}`, `Speech for ${level}.`);

    const livePlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "live",
      muted: false,
      lang: "en",
      liveState: "open"
    });
    assert.equal(livePlan.earcon, expectedEarcon);
    assert.equal(livePlan.earconMuted, false);
    assert.equal(
      livePlan.assertiveAnnouncement,
      formatVerdictAnnouncement(verdict)
    );
    assert.equal(
      livePlan.assertiveAnnouncement,
      `Headline ${level}. Speech for ${level}.`
    );
    assert.equal(livePlan.fallbackTts, null);

    const snapshotPlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "snapshot",
      muted: false,
      lang: "fi"
    });
    assert.equal(snapshotPlan.earcon, expectedEarcon);
    assert.deepEqual(snapshotPlan.fallbackTts, {
      text: `Speech for ${level}.`,
      lang: "fi",
      preferServerTts: true
    });

    const offlinePlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "offline",
      muted: false,
      lang: "sv"
    });
    assert.equal(offlinePlan.earcon, expectedEarcon);
    assert.deepEqual(offlinePlan.fallbackTts, {
      text: `Speech for ${level}.`,
      lang: "sv",
      preferServerTts: false
    });

    const idleLiveSnapshotPlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "live",
      muted: false,
      lang: "en",
      liveState: "closed"
    });
    assert.deepEqual(idleLiveSnapshotPlan.fallbackTts, {
      text: `Speech for ${level}.`,
      lang: "en",
      preferServerTts: true
    });

    const mutedSnapshotPlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "snapshot",
      muted: true,
      lang: "en"
    });
    assert.equal(mutedSnapshotPlan.earconMuted, true);
    assert.equal(mutedSnapshotPlan.fallbackTts, null);

    const mutedOfflinePlan = resolveVerdictFeedbackPlan({
      verdict,
      mode: "offline",
      muted: true,
      lang: "en"
    });
    assert.equal(mutedOfflinePlan.earconMuted, true);
    assert.equal(mutedOfflinePlan.fallbackTts, null);
  }
});

test("createControllerSessionCallbacks wires HoldUpSessionManager audio, barge-in, checking pulse, coach, and verdict TTS", async () => {
  let muted = false;
  let lang = "fi";
  let modeOverride: "live" | "snapshot" | "offline" | null = null;

  const enqueuedPcm: string[] = [];
  let playbackFlushes = 0;
  let speechCancels = 0;
  const earconsPlayed: Array<{ kind: EarconKind; muted: boolean }> = [];
  const pulsesStarted: Array<{ muted: boolean; stopped: boolean }> = [];
  const politeAnnouncements: string[] = [];
  const assertiveAnnouncements: string[] = [];
  const fallbackSpeeches: Array<{
    text: string;
    lang?: string;
    preferServerTts?: boolean;
  }> = [];

  const audioBridge: AudioStreamBridge = {
    enqueuePcm24k: (b64) => {
      enqueuedPcm.push(b64);
    },
    flushPlayback: () => {
      playbackFlushes += 1;
    }
  };

  const sockets: FakeWs[] = [];
  let mgrRef: HoldUpSessionManager | null = null;

  const feedback = createControllerSessionCallbacks({
    getMuted: () => muted,
    getLang: () => lang,
    getLiveState: () => mgrRef?.getSnapshot().liveState ?? "closed",
    getModeOverride: () => modeOverride,
    getAudioBridge: () => audioBridge,
    announcePolite: (msg) => politeAnnouncements.push(msg),
    announceAssertive: (msg) => assertiveAnnouncements.push(msg),
    playEarconFn: (kind, opts) => {
      earconsPlayed.push({ kind, muted: Boolean(opts?.muted) });
    },
    startCheckingPulseFn: (opts) => {
      const rec = { muted: Boolean(opts?.muted), stopped: false };
      pulsesStarted.push(rec);
      return () => {
        rec.stopped = true;
      };
    },
    speakFallbackFn: async (text, opts) => {
      fallbackSpeeches.push({
        text,
        lang: opts?.lang,
        preferServerTts: opts?.preferServerTts
      });
    },
    cancelSpeechFn: () => {
      speechCancels += 1;
    }
  });

  const matchVerdict = makeVerdict(
    "match",
    "Amlodipine 5 mg",
    "Yes, your evening blood pressure pill."
  );
  const warningVerdict = makeVerdict(
    "warning",
    "Stop: NSAID warning",
    "Ibuprofen conflicts with your avoid list."
  );

  const mgr = new HoldUpSessionManager({
    sessionId: "hup-test",
    initialProfile: DEMO_PROFILE,
    wsUrlBuilder: wsUrl,
    createWs: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    fetchImpl: async () =>
      new Response(JSON.stringify(warningVerdict), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
    callbacks: feedback.callbacks
  });
  mgrRef = mgr;

  mgr.startSession();
  sockets[0].open();
  sockets[0].receive({ type: "ready", model: "gemini-live", session: "hup-test" });

  sockets[0].receive({ type: "audio", data: "cGNtMjRr" });
  assert.deepEqual(enqueuedPcm, ["cGNtMjRr"]);

  muted = true;
  sockets[0].receive({ type: "audio", data: "bXV0ZWQ=" });
  assert.deepEqual(enqueuedPcm, ["cGNtMjRr"]);
  muted = false;

  sockets[0].receive({ type: "interrupted" });
  assert.equal(playbackFlushes, 1);
  assert.equal(speechCancels, 1);

  sockets[0].receive({ type: "coach", cue: "rotate_left", text: "Turn it slightly left" });
  assert.deepEqual(earconsPlayed.at(-1), { kind: "cue", muted: false });
  assert.ok(politeAnnouncements.includes("Turn it slightly left"));

  sockets[0].receive({ type: "checking", phase: "start" });
  assert.equal(pulsesStarted.length, 1);
  assert.equal(pulsesStarted[0].muted, false);
  assert.equal(pulsesStarted[0].stopped, false);

  sockets[0].receive({ type: "verdict", verdict: matchVerdict });
  assert.equal(pulsesStarted[0].stopped, true);
  assert.deepEqual(earconsPlayed.at(-1), { kind: "match", muted: false });
  assert.equal(
    assertiveAnnouncements.at(-1),
    "Amlodipine 5 mg. Yes, your evening blood pressure pill."
  );
  assert.equal(fallbackSpeeches.length, 0);

  mgr.sendFrame({ data: "frame-jpeg-b64", w: 768, h: 768, sharpness: 0.9, ts: 1 });
  sockets[0].drop();
  assert.ok(politeAnnouncements.some((m) => m.toLowerCase().includes("snapshot")));

  await mgr.sendQuestion("Can I take this?");
  assert.deepEqual(earconsPlayed.at(-1), { kind: "warning", muted: false });
  assert.equal(
    assertiveAnnouncements.at(-1),
    "Stop: NSAID warning. Ibuprofen conflicts with your avoid list."
  );
  assert.equal(fallbackSpeeches.length, 1);
  assert.deepEqual(fallbackSpeeches[0], {
    text: "Ibuprofen conflicts with your avoid list.",
    lang: "fi",
    preferServerTts: true
  });

  lang = "sv";
  modeOverride = "offline";
  const offlineVerdict = makeVerdict(
    "unsure",
    "Offline: unknown barcode",
    "Reconnect to read new labels."
  );
  mgr.applyLocalVerdict(offlineVerdict);
  modeOverride = null;

  assert.deepEqual(earconsPlayed.at(-1), { kind: "unsure", muted: false });
  assert.equal(fallbackSpeeches.length, 2);
  assert.deepEqual(fallbackSpeeches[1], {
    text: "Reconnect to read new labels.",
    lang: "sv",
    preferServerTts: false
  });

  muted = true;
  mgr.setOnline(false);
  mgr.applyLocalVerdict(offlineVerdict);
  assert.deepEqual(earconsPlayed.at(-1), { kind: "unsure", muted: true });
  assert.equal(fallbackSpeeches.length, 2);

  feedback.disposeCheckingPulse();
  mgr.stopSession();
});

test("dispatchControllerShortcut routes all 7 keyboard actions accurately", () => {
  const calls: string[] = [];
  let active = false;

  const handlers = {
    isCheckingActive: () => active,
    startCheck: () => {
      active = true;
      calls.push("startCheck");
    },
    stopCheck: () => {
      active = false;
      calls.push("stopCheck");
    },
    snapshotVerify: () => calls.push("snapshotVerify"),
    offlineBarcodeScan: () => calls.push("offlineBarcodeScan"),
    logDose: () => calls.push("logDose"),
    repeatLastVerdict: () => calls.push("repeatLastVerdict"),
    cycleTheme: () => calls.push("cycleTheme"),
    openPrivacy: () => calls.push("openPrivacy")
  };

  dispatchControllerShortcut("toggle_check", handlers);
  dispatchControllerShortcut("toggle_check", handlers);
  dispatchControllerShortcut("snapshot_verify", handlers);
  dispatchControllerShortcut("offline_barcode", handlers);
  dispatchControllerShortcut("log_dose", handlers);
  dispatchControllerShortcut("repeat", handlers);
  dispatchControllerShortcut("cycle_theme", handlers);
  dispatchControllerShortcut("open_privacy", handlers);

  assert.deepEqual(calls, [
    "startCheck",
    "stopCheck",
    "snapshotVerify",
    "offlineBarcodeScan",
    "logDose",
    "repeatLastVerdict",
    "cycleTheme",
    "openPrivacy"
  ]);
});

test("useHoldUpController initializes persisted state, safe no-op audio bridge, and full action surface in SSR", async () => {
  const storage = createMemoryStorage();
  saveConsent(true, storage);
  saveTheme("high-contrast", storage);

  let captured = null as HoldUpController | null;
  function Probe() {
    captured = useHoldUpController({ storage });
    return createElement("div", { "data-session": captured.sessionId }, captured.theme);
  }

  const html = renderToStaticMarkup(createElement(Probe));
  assert.ok(captured !== null);
  const ctrl: HoldUpController = captured;

  assert.match(ctrl.sessionId, /^hup-[a-z0-9]{4}$/);
  assert.ok(html.includes("high-contrast"));
  assert.equal(ctrl.theme, "high-contrast");
  assert.equal(ctrl.consent.accepted, true);
  assert.deepEqual(ctrl.profile, DEMO_PROFILE);
  assert.equal(ctrl.muted, false);
  assert.deepEqual(ctrl.chaos, DEFAULT_CHAOS);
  assert.equal(ctrl.source, "demo");
  assert.equal(ctrl.activeScenarioId, "amlodipine_match");
  assert.equal(ctrl.activeScenario.id, "amlodipine_match");
  assert.equal(ctrl.privacyModalOpen, false);

  const requiredActionNames: Array<keyof HoldUpController> = [
    "acceptConsent",
    "updateProfile",
    "resetDemoProfile",
    "wipeAllData",
    "changeTheme",
    "cycleTheme",
    "toggleMute",
    "changeSource",
    "selectScenario",
    "startCheck",
    "stopCheck",
    "snapshotVerify",
    "offlineBarcodeScan",
    "submitQuestion",
    "logDose",
    "undoDose",
    "repeatLastVerdict",
    "setChaos",
    "triggerHudEvent"
  ];

  for (const name of requiredActionNames) {
    assert.equal(typeof ctrl[name], "function", `expected ${String(name)} to be a function`);
  }

  await NOOP_AUDIO_BRIDGE.startMic(() => {});
  NOOP_AUDIO_BRIDGE.stopMic();
  NOOP_AUDIO_BRIDGE.enqueuePcm24k("abc");
  NOOP_AUDIO_BRIDGE.flushPlayback();
  await NOOP_AUDIO_BRIDGE.resumePlayback();

  const rawBytes = new Uint8Array([72, 111, 108, 100, 85, 112]);
  assert.equal(arrayBufferToBase64(rawBytes.buffer), "SG9sZFVw");
});

test("useHoldUpController actions execute end-to-end across barcode scan, snapshot verify, dose logging, HUD events, and wipe", async () => {
  const storage = createMemoryStorage();
  const verifyRequests: Array<{ frames: string[]; question?: string }> = [];

  const mockVerdict = makeVerdict(
    "match",
    "Amlodipine 5 mg",
    "Matches your saved evening medication."
  );

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/fixtures/")) {
      return new Response(new Uint8Array(128).fill(0xff), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    }
    if (url === "/api/verify") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        frames: string[];
        question?: string;
      };
      verifyRequests.push(body);
      return new Response(JSON.stringify(mockVerdict), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("", { status: 503 });
  };

  let captured = null as HoldUpController | null;
  function ActionProbe() {
    captured = useHoldUpController({
      storage,
      fetchImpl: fakeFetch,
      wsUrlBuilder: wsUrl,
      createWs: (url) => new FakeWs(url)
    });
    return createElement("div", null, "probe");
  }

  renderToStaticMarkup(createElement(ActionProbe));
  assert.ok(captured !== null);
  const ctrl: HoldUpController = captured;

  const accepted = ctrl.acceptConsent();
  assert.equal(accepted.accepted, true);

  assert.equal(ctrl.cycleTheme(), "light");
  assert.equal(ctrl.cycleTheme(), "high-contrast");
  assert.equal(ctrl.cycleTheme(), "dark");

  assert.equal(ctrl.toggleMute(), true);
  assert.equal(ctrl.toggleMute(), false);

  const selected = ctrl.selectScenario("ibuprofen_nsaid");
  assert.equal(selected.id, "ibuprofen_nsaid");

  const snapVerdict = await ctrl.snapshotVerify();
  assert.ok(snapVerdict !== null);
  assert.equal(snapVerdict.level, "match");
  assert.equal(verifyRequests.length, 1);
  assert.equal(verifyRequests[0].frames.length, 1);
  assert.equal(verifyRequests[0].question, "Can I take this for a headache?");

  const logged = ctrl.logDose();
  assert.ok(logged !== null);
  assert.equal(logged.doseLog.length, 1);
  assert.equal(logged.doseLog[0].medId, "aml");
  assert.equal(ctrl.sessionManager.getSnapshot().verdict?.takenToday, true);

  const undone = ctrl.undoDose();
  assert.equal(undone.doseLog.length, 0);
  assert.equal(ctrl.sessionManager.getSnapshot().verdict?.takenToday, false);

  const offlineMatch = await ctrl.offlineBarcodeScan("6432100012345");
  assert.equal(offlineMatch.level, "match");
  assert.equal(offlineMatch.matchedMedId, "aml");

  ctrl.triggerHudEvent("log_dose");
  assert.equal(ctrl.sessionManager.getSnapshot().verdict?.takenToday, true);

  ctrl.triggerHudEvent("dismiss");

  ctrl.wipeAllData();
  assert.equal(storage.length, 0);
});

