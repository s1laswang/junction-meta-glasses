import React, { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { cueLabel } from "../i18n/translations.ts";
import type {
  CameraSource,
  CoachCue,
  DemoScenario,
  DemoScenarioId,
  TransportMode
} from "../types.ts";

export type ViewfinderStageProps = {
  cameraActive: boolean;
  source: CameraSource;
  onChangeSource: (src: CameraSource) => void;
  mode: TransportMode;
  coach: { cue: CoachCue; text: string } | null;
  checking: boolean;
  autoStopRemainingSec: number | null;
  glassesConnected: boolean;
  glassesWorn: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  demoImgRef: React.RefObject<HTMLImageElement | null>;
  scenarios: readonly DemoScenario[];
  activeScenarioId: DemoScenarioId;
  onSelectScenario: (id: DemoScenarioId) => void;
  onStart: () => void;
  onStop: () => void;
  onSnapshotVerify: () => void;
  onOfflineBarcodeScan: () => void;
  lang: string;
};

type SourceOption = {
  id: CameraSource;
  label: string;
};

const SOURCE_OPTIONS: readonly SourceOption[] = [
  { id: "phone", label: "Phone Camera" },
  { id: "glasses", label: "Glasses (DAT)" },
  { id: "demo", label: "Demo Props" }
];

const SOURCE_LABELS: Record<CameraSource, string> = {
  phone: "Phone Camera",
  glasses: "Glasses (DAT)",
  demo: "Demo Props"
};

const MODE_BADGE_LABELS: Record<TransportMode, "LIVE" | "SNAPSHOT" | "OFFLINE"> = {
  live: "LIVE",
  snapshot: "SNAPSHOT",
  offline: "OFFLINE"
};

const COACH_BADGE_LABELS: Record<CoachCue, string> = {
  rotate_left: "ROTATE LEFT",
  rotate_right: "ROTATE RIGHT",
  closer: "MOVE CLOSER",
  farther: "MOVE FARTHER",
  more_light: "MORE LIGHT",
  hold_still: "HOLD STILL",
  other_side: "TURN PACKAGE OVER",
  ok: "LABEL IN VIEW"
};

function getModeBadgeStyle(mode: TransportMode): CSSProperties {
  if (mode === "live") {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minHeight: "36px",
      padding: "6px 12px",
      borderRadius: "var(--radius-pill, 9999px)",
      backgroundColor: "var(--verdict-match-bg, #06261d)",
      color: "var(--verdict-match-fg, #7ef7c8)",
      border: "2px solid var(--verdict-match-border, #2dd4a0)",
      fontSize: "var(--text-xs, 0.875rem)",
      fontWeight: 800,
      letterSpacing: "0.05em"
    };
  }
  if (mode === "snapshot") {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minHeight: "36px",
      padding: "6px 12px",
      borderRadius: "var(--radius-pill, 9999px)",
      backgroundColor: "var(--verdict-info-bg, #0a1f38)",
      color: "var(--verdict-info-fg, #a6d4ff)",
      border: "2px solid var(--verdict-info-border, #4da3ff)",
      fontSize: "var(--text-xs, 0.875rem)",
      fontWeight: 800,
      letterSpacing: "0.05em"
    };
  }
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minHeight: "36px",
    padding: "6px 12px",
    borderRadius: "var(--radius-pill, 9999px)",
    backgroundColor: "var(--verdict-unsure-bg, #261b04)",
    color: "var(--verdict-unsure-fg, #ffe169)",
    border: "2px dashed var(--verdict-unsure-border, #f5b82e)",
    fontSize: "var(--text-xs, 0.875rem)",
    fontWeight: 800,
    letterSpacing: "0.05em"
  };
}

