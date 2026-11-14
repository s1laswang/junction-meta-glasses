import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { ScreenReaderAnnouncer } from "./a11y/announcer.tsx";
import {
  DEFAULT_READING_COMFORT,
  loadReadingComfort,
  saveReadingComfort,
  type ReadingComfortPrefs
} from "./a11y/readingComfort.ts";
import { createLiveAudioBridge } from "./audio/player.ts";
import { cancelSpeech, speakFallback } from "./audio/tts.ts";
import { estimateJpegByteSharpness } from "./camera/fixtureLoader.ts";
import { AppHeader, type AppTab } from "./components/AppHeader.tsx";
import { BrailleStickerGuardCard } from "./components/BrailleStickerGuardCard.tsx";
import { CaregiverAlertCard } from "./components/CaregiverAlertCard.tsx";
import { CognitiveRoutineCard } from "./components/CognitiveRoutineCard.tsx";
import { ConfidenceBreakdownCard } from "./components/ConfidenceBreakdownCard.tsx";
import { ConsentOnboarding } from "./components/ConsentOnboarding.tsx";
import { ConversationBar } from "./components/ConversationBar.tsx";
import { DeviceResiliencePanel } from "./components/DeviceResiliencePanel.tsx";
import { DoseTimelineCard } from "./components/DoseTimelineCard.tsx";
import { EmergencyMedCard } from "./components/EmergencyMedCard.tsx";
import { EvalProofCard } from "./components/EvalProofCard.tsx";
import { FrameReadinessMeter } from "./components/FrameReadinessMeter.tsx";
import { HardwareTelemetryCard } from "./components/HardwareTelemetryCard.tsx";
import {
  JudgeDemoTour,
  type TourStepAction,
  type TourStepId
} from "./components/JudgeDemoTour.tsx";
import { LanguageVoiceSupportCard } from "./components/LanguageVoiceSupportCard.tsx";
import { OfflineReadinessCard } from "./components/OfflineReadinessCard.tsx";
import { PermissionBanner } from "./components/PermissionBanner.tsx";
import { PharmacyImportModal } from "./components/PharmacyImportModal.tsx";
import { PilotOnboardingCard } from "./components/PilotOnboardingCard.tsx";
import { PrivacyFlowCard } from "./components/PrivacyFlowCard.tsx";
import { ProfileManager } from "./components/ProfileManager.tsx";
import { ReadingComfortBar } from "./components/ReadingComfortBar.tsx";
import { SafetyRuleExplainerCard } from "./components/SafetyRuleExplainerCard.tsx";
import { ScheduleChecklistCard } from "./components/ScheduleChecklistCard.tsx";
import { ShortcutsModal } from "./components/ShortcutsModal.tsx";
import { TactileHandlingGuideCard } from "./components/TactileHandlingGuideCard.tsx";
import { VerdictCard } from "./components/VerdictCard.tsx";
import { ViewfinderStage } from "./components/ViewfinderStage.tsx";
import { VoiceActivityPill } from "./components/VoiceActivityPill.tsx";
import { VoiceCommandCheatSheetCard } from "./components/VoiceCommandCheatSheetCard.tsx";
import { WhyGlassesComparisonCard } from "./components/WhyGlassesComparisonCard.tsx";
import { HudApp } from "./hud/HudApp.tsx";
import { HudPreviewFrame } from "./hud/HudPreviewFrame.tsx";
import { buildBridgeDeepLink, buildHudUrl } from "./pairing/links.ts";
import { encodeQrSvg } from "./pairing/qrSvg.ts";
import { resolveAppRoute, type ResolvedRoute } from "./routing/routeResolver.ts";
import { parseLocalIntent } from "./session/localVoiceIntent.ts";
import {
  DEFAULT_CHAOS,
  useHoldUpController,
  type AudioStreamBridge,
  type HoldUpControllerOptions
} from "./session/useHoldUpController.ts";
import type { Verdict } from "./types.ts";

export type AppProps = {
  initialUrl?: string;
  controllerOptions?: HoldUpControllerOptions;
  initialVerdict?: Verdict | null;
};

