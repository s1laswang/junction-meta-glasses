import React, { useState, type CSSProperties, type KeyboardEvent } from "react";
import type { CoachCue, DeviceState, Verdict, VerdictLevel } from "../types.ts";

export type HudPreviewFrameProps = {
  verdict: Verdict | null;
  coach: { cue: CoachCue; text: string } | null;
  checking: boolean;
  device: DeviceState;
  hudSocketConnected: boolean;
  onTriggerHudEvent: (name: "log_dose" | "repeat" | "dismiss") => void;
};

type HudActionName = "log_dose" | "repeat" | "dismiss";

type HudActionDef = {
  name: HudActionName;
  label: string;
  shortHint: string;
};

const HUD_ACTIONS: readonly HudActionDef[] = [
  { name: "log_dose", label: "Log Dose", shortHint: "Save to device log" },
  { name: "repeat", label: "Repeat", shortHint: "Speak verdict again" },
  { name: "dismiss", label: "Dismiss", shortHint: "Clear HUD card" }
];

type VerdictVisualSpec = {
  color: string;
  glow: string;
  tint: string;
  badge: string;
  shapeLabel: string;
};

const VERDICT_VISUALS: Record<VerdictLevel, VerdictVisualSpec> = {
  match: {
    color: "#22ff88",
    glow: "rgba(34, 255, 136, 0.34)",
    tint: "rgba(34, 255, 136, 0.08)",
    badge: "MATCH",
    shapeLabel: "Check shield"
  },
  warning: {
    color: "#ffbb22",
    glow: "rgba(255, 187, 34, 0.36)",
    tint: "rgba(255, 187, 34, 0.09)",
    badge: "WARNING",
    shapeLabel: "Warning triangle"
  },
  unsure: {
    color: "#38d6ff",
    glow: "rgba(56, 214, 255, 0.34)",
    tint: "rgba(56, 214, 255, 0.08)",
    badge: "UNSURE",
    shapeLabel: "Caution diamond"
  },
  info: {
    color: "#ffffff",
    glow: "rgba(255, 255, 255, 0.28)",
    tint: "rgba(255, 255, 255, 0.07)",
    badge: "INFO",
    shapeLabel: "Info circle"
  }
};

const COACH_LABELS: Record<CoachCue, string> = {
  rotate_left: "ROTATE LEFT",
  rotate_right: "ROTATE RIGHT",
  closer: "MOVE CLOSER",
  farther: "MOVE FARTHER",
  more_light: "MORE LIGHT",
  hold_still: "HOLD STILL",
  other_side: "TURN PACKAGE OVER",
  ok: "LABEL LOCKED"
};

