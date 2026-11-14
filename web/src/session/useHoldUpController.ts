import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from "react";
import { useLiveAnnouncer } from "../a11y/announcer.tsx";
import { useKeyboardShortcuts, type ShortcutAction } from "../a11y/shortcuts.ts";
import {
  playEarcon,
  startCheckingPulse,
  verdictEarcon,
  type EarconKind
} from "../audio/earcons.ts";
import { cancelSpeech, speakFallback } from "../audio/tts.ts";
import { computeAdaptiveParams } from "../camera/adaptive.ts";
import { detectBarcodeFromElement, offlineBarcodeVerdict } from "../camera/barcode.ts";
import {
  CameraController,
  classifyMediaError,
  probePermissions,
  type CapturedFrame
} from "../camera/cameraStream.ts";
import { DEMO_SCENARIOS, getDemoScenario } from "../camera/demoScenarios.ts";
import {
  CONSENT_VERSION,
  STORAGE_KEYS,
  appendDoseLog,
  exportCaregiverSummary,
  loadConsent,
  loadOrCreateSessionId,
  loadProfile,
  loadTheme,
  resetToDemoProfile,
  saveConsent,
  saveProfile,
  saveTheme,
  undoLastDose,
  wipeAllLocalData,
  type KeyValueStorage
} from "../storage/profileStore.ts";
import type {
  CameraSource,
  ChaosConfig,
  CoachCue,
  ConsentRecord,
  DemoScenario,
  DemoScenarioId,
  LiveState,
  Profile,
  SessionSnapshot,
  ThemeMode,
  TransportMode,
  Verdict
} from "../types.ts";
import {
  HoldUpSessionManager,
  type SessionCallbacks,
  type WsLike
} from "./sessionManager.ts";

export type AudioStreamBridge = {
  startMic?: (onChunk: (b64: string) => void) => Promise<void>;
  stopMic?: () => void;
  enqueuePcm24k?: (b64: string) => void;
  flushPlayback?: () => void;
  resumePlayback?: () => Promise<void>;
};

export type HudEventName = "repeat" | "log_dose" | "dismiss" | "stop";

export type VerdictFeedbackPlan = {
  earcon: EarconKind;
  earconMuted: boolean;
  assertiveAnnouncement: string;
  fallbackTts: {
    text: string;
    lang: string;
    preferServerTts: boolean;
  } | null;
};

export type ControllerFeedbackDeps = {
  getMuted: () => boolean;
  getLang: () => string;
  getLiveState?: () => LiveState;
  getModeOverride?: () => TransportMode | null;
  isSilentVerdictUpdate?: () => boolean;
  getAudioBridge?: () => AudioStreamBridge | undefined;
  fetchImpl?: typeof fetch;
  announcePolite: (message: string) => void;
  announceAssertive: (message: string) => void;
  onResetHudDismissed?: () => void;
  playEarconFn?: typeof playEarcon;
  startCheckingPulseFn?: typeof startCheckingPulse;
  speakFallbackFn?: typeof speakFallback;
  cancelSpeechFn?: typeof cancelSpeech;
};

export type HoldUpControllerOptions = {
  audioBridge?: AudioStreamBridge;
  storage?: KeyValueStorage;
  wsUrlBuilder?: (sessionId: string) => string;
  createWs?: (url: string) => WsLike;
  fetchImpl?: typeof fetch;
};

export type HoldUpController = {
  sessionId: string;
  snapshot: SessionSnapshot;
  sessionManager: HoldUpSessionManager;
  profile: Profile;
  consent: ConsentRecord;
  theme: ThemeMode;
  muted: boolean;
  chaos: ChaosConfig;
  source: CameraSource;
  activeScenarioId: DemoScenarioId;
  activeScenario: DemoScenario;
  scenarios: readonly DemoScenario[];
  privacyModalOpen: boolean;
  hudDismissed: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  demoImageRef: RefObject<HTMLImageElement | null>;
  cameraController: CameraController;
  politeMessage: string;
  politeSeq: number;
  assertiveMessage: string;
  assertiveSeq: number;
  announcer: {
    politeMessage: string;
    politeSeq: number;
    assertiveMessage: string;
    assertiveSeq: number;
    announce: (message: string, priority?: "polite" | "assertive") => void;
    announcePolite: (message: string) => void;
    announceAssertive: (message: string) => void;
  };
  acceptConsent: () => ConsentRecord;
  updateProfile: (next: Profile | ((prev: Profile) => Profile)) => Profile;
  resetDemoProfile: () => Profile;
  wipeAllData: () => void;
  changeTheme: (next: ThemeMode) => void;
  cycleTheme: () => ThemeMode;
  toggleMute: () => boolean;
  setMuted: (next: boolean) => void;
  changeSource: (next: CameraSource) => void;
  selectScenario: (id: DemoScenarioId) => DemoScenario;
  startCheck: () => Promise<void>;
  stopCheck: () => void;
  toggleCheck: () => Promise<void>;
  snapshotVerify: (question?: string) => Promise<Verdict | null>;
  offlineBarcodeScan: (explicitBarcode?: string) => Promise<Verdict>;
  submitQuestion: (text: string) => Promise<void>;
  logDose: (medId?: string) => Profile | null;
  undoDose: () => Profile;
  repeatLastVerdict: () => void;
  setChaos: (next: ChaosConfig | ((prev: ChaosConfig) => ChaosConfig)) => void;
  triggerHudEvent: (name: HudEventName) => void;
  setPrivacyModalOpen: (open: boolean) => void;
  openPrivacyModal: () => void;
  closePrivacyModal: () => void;
  getCaregiverSummary: (now?: Date) => string;
};