const DOUBLE_SLASH = "\x2f\x2f";
const DEFAULT_PWA_URL = `http:${DOUBLE_SLASH}localhost:5173/`;
const DEFAULT_SERVER_ORIGIN = `http:${DOUBLE_SLASH}localhost:8787`;
const SPEAKING_IDLE_MS = 700;

type FooterResourceLink = {
  href: string;
  label: string;
};

const FOOTER_RESOURCE_LINKS: readonly FooterResourceLink[] = [
  { href: "/deck", label: "Pitch Deck (12 Slides)" },
  { href: "/judge-handout.html", label: "Judge Quick-Start (A4)" },
  { href: "/architecture-poster.html", label: "Architecture Poster (SVG)" },
  { href: "/printable-props.html", label: "Printable Demo Props & QR" },
  { href: "/hud", label: "Ray-Ban Display HUD (/hud)" }
];

const ROOT_WRAPPER_STYLE: CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "var(--bg-app, #0b0f17)",
  color: "var(--text-primary, #f8fafc)"
};

const MAIN_SHELL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0
};

const SHELL_CONTAINER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  width: "100%",
  maxWidth: "var(--container-max, 1280px)",
  marginInline: "auto",
  padding: "var(--space-5, 20px)",
  flex: "1 1 auto"
};

const CHECK_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
  gap: "20px",
  alignItems: "start",
  width: "100%"
};

const COLUMN_STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  minWidth: 0,
  width: "100%"
};

const FOOTER_STYLE: CSSProperties = {
  width: "100%",
  backgroundColor: "var(--bg-surface, #121926)",
  color: "var(--text-primary, #f8fafc)",
  borderTop: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
  padding: "var(--space-4, 16px) var(--space-5, 20px)"
};

const FOOTER_INNER_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3, 12px)",
  width: "100%",
  maxWidth: "var(--container-max, 1280px)",
  marginInline: "auto"
};

const FOOTER_CAPTION_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs, 0.875rem)",
  lineHeight: 1.45,
  color: "var(--text-secondary, #d8e1ee)"
};

const FOOTER_LINKS_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2, 8px)"
};

const FOOTER_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-2, 8px)",
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 16px",
  borderRadius: "var(--radius-md, 12px)",
  border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  color: "var(--text-primary, #f8fafc)",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 700,
  lineHeight: 1.25,
  textDecoration: "none",
  whiteSpace: "nowrap"
};