function getCoachBannerStyle(cue: CoachCue): CSSProperties {
  if (cue === "ok") {
    return {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-3, 12px)",
      padding: "var(--space-4, 16px)",
      borderRadius: "var(--radius-md, 12px)",
      backgroundColor: "var(--verdict-match-bg, #06261d)",
      color: "var(--verdict-match-fg, #7ef7c8)",
      border: "2.5px solid var(--verdict-match-border, #2dd4a0)"
    };
  }
  if (cue === "more_light") {
    return {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-3, 12px)",
      padding: "var(--space-4, 16px)",
      borderRadius: "var(--radius-md, 12px)",
      backgroundColor: "var(--verdict-unsure-bg, #261b04)",
      color: "var(--verdict-unsure-fg, #ffe169)",
      border: "2.5px solid var(--verdict-unsure-border, #f5b82e)"
    };
  }
  return {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3, 12px)",
    padding: "var(--space-4, 16px)",
    borderRadius: "var(--radius-md, 12px)",
    backgroundColor: "var(--verdict-info-bg, #0a1f38)",
    color: "var(--verdict-info-fg, #a6d4ff)",
    border: "2.5px solid var(--verdict-info-border, #4da3ff)"
  };
}

function SourceOptionIcon({ source }: { source: CameraSource }) {
  const iconStyle: CSSProperties = { width: "20px", height: "20px", flexShrink: 0 };

  if (source === "phone") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
        <circle cx="12" cy="9" r="2.2" />
        <line x1="10" y1="18" x2="14" y2="18" />
      </svg>
    );
  }

  if (source === "glasses") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <rect x="2" y="8" width="8.5" height="7" rx="2.5" />
        <rect x="13.5" y="8" width="8.5" height="7" rx="2.5" />
        <path d="M10.5 11h3" />
        <path d="M2 10.5L3.5 6" />
        <path d="M22 10.5L20.5 6" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconStyle}
    >
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
      <circle cx="16.5" cy="14.5" r="1.5" />
    </svg>
  );
}

function ModeBadgeIcon({ mode }: { mode: TransportMode }) {
  const iconStyle: CSSProperties = { width: "16px", height: "16px", flexShrink: 0 };

  if (mode === "live") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M6.3 6.3a8 8 0 0 0 0 11.4" />
        <path d="M17.7 6.3a8 8 0 0 1 0 11.4" />
      </svg>
    );
  }

  if (mode === "snapshot") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={iconStyle}
      >
        <path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
        <circle cx="12" cy="13" r="3.2" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={iconStyle}
    >
      <path d="M4 6v12" />
      <path d="M8 6v12" />
      <path d="M12 6v12" />
      <path d="M16 6v12" />
      <path d="M20 6v12" />
    </svg>
  );
}

function CoachCueIcon({ cue }: { cue: CoachCue }) {
  const iconStyle: CSSProperties = { width: "40px", height: "40px", flexShrink: 0 };

  switch (cue) {
    case "rotate_left":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M29 27A11 11 0 1 0 13 13" />
          <path d="M12 7V14H19" />
        </svg>
      );
    case "rotate_right":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M11 27A11 11 0 1 1 27 13" />
          <path d="M28 7V14H21" />
        </svg>
      );
    case "closer":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M20 31V11M13 18L20 11L27 18" />
          <path d="M8 14V8H14M32 14V8H26" strokeWidth="2.5" />
        </svg>
      );
    case "farther":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M20 9V29M13 22L20 29L27 22" />
          <path d="M8 26V32H14M32 26V32H26" strokeWidth="2.5" />
        </svg>
      );
    case "more_light":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <circle cx="20" cy="20" r="6.5" />
          <path d="M20 5V9M20 31V35M5 20H9M31 20H35M9.5 9.5L12.5 12.5M27.5 27.5L30.5 30.5M30.5 9.5L27.5 12.5M12.5 27.5L9.5 30.5" />
        </svg>
      );
    case "hold_still":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M9 15V9H15M31 15V9H25M9 25V31H15M31 25V31H25" />
          <circle cx="20" cy="20" r="4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "other_side":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <path d="M8 15H31L25.5 9.5M32 25H9L14.5 30.5" />
        </svg>
      );
    case "ok":
      return (
        <svg
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={iconStyle}
        >
          <circle cx="20" cy="20" r="13.5" />
          <path d="M13.5 20.4L18 24.8L27 15.6" strokeWidth="3" />
        </svg>
      );
  }
}