const EXTRA_STORAGE_KEYS = {
  muted: "holdup.muted",
  chaos: "holdup.chaos",
  scenario: "holdup.activeScenarioId",
  source: "holdup.source"
} as const;

const SESSION_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const DEFAULT_CHAOS: ChaosConfig = Object.freeze({
  forceWsDrop: false,
  forceOffline: false,
  simulateGlassesDoffed: false,
  simulateLowBattery: false
});

export const NOOP_AUDIO_BRIDGE: Required<AudioStreamBridge> = Object.freeze({
  startMic: async () => {},
  stopMic: () => {},
  enqueuePcm24k: () => {},
  flushPlayback: () => {},
  resumePlayback: async () => {}
});

export function cycleThemeMode(current: ThemeMode): ThemeMode {
  if (current === "dark") {
    return "light";
  }
  if (current === "light") {
    return "high-contrast";
  }
  return "dark";
}

export function syncDocumentTheme(
  theme: ThemeMode,
  doc?: { documentElement?: { setAttribute(k: string, v: string): void } }
): void {
  const target =
    arguments.length >= 2
      ? doc
      : typeof document !== "undefined"
        ? document
        : undefined;
  if (target?.documentElement && typeof target.documentElement.setAttribute === "function") {
    target.documentElement.setAttribute("data-theme", theme);
  }
}

export function hasBrowserCameraApi(
  nav?: { mediaDevices?: { getUserMedia?: unknown } } | null
): boolean {
  const target =
    nav !== undefined ? nav : typeof navigator !== "undefined" ? navigator : null;
  return Boolean(
    target?.mediaDevices && typeof target.mediaDevices.getUserMedia === "function"
  );
}

export function resolveDefaultCameraSource(
  hasCameraApi: boolean,
  stored?: string | null
): CameraSource {
  if (stored === "demo" || stored === "glasses") {
    return stored;
  }
  if (stored === "phone") {
    return hasCameraApi ? "phone" : "demo";
  }
  return hasCameraApi ? "phone" : "demo";
}

export function formatVerdictAnnouncement(
  verdict: Pick<Verdict, "headline" | "speech">
): string {
  return `${verdict.headline}. ${verdict.speech}`;
}

export function resolveVerdictFeedbackPlan(input: {
  verdict: Verdict;
  mode: TransportMode;
  muted: boolean;
  lang: string;
  liveState?: LiveState;
}): VerdictFeedbackPlan {
  const earcon = verdictEarcon(input.verdict.level);
  const assertiveAnnouncement = formatVerdictAnnouncement(input.verdict);
  const effectiveMode: TransportMode =
    input.mode === "live" && input.liveState !== undefined && input.liveState !== "open"
      ? "snapshot"
      : input.mode;

  const shouldSpeakFallback =
    !input.muted &&
    (effectiveMode === "snapshot" || effectiveMode === "offline") &&
    input.verdict.speech.trim().length > 0;

  return {
    earcon,
    earconMuted: input.muted,
    assertiveAnnouncement,
    fallbackTts: shouldSpeakFallback
      ? {
          text: input.verdict.speech,
          lang: input.lang || "en",
          preferServerTts: effectiveMode === "snapshot"
        }
      : null
  };
}

export function createControllerSessionCallbacks(deps: ControllerFeedbackDeps): {
  callbacks: SessionCallbacks;
  disposeCheckingPulse: () => void;
  refreshCheckingPulseMute: (checking: boolean) => void;
} {
  const playEarconFn = deps.playEarconFn ?? playEarcon;
  const startCheckingPulseFn = deps.startCheckingPulseFn ?? startCheckingPulse;
  const speakFallbackFn = deps.speakFallbackFn ?? speakFallback;
  const cancelSpeechFn = deps.cancelSpeechFn ?? cancelSpeech;

  let stopPulse: (() => void) | null = null;

  const disposeCheckingPulse = () => {
    if (stopPulse) {
      const fn = stopPulse;
      stopPulse = null;
      fn();
    }
  };

  const refreshCheckingPulseMute = (checking: boolean) => {
    disposeCheckingPulse();
    if (checking) {
      stopPulse = startCheckingPulseFn({ muted: deps.getMuted() });
    }
  };

  const callbacks: SessionCallbacks = {
    onAudioChunk: (b64Pcm24k: string) => {
      if (!deps.getMuted() && b64Pcm24k) {
        deps.getAudioBridge?.()?.enqueuePcm24k?.(b64Pcm24k);
      }
    },
    onInterrupted: () => {
      deps.getAudioBridge?.()?.flushPlayback?.();
      cancelSpeechFn();
    },
    onCheckingChange: (checking: boolean) => {
      disposeCheckingPulse();
      if (checking) {
        stopPulse = startCheckingPulseFn({ muted: deps.getMuted() });
      }
    },
    onVerdict: (verdict: Verdict, mode: TransportMode) => {
      deps.onResetHudDismissed?.();
      if (deps.isSilentVerdictUpdate?.()) {
        return;
      }
      const override = deps.getModeOverride?.() ?? null;
      const effectiveMode = override ?? mode;
      const plan = resolveVerdictFeedbackPlan({
        verdict,
        mode: effectiveMode,
        muted: deps.getMuted(),
        lang: deps.getLang(),
        liveState: override ? undefined : deps.getLiveState?.()
      });

      playEarconFn(plan.earcon, { muted: plan.earconMuted });
      deps.announceAssertive(plan.assertiveAnnouncement);

      if (plan.fallbackTts) {
        void speakFallbackFn(plan.fallbackTts.text, {
          lang: plan.fallbackTts.lang,
          preferServerTts: plan.fallbackTts.preferServerTts,
          fetchImpl: deps.fetchImpl
        });
      }
    },
    onCoach: (_cue: CoachCue, text: string) => {
      deps.onResetHudDismissed?.();
      playEarconFn("cue", { muted: deps.getMuted() });
      deps.announcePolite(text);
    },
    onStateAnnouncement: (msg: string) => {
      deps.announcePolite(msg);
    }
  };

  return {
    callbacks,
    disposeCheckingPulse,
    refreshCheckingPulseMute
  };
}

