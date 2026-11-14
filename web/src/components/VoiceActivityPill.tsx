import type { CSSProperties } from "react";
import { normalizeLang, type UiLocale } from "../i18n/translations.ts";
import type { LiveState, TransportMode } from "../types.ts";

export type VoiceActivityState =
  | "listening"
  | "assistant_speaking"
  | "snapshot_ready"
  | "offline_local"
  | "muted"
  | "idle";

export type VoiceActivityStateOptions = {
  cameraActive: boolean;
  mode: TransportMode;
  live: LiveState;
  muted: boolean;
  assistantSpeaking?: boolean;
};

export type VoiceActivityPillProps = {
  cameraActive: boolean;
  mode: TransportMode;
  live: LiveState;
  muted: boolean;
  assistantSpeaking?: boolean;
  micRms?: number;
  lang: string;
  onInterruptSpeech?: () => void;
};

type StateCopy = {
  badge: string;
  detail: string;
};

type LocaleCopy = {
  regionAriaLabel: string;
  interruptLabel: string;
  interruptAria: string;
  states: Record<VoiceActivityState, StateCopy>;
};

const COPY_BY_LOCALE: Record<UiLocale, LocaleCopy> = {
  en: {
    regionAriaLabel: "Open-ear voice and audio status",
    interruptLabel: "Interrupt Speech",
    interruptAria: "Interrupt Speech and return to listening",
    states: {
      listening: {
        badge: "MIC LISTENING",
        detail: "Open-ear mic active: ask a question anytime"
      },
      assistant_speaking: {
        badge: "HOLDUP SPEAKING",
        detail: "Speaking aloud: speak or tap Interrupt Speech to barge in"
      },
      snapshot_ready: {
        badge: "SNAPSHOT AUDIO",
        detail: "Single-photo check ready with spoken reply"
      },
      offline_local: {
        badge: "OFFLINE LOCAL",
        detail: "On-device barcode and local commands only"
      },
      muted: {
        badge: "AUDIO MUTED",
        detail: "Voice output and earcons muted"
      },
      idle: {
        badge: "MIC STANDBY",
        detail: "Microphone off until you start a label check"
      }
    }
  },
  fi: {
    regionAriaLabel: "Avoimen korvan puhe- ja äänitila",
    interruptLabel: "Keskeytä puhe",
    interruptAria: "Keskeytä puhe ja palaa kuunteluun",
    states: {
      listening: {
        badge: "MIKKI KUUNTELEE",
        detail: "Avoin mikrofoni päällä: kysy milloin vain"
      },
      assistant_speaking: {
        badge: "HOLDUP PUHUU",
        detail: "Puhuu ääneen: puhu päälle tai keskeytä puhe"
      },
      snapshot_ready: {
        badge: "KUVATILAN ÄÄNI",
        detail: "Yksittäiskuvatarkistus ja puhuttu vastaus valmiina"
      },
      offline_local: {
        badge: "PAIKALLINEN TILA",
        detail: "Vain laitteen viivakoodi ja paikalliset komennot"
      },
      muted: {
        badge: "ÄÄNI MYKISTETTY",
        detail: "Puheääni ja äänimerkit mykistetty"
      },
      idle: {
        badge: "MIKKI VALMIUSTILASSA",
        detail: "Mikrofoni pois päältä kunnes aloitat tarkistuksen"
      }
    }
  },
  sv: {
    regionAriaLabel: "Röst- och ljudstatus med öppet öra",
    interruptLabel: "Avbryt tal",
    interruptAria: "Avbryt tal och återgå till lyssning",
    states: {
      listening: {
        badge: "MIK LYSSNAR",
        detail: "Öppen mikrofon aktiv: fråga när som helst"
      },
      assistant_speaking: {
        badge: "HOLDUP TALAR",
        detail: "Talar högt: tala eller tryck för att avbryta tal"
      },
      snapshot_ready: {
        badge: "STILLBILDSLJUD",
        detail: "Stillbildskontroll redo med uppläst svar"
      },
      offline_local: {
        badge: "LOKALT OFFLINE",
        detail: "Endast streckkod och lokala kommandon på enheten"
      },
      muted: {
        badge: "LJUD AVSTÄNGT",
        detail: "Röstuppläsning och ljudsignaler avstängda"
      },
      idle: {
        badge: "MIK I VÄNTELÄGE",
        detail: "Mikrofonen är av tills du startar en kontroll"
      }
    }
  }
};

export function resolveVoiceActivityState(opts: {
  cameraActive: boolean;
  mode: TransportMode;
  live: LiveState;
  muted: boolean;
  assistantSpeaking?: boolean;
}): VoiceActivityState {
  if (opts.muted) {
    return "muted";
  }
  if (opts.assistantSpeaking) {
    return "assistant_speaking";
  }
  if (opts.mode === "offline") {
    return "offline_local";
  }
  if (opts.mode === "snapshot" || opts.live === "degraded") {
    return "snapshot_ready";
  }
  if (opts.cameraActive && opts.mode === "live" && opts.live === "open") {
    return "listening";
  }
  return "idle";
}