export function ViewfinderStage(props: ViewfinderStageProps) {
  const {
    cameraActive,
    source,
    onChangeSource,
    mode,
    coach,
    checking,
    autoStopRemainingSec,
    glassesConnected,
    glassesWorn,
    videoRef,
    demoImgRef,
    scenarios,
    activeScenarioId,
    onSelectScenario,
    onStart,
    onStop,
    onSnapshotVerify,
    onOfflineBarcodeScan,
    lang
  } = props;

  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeScenario =
    scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0] ?? null;

  const hasCountdown =
    cameraActive &&
    autoStopRemainingSec !== null &&
    Number.isFinite(autoStopRemainingSec);

  const clampedCountdownSec = hasCountdown
    ? Math.max(0, Math.round(autoStopRemainingSec))
    : null;

  const activeSourceLabel = SOURCE_LABELS[source];
  const isGlassesStreaming = glassesConnected && glassesWorn;
  const isOfflineMode = mode === "offline";

  const handleRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = SOURCE_OPTIONS.length;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % count;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index + count - 1) % count;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = count - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const targetOption = SOURCE_OPTIONS[nextIndex];
      onChangeSource(targetOption.id);
      radioRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <section
      className="card viewfinder-stage"
      lang={lang || "en"}
      aria-label="Camera viewfinder and label framing stage"
      aria-busy={checking}
      data-camera-active={cameraActive ? "true" : "false"}
      data-source={source}
      data-mode={mode}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 16px)",
        padding: "var(--space-5, 20px)",
        borderRadius: "var(--radius-lg, 18px)",
        backgroundColor: "var(--bg-surface, #121926)",
        color: "var(--text-primary, #f8fafc)",
        border: cameraActive
          ? "2.5px solid var(--accent, #5cc0ff)"
          : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
        boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.32))"
      }}
    >
      <div
        className="viewfinder-status-bar"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2, 8px)"
        }}
      >
        <div
          className={`pill viewfinder-privacy-pill ${
            cameraActive ? "is-camera-on" : "is-camera-off"
          }`}
          role="status"
          aria-live="polite"
          data-privacy-state={cameraActive ? "on" : "off"}
          style={
            cameraActive
              ? {
                  display: "inline-flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                  minHeight: "40px",
                  padding: "6px 14px",
                  borderRadius: "var(--radius-pill, 9999px)",
                  backgroundColor: "var(--verdict-match-bg, #06261d)",
                  color: "var(--verdict-match-fg, #7ef7c8)",
                  border: "2px solid var(--verdict-match-border, #2dd4a0)",
                  fontWeight: 800,
                  fontSize: "var(--text-sm, 1rem)"
                }
              : {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  minHeight: "40px",
                  padding: "6px 14px",
                  borderRadius: "var(--radius-pill, 9999px)",
                  backgroundColor: "var(--bg-elevated, #1a2333)",
                  color: "var(--text-primary, #f8fafc)",
                  border: "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)",
                  fontWeight: 700,
                  fontSize: "var(--text-sm, 1rem)"
                }
          }
        >
          {cameraActive ? (
            <>
              <span className="privacy-live-dot" aria-hidden="true" />
              <span>CAMERA ON: {activeSourceLabel}</span>
              {clampedCountdownSec !== null && (
                <span
                  className="viewfinder-autostop"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  · Auto-stop in {clampedCountdownSec}s
                </span>
              )}
            </>
          ) : (
            <>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
                style={{ width: "18px", height: "18px", flexShrink: 0 }}
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <span>CAMERA OFF: Nothing captured</span>
            </>
          )}
        </div>

        <span
          className={`badge viewfinder-mode-badge viewfinder-mode-${mode}`}
          data-transport-mode={mode}
          style={getModeBadgeStyle(mode)}
        >
          <ModeBadgeIcon mode={mode} />
          <span>{MODE_BADGE_LABELS[mode]}</span>
        </span>
      </div>

      <div
        className="viewfinder-source-selector"
        role="radiogroup"
        aria-label="Camera source"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "var(--space-2, 8px)",
          padding: "6px",
          borderRadius: "var(--radius-md, 12px)",
          backgroundColor: "var(--bg-app, #0b0f17)",
          border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
        }}
      >
        {SOURCE_OPTIONS.map((option, index) => {
          const isSelected = source === option.id;
          return (
            <button
              key={option.id}
              ref={(el) => {
                radioRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              data-source-option={option.id}
              className={`btn viewfinder-source-radio${isSelected ? " is-selected" : ""}`}
              onClick={() => {
                if (!isSelected) {
                  onChangeSource(option.id);
                }
              }}
              onKeyDown={(event) => handleRadioKeyDown(event, index)}
              style={{
                minHeight: "56px",
                padding: "10px 14px",
                borderRadius: "var(--radius-sm, 8px)",
                backgroundColor: isSelected
                  ? "var(--accent-subtle, rgba(92, 192, 255, 0.16))"
                  : "var(--bg-elevated, #1a2333)",
                color: "var(--text-primary, #f8fafc)",
                border: isSelected
                  ? "2.5px solid var(--accent, #5cc0ff)"
                  : "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)",
                fontWeight: isSelected ? 800 : 700,
                fontSize: "var(--text-sm, 1rem)"
              }}
            >
              <SourceOptionIcon source={option.id} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>

      <div
        className="viewfinder-viewport"
        data-viewport-source={source}
        style={{
          position: "relative",
          width: "100%",
          minHeight: "280px",
          borderRadius: "var(--radius-md, 12px)",
          overflow: "hidden",
          backgroundColor: "var(--bg-app, #0b0f17)",
          border: "2px solid var(--border-strong, #6980a3)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          hidden={source !== "phone"}
          aria-hidden={source !== "phone" ? true : undefined}
          aria-label={source === "phone" ? "Phone camera live preview" : undefined}
          className="viewfinder-video"
          style={{
            display: source === "phone" ? "block" : "none",
            width: "100%",
            maxHeight: "420px",
            minHeight: "280px",
            objectFit: "cover",
            backgroundColor: "#05080f"
          }}
        />

        {source === "phone" && !cameraActive && (
          <div
            className="viewfinder-phone-standby"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "var(--space-2, 8px)",
              padding: "var(--space-5, 20px)",
              textAlign: "center",
              backgroundColor: "var(--bg-overlay, rgba(6, 9, 15, 0.86))",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            <svg
              viewBox="0 0 48 48"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{ width: "44px", height: "44px", color: "var(--accent, #5cc0ff)" }}
            >
              <path d="M10 17V10h7M38 17V10h-7M10 31v7h7M38 31v7h-7" />
              <circle cx="24" cy="24" r="5" />
            </svg>
            <p
              style={{
                margin: 0,
                fontWeight: 800,
                fontSize: "var(--text-lg, 1.25rem)"
              }}
            >
              Hold label 20 to 30 cm in front of your phone camera
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                color: "var(--text-secondary, #d8e1ee)",
                maxWidth: "42ch"
              }}
            >
              Camera stays off until you start an active check or capture a single snapshot.
            </p>
          </div>
        )}

        {source === "glasses" && (
          <div
            className="viewfinder-glasses-pov"
            data-glasses-connected={glassesConnected ? "true" : "false"}
            data-glasses-worn={glassesWorn ? "true" : "false"}
            style={{
              width: "100%",
              minHeight: "280px",
              padding: "var(--space-5, 20px)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "var(--space-3, 12px)",
              textAlign: "center",
              backgroundColor: "var(--bg-surface, #121926)",
              color: "var(--text-primary, #f8fafc)"
            }}
          >
            <svg
              viewBox="0 0 120 48"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{
                width: "108px",
                height: "44px",
                color: isGlassesStreaming
                  ? "var(--verdict-match-fg, #7ef7c8)"
                  : "var(--text-secondary, #d8e1ee)"
              }}
            >
              <rect x="8" y="10" width="42" height="28" rx="10" />
              <rect x="70" y="10" width="42" height="28" rx="10" />
              <path d="M50 20h20" />
              <circle
                cx="102"
                cy="17"
                r="3.2"
                fill={isGlassesStreaming ? "currentColor" : "none"}
              />
            </svg>

            <div
              className="viewfinder-glasses-chips"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-2, 8px)"
              }}
            >
              <span
                className="pill viewfinder-glasses-conn-pill"
                style={{
                  backgroundColor: glassesConnected
                    ? "var(--verdict-match-bg, #06261d)"
                    : "var(--bg-elevated, #1a2333)",
                  color: glassesConnected
                    ? "var(--verdict-match-fg, #7ef7c8)"
                    : "var(--text-secondary, #d8e1ee)",
                  borderColor: glassesConnected
                    ? "var(--verdict-match-border, #2dd4a0)"
                    : "var(--border-subtle, #2c3a52)",
                  fontWeight: 700
                }}
              >
                {glassesConnected ? "Bridge Connected" : "Bridge Disconnected"}
              </span>

              <span
                className="pill viewfinder-glasses-worn-pill"
                style={{
                  backgroundColor: glassesWorn
                    ? "var(--verdict-info-bg, #0a1f38)"
                    : "var(--verdict-unsure-bg, #261b04)",
                  color: glassesWorn
                    ? "var(--verdict-info-fg, #a6d4ff)"
                    : "var(--verdict-unsure-fg, #ffe169)",
                  borderColor: glassesWorn
                    ? "var(--verdict-info-border, #4da3ff)"
                    : "var(--verdict-unsure-border, #f5b82e)",
                  fontWeight: 700
                }}
              >
                {glassesWorn ? "Glasses Worn" : "Glasses Doffed"}
              </span>
            </div>

            <p
              className="viewfinder-glasses-status"
              style={{
                margin: 0,
                fontSize: "var(--text-lg, 1.25rem)",
                fontWeight: 800,
                lineHeight: 1.35,
                maxWidth: "44ch"
              }}
            >
              {isGlassesStreaming
                ? "Streaming first-person frames from Ray-Ban Meta via Android DAT bridge"
                : "Waiting for HoldUp Bridge stream..."}
            </p>

            <p
              className="viewfinder-glasses-hint"
              style={{
                margin: 0,
                fontSize: "var(--text-sm, 1rem)",
                color: "var(--text-secondary, #d8e1ee)",
                maxWidth: "48ch"
              }}
            >
              {isGlassesStreaming
                ? "Hands stay free: hold the box naturally at chest height while open-ear audio guides rotation."
                : glassesConnected
                  ? "Put your Ray-Ban Meta glasses on to resume first-person DAT framing, or switch to Phone Camera."
                  : "Pair Ray-Ban Meta in Developer Mode and start HoldUp Bridge, or switch to Phone Camera or Demo Props."}
            </p>
          </div>
        )}

        {source === "demo" && activeScenario && (
          <div
            className="viewfinder-demo-stage"
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              backgroundColor: "var(--bg-app, #0b0f17)"
            }}
          >
            <img
              ref={demoImgRef}
              src={activeScenario.fixtureUrl}
              crossOrigin="anonymous"
              alt={activeScenario.title}
              className="viewfinder-demo-img"
              style={{
                width: "100%",
                maxHeight: "360px",
                objectFit: "contain",
                backgroundColor: "#05080f"
              }}
            />
            <div
              className="viewfinder-demo-caption"
              style={{
                width: "100%",
                padding: "10px 14px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                backgroundColor: "var(--bg-elevated, #1a2333)",
                borderTop: "1px solid var(--border-subtle, #2c3a52)",
                fontSize: "var(--text-xs, 0.875rem)",
                color: "var(--text-secondary, #d8e1ee)"
              }}
            >
              <span style={{ fontWeight: 700, color: "var(--text-primary, #f8fafc)" }}>
                Active prop: {activeScenario.title}
              </span>
              <span>Prompt: &ldquo;{activeScenario.question}&rdquo;</span>
            </div>
          </div>
        )}

        {checking && (
          <div
            className="pill viewfinder-checking-pill"
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              top: "12px",
              right: "12px",
              backgroundColor: "var(--verdict-unsure-bg, #261b04)",
              color: "var(--verdict-unsure-fg, #ffe169)",
              border: "2px solid var(--verdict-unsure-border, #f5b82e)",
              fontWeight: 800
            }}
          >
            <span>Checking label...</span>
          </div>
        )}
      </div>

      {source === "demo" && scenarios.length > 0 && (
        <div
          className="viewfinder-scenario-grid"
          role="group"
          aria-label="Demo prop scenarios"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "var(--space-2, 8px)"
          }}
        >
          {scenarios.map((scenario) => {
            const isSelected = scenario.id === activeScenarioId;
            return (
              <button
                key={scenario.id}
                type="button"
                className={`btn viewfinder-scenario-btn${isSelected ? " is-selected" : ""}`}
                data-scenario-id={scenario.id}
                aria-pressed={isSelected}
                onClick={() => onSelectScenario(scenario.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  gap: "4px",
                  minHeight: "64px",
                  padding: "12px 14px",
                  textAlign: "left",
                  borderRadius: "var(--radius-md, 12px)",
                  backgroundColor: isSelected
                    ? "var(--accent-subtle, rgba(92, 192, 255, 0.16))"
                    : "var(--bg-elevated, #1a2333)",
                  color: "var(--text-primary, #f8fafc)",
                  border: isSelected
                    ? "2.5px solid var(--accent, #5cc0ff)"
                    : "var(--border-width, 1.5px) solid var(--border-strong, #6980a3)"
                }}
              >
                <span
                  className="viewfinder-scenario-title"
                  style={{
                    fontSize: "var(--text-sm, 1rem)",
                    fontWeight: 800,
                    lineHeight: 1.28,
                    color: "var(--text-primary, #f8fafc)"
                  }}
                >
                  {scenario.title}
                </span>
                <span
                  className="viewfinder-scenario-subtitle"
                  style={{
                    fontSize: "var(--text-xs, 0.875rem)",
                    fontWeight: 500,
                    lineHeight: 1.35,
                    color: "var(--text-secondary, #d8e1ee)"
                  }}
                >
                  {scenario.subtitle}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {coach !== null && (
        <div
          className={`viewfinder-coach-banner viewfinder-coach-${coach.cue}`}
          data-coach-cue={coach.cue}
          role="status"
          aria-live="polite"
          style={getCoachBannerStyle(coach.cue)}
        >
          <CoachCueIcon cue={coach.cue} />
          <div
            className="viewfinder-coach-copy"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              minWidth: 0
            }}
          >
            <span
              className="viewfinder-coach-badge"
              style={{
                fontSize: "var(--text-xs, 0.875rem)",
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase"
              }}
            >
              {COACH_BADGE_LABELS[coach.cue]}
            </span>
            <p
              className="viewfinder-coach-text"
              style={{
                margin: 0,
                fontSize: "var(--text-lg, 1.25rem)",
                fontWeight: 800,
                lineHeight: 1.35,
                color: "var(--text-primary, #f8fafc)"
              }}
            >
              {coach.text.trim() || cueLabel(lang, coach.cue)}
            </p>
          </div>
        </div>
      )}

      <div
        className="viewfinder-controls"
        role="group"
        aria-label="Label check actions"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "var(--space-3, 12px)"
        }}
      >
        {cameraActive ? (
          <button
            type="button"
            className="btn btn-danger btn-lg viewfinder-btn-toggle is-active"
            data-action="stop-camera"
            onClick={onStop}
            style={{ minHeight: "60px" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
              style={{ width: "20px", height: "20px", flexShrink: 0 }}
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <span>Stop Camera</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg viewfinder-btn-toggle"
            data-action="start-check"
            onClick={onStart}
            style={{ minHeight: "60px" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={{ width: "22px", height: "22px", flexShrink: 0 }}
            >
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
            </svg>
            <span>Start Check</span>
          </button>
        )}

        <button
          type="button"
          className={`btn ${
            mode === "snapshot" ? "btn-primary" : "btn-secondary"
          } btn-lg viewfinder-btn-snapshot`}
          data-action="snapshot-verify"
          disabled={checking}
          aria-disabled={checking}
          onClick={onSnapshotVerify}
          style={{ minHeight: "60px" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: "22px", height: "22px", flexShrink: 0 }}
          >
            <path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
            <circle cx="12" cy="13" r="3.2" />
          </svg>
          <span>Read Snapshot Now</span>
        </button>

        <button
          type="button"
          className={`btn ${
            isOfflineMode ? "btn-primary is-offline-highlighted" : "btn-secondary"
          } btn-lg viewfinder-btn-barcode`}
          data-action="offline-barcode"
          data-highlighted={isOfflineMode ? "true" : "false"}
          onClick={onOfflineBarcodeScan}
          style={
            isOfflineMode
              ? {
                  minHeight: "60px",
                  borderWidth: "2.5px",
                  borderStyle: "solid",
                  borderColor: "var(--accent, #5cc0ff)"
                }
              : {
                  minHeight: "60px"
                }
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: "22px", height: "22px", flexShrink: 0 }}
          >
            <path d="M4 6v12" />
            <path d="M8 6v12" />
            <path d="M12 6v12" />
            <path d="M16 6v12" />
            <path d="M20 6v12" />
          </svg>
          <span>Match Saved Barcode</span>
        </button>
      </div>
    </section>
  );
}

export default ViewfinderStage;