function decodeBase64BytesSafe(b64: string): Uint8Array {
  const payload = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1).trim() : b64.trim();
  if (payload.length === 0) {
    return new Uint8Array(0);
  }
  try {
    const nodeBuffer = (
      globalThis as unknown as {
        Buffer?: { from(input: string, encoding: "base64"): Uint8Array };
      }
    ).Buffer;
    if (nodeBuffer && typeof nodeBuffer.from === "function") {
      const buf = nodeBuffer.from(payload, "base64");
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    if (typeof globalThis.atob === "function") {
      const bin = globalThis.atob(payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
  } catch {
    const approxLen = Math.floor((payload.length * 3) / 4);
    return new Uint8Array(Math.max(0, approxLen));
  }
  const approxLen = Math.floor((payload.length * 3) / 4);
  return new Uint8Array(Math.max(0, approxLen));
}

export function resolveLatestFrameSharpness(
  bufferedFrames: readonly string[],
  cameraActive: boolean,
  source: string,
  scenarioId: string
): number | null {
  if (bufferedFrames.length > 0) {
    const latestFrame = bufferedFrames[bufferedFrames.length - 1];
    return estimateJpegByteSharpness(decodeBase64BytesSafe(latestFrame));
  }
  if (cameraActive && source === "demo") {
    return scenarioId === "blurry_strength" ? 0.14 : 0.85;
  }
  return null;
}

function toLocationLike(initialUrl?: string): { pathname: string; search: string } {
  const raw =
    typeof initialUrl === "string" && initialUrl.trim().length > 0
      ? initialUrl.trim()
      : typeof window !== "undefined" &&
          typeof window.location?.href === "string" &&
          window.location.href.length > 0
        ? window.location.href
        : DEFAULT_PWA_URL;

  try {
    const parsed = new URL(raw, DEFAULT_PWA_URL);
    return { pathname: parsed.pathname, search: parsed.search };
  } catch {
    return { pathname: "/", search: "" };
  }
}

type HoldUpPwaShellProps = {
  route: ResolvedRoute;
  controllerOptions?: HoldUpControllerOptions;
  initialVerdict?: Verdict | null;
};

function HoldUpPwaShell({
  route,
  controllerOptions,
  initialVerdict
}: HoldUpPwaShellProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<AppTab>(() => route.initialTab);
  const [pharmacyOpen, setPharmacyOpen] = useState<boolean>(() =>
    Boolean(route.rxPayloadUri)
  );
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [activeTourStep, setActiveTourStep] = useState<TourStepId | null>(null);
  const [readingComfort, setReadingComfort] = useState<ReadingComfortPrefs>(() =>
    loadReadingComfort(controllerOptions?.storage)
  );
  const [micRms, setMicRms] = useState<number>(0);
  const [assistantSpeaking, setAssistantSpeaking] = useState<boolean>(false);

  const liveAudioRef = useRef<(AudioStreamBridge & { dispose: () => void }) | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSpeakingTimer = useCallback((): void => {
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);

  const markAssistantAudioChunk = useCallback((): void => {
    setAssistantSpeaking(true);
    clearSpeakingTimer();
    const timer = setTimeout(() => {
      speakingTimerRef.current = null;
      setAssistantSpeaking(false);
    }, SPEAKING_IDLE_MS);
    const maybeNodeTimer = timer as unknown as { unref?: () => void };
    maybeNodeTimer.unref?.();
    speakingTimerRef.current = timer;
  }, [clearSpeakingTimer]);

  const getOrCreateBrowserAudio = useCallback(() => {
    if (typeof window === "undefined") {
      return null;
    }
    if (!liveAudioRef.current) {
      liveAudioRef.current = createLiveAudioBridge({
        onMicLevel: (rms) => {
          setMicRms(rms);
        }
      });
    }
    return liveAudioRef.current;
  }, []);

  const lazyBrowserAudioBridge = useMemo<AudioStreamBridge | undefined>(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    return {
      startMic: async (onChunk) => {
        await getOrCreateBrowserAudio()?.startMic?.(onChunk);
      },
      stopMic: () => {
        liveAudioRef.current?.stopMic?.();
        setMicRms(0);
      },
      enqueuePcm24k: (b64) => {
        markAssistantAudioChunk();
        getOrCreateBrowserAudio()?.enqueuePcm24k?.(b64);
      },
      flushPlayback: () => {
        clearSpeakingTimer();
        setAssistantSpeaking(false);
        liveAudioRef.current?.flushPlayback?.();
      },
      resumePlayback: async () => {
        await getOrCreateBrowserAudio()?.resumePlayback?.();
      }
    };
  }, [clearSpeakingTimer, getOrCreateBrowserAudio, markAssistantAudioChunk]);

  useEffect(() => {
    return () => {
      clearSpeakingTimer();
      liveAudioRef.current?.dispose();
      liveAudioRef.current = null;
    };
  }, [clearSpeakingTimer]);

  const wrappedExternalAudioBridge = useMemo<AudioStreamBridge | undefined>(() => {
    const ext = controllerOptions?.audioBridge;
    if (!ext) {
      return undefined;
    }
    return {
      startMic: ext.startMic
        ? async (onChunk) => {
            await ext.startMic?.(onChunk);
          }
        : undefined,
      stopMic: () => {
        ext.stopMic?.();
        setMicRms(0);
      },
      enqueuePcm24k: (b64) => {
        markAssistantAudioChunk();
        ext.enqueuePcm24k?.(b64);
      },
      flushPlayback: () => {
        clearSpeakingTimer();
        setAssistantSpeaking(false);
        ext.flushPlayback?.();
      },
      resumePlayback: ext.resumePlayback
        ? async () => {
            await ext.resumePlayback?.();
          }
        : undefined
    };
  }, [clearSpeakingTimer, controllerOptions?.audioBridge, markAssistantAudioChunk]);

  const mergedControllerOptions = useMemo<HoldUpControllerOptions>(
    () => ({
      ...controllerOptions,
      audioBridge: wrappedExternalAudioBridge ?? lazyBrowserAudioBridge
    }),
    [controllerOptions, lazyBrowserAudioBridge, wrappedExternalAudioBridge]
  );

  const ctrl = useHoldUpController(mergedControllerOptions);

  const handleInterruptSpeech = useCallback((): void => {
    clearSpeakingTimer();
    setAssistantSpeaking(false);
    controllerOptions?.audioBridge?.flushPlayback?.();
    liveAudioRef.current?.flushPlayback?.();
    cancelSpeech();
  }, [clearSpeakingTimer, controllerOptions?.audioBridge]);

  const appliedInitialRouteRef = useRef<boolean>(false);

  useEffect(() => {
    if (appliedInitialRouteRef.current) {
      return;
    }
    appliedInitialRouteRef.current = true;

    if (route.themeParam) {
      ctrl.changeTheme(route.themeParam);
    }
    if (route.scenarioParam) {
      ctrl.selectScenario(route.scenarioParam);
      ctrl.changeSource("demo");
    }
    if (route.langParam) {
      const nextLang = route.langParam;
      ctrl.updateProfile((prev) =>
        prev.lang === nextLang ? prev : { ...prev, lang: nextLang }
      );
    }
    if (route.rxPayloadUri) {
      setPharmacyOpen(true);
    }
  }, [ctrl, route]);

  const effectiveTheme =
    !appliedInitialRouteRef.current && route.themeParam ? route.themeParam : ctrl.theme;
  const effectiveLang =
    !appliedInitialRouteRef.current && route.langParam
      ? route.langParam
      : ctrl.profile.lang;
  const effectiveProfile = useMemo(
    () =>
      effectiveLang !== ctrl.profile.lang
        ? { ...ctrl.profile, lang: effectiveLang }
        : ctrl.profile,
    [ctrl.profile, effectiveLang]
  );
  const effectiveSource =
    !appliedInitialRouteRef.current && route.scenarioParam ? "demo" : ctrl.source;
  const effectiveScenarioId =
    !appliedInitialRouteRef.current && route.scenarioParam
      ? route.scenarioParam
      : ctrl.activeScenarioId;

  const handleChangeLang = useCallback(
    (nextLang: string): void => {
      ctrl.updateProfile((prev) =>
        prev.lang === nextLang ? prev : { ...prev, lang: nextLang }
      );
    },
    [ctrl]
  );

  const handleOpenPharmacyImport = useCallback((): void => {
    setPharmacyOpen(true);
  }, []);

  const handleRunTourStep = useCallback(
    (step: TourStepAction): void => {
      setActiveTourStep(step.id);
      ctrl.changeSource("demo");
      ctrl.selectScenario(step.scenarioId);
      ctrl.setChaos({ ...DEFAULT_CHAOS, ...step.chaosPatch });
      setActiveTab("check");
      if (step.modeAction === "offline_barcode") {
        void ctrl.offlineBarcodeScan();
      } else {
        void ctrl.snapshotVerify();
      }
    },
    [ctrl]
  );

  const handleSubmitConversation = useCallback(
    (rawQuestion: string): void => {
      const intent = parseLocalIntent(rawQuestion);
      if (intent.kind === "question") {
        void ctrl.submitQuestion(intent.text);
        return;
      }
      if (intent.kind === "log_dose") {
        ctrl.logDose();
        return;
      }
      if (intent.kind === "repeat") {
        ctrl.repeatLastVerdict();
        return;
      }
      if (intent.kind === "stop") {
        ctrl.stopCheck();
        return;
      }
      void ctrl.offlineBarcodeScan();
    },
    [ctrl]
  );

  const serverOrigin =
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string" &&
    window.location.origin.length > 0
      ? window.location.origin
      : DEFAULT_SERVER_ORIGIN;

  const pairingArtifacts = useMemo(() => {
    if (activeTab !== "device") {
      return null;
    }
    const bridgeLink = buildBridgeDeepLink(serverOrigin, ctrl.sessionId);
    const hudUrl = buildHudUrl(serverOrigin, ctrl.sessionId);
    const bridgeQrSvg = encodeQrSvg(bridgeLink, {
      title: "HoldUp Android DAT Bridge QR"
    });
    const hudQrSvg = encodeQrSvg(hudUrl, {
      title: "Ray-Ban Display HUD QR"
    });
    return { bridgeLink, hudUrl, bridgeQrSvg, hudQrSvg };
  }, [activeTab, ctrl.sessionId, serverOrigin]);

  const bufferedFrames = ctrl.sessionManager.getBufferedFrames();
  const latestBufferedFrame =
    bufferedFrames.length > 0 ? bufferedFrames[bufferedFrames.length - 1] : null;
  const latestSharpness = useMemo<number | null>(
    () =>
      resolveLatestFrameSharpness(
        latestBufferedFrame !== null ? [latestBufferedFrame] : [],
        ctrl.snapshot.cameraActive,
        effectiveSource,
        effectiveScenarioId
      ),
    [
      ctrl.snapshot.cameraActive,
      effectiveScenarioId,
      effectiveSource,
      latestBufferedFrame
    ]
  );

  const effectiveVerdict = ctrl.snapshot.verdict ?? initialVerdict ?? null;
  const hudPreviewVerdict = ctrl.hudDismissed ? null : effectiveVerdict;
  const hudPreviewCoach = ctrl.hudDismissed ? null : ctrl.snapshot.coach;

  const handleChangeReadingComfort = useCallback(
    (next: ReadingComfortPrefs): void => {
      const saved = saveReadingComfort(next, controllerOptions?.storage);
      setReadingComfort(saved);
    },
    [controllerOptions?.storage]
  );

  const handleWipeAllData = useCallback((): void => {
    ctrl.wipeAllData();
    setReadingComfort({ ...DEFAULT_READING_COMFORT });
  }, [ctrl]);

  return (
    <div
      data-theme={effectiveTheme}
      data-text-scale={readingComfort.textScale}
      data-cognitive-density={readingComfort.density}
      style={ROOT_WRAPPER_STYLE}
    >
      <ScreenReaderAnnouncer
        politeMessage={ctrl.politeMessage}
        politeSeq={ctrl.politeSeq}
        assertiveMessage={ctrl.assertiveMessage}
        assertiveSeq={ctrl.assertiveSeq}
      />

      <AppHeader
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        theme={effectiveTheme}
        onChangeTheme={ctrl.changeTheme}
        muted={ctrl.muted}
        onToggleMute={() => {
          ctrl.toggleMute();
        }}
        lang={effectiveLang}
        onChangeLang={handleChangeLang}
        mode={ctrl.snapshot.mode}
        hudConnected={ctrl.snapshot.hudConnected}
        medCount={effectiveProfile.meds.length}
        onOpenPrivacy={ctrl.openPrivacyModal}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />

      <main
        id="main-content"
        className="app-shell"
        tabIndex={-1}
        style={MAIN_SHELL_STYLE}
      >
        <div style={SHELL_CONTAINER_STYLE}>
          {!ctrl.consent.accepted && !ctrl.privacyModalOpen ? (
            <ConsentOnboarding
              lang={effectiveLang}
              consent={ctrl.consent}
              profileMedCount={effectiveProfile.meds.length}
              onAccept={() => {
                ctrl.acceptConsent();
              }}
              onResetDemoProfile={() => {
                ctrl.resetDemoProfile();
              }}
              onWipeAllData={handleWipeAllData}
            />
          ) : null}

          <ReadingComfortBar
            prefs={readingComfort}
            lang={effectiveLang}
            storage={controllerOptions?.storage}
            onChange={handleChangeReadingComfort}
          />

          <div className="cognitive-secondary">
            <JudgeDemoTour
              lang={effectiveLang}
              activeStep={activeTourStep}
              onRunStep={handleRunTourStep}
            />
          </div>

          <PermissionBanner
            permissions={ctrl.snapshot.permissions}
            currentSource={effectiveSource}
            lastError={ctrl.snapshot.lastError}
            lang={effectiveLang}
            onUseSnapshotMode={() => {
              ctrl.stopCheck();
              void ctrl.snapshotVerify();
            }}
            onUseDemoProps={() => {
              ctrl.changeSource("demo");
            }}
            onRetryPermissions={() => {
              void ctrl.startCheck();
            }}
          />

          {activeTab === "check" ? (
            <div
              id="panel-check"
              role="tabpanel"
              aria-labelledby="tab-check"
              className="check-grid"
              style={CHECK_GRID_STYLE}
            >
              <div style={COLUMN_STACK_STYLE}>
                <ViewfinderStage
                  cameraActive={ctrl.snapshot.cameraActive}
                  source={effectiveSource}
                  onChangeSource={ctrl.changeSource}
                  mode={ctrl.snapshot.mode}
                  coach={ctrl.snapshot.coach}
                  checking={ctrl.snapshot.checking}
                  autoStopRemainingSec={ctrl.snapshot.autoStopRemainingSec}
                  glassesConnected={ctrl.snapshot.device.connected}
                  glassesWorn={ctrl.snapshot.device.worn}
                  videoRef={ctrl.videoRef}
                  demoImgRef={ctrl.demoImageRef}
                  scenarios={ctrl.scenarios}
                  activeScenarioId={effectiveScenarioId}
                  onSelectScenario={(id) => {
                    ctrl.selectScenario(id);
                  }}
                  onStart={() => {
                    void ctrl.startCheck();
                  }}
                  onStop={ctrl.stopCheck}
                  onSnapshotVerify={() => {
                    void ctrl.snapshotVerify();
                  }}
                  onOfflineBarcodeScan={() => {
                    void ctrl.offlineBarcodeScan();
                  }}
                  lang={effectiveLang}
                />

                <FrameReadinessMeter
                  cameraActive={ctrl.snapshot.cameraActive}
                  checking={ctrl.snapshot.checking}
                  sharpness={latestSharpness}
                  bufferedFrames={bufferedFrames.length}
                  coach={ctrl.snapshot.coach}
                  lang={effectiveLang}
                />

                <VoiceActivityPill
                  cameraActive={ctrl.snapshot.cameraActive}
                  mode={ctrl.snapshot.mode}
                  live={ctrl.snapshot.liveState}
                  muted={ctrl.muted}
                  assistantSpeaking={assistantSpeaking}
                  micRms={micRms}
                  lang={effectiveLang}
                  onInterruptSpeech={handleInterruptSpeech}
                />

                <ConversationBar
                  transcripts={ctrl.snapshot.transcripts}
                  mode={ctrl.snapshot.mode}
                  lang={effectiveLang}
                  onSubmitQuestion={handleSubmitConversation}
                />

                <div className="cognitive-secondary">
                  <VoiceCommandCheatSheetCard
                    lang={effectiveLang}
                    onRunPhrase={handleSubmitConversation}
                    onTriggerHudGesture={(event) => {
                      ctrl.triggerHudEvent(event);
                    }}
                  />
                </div>

                <div className="cognitive-secondary">
                  <TactileHandlingGuideCard
                    lang={effectiveLang}
                    activeCue={ctrl.snapshot.coach?.cue ?? null}
                    onSpeakTip={(tip) => {
                      if (!ctrl.muted) {
                        void speakFallback(tip, {
                          lang: effectiveLang,
                          preferServerTts: false
                        });
                      }
                    }}
                  />
                </div>
              </div>

              <div style={COLUMN_STACK_STYLE}>
                <VerdictCard
                  verdict={effectiveVerdict}
                  checking={ctrl.snapshot.checking}
                  mode={ctrl.snapshot.mode}
                  lang={effectiveLang}
                  onLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
                  onRepeat={ctrl.repeatLastVerdict}
                />

                <div className="cognitive-secondary">
                  <ConfidenceBreakdownCard
                    verdict={effectiveVerdict}
                    lang={effectiveLang}
                  />
                </div>

                <ScheduleChecklistCard
                  profile={effectiveProfile}
                  lang={effectiveLang}
                  onVerifyMed={() => {
                    void ctrl.startCheck();
                  }}
                  onLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
                />

                <div className="cognitive-secondary">
                  <HudPreviewFrame
                    verdict={hudPreviewVerdict}
                    coach={hudPreviewCoach}
                    checking={ctrl.snapshot.checking}
                    device={ctrl.snapshot.device}
                    hudSocketConnected={ctrl.snapshot.hudConnected}
                    onTriggerHudEvent={(name) => {
                      ctrl.triggerHudEvent(name);
                    }}
                  />
                </div>

                <CaregiverAlertCard
                  profile={effectiveProfile}
                  lastVerdict={effectiveVerdict}
                  lang={effectiveLang}
                  onQuickLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
                />

                <CognitiveRoutineCard
                  profile={effectiveProfile}
                  cameraActive={ctrl.snapshot.cameraActive}
                  lastVerdict={effectiveVerdict}
                  lang={effectiveLang}
                  onStartCheck={() => {
                    void ctrl.startCheck();
                  }}
                  onLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
                  onRepeatVerdict={ctrl.repeatLastVerdict}
                />
              </div>
            </div>
          ) : null}

          {activeTab === "profile" ? (
            <div
              id="panel-profile"
              role="tabpanel"
              aria-labelledby="tab-profile"
              style={COLUMN_STACK_STYLE}
            >
              <ScheduleChecklistCard
                profile={effectiveProfile}
                lang={effectiveLang}
                onVerifyMed={() => {
                  setActiveTab("check");
                  void ctrl.startCheck();
                }}
                onLogDose={(medId) => {
                  ctrl.logDose(medId);
                }}
              />

              <DoseTimelineCard
                profile={effectiveProfile}
                lang={effectiveLang}
                onUndoLastDose={() => {
                  ctrl.undoDose();
                }}
              />

              <SafetyRuleExplainerCard
                profile={effectiveProfile}
                lang={effectiveLang}
              />

              <ProfileManager
                profile={effectiveProfile}
                onChange={(next) => {
                  ctrl.updateProfile(next);
                }}
                onResetDemo={() => {
                  ctrl.resetDemoProfile();
                }}
                onUndoLastDose={() => {
                  ctrl.undoDose();
                }}
                caregiverSummaryText={ctrl.getCaregiverSummary()}
                onOpenPharmacyImport={handleOpenPharmacyImport}
              />

              <CaregiverAlertCard
                profile={effectiveProfile}
                lastVerdict={effectiveVerdict}
                lang={effectiveLang}
                onQuickLogDose={(medId) => {
                  ctrl.logDose(medId);
                }}
              />

              <EmergencyMedCard
                profile={effectiveProfile}
                lang={effectiveLang}
              />

              <LanguageVoiceSupportCard
                activeLang={effectiveLang}
                muted={ctrl.muted}
                onSelectLang={handleChangeLang}
                onSpeakSample={(text, code) => {
                  if (!ctrl.muted) {
                    void speakFallback(text, {
                      lang: code,
                      preferServerTts: false
                    });
                  }
                }}
              />

              <BrailleStickerGuardCard
                lang={effectiveLang}
                onOpenPharmacyQr={handleOpenPharmacyImport}
                onSpeakGuidance={(text) => {
                  if (!ctrl.muted) {
                    void speakFallback(text, {
                      lang: effectiveLang,
                      preferServerTts: false
                    });
                  }
                }}
              />
            </div>
          ) : null}

          {activeTab === "device" && pairingArtifacts ? (
            <div
              id="panel-device"
              role="tabpanel"
              aria-labelledby="tab-device"
              style={COLUMN_STACK_STYLE}
            >
              <HardwareTelemetryCard
                device={ctrl.snapshot.device}
                hudConnected={ctrl.snapshot.hudConnected}
                mode={ctrl.snapshot.mode}
                rttMs={ctrl.snapshot.network.rttMs}
                cameraActive={ctrl.snapshot.cameraActive}
                lang={effectiveLang}
              />

              <OfflineReadinessCard
                profile={effectiveProfile}
                mode={ctrl.snapshot.mode}
                lang={effectiveLang}
                onOpenPharmacyImport={handleOpenPharmacyImport}
              />

              <PrivacyFlowCard
                profile={effectiveProfile}
                consent={ctrl.consent}
                cameraActive={ctrl.snapshot.cameraActive}
                autoStopRemainingSec={ctrl.snapshot.autoStopRemainingSec}
                device={ctrl.snapshot.device}
                lang={effectiveLang}
                onOpenPrivacyModal={ctrl.openPrivacyModal}
                onWipeAll={handleWipeAllData}
              />

              <DeviceResiliencePanel
                snapshot={ctrl.snapshot}
                chaos={ctrl.chaos}
                onChangeChaos={ctrl.setChaos}
                serverOrigin={serverOrigin}
                bridgeLink={pairingArtifacts.bridgeLink}
                hudUrl={pairingArtifacts.hudUrl}
                bridgeQrSvg={pairingArtifacts.bridgeQrSvg}
                hudQrSvg={pairingArtifacts.hudQrSvg}
              />

              <EvalProofCard
                lang={effectiveLang}
                fetchImpl={controllerOptions?.fetchImpl}
              />

              <HudPreviewFrame
                verdict={hudPreviewVerdict}
                coach={hudPreviewCoach}
                checking={ctrl.snapshot.checking}
                device={ctrl.snapshot.device}
                hudSocketConnected={ctrl.snapshot.hudConnected}
                onTriggerHudEvent={(name) => {
                  ctrl.triggerHudEvent(name);
                }}
              />

              <PilotOnboardingCard
                consentAccepted={ctrl.consent.accepted}
                device={ctrl.snapshot.device}
                cameraPerm={ctrl.snapshot.permissions.camera}
                profile={effectiveProfile}
                lang={effectiveLang}
                onOpenConsent={ctrl.openPrivacyModal}
                onOpenPharmacyQr={handleOpenPharmacyImport}
                onStartDemoTour={() => {
                  setActiveTab("check");
                }}
              />

              <WhyGlassesComparisonCard lang={effectiveLang} />
            </div>
          ) : null}
        </div>
      </main>

      <footer
        className="app-footer"
        aria-label="Submission and hardware resources"
        style={FOOTER_STYLE}
      >
        <div style={FOOTER_INNER_STYLE}>
          <p style={FOOTER_CAPTION_STYLE}>
            HoldUp: Hands-free label verification for Meta AI Glasses. Personal health profile stays on this device.
          </p>

          <div style={FOOTER_LINKS_ROW_STYLE}>
            {FOOTER_RESOURCE_LINKS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary app-footer-link"
                style={FOOTER_LINK_STYLE}
              >
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        </div>
      </footer>

      {ctrl.privacyModalOpen ? (
        <ConsentOnboarding
          isModal
          lang={effectiveLang}
          consent={ctrl.consent}
          profileMedCount={effectiveProfile.meds.length}
          onAccept={() => {
            ctrl.acceptConsent();
          }}
          onClose={ctrl.closePrivacyModal}
          onResetDemoProfile={() => {
            ctrl.resetDemoProfile();
          }}
          onWipeAllData={handleWipeAllData}
        />
      ) : null}

      <ShortcutsModal
        open={shortcutsOpen}
        lang={effectiveLang}
        muted={ctrl.muted}
        onClose={() => setShortcutsOpen(false)}
      />

      <PharmacyImportModal
        open={pharmacyOpen}
        profile={effectiveProfile}
        lang={effectiveLang}
        onImportProfile={(next) => {
          ctrl.updateProfile(next);
          setPharmacyOpen(false);
        }}
        onClose={() => setPharmacyOpen(false)}
      />
    </div>
  );
}

export function App(): React.JSX.Element;
export function App(props: AppProps): React.JSX.Element;
export function App(props?: AppProps): React.JSX.Element {
  const route = resolveAppRoute(toLocationLike(props?.initialUrl));

  if (route.surface === "hud") {
    return <HudApp sessionParam={route.sessionParam} speak={route.hudSpeak} />;
  }

  return (
    <HoldUpPwaShell
      route={route}
      controllerOptions={props?.controllerOptions}
      initialVerdict={props?.initialVerdict}
    />
  );
}

export default App;