export function quantizeMicBars(rms: number, barCount = 5): number[] {
  const safeCount = Number.isFinite(barCount) ? Math.max(0, Math.floor(barCount)) : 5;
  if (safeCount === 0) {
    return [];
  }
  const normalizedRms = !Number.isFinite(rms)
    ? rms > 0
      ? 1
      : 0
    : Math.max(0, Math.min(1, rms));

  const heights: number[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    const bandFill = Math.max(0, Math.min(1, normalizedRms * safeCount - i));
    const quantizedStep = Math.round(bandFill * 4);
    const height = (2 + quantizedStep * 2) / 10;
    heights.push(height);
  }
  return heights;
}

const ICON_SVG_STYLE: CSSProperties = {
  width: "20px",
  height: "20px",
  flexShrink: 0
};

const MAIN_CLUSTER_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3, 12px)",
  flex: "1 1 240px"
};

const DETAIL_TEXT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 600,
  lineHeight: 1.35,
  color: "var(--text-primary, #f8fafc)"
};

const CONTROLS_CLUSTER_STYLE: CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3, 12px)"
};

const VU_METER_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "flex-end",
  gap: "4px",
  height: "28px",
  padding: "4px 8px",
  borderRadius: "var(--radius-sm, 8px)",
  backgroundColor: "var(--bg-elevated, #1a2333)",
  border: "var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52)"
};

const INTERRUPT_BUTTON_STYLE: CSSProperties = {
  minHeight: "56px",
  minWidth: "56px",
  padding: "10px 16px",
  fontSize: "var(--text-sm, 1rem)",
  fontWeight: 800,
  borderRadius: "var(--radius-pill, 9999px)"
};

function getContainerStyle(state: VoiceActivityState): CSSProperties {
  const base: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3, 12px)",
    padding: "var(--space-3, 12px) var(--space-4, 16px)",
    borderRadius: "var(--radius-lg, 18px)",
    backgroundColor: "var(--bg-surface, #121926)",
    color: "var(--text-primary, #f8fafc)",
    borderWidth: "var(--border-width, 1.5px)",
    borderStyle: "solid",
    borderColor: "var(--border-subtle, #2c3a52)"
  };

  if (state === "listening") {
    return {
      ...base,
      borderColor: "var(--verdict-match-border, #2dd4a0)"
    };
  }
  if (state === "assistant_speaking") {
    return {
      ...base,
      borderColor: "var(--verdict-info-border, #4da3ff)"
    };
  }
  if (state === "snapshot_ready") {
    return {
      ...base,
      borderColor: "var(--verdict-unsure-border, #f5b82e)"
    };
  }
  if (state === "offline_local") {
    return {
      ...base,
      borderStyle: "dashed",
      borderColor: "var(--verdict-unsure-border, #f5b82e)"
    };
  }
  if (state === "muted") {
    return {
      ...base,
      borderStyle: "double",
      borderWidth: "3px",
      borderColor: "var(--verdict-warning-border, #ff6b52)"
    };
  }
  return base;
}

function getBadgeStyle(state: VoiceActivityState): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2, 8px)",
    minHeight: "36px",
    padding: "6px 12px",
    borderRadius: "var(--radius-pill, 9999px)",
    fontSize: "var(--text-xs, 0.875rem)",
    fontWeight: 800,
    letterSpacing: "0.04em",
    lineHeight: 1.2,
    whiteSpace: "nowrap"
  };

  if (state === "listening") {
    return {
      ...base,
      backgroundColor: "var(--verdict-match-bg, #06261d)",
      color: "var(--verdict-match-fg, #7ef7c8)",
      border: "2px solid var(--verdict-match-border, #2dd4a0)"
    };
  }
  if (state === "assistant_speaking") {
    return {
      ...base,
      backgroundColor: "var(--verdict-info-bg, #0a1f38)",
      color: "var(--verdict-info-fg, #a6d4ff)",
      border: "2px solid var(--verdict-info-border, #4da3ff)"
    };
  }
  if (state === "snapshot_ready") {
    return {
      ...base,
      backgroundColor: "var(--verdict-unsure-bg, #261b04)",
      color: "var(--verdict-unsure-fg, #ffe169)",
      border: "2px solid var(--verdict-unsure-border, #f5b82e)"
    };
  }
  if (state === "offline_local") {
    return {
      ...base,
      backgroundColor: "var(--verdict-unsure-bg, #261b04)",
      color: "var(--verdict-unsure-fg, #ffe169)",
      border: "2px dashed var(--verdict-unsure-border, #f5b82e)"
    };
  }
  if (state === "muted") {
    return {
      ...base,
      backgroundColor: "var(--verdict-warning-bg, #2d0e0a)",
      color: "var(--verdict-warning-fg, #ffb8ab)",
      border: "2px solid var(--verdict-warning-border, #ff6b52)"
    };
  }
  return {
    ...base,
    backgroundColor: "var(--bg-elevated, #1a2333)",
    color: "var(--text-primary, #f8fafc)",
    border: "2px solid var(--border-strong, #6980a3)"
  };
}