const SCOPED_STYLES = `
.hpf-root {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 1rem);
  padding: var(--space-5, 1.25rem);
  background-color: var(--bg-surface, #121926);
  color: var(--text-primary, #f8fafc);
  border: var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52);
  border-radius: var(--radius-lg, 18px);
  box-shadow: var(--shadow-sm, none);
  font-family: var(--font-sans, system-ui, sans-serif);
}

.hpf-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3, 0.75rem);
}

.hpf-header-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 0.5rem);
  min-width: 0;
  flex: 1 1 280px;
}

.hpf-title {
  margin: 0;
  font-size: var(--text-lg, 1.25rem);
  font-weight: 700;
  line-height: 1.28;
  color: var(--text-primary, #f8fafc);
}

.hpf-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2, 0.5rem);
}

.hpf-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.22rem 0.65rem;
  border-radius: var(--radius-pill, 9999px);
  border: var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52);
  background-color: var(--bg-elevated, #1a2333);
  color: var(--text-secondary, #d8e1ee);
  font-size: var(--text-xs, 0.875rem);
  font-weight: 600;
  line-height: 1.25;
}

.hpf-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex-shrink: 0;
}

.hpf-open-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2, 0.5rem);
  min-height: var(--tap-min, 56px);
  padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
  border-radius: var(--radius-md, 12px);
  border: var(--border-width, 1.5px) solid var(--border-strong, #6980a3);
  background-color: var(--bg-elevated, #1a2333);
  color: var(--text-primary, #f8fafc);
  font-size: var(--text-sm, 1rem);
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.hpf-open-link:hover {
  border-color: var(--accent, #5cc0ff);
  background-color: var(--bg-surface, #121926);
  color: var(--text-primary, #f8fafc);
}

.hpf-open-link:focus-visible,
.hpf-gesture-btn:focus-visible,
.hpf-waveguide:focus-visible {
  outline: 3px solid var(--focus-ring, #ffdd00);
  outline-offset: 3px;
}

.hpf-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-4, 1rem);
  border-radius: var(--radius-lg, 18px);
  background: radial-gradient(circle at 50% 35%, #192231 0%, #090d14 100%);
  border: 1px solid var(--border-subtle, #2c3a52);
}

.hpf-glasses-shell {
  position: relative;
  width: 100%;
  max-width: 476px;
  padding: 20px 22px 24px 22px;
  border-radius: 26px 38px 54px 42px;
  background: linear-gradient(160deg, #272d38 0%, #12161d 48%, #090b0f 100%);
  border: 2.5px solid #3c4657;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.62), inset 0 1px 1px rgba(255, 255, 255, 0.16);
}

.hpf-frame-brow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 0.5rem);
  margin-bottom: 12px;
  padding: 0 4px;
  color: #cfd8e6;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.hpf-rivet {
  display: inline-block;
  width: 14px;
  height: 5px;
  border-radius: 999px;
  background: linear-gradient(90deg, #9aa6b8 0%, #eef4ff 50%, #8995a8 100%);
}

.hpf-led-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  color: #dce5f2;
}

.hpf-lens-well {
  padding: 8px;
  border-radius: 18px 24px 34px 26px;
  background-color: #030508;
  border: 1.5px solid rgba(130, 160, 200, 0.24);
}

.hpf-waveguide {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  background-color: #000000;
  color: #ffffff;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px;
  overflow: hidden;
  user-select: none;
}

.hpf-wg-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.78);
}

.hpf-wg-center {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 0;
  min-height: 0;
}

.hpf-hud-card {
  width: 100%;
  background-color: #000000;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hpf-card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hpf-card-badge-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.hpf-hud-headline {
  margin: 0;
  font-size: clamp(1.15rem, 3.6vw, 1.55rem);
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: #ffffff;
}

.hpf-hud-product {
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.3;
}

.hpf-hud-detail {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.38;
  color: rgba(255, 255, 255, 0.88);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hpf-coach-card {
  width: 100%;
  background-color: #000000;
  border: 2px solid #38d6ff;
  box-shadow: 0 0 22px rgba(56, 214, 255, 0.28);
  border-radius: 14px;
  padding: 18px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
}

.hpf-checking-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  padding: 16px;
}

@keyframes hpf-pulse-ring {
  0% {
    transform: scale(0.86);
    opacity: 0.95;
  }
  70% {
    transform: scale(1.18);
    opacity: 0.22;
  }
  100% {
    transform: scale(0.86);
    opacity: 0.95;
  }
}

.hpf-pulse-orb {
  position: relative;
  width: 68px;
  height: 68px;
  border-radius: 9999px;
  border: 2.5px solid #22ff88;
  box-shadow: 0 0 22px rgba(34, 255, 136, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: hpf-pulse-ring 1.35s ease-in-out infinite;
}

.hpf-reticle {
  position: relative;
  width: 148px;
  height: 148px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
}

.hpf-wg-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.hpf-hud-btn {
  min-height: 46px;
  padding: 8px 6px;
  border-radius: 10px;
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 0.86rem;
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 0.01em;
  text-align: center;
  cursor: pointer;
  transition: transform 90ms ease, background-color 120ms ease;
}

.hpf-hud-btn:active {
  transform: scale(0.98);
}

.hpf-neural-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 0.75rem);
  padding: var(--space-4, 1rem);
  border-radius: var(--radius-md, 12px);
  background-color: var(--bg-elevated, #1a2333);
  border: var(--border-width, 1.5px) solid var(--border-subtle, #2c3a52);
}

.hpf-neural-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 0.5rem);
}

.hpf-neural-title {
  font-size: var(--text-sm, 1rem);
  font-weight: 700;
  color: var(--text-primary, #f8fafc);
}

.hpf-neural-readout {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--text-xs, 0.875rem);
  font-weight: 600;
  color: var(--text-secondary, #d8e1ee);
}

.hpf-gesture-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
  gap: var(--space-2, 0.5rem);
}

.hpf-gesture-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2, 0.5rem);
  min-height: var(--tap-min, 56px);
  padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
  border-radius: var(--radius-md, 12px);
  border: var(--border-width, 1.5px) solid var(--border-strong, #6980a3);
  background-color: var(--bg-surface, #121926);
  color: var(--text-primary, #f8fafc);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: var(--text-sm, 1rem);
  font-weight: 700;
  line-height: 1.25;
  cursor: pointer;
  touch-action: manipulation;
  transition: border-color 140ms ease, background-color 140ms ease, transform 90ms ease;
}

.hpf-gesture-btn:hover {
  border-color: var(--accent, #5cc0ff);
  background-color: var(--bg-elevated, #1a2333);
}

.hpf-gesture-btn:active {
  transform: translateY(1px) scale(0.99);
}

.hpf-gesture-pinch {
  background-color: var(--accent, #5cc0ff);
  color: var(--accent-fg, #04111f);
  border-color: var(--accent, #5cc0ff);
}

.hpf-gesture-pinch:hover {
  background-color: var(--accent-hover, #7ad0ff);
  border-color: var(--accent-hover, #7ad0ff);
  color: var(--accent-fg, #04111f);
}

@media (max-width: 480px) {
  .hpf-glasses-shell {
    padding: 14px;
  }

  .hpf-waveguide {
    padding: 12px;
  }

  .hpf-hud-btn {
    font-size: 0.78rem;
    padding: 6px 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hpf-pulse-orb {
    animation: none !important;
  }

  .hpf-hud-btn,
  .hpf-gesture-btn,
  .hpf-open-link {
    transition: none !important;
  }
}
`;

