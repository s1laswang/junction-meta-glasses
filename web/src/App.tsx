import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { ScreenReaderAnnouncer } from "./a11y/announcer.tsx";
import { createLiveAudioBridge } from "./audio/player.ts";
import { AppHeader, type AppTab } from "./components/AppHeader.tsx";
import { CaregiverAlertCard } from "./components/CaregiverAlertCard.tsx";
import { ConsentOnboarding } from "./components/ConsentOnboarding.tsx";
import { ConversationBar } from "./components/ConversationBar.tsx";
import { DeviceResiliencePanel } from "./components/DeviceResiliencePanel.tsx";
import { EvalProofCard } from "./components/EvalProofCard.tsx";
import {
  JudgeDemoTour,
  type TourStepAction,
  type TourStepId
} from "./components/JudgeDemoTour.tsx";
import { PermissionBanner } from "./components/PermissionBanner.tsx";
import { PharmacyImportModal } from "./components/PharmacyImportModal.tsx";
import { ProfileManager } from "./components/ProfileManager.tsx";
import { ShortcutsModal } from "./components/ShortcutsModal.tsx";
import { VerdictCard } from "./components/VerdictCard.tsx";
import { ViewfinderStage } from "./components/ViewfinderStage.tsx";
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

export type AppProps = {
  initialUrl?: string;
  controllerOptions?: HoldUpControllerOptions;
};

const DOUBLE_SLASH = "\x2f\x2f";
const DEFAULT_PWA_URL = `http:${DOUBLE_SLASH}localhost:5173/`;
const DEFAULT_SERVER_ORIGIN = `http:${DOUBLE_SLASH}localhost:8787`;

const ROOT_WRAPPER_STYLE: CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "var(--bg-app, #0b0f17)",
  color: "var(--text-primary, #f8fafc)"
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
};

function HoldUpPwaShell({
  route,
  controllerOptions
}: HoldUpPwaShellProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<AppTab>(() => route.initialTab);
  const [pharmacyOpen, setPharmacyOpen] = useState<boolean>(() =>
    Boolean(route.rxPayloadUri)
  );
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [activeTourStep, setActiveTourStep] = useState<TourStepId | null>(null);

  const liveAudioRef = useRef<(AudioStreamBridge & { dispose: () => void }) | null>(null);

  const getOrCreateBrowserAudio = useCallback(() => {
    if (typeof window === "undefined") {
      return null;
    }
    if (!liveAudioRef.current) {
      liveAudioRef.current = createLiveAudioBridge();
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
      },
      enqueuePcm24k: (b64) => {
        getOrCreateBrowserAudio()?.enqueuePcm24k?.(b64);
      },
      flushPlayback: () => {
        liveAudioRef.current?.flushPlayback?.();
      },
      resumePlayback: async () => {
        await getOrCreateBrowserAudio()?.resumePlayback?.();
      }
    };
  }, [getOrCreateBrowserAudio]);

  useEffect(() => {
    return () => {
      liveAudioRef.current?.dispose();
      liveAudioRef.current = null;
    };
  }, []);

  const mergedControllerOptions = useMemo<HoldUpControllerOptions>(
    () => ({
      ...controllerOptions,
      audioBridge: controllerOptions?.audioBridge ?? lazyBrowserAudioBridge
    }),
    [controllerOptions, lazyBrowserAudioBridge]
  );

  const ctrl = useHoldUpController(mergedControllerOptions);

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

  const hudPreviewVerdict = ctrl.hudDismissed ? null : ctrl.snapshot.verdict;
  const hudPreviewCoach = ctrl.hudDismissed ? null : ctrl.snapshot.coach;

  return (
    <div data-theme={effectiveTheme} style={ROOT_WRAPPER_STYLE}>
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
        onChangeLang={(nextLang) => {
          ctrl.updateProfile((prev) => ({ ...prev, lang: nextLang }));
        }}
        mode={ctrl.snapshot.mode}
        hudConnected={ctrl.snapshot.hudConnected}
        medCount={effectiveProfile.meds.length}
        onOpenPrivacy={ctrl.openPrivacyModal}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />

      <main id="main-content" className="app-shell" tabIndex={-1}>
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
              onWipeAllData={ctrl.wipeAllData}
            />
          ) : null}

          <JudgeDemoTour
            lang={effectiveLang}
            activeStep={activeTourStep}
            onRunStep={handleRunTourStep}
          />

          <PermissionBanner
            permissions={ctrl.snapshot.permissions}
            currentSource={effectiveSource}
            lastError={ctrl.snapshot.lastError}
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

                <ConversationBar
                  transcripts={ctrl.snapshot.transcripts}
                  mode={ctrl.snapshot.mode}
                  lang={effectiveLang}
                  onSubmitQuestion={handleSubmitConversation}
                />
              </div>

              <div style={COLUMN_STACK_STYLE}>
                <VerdictCard
                  verdict={ctrl.snapshot.verdict}
                  checking={ctrl.snapshot.checking}
                  mode={ctrl.snapshot.mode}
                  lang={effectiveLang}
                  onLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
                  onRepeat={ctrl.repeatLastVerdict}
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

                <CaregiverAlertCard
                  profile={effectiveProfile}
                  lastVerdict={ctrl.snapshot.verdict}
                  lang={effectiveLang}
                  onQuickLogDose={(medId) => {
                    ctrl.logDose(medId);
                  }}
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
                onOpenPharmacyImport={() => setPharmacyOpen(true)}
              />

              <CaregiverAlertCard
                profile={effectiveProfile}
                lastVerdict={ctrl.snapshot.verdict}
                lang={effectiveLang}
                onQuickLogDose={(medId) => {
                  ctrl.logDose(medId);
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
            </div>
          ) : null}
        </div>
      </main>

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
          onWipeAllData={ctrl.wipeAllData}
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
    />
  );
}

export default App;