export type ShortcutDispatchHandlers = {
  isCheckingActive: () => boolean;
  startCheck: () => unknown;
  stopCheck: () => void;
  snapshotVerify: () => unknown;
  offlineBarcodeScan: () => unknown;
  logDose: () => unknown;
  repeatLastVerdict: () => void;
  cycleTheme: () => unknown;
  openPrivacy: () => void;
};

export function dispatchControllerShortcut(
  action: ShortcutAction,
  handlers: ShortcutDispatchHandlers
): void {
  switch (action) {
    case "toggle_check":
      if (handlers.isCheckingActive()) {
        handlers.stopCheck();
      } else {
        void handlers.startCheck();
      }
      return;
    case "snapshot_verify":
      void handlers.snapshotVerify();
      return;
    case "offline_barcode":
      void handlers.offlineBarcodeScan();
      return;
    case "log_dose":
      handlers.logDose();
      return;
    case "repeat":
      handlers.repeatLastVerdict();
      return;
    case "cycle_theme":
      handlers.cycleTheme();
      return;
    case "open_privacy":
      handlers.openPrivacy();
      return;
  }
}

function getStorageTarget(storage?: KeyValueStorage): KeyValueStorage | null {
  if (storage) {
    return storage;
  }
  try {
    const ls = globalThis.localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function" &&
      typeof ls.removeItem === "function"
    ) {
      return ls;
    }
  } catch {
    return null;
  }
  return null;
}

function readExtraKey(key: string, storage?: KeyValueStorage): string | null {
  const target = getStorageTarget(storage);
  if (!target) {
    return null;
  }
  try {
    return target.getItem(key);
  } catch {
    return null;
  }
}

function writeExtraKey(key: string, value: string, storage?: KeyValueStorage): void {
  const target = getStorageTarget(storage);
  if (!target) {
    return;
  }
  try {
    target.setItem(key, value);
  } catch {
    return;
  }
}

function loadStoredMuted(storage?: KeyValueStorage): boolean {
  const raw = readExtraKey(EXTRA_STORAGE_KEYS.muted, storage);
  return raw === "1" || raw === "true";
}

function saveStoredMuted(muted: boolean, storage?: KeyValueStorage): void {
  writeExtraKey(EXTRA_STORAGE_KEYS.muted, muted ? "1" : "0", storage);
}

function isDemoScenarioId(value: string | null): value is DemoScenarioId {
  return Boolean(value && DEMO_SCENARIOS.some((s) => s.id === value));
}

function loadStoredScenarioId(storage?: KeyValueStorage): DemoScenarioId {
  const raw = readExtraKey(EXTRA_STORAGE_KEYS.scenario, storage);
  return isDemoScenarioId(raw) ? raw : DEMO_SCENARIOS[0].id;
}

function saveStoredScenarioId(id: DemoScenarioId, storage?: KeyValueStorage): void {
  writeExtraKey(EXTRA_STORAGE_KEYS.scenario, id, storage);
}

function loadStoredChaos(storage?: KeyValueStorage): ChaosConfig {
  const raw = readExtraKey(EXTRA_STORAGE_KEYS.chaos, storage);
  if (!raw) {
    return { ...DEFAULT_CHAOS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_CHAOS };
    }
    const rec = parsed as Record<string, unknown>;
    return {
      forceWsDrop: Boolean(rec.forceWsDrop),
      forceOffline: Boolean(rec.forceOffline),
      simulateGlassesDoffed: Boolean(rec.simulateGlassesDoffed),
      simulateLowBattery: Boolean(rec.simulateLowBattery)
    };
  } catch {
    return { ...DEFAULT_CHAOS };
  }
}

function saveStoredChaos(chaos: ChaosConfig, storage?: KeyValueStorage): void {
  writeExtraKey(EXTRA_STORAGE_KEYS.chaos, JSON.stringify(chaos), storage);
}

function loadStoredSource(storage?: KeyValueStorage): CameraSource {
  const raw = readExtraKey(EXTRA_STORAGE_KEYS.source, storage);
  return resolveDefaultCameraSource(hasBrowserCameraApi(), raw);
}

function saveStoredSource(source: CameraSource, storage?: KeyValueStorage): void {
  writeExtraKey(EXTRA_STORAGE_KEYS.source, source, storage);
}

function hasAnyChaosFlag(chaos: ChaosConfig): boolean {
  return (
    chaos.forceWsDrop ||
    chaos.forceOffline ||
    chaos.simulateGlassesDoffed ||
    chaos.simulateLowBattery
  );
}

function createEphemeralSessionId(): string {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 4; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += SESSION_ALPHABET[bytes[i] % SESSION_ALPHABET.length];
  }
  return `hup-${suffix}`;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  const maybeBuffer = (
    globalThis as {
      Buffer?: { from(data: Uint8Array): { toString(enc: string): string } };
    }
  ).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString("base64");
  }
  return "";
}

function hasDoseLoggedToday(profile: Profile, medId: string, now = new Date()): boolean {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return profile.doseLog.some(
    (entry) => entry.medId === medId && entry.ts >= start.getTime() && entry.ts <= end.getTime()
  );
}