function resolveStandaloneHudHref(): string {
  if (typeof window === "undefined" || !window.location?.search) {
    return "/hud";
  }
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  return session ? `/hud?session=${encodeURIComponent(session)}` : "/hud";
}

function VerdictGlyph({ level, color }: { level: VerdictLevel; color: string }) {
  if (level === "match") {
    return (
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M16 3L27 7.5V15.5C27 22.2 22.3 27.4 16 29.5C9.7 27.4 5 22.2 5 15.5V7.5L16 3Z"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M11 16.2L14.5 19.7L21.5 12.5"
          stroke={color}
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (level === "warning") {
    return (
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M16 4L29 27H3L16 4Z"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M16 12.2V19.4"
          stroke={color}
          strokeWidth="2.8"
          strokeLinecap="round"
        />
        <circle cx="16" cy="23.4" r="1.5" fill={color} />
      </svg>
    );
  }

  if (level === "unsure") {
    return (
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M16 2.5L29.5 16L16 29.5L2.5 16L16 2.5Z"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M13.3 12.6C13.3 10.9 14.5 9.7 16.2 9.7C17.9 9.7 19.1 10.8 19.1 12.3C19.1 13.7 18.2 14.4 17 15.2C16.2 15.7 16 16.3 16 17.4"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="16" cy="21.2" r="1.4" fill={color} />
      </svg>
    );
  }

  return (
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="12.5" stroke={color} strokeWidth="2.5" />
      <circle cx="16" cy="10.8" r="1.5" fill={color} />
      <path d="M16 14.8V22" stroke={color} strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}

function CoachArrowGlyph({ cue }: { cue: CoachCue }) {
  const stroke = cue === "ok" ? "#22ff88" : "#38d6ff";

  switch (cue) {
    case "rotate_left":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M29 27A11 11 0 1 0 13 13"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M12 7V14H19"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "rotate_right":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M11 27A11 11 0 1 1 27 13"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M28 7V14H21"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "closer":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M20 30V11M13 18L20 11L27 18"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8 13V8H13M32 13V8H27"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "farther":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M20 10V29M13 22L20 29L27 22"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8 27V32H13M32 27V32H27"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "more_light":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle cx="20" cy="20" r="6.5" stroke="#ffbb22" strokeWidth="2.8" />
          <path
            d="M20 5V9M20 31V35M5 20H9M31 20H35M9.5 9.5L12.5 12.5M27.5 27.5L30.5 30.5M30.5 9.5L27.5 12.5M12.5 27.5L9.5 30.5"
            stroke="#ffbb22"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "hold_still":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M9 15V9H15M31 15V9H25M9 25V31H15M31 25V31H25"
            stroke={stroke}
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20" cy="20" r="3.5" fill={stroke} />
        </svg>
      );
    case "other_side":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path
            d="M8 15H31L25.5 9.5M32 25H9L14.5 30.5"
            stroke={stroke}
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "ok":
      return (
        <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle cx="20" cy="20" r="13.5" stroke={stroke} strokeWidth="2.8" />
          <path
            d="M13.5 20.4L18 24.8L27 15.6"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

export function HudPreviewFrame(props: HudPreviewFrameProps): React.JSX.Element {
  const { verdict, coach, checking, device, hudSocketConnected, onTriggerHudEvent } = props;
  const [focusIdx, setFocusIdx] = useState<number>(0);
  const [lastTriggered, setLastTriggered] = useState<HudActionName | null>(null);

  const moveFocusLeft = () => {
    setFocusIdx((prev) => (prev + HUD_ACTIONS.length - 1) % HUD_ACTIONS.length);
  };

  const moveFocusRight = () => {
    setFocusIdx((prev) => (prev + 1) % HUD_ACTIONS.length);
  };

  const activateActionAt = (index: number) => {
    const safeIdx = ((index % HUD_ACTIONS.length) + HUD_ACTIONS.length) % HUD_ACTIONS.length;
    const action = HUD_ACTIONS[safeIdx];
    setFocusIdx(safeIdx);
    setLastTriggered(action.name);
    onTriggerHudEvent(action.name);
  };

  const handleWaveguideKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocusLeft();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocusRight();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateActionAt(focusIdx);
    }
  };

  const focusedAction = HUD_ACTIONS[focusIdx] ?? HUD_ACTIONS[0];
  const hudHref = resolveStandaloneHudHref();

  const deviceSummary = device.connected
    ? device.worn
      ? "Glasses Worn"
      : "Glasses Doffed"
    : device.source === "glasses"
      ? "Glasses Disconnected"
      : "Phone Eye Active";

  const batteryLabel =
    typeof device.battery === "number" && Number.isFinite(device.battery)
      ? `${Math.max(0, Math.min(100, Math.round(device.battery)))}%`
      : null;

  const renderWaveguideBody = () => {
    if (checking) {
      return (
        <div className="hpf-checking-box" role="status" aria-live="polite">
          <div className="hpf-pulse-orb" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="5" fill="#22ff88" />
              <path
                d="M16 4V8M16 24V28M4 16H8M24 16H28"
                stroke="#22ff88"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div
            style={{
              fontSize: "1.2rem",
              fontWeight: 800,
              letterSpacing: "0.04em",
              color: "#22ff88"
            }}
          >
            CHECKING LABEL...
          </div>
          <p className="hpf-hud-detail">
            Verifying fields and personal medication safety
          </p>
        </div>
      );
    }

    if (verdict) {
      const visual = VERDICT_VISUALS[verdict.level];
      const productParts = [
        verdict.read.product.value,
        verdict.read.strength.value
      ].filter((part): part is string => Boolean(part && part.trim()));
      const productSummary = productParts.join(" ");
      const secondaryDetail = verdict.reasons[0] ?? verdict.speech;

      const cardStyle: CSSProperties = {
        backgroundColor: "#000000",
        border: `2.5px solid ${visual.color}`,
        boxShadow: `0 0 24px ${visual.glow}, inset 0 0 18px ${visual.tint}`
      };

      return (
        <div
          className="hpf-hud-card"
          style={cardStyle}
          data-verdict-level={verdict.level}
          role="region"
          aria-label={`${visual.badge} verdict card`}
        >
          <div className="hpf-card-header">
            <span className="hpf-card-badge-group">
              <VerdictGlyph level={verdict.level} color={visual.color} />
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 9px",
                  borderRadius: "999px",
                  border: `1.5px solid ${visual.color}`,
                  color: visual.color,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: "0.78rem",
                  fontWeight: 800,
                  letterSpacing: "0.07em"
                }}
              >
                {visual.badge}
              </span>
            </span>

            {typeof verdict.takenToday === "boolean" ? (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "6px",
                  border: "1px solid rgba(255, 255, 255, 0.4)",
                  color: "#ffffff",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: "0.72rem",
                  fontWeight: 700
                }}
              >
                {verdict.takenToday ? "TAKEN TODAY" : "NOT TAKEN"}
              </span>
            ) : null}
          </div>

          <h3 className="hpf-hud-headline">{verdict.headline}</h3>

          {productSummary ? (
            <div className="hpf-hud-product" style={{ color: visual.color }}>
              {productSummary}
            </div>
          ) : null}

          {secondaryDetail ? (
            <p className="hpf-hud-detail">{secondaryDetail}</p>
          ) : null}
        </div>
      );
    }

    if (coach) {
      const cueAccent = coach.cue === "ok" ? "#22ff88" : coach.cue === "more_light" ? "#ffbb22" : "#38d6ff";
      return (
        <div
          className="hpf-coach-card"
          style={{
            borderColor: cueAccent,
            boxShadow: `0 0 20px rgba(56, 214, 255, 0.25)`
          }}
          data-coach-cue={coach.cue}
          role="status"
          aria-live="polite"
        >
          <CoachArrowGlyph cue={coach.cue} />
          <span
            style={{
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: "0.78rem",
              fontWeight: 800,
              letterSpacing: "0.08em",
              color: cueAccent
            }}
          >
            {COACH_LABELS[coach.cue]}
          </span>
          <p
            style={{
              margin: 0,
              fontSize: "1.12rem",
              fontWeight: 700,
              lineHeight: 1.3,
              color: "#ffffff"
            }}
          >
            {coach.text}
          </p>
        </div>
      );
    }

    return (
      <div className="hpf-reticle" data-idle-reticle="true">
        <svg width="108" height="108" viewBox="0 0 108 108" fill="none" aria-hidden="true">
          <path
            d="M14 34V14H34M74 14H94V34M14 74V94H34M74 94H94V74"
            stroke="rgba(34, 255, 136, 0.72)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="54" cy="54" r="3.5" fill="#22ff88" />
          <path
            d="M54 40V46M54 62V68M40 54H46M62 54H68"
            stroke="rgba(255, 255, 255, 0.45)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        <span
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: "0.76rem",
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "rgba(255, 255, 255, 0.76)"
          }}
        >
          STANDBY RETICLE
        </span>
      </div>
    );
  };

  return (
    <section className="hpf-root" aria-labelledby="hpf-heading">
      <style>{SCOPED_STYLES}</style>

      <header className="hpf-header">
        <div className="hpf-header-copy">
          <h2 id="hpf-heading" className="hpf-title">
            Meta Ray-Ban Display: In-Lens Waveguide Preview (600x600 Additive)
          </h2>

          <div className="hpf-meta-row">
            <span className="hpf-status-pill">
              <span
                className="hpf-dot"
                style={{
                  backgroundColor: hudSocketConnected ? "#22ff88" : "#ffbb22"
                }}
              />
              {hudSocketConnected ? "HUD WS Connected" : "HUD WS Local Preview"}
            </span>

            <span className="hpf-status-pill">{deviceSummary}</span>

            {batteryLabel ? (
              <span className="hpf-status-pill">Battery {batteryLabel}</span>
            ) : null}
          </div>
        </div>

        <a
          href={hudHref}
          target="_blank"
          rel="noopener noreferrer"
          className="hpf-open-link"
        >
          <span>Open /hud Window</span>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M11 3H17V9M17 3L9.5 10.5M8 5H4.5C3.67 5 3 5.67 3 6.5V15.5C3 16.33 3.67 17 4.5 17H13.5C14.33 17 15 16.33 15 15.5V12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </header>

      <div className="hpf-stage">
        <div className="hpf-glasses-shell">
          <div className="hpf-frame-brow">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <span className="hpf-rivet" aria-hidden="true" />
              <span>RIGHT LENS WAVEGUIDE</span>
            </span>

            <span className="hpf-led-indicator">
              <span
                className="hpf-dot"
                style={{
                  backgroundColor: device.streaming ? "#22ff88" : "rgba(255, 255, 255, 0.28)",
                  boxShadow: device.streaming ? "0 0 8px #22ff88" : "none"
                }}
              />
              <span>{device.streaming ? "LED STREAMING" : "LED IDLE"}</span>
            </span>
          </div>

          <div className="hpf-lens-well">
            <div
              className="hpf-waveguide"
              style={{ backgroundColor: "#000000", aspectRatio: "1 / 1" }}
              data-waveguide-viewport="600x600"
              tabIndex={0}
              role="group"
              aria-label="600 by 600 additive light waveguide viewport"
              onKeyDown={handleWaveguideKeyDown}
            >
              <div className="hpf-wg-topbar">
                <span>600x600 ADDITIVE</span>
                <span>
                  {hudSocketConnected ? "SYNC" : "SIM"}
                  {batteryLabel ? ` | ${batteryLabel}` : ""}
                </span>
              </div>

              <div className="hpf-wg-center">{renderWaveguideBody()}</div>

              <div className="hpf-wg-actions" role="group" aria-label="In-lens HUD actions">
                {HUD_ACTIONS.map((action, idx) => {
                  const isFocused = idx === focusIdx;
                  const btnStyle: CSSProperties = isFocused
                    ? {
                        backgroundColor: "rgba(255, 238, 0, 0.14)",
                        color: "#ffee00",
                        border: "2px solid #ffee00",
                        outline: "2px solid #ffee00",
                        outlineOffset: "2px",
                        boxShadow: "0 0 12px rgba(255, 238, 0, 0.52)"
                      }
                    : {
                        backgroundColor: "#000000",
                        color: "#ffffff",
                        border: "1.5px solid rgba(255, 255, 255, 0.36)",
                        outline: "none"
                      };

                  return (
                    <button
                      key={action.name}
                      type="button"
                      className="hpf-hud-btn"
                      style={btnStyle}
                      data-hud-action={action.name}
                      data-focused={isFocused ? "true" : "false"}
                      aria-current={isFocused ? "true" : undefined}
                      onFocus={() => setFocusIdx(idx)}
                      onClick={() => activateActionAt(idx)}
                    >
                      {action.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="hpf-neural-bar"
        role="group"
        aria-label="Simulated Meta Neural Band Gesture Bar"
      >
        <div className="hpf-neural-header">
          <span className="hpf-neural-title">Simulated Meta Neural Band Gesture Bar</span>
          <span className="hpf-neural-readout" aria-live="polite">
            Focus: {focusedAction.label} ({focusedAction.shortHint})
            {lastTriggered ? ` | Sent: ${lastTriggered}` : ""}
          </span>
        </div>

        <div className="hpf-gesture-grid">
          <button
            type="button"
            className="hpf-gesture-btn"
            onClick={moveFocusLeft}
          >
            <span aria-hidden="true">&larr;</span>
            <span>Thumb Swipe Left (ArrowLeft)</span>
          </button>

          <button
            type="button"
            className="hpf-gesture-btn"
            onClick={moveFocusRight}
          >
            <span>Thumb Swipe Right (ArrowRight)</span>
            <span aria-hidden="true">&rarr;</span>
          </button>

          <button
            type="button"
            className="hpf-gesture-btn hpf-gesture-pinch"
            onClick={() => activateActionAt(focusIdx)}
          >
            <span>Index Pinch (Enter)</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export default HudPreviewFrame;