function getVuBarStyle(height: number, state: VoiceActivityState): CSSProperties {
  const active = height > 0.2 && state !== "muted" && state !== "idle";
  let color = "var(--border-strong, #6980a3)";
  if (state === "listening") {
    color = active ? "var(--verdict-match-border, #2dd4a0)" : "var(--border-strong, #6980a3)";
  } else if (state === "assistant_speaking") {
    color = active ? "var(--verdict-info-border, #4da3ff)" : "var(--border-strong, #6980a3)";
  } else if (state === "snapshot_ready" || state === "offline_local") {
    color = active ? "var(--verdict-unsure-border, #f5b82e)" : "var(--border-strong, #6980a3)";
  } else if (state === "muted") {
    color = "var(--verdict-warning-border, #ff6b52)";
  }

  return {
    display: "inline-block",
    width: "5px",
    height: `${Math.round(height * 100)}%`,
    borderRadius: "var(--radius-pill, 9999px)",
    backgroundColor: color
  };
}

function renderStateIcon(state: VoiceActivityState) {
  if (state === "listening") {
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
        style={ICON_SVG_STYLE}
      >
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </svg>
    );
  }
  if (state === "assistant_speaking") {
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
        style={ICON_SVG_STYLE}
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M19 5.5a9.5 9.5 0 0 1 0 13" />
      </svg>
    );
  }
  if (state === "snapshot_ready") {
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
        style={ICON_SVG_STYLE}
      >
        <path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
        <circle cx="12" cy="13" r="3.5" />
      </svg>
    );
  }
  if (state === "offline_local") {
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
        style={ICON_SVG_STYLE}
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="7" y1="8" x2="7" y2="16" />
        <line x1="10.5" y1="8" x2="10.5" y2="16" />
        <line x1="14" y1="8" x2="14" y2="16" />
        <line x1="17" y1="8" x2="17" y2="16" />
      </svg>
    );
  }
  if (state === "muted") {
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
        style={ICON_SVG_STYLE}
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <line x1="22" y1="9" x2="16" y2="15" />
        <line x1="16" y1="9" x2="22" y2="15" />
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
      style={ICON_SVG_STYLE}
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="10" y1="9" x2="10" y2="15" />
      <line x1="14" y1="9" x2="14" y2="15" />
    </svg>
  );
}

export function VoiceActivityPill(props: VoiceActivityPillProps) {
  const {
    cameraActive,
    mode,
    live,
    muted,
    assistantSpeaking = false,
    micRms = 0,
    lang,
    onInterruptSpeech
  } = props;

  const locale = normalizeLang(lang);
  const copy = COPY_BY_LOCALE[locale];
  const state = resolveVoiceActivityState({
    cameraActive,
    mode,
    live,
    muted,
    assistantSpeaking
  });
  const stateCopy = copy.states[state];
  const effectiveRms = state === "muted" || state === "idle" ? 0 : micRms;
  const bars = quantizeMicBars(effectiveRms, 5);
  const showInterruptButton = Boolean(assistantSpeaking) && typeof onInterruptSpeech === "function";

  return (
    <div
      role="region"
      aria-label={copy.regionAriaLabel}
      lang={locale}
      className={`voice-activity-pill voice-state-${state}`}
      data-voice-state={state}
      data-mode={mode}
      style={getContainerStyle(state)}
    >
      <div className="voice-activity-main" style={MAIN_CLUSTER_STYLE}>
        <span
          className={`badge voice-status-badge voice-badge-${state}`}
          data-voice-badge={state}
          style={getBadgeStyle(state)}
        >
          {state === "listening" ? (
            <span className="privacy-live-dot" aria-hidden="true" />
          ) : null}
          {renderStateIcon(state)}
          <span>{stateCopy.badge}</span>
        </span>

        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="voice-status-detail"
          style={DETAIL_TEXT_STYLE}
        >
          {stateCopy.detail}
        </span>
      </div>

      <div className="voice-activity-controls" style={CONTROLS_CLUSTER_STYLE}>
        <div
          className="voice-vu-meter"
          aria-hidden="true"
          data-bar-count={bars.length}
          style={VU_METER_STYLE}
        >
          {bars.map((height, index) => (
            <span
              key={index}
              className="voice-vu-bar"
              data-bar-index={index}
              data-bar-height={height}
              style={getVuBarStyle(height, state)}
            />
          ))}
        </div>

        {showInterruptButton ? (
          <button
            type="button"
            className="btn btn-secondary voice-interrupt-btn"
            data-action="interrupt-speech"
            aria-label={copy.interruptAria}
            onClick={onInterruptSpeech}
            style={INTERRUPT_BUTTON_STYLE}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              style={ICON_SVG_STYLE}
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <span>{copy.interruptLabel}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default VoiceActivityPill;