export function useHoldUpController(opts?: HoldUpControllerOptions): HoldUpController {
  const storage = opts?.storage;
  const announcer = useLiveAnnouncer();
  const { announcePolite, announceAssertive } = announcer;

  const [sessionId, setSessionId] = useState<string>(() => loadOrCreateSessionId(storage));
  const [profile, setProfile] = useState<Profile>(() => loadProfile(storage));
  const [consent, setConsent] = useState<ConsentRecord>(() => loadConsent(storage));
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme(storage));
  const [muted, setMutedState] = useState<boolean>(() => loadStoredMuted(storage));
  const [chaos, setChaosState] = useState<ChaosConfig>(() => loadStoredChaos(storage));
  const [activeScenarioId, setActiveScenarioId] = useState<DemoScenarioId>(() =>
    loadStoredScenarioId(storage)
  );
  const [source, setSourceState] = useState<CameraSource>(() => loadStoredSource(storage));
  const [privacyModalOpen, setPrivacyModalOpen] = useState<boolean>(false);
  const [hudDismissed, setHudDismissed] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const demoImageRef = useRef<HTMLImageElement | null>(null);
  const cameraControllerRef = useRef<CameraController | null>(null);
  if (!cameraControllerRef.current) {
    cameraControllerRef.current = new CameraController();
  }
  const cameraController = cameraControllerRef.current;

  const profileRef = useRef<Profile>(profile);
  profileRef.current = profile;

  const consentRef = useRef<ConsentRecord>(consent);
  consentRef.current = consent;

  const themeRef = useRef<ThemeMode>(theme);
  themeRef.current = theme;

  const mutedRef = useRef<boolean>(muted);
  mutedRef.current = muted;

  const chaosRef = useRef<ChaosConfig>(chaos);
  chaosRef.current = chaos;

  const activeScenarioIdRef = useRef<DemoScenarioId>(activeScenarioId);
  activeScenarioIdRef.current = activeScenarioId;

  const sourceRef = useRef<CameraSource>(source);
  sourceRef.current = source;

  const audioBridgeRef = useRef<AudioStreamBridge | undefined>(opts?.audioBridge);
  audioBridgeRef.current = opts?.audioBridge;

  const fetchImplRef = useRef<typeof fetch | undefined>(opts?.fetchImpl);
  fetchImplRef.current = opts?.fetchImpl;

  const announcePoliteRef = useRef(announcePolite);
  announcePoliteRef.current = announcePolite;

  const announceAssertiveRef = useRef(announceAssertive);
  announceAssertiveRef.current = announceAssertive;

  const localVerdictModeOverrideRef = useRef<TransportMode | null>(null);
  const silentVerdictUpdateRef = useRef<boolean>(false);
  const hardwareRunningRef = useRef<boolean>(false);
  const demoFixtureCacheRef = useRef<Map<string, string>>(new Map());

  const managerBundleRef = useRef<{
    sessionId: string;
    manager: HoldUpSessionManager;
    disposeCheckingPulse: () => void;
    refreshCheckingPulseMute: (checking: boolean) => void;
  } | null>(null);

  if (!managerBundleRef.current || managerBundleRef.current.sessionId !== sessionId) {
    let createdManager: HoldUpSessionManager | null = null;
    const feedback = createControllerSessionCallbacks({
      getMuted: () => mutedRef.current,
      getLang: () => profileRef.current.lang || "en",
      getLiveState: () => createdManager?.getSnapshot().liveState ?? "closed",
      getModeOverride: () => localVerdictModeOverrideRef.current,
      isSilentVerdictUpdate: () => silentVerdictUpdateRef.current,
      getAudioBridge: () => audioBridgeRef.current,
      fetchImpl: opts?.fetchImpl,
      announcePolite: (msg) => announcePoliteRef.current(msg),
      announceAssertive: (msg) => announceAssertiveRef.current(msg),
      onResetHudDismissed: () => setHudDismissed(false)
    });

    createdManager = new HoldUpSessionManager({
      sessionId,
      initialProfile: profileRef.current,
      wsUrlBuilder: opts?.wsUrlBuilder,
      createWs: opts?.createWs,
      fetchImpl: opts?.fetchImpl,
      callbacks: feedback.callbacks
    });

    if (hasAnyChaosFlag(chaosRef.current)) {
      createdManager.setChaos(chaosRef.current);
    }

    managerBundleRef.current = {
      sessionId,
      manager: createdManager,
      disposeCheckingPulse: feedback.disposeCheckingPulse,
      refreshCheckingPulseMute: feedback.refreshCheckingPulseMute
    };
  }

  const sessionManager = managerBundleRef.current.manager;
  const snapshot = useSyncExternalStore(
    sessionManager.subscribe,
    sessionManager.getSnapshot,
    sessionManager.getSnapshot
  );

  const activeScenario = useMemo(
    () => getDemoScenario(activeScenarioId),
    [activeScenarioId]
  );

  useEffect(() => {
    syncDocumentTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    void probePermissions().then((perms) => {
      if (cancelled) {
        return;
      }
      sessionManager.setPermissions(perms);
      if (perms.camera === "unavailable" && sourceRef.current === "phone") {
        setSourceState("demo");
        saveStoredSource("demo", storage);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionManager, storage]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const handleOnline = () => sessionManager.setOnline(true);
    const handleOffline = () => sessionManager.setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [sessionManager]);

  useEffect(() => {
    const bundle = managerBundleRef.current;
    return () => {
      bundle?.disposeCheckingPulse();
      cameraController.stop();
      audioBridgeRef.current?.stopMic?.();
      audioBridgeRef.current?.flushPlayback?.();
      cancelSpeech();
      sessionManager.stopSession();
    };
  }, [cameraController, sessionManager]);

  const loadDemoFixtureBase64 = useCallback(async (fixtureUrl: string): Promise<string | null> => {
    const cached = demoFixtureCacheRef.current.get(fixtureUrl);
    if (cached) {
      return cached;
    }
    const fetchFn =
      fetchImplRef.current ??
      (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    if (!fetchFn) {
      return null;
    }
    try {
      const res = await fetchFn(fixtureUrl);
      if (!res.ok) {
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) {
        return null;
      }
      const b64 = arrayBufferToBase64(buf);
      if (!b64) {
        return null;
      }
      demoFixtureCacheRef.current.set(fixtureUrl, b64);
      return b64;
    } catch {
      return null;
    }
  }, []);

  const captureCurrentFrame = useCallback(async (): Promise<CapturedFrame | null> => {
    const snap = sessionManager.getSnapshot();
    const adaptive = computeAdaptiveParams(snap.network.rttMs, snap.network.online);
    const currentSource = sourceRef.current;
    const usePhoneEye =
      currentSource === "phone" ||
      (currentSource === "glasses" && snap.device.source === "phone");

    if (usePhoneEye && videoRef.current) {
      const captured = cameraController.captureFrame(videoRef.current, {
        maxDim: adaptive.maxDim,
        jpegQuality: adaptive.jpegQuality
      });
      if (captured) {
        return captured;
      }
    }

    if (currentSource === "demo") {
      if (demoImageRef.current) {
        const fromImg = cameraController.captureFrame(demoImageRef.current, {
          maxDim: adaptive.maxDim,
          jpegQuality: adaptive.jpegQuality
        });
        if (fromImg) {
          return fromImg;
        }
      }
      const scenario = getDemoScenario(activeScenarioIdRef.current);
      const b64 = await loadDemoFixtureBase64(scenario.fixtureUrl);
      if (b64) {
        return {
          data: b64,
          w: 768,
          h: 768,
          sharpness: 0.88,
          ts: Date.now()
        };
      }
    }

    return null;
  }, [cameraController, loadDemoFixtureBase64, sessionManager]);

  useEffect(() => {
    if (!snapshot.cameraActive) {
      if (hardwareRunningRef.current) {
        hardwareRunningRef.current = false;
        cameraController.stop();
        audioBridgeRef.current?.stopMic?.();
        playEarcon("camera_off", { muted: mutedRef.current });
      }
      return;
    }

    hardwareRunningRef.current = true;
    const usePhoneEye =
      source === "phone" || (source === "glasses" && snapshot.device.source === "phone");

    if (usePhoneEye && videoRef.current && !cameraController.active) {
      void cameraController.startPhoneCamera(videoRef.current).then((res) => {
        if (res.ok) {
          sessionManager.setPermissions({ camera: "granted" });
        } else {
          sessionManager.setPermissions({ camera: res.status });
        }
      });
    } else if (!usePhoneEye && cameraController.active) {
      cameraController.stop();
    }

    if (source === "glasses" && snapshot.device.source === "glasses") {
      return;
    }

    let cancelled = false;
    const adaptive = computeAdaptiveParams(snapshot.network.rttMs, snapshot.network.online);

    const pump = async () => {
      const frame = await captureCurrentFrame();
      if (!cancelled && frame) {
        sessionManager.sendFrame(frame);
      }
    };

    void pump();
    const timer = setInterval(() => {
      void pump();
    }, adaptive.intervalMs);
    const maybeNodeTimer = timer as unknown as { unref?: () => void };
    maybeNodeTimer.unref?.();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    activeScenarioId,
    cameraController,
    captureCurrentFrame,
    sessionManager,
    snapshot.cameraActive,
    snapshot.device.source,
    snapshot.network.online,
    snapshot.network.rttMs,
    source
  ]);

  const acceptConsent = useCallback((): ConsentRecord => {
    writeExtraKey(STORAGE_KEYS.sessionId, sessionId, storage);
    const record = saveConsent(true, storage);
    consentRef.current = record;
    setConsent(record);
    setPrivacyModalOpen(false);
    announcePolite("Privacy consent saved.");
    return record;
  }, [announcePolite, sessionId, storage]);

  const updateProfile = useCallback(
    (next: Profile | ((prev: Profile) => Profile)): Profile => {
      const resolved = typeof next === "function" ? next(profileRef.current) : next;
      const saved = saveProfile(resolved, storage);
      profileRef.current = saved;
      setProfile(saved);
      sessionManager.updateProfile(saved);
      return saved;
    },
    [sessionManager, storage]
  );

  const resetDemoProfile = useCallback((): Profile => {
    const demo = resetToDemoProfile(storage);
    profileRef.current = demo;
    setProfile(demo);
    sessionManager.updateProfile(demo);
    announcePolite("Demo profile loaded on this device.");
    return demo;
  }, [announcePolite, sessionManager, storage]);

  const stopCheck = useCallback((): void => {
    const wasActive = sessionManager.getSnapshot().cameraActive || hardwareRunningRef.current;
    hardwareRunningRef.current = false;
    managerBundleRef.current?.disposeCheckingPulse();
    cameraController.stop();
    audioBridgeRef.current?.stopMic?.();
    audioBridgeRef.current?.flushPlayback?.();
    cancelSpeech();
    if (wasActive) {
      playEarcon("camera_off", { muted: mutedRef.current });
    }
    sessionManager.sendEvent("stop");
  }, [cameraController, sessionManager]);

  const wipeAllData = useCallback((): void => {
    hardwareRunningRef.current = false;
    managerBundleRef.current?.disposeCheckingPulse();
    cameraController.stop();
    audioBridgeRef.current?.stopMic?.();
    audioBridgeRef.current?.flushPlayback?.();
    cancelSpeech();
    sessionManager.stopSession();

    wipeAllLocalData(storage);

    const emptyProfile: Profile = {
      meds: [],
      allergies: [],
      avoid: [],
      doseLog: [],
      lang: "en"
    };
    const clearedConsent: ConsentRecord = {
      accepted: false,
      acceptedAt: null,
      version: CONSENT_VERSION
    };
    const defaultSource = resolveDefaultCameraSource(hasBrowserCameraApi());

    profileRef.current = emptyProfile;
    consentRef.current = clearedConsent;
    themeRef.current = "dark";
    mutedRef.current = false;
    chaosRef.current = { ...DEFAULT_CHAOS };
    activeScenarioIdRef.current = DEMO_SCENARIOS[0].id;
    sourceRef.current = defaultSource;

    setProfile(emptyProfile);
    setConsent(clearedConsent);
    setTheme("dark");
    syncDocumentTheme("dark");
    setMutedState(false);
    setChaosState({ ...DEFAULT_CHAOS });
    setActiveScenarioId(DEMO_SCENARIOS[0].id);
    setSourceState(defaultSource);
    setPrivacyModalOpen(false);
    setHudDismissed(false);
    setSessionId(createEphemeralSessionId());

    announceAssertive("All local data deleted from this device.");
  }, [announceAssertive, cameraController, sessionManager, storage]);

  const changeTheme = useCallback(
    (next: ThemeMode): void => {
      themeRef.current = next;
      setTheme(next);
      saveTheme(next, storage);
      syncDocumentTheme(next);
      announcePolite(`Theme set to ${next}.`);
    },
    [announcePolite, storage]
  );

  const cycleTheme = useCallback((): ThemeMode => {
    const next = cycleThemeMode(themeRef.current);
    changeTheme(next);
    return next;
  }, [changeTheme]);

  const setMuted = useCallback(
    (next: boolean): void => {
      mutedRef.current = next;
      setMutedState(next);
      saveStoredMuted(next, storage);
      if (next) {
        audioBridgeRef.current?.flushPlayback?.();
        cancelSpeech();
      }
      managerBundleRef.current?.refreshCheckingPulseMute(
        sessionManager.getSnapshot().checking
      );
      announcePolite(next ? "Audio muted." : "Audio unmuted.");
    },
    [announcePolite, sessionManager, storage]
  );

  const toggleMute = useCallback((): boolean => {
    const next = !mutedRef.current;
    setMuted(next);
    return next;
  }, [setMuted]);

  const changeSource = useCallback(
    (next: CameraSource): void => {
      sourceRef.current = next;
      setSourceState(next);
      saveStoredSource(next, storage);

      if (next !== "phone") {
        cameraController.stop();
      }

      if (sessionManager.getSnapshot().cameraActive && next !== "demo") {
        sessionManager.startSession({
          voice: true,
          preferredSource: next === "glasses" ? "glasses" : "phone"
        });
      }

      const label =
        next === "glasses"
          ? "Switched to glasses camera."
          : next === "demo"
            ? "Switched to demo props."
            : "Switched to phone camera.";
      announcePolite(label);
    },
    [announcePolite, cameraController, sessionManager, storage]
  );

  const selectScenario = useCallback(
    (id: DemoScenarioId): DemoScenario => {
      const scenario = getDemoScenario(id);
      activeScenarioIdRef.current = id;
      setActiveScenarioId(id);
      saveStoredScenarioId(id, storage);

      if (sourceRef.current !== "demo") {
        sourceRef.current = "demo";
        setSourceState("demo");
        saveStoredSource("demo", storage);
        cameraController.stop();
      }

      announcePolite(`Selected demo prop: ${scenario.title}.`);
      return scenario;
    },
    [announcePolite, cameraController, storage]
  );

  const startCheck = useCallback(async (): Promise<void> => {
    cancelSpeech();
    try {
      await audioBridgeRef.current?.resumePlayback?.();
    } catch {
      void 0;
    }

    let currentSource = sourceRef.current;
    if (currentSource === "phone" && videoRef.current) {
      const camRes = await cameraController.startPhoneCamera(videoRef.current);
      if (camRes.ok) {
        sessionManager.setPermissions({ camera: "granted" });
      } else {
        sessionManager.setPermissions({ camera: camRes.status });
        if (camRes.status === "denied") {
          announceAssertive(camRes.message);
          return;
        }
        currentSource = "demo";
        sourceRef.current = "demo";
        setSourceState("demo");
        saveStoredSource("demo", storage);
        announcePolite(`${camRes.message} Switched to demo props.`);
      }
    } else if (currentSource !== "phone") {
      cameraController.stop();
    }

    hardwareRunningRef.current = true;
    playEarcon("camera_on", { muted: mutedRef.current });

    const preferredSource: "phone" | "glasses" =
      currentSource === "glasses" ? "glasses" : "phone";
    sessionManager.startSession({ voice: true, preferredSource });

    if (audioBridgeRef.current?.startMic) {
      try {
        await audioBridgeRef.current.startMic((b64) => {
          if (!mutedRef.current) {
            sessionManager.sendAudio(b64);
          }
        });
        sessionManager.setPermissions({ microphone: "granted" });
      } catch (err) {
        const classified = classifyMediaError(err);
        sessionManager.setPermissions({ microphone: classified.status });
      }
    }
  }, [announceAssertive, announcePolite, cameraController, sessionManager, storage]);

  const toggleCheck = useCallback(async (): Promise<void> => {
    if (sessionManager.getSnapshot().cameraActive) {
      stopCheck();
    } else {
      await startCheck();
    }
  }, [sessionManager, startCheck, stopCheck]);

  const snapshotVerify = useCallback(
    async (question?: string): Promise<Verdict | null> => {
      try {
        await audioBridgeRef.current?.resumePlayback?.();
      } catch {
        void 0;
      }

      let tempCameraStarted = false;
      if (
        sourceRef.current === "phone" &&
        videoRef.current &&
        !cameraController.active
      ) {
        const camRes = await cameraController.startPhoneCamera(videoRef.current);
        if (camRes.ok) {
          tempCameraStarted = true;
          sessionManager.setPermissions({ camera: "granted" });
        } else {
          sessionManager.setPermissions({ camera: camRes.status });
        }
      }

      try {
        const freshFrame = await captureCurrentFrame();
        if (freshFrame && sessionManager.getSnapshot().cameraActive) {
          sessionManager.sendFrame(freshFrame);
        }
        const buffered = sessionManager.getBufferedFrames();
        const frames = freshFrame ? [...buffered, freshFrame.data] : [...buffered];
        const resolvedQuestion =
          question?.trim() ||
          (sourceRef.current === "demo"
            ? getDemoScenario(activeScenarioIdRef.current).question
            : undefined);

        return await sessionManager.verifySnapshot(frames, resolvedQuestion);
      } finally {
        if (tempCameraStarted && !sessionManager.getSnapshot().cameraActive) {
          cameraController.stop();
        }
      }
    },
    [cameraController, captureCurrentFrame, sessionManager]
  );

  const offlineBarcodeScan = useCallback(
    async (explicitBarcode?: string): Promise<Verdict> => {
      try {
        await audioBridgeRef.current?.resumePlayback?.();
      } catch {
        void 0;
      }

      let rawBarcode = typeof explicitBarcode === "string" ? explicitBarcode.trim() : "";

      if (!rawBarcode) {
        if (sourceRef.current === "phone" && videoRef.current) {
          const detected = await detectBarcodeFromElement(videoRef.current);
          rawBarcode = detected ?? "";
        } else if (sourceRef.current === "demo") {
          const detected = demoImageRef.current
            ? await detectBarcodeFromElement(demoImageRef.current)
            : null;
          rawBarcode =
            detected ?? getDemoScenario(activeScenarioIdRef.current).barcode ?? "";
        } else if (videoRef.current) {
          const detected = await detectBarcodeFromElement(videoRef.current);
          rawBarcode = detected ?? "";
        }
      }

      const verdict = offlineBarcodeVerdict(rawBarcode, profileRef.current);
      localVerdictModeOverrideRef.current = "offline";
      try {
        sessionManager.applyLocalVerdict(verdict);
      } finally {
        localVerdictModeOverrideRef.current = null;
      }
      return verdict;
    },
    [sessionManager]
  );

  const submitQuestion = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      try {
        await audioBridgeRef.current?.resumePlayback?.();
      } catch {
        void 0;
      }

      const snap = sessionManager.getSnapshot();
      const liveWsOpen = snap.mode === "live" && snap.liveState === "open";

      if (!liveWsOpen && snap.network.online) {
        const freshFrame = await captureCurrentFrame();
        if (freshFrame) {
          if (snap.cameraActive) {
            sessionManager.sendFrame(freshFrame);
          } else if (sessionManager.getBufferedFrames().length === 0) {
            await sessionManager.verifySnapshot([freshFrame.data], trimmed);
            return;
          }
        }
      }

      await sessionManager.sendQuestion(trimmed);
    },
    [captureCurrentFrame, sessionManager]
  );

  const logDose = useCallback(
    (medId?: string): Profile | null => {
      const snap = sessionManager.getSnapshot();
      const currentVerdict = snap.verdict;
      const explicitId = typeof medId === "string" ? medId.trim() : "";

      if (!explicitId) {
        if (!currentVerdict?.matchedMedId) {
          announcePolite("No matched medication to log right now.");
          return null;
        }
        if (currentVerdict.level === "warning" && currentVerdict.takenToday) {
          announcePolite("Dose already logged today.");
          return null;
        }
      }

      const targetId = explicitId || currentVerdict?.matchedMedId?.trim() || "";
      if (!targetId) {
        announcePolite("No matched medication to log right now.");
        return null;
      }

      const nextProfile = appendDoseLog(profileRef.current, targetId, Date.now(), storage);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      sessionManager.updateProfile(nextProfile);

      const liveOpen = snap.mode === "live" && snap.liveState === "open";
      if (liveOpen && currentVerdict?.matchedMedId === targetId) {
        sessionManager.sendEvent("log_dose");
      } else if (currentVerdict?.matchedMedId === targetId && !currentVerdict.takenToday) {
        silentVerdictUpdateRef.current = true;
        try {
          sessionManager.applyLocalVerdict({ ...currentVerdict, takenToday: true });
        } finally {
          silentVerdictUpdateRef.current = false;
        }
      }

      const med = nextProfile.meds.find((item) => item.id === targetId);
      playEarcon("info", { muted: mutedRef.current });
      announcePolite(med ? `Dose logged for ${med.name}.` : "Dose logged.");
      return nextProfile;
    },
    [announcePolite, sessionManager, storage]
  );

  const undoDose = useCallback((): Profile => {
    const previousLast = profileRef.current.doseLog.at(-1);
    const nextProfile = undoLastDose(profileRef.current, storage);
    profileRef.current = nextProfile;
    setProfile(nextProfile);
    sessionManager.updateProfile(nextProfile);

    if (!previousLast) {
      announcePolite("No logged doses to undo.");
      return nextProfile;
    }

    const snap = sessionManager.getSnapshot();
    const liveOpen = snap.mode === "live" && snap.liveState === "open";
    if (!liveOpen && snap.verdict?.matchedMedId === previousLast.medId) {
      const stillTaken = hasDoseLoggedToday(nextProfile, previousLast.medId);
      if (snap.verdict.takenToday !== stillTaken) {
        silentVerdictUpdateRef.current = true;
        try {
          sessionManager.applyLocalVerdict({ ...snap.verdict, takenToday: stillTaken });
        } finally {
          silentVerdictUpdateRef.current = false;
        }
      }
    }

    const med = nextProfile.meds.find((item) => item.id === previousLast.medId);
    announcePolite(
      med ? `Removed last logged dose for ${med.name}.` : "Removed last logged dose."
    );
    return nextProfile;
  }, [announcePolite, sessionManager, storage]);

  const repeatLastVerdict = useCallback((): void => {
    const snap = sessionManager.getSnapshot();
    if (snap.verdict) {
      sessionManager.sendEvent("repeat");
      return;
    }
    if (snap.coach) {
      playEarcon("cue", { muted: mutedRef.current });
      announcePolite(snap.coach.text);
      if (!mutedRef.current && !(snap.mode === "live" && snap.liveState === "open")) {
        void speakFallback(snap.coach.text, {
          lang: profileRef.current.lang || "en",
          preferServerTts: false,
          fetchImpl: fetchImplRef.current
        });
      }
      return;
    }
    announcePolite("Nothing to repeat yet. Hold up a label and start a check.");
  }, [announcePolite, sessionManager]);

  const setChaos = useCallback(
    (next: ChaosConfig | ((prev: ChaosConfig) => ChaosConfig)): void => {
      const resolved = typeof next === "function" ? next(chaosRef.current) : next;
      const copy: ChaosConfig = {
        forceWsDrop: Boolean(resolved.forceWsDrop),
        forceOffline: Boolean(resolved.forceOffline),
        simulateGlassesDoffed: Boolean(resolved.simulateGlassesDoffed),
        simulateLowBattery: Boolean(resolved.simulateLowBattery)
      };
      chaosRef.current = copy;
      setChaosState(copy);
      saveStoredChaos(copy, storage);
      sessionManager.setChaos(copy);
    },
    [sessionManager, storage]
  );

  const triggerHudEvent = useCallback(
    (name: HudEventName): void => {
      if (name === "repeat") {
        repeatLastVerdict();
        return;
      }
      if (name === "log_dose") {
        logDose();
        return;
      }
      if (name === "stop") {
        stopCheck();
        return;
      }
      setHudDismissed(true);
      playEarcon("cue", { muted: mutedRef.current });
      announcePolite("HUD card dismissed.");
    },
    [announcePolite, logDose, repeatLastVerdict, stopCheck]
  );

  const openPrivacyModal = useCallback((): void => {
    setPrivacyModalOpen(true);
    announcePolite("Privacy and local data controls opened.");
  }, [announcePolite]);

  const closePrivacyModal = useCallback((): void => {
    setPrivacyModalOpen(false);
    announcePolite("Privacy and local data controls closed.");
  }, [announcePolite]);

  const getCaregiverSummary = useCallback(
    (now?: Date): string => exportCaregiverSummary(profileRef.current, now),
    []
  );

  const handleShortcut = useCallback(
    (action: ShortcutAction): void => {
      if (
        !consentRef.current.accepted &&
        action !== "cycle_theme" &&
        action !== "open_privacy"
      ) {
        announcePolite("Accept privacy consent before starting a label check.");
        return;
      }
      dispatchControllerShortcut(action, {
        isCheckingActive: () => sessionManager.getSnapshot().cameraActive,
        startCheck,
        stopCheck,
        snapshotVerify,
        offlineBarcodeScan,
        logDose,
        repeatLastVerdict,
        cycleTheme,
        openPrivacy: openPrivacyModal
      });
    },
    [
      announcePolite,
      cycleTheme,
      logDose,
      offlineBarcodeScan,
      openPrivacyModal,
      repeatLastVerdict,
      sessionManager,
      snapshotVerify,
      startCheck,
      stopCheck
    ]
  );

  useKeyboardShortcuts(handleShortcut, true);

  return {
    sessionId,
    snapshot,
    sessionManager,
    profile,
    consent,
    theme,
    muted,
    chaos,
    source,
    activeScenarioId,
    activeScenario,
    scenarios: DEMO_SCENARIOS,
    privacyModalOpen,
    hudDismissed,
    videoRef,
    demoImageRef,
    cameraController,
    politeMessage: announcer.politeMessage,
    politeSeq: announcer.politeSeq,
    assertiveMessage: announcer.assertiveMessage,
    assertiveSeq: announcer.assertiveSeq,
    announcer,
    acceptConsent,
    updateProfile,
    resetDemoProfile,
    wipeAllData,
    changeTheme,
    cycleTheme,
    toggleMute,
    setMuted,
    changeSource,
    selectScenario,
    startCheck,
    stopCheck,
    toggleCheck,
    snapshotVerify,
    offlineBarcodeScan,
    submitQuestion,
    logDose,
    undoDose,
    repeatLastVerdict,
    setChaos,
    triggerHudEvent,
    setPrivacyModalOpen,
    openPrivacyModal,
    closePrivacyModal,
    getCaregiverSummary
  };
}
