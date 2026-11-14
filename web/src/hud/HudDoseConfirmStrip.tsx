import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { clampHudHeadline, sanitizeHudText } from "./HudApp.tsx";

export type HudDoseLocale = "en" | "fi" | "sv";

export type DoseConfirmPhase = "idle" | "confirming" | "logged";

export type DoseConfirmState = {
  phase: DoseConfirmPhase;
  medName: string;
  strength: string;
  focusIndex: number;
  armedAtMs: number | null;
  loggedAtMs: number | null;
};

export type DoseConfirmEvent =
  | { type: "arm"; medName: string; strength: string; nowMs: number }
  | { type: "confirm"; nowMs: number }
  | { type: "cancel" }
  | { type: "undo" }
  | { type: "dismiss" }
  | { type: "expire"; nowMs: number; confirmTimeoutMs?: number; undoWindowMs?: number }
  | { type: "focus"; key: string };

export type HudDoseConfirmStripProps = {
  medName: string;
  strength?: string;
  lang?: string;
  initialState?: Partial<DoseConfirmState>;
  confirmTimeoutMs?: number;
  undoWindowMs?: number;
  onConfirmLogDose?: () => void;
  onUndoLogDose?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
};

type StripButtonSpec = {
  id: "confirm" | "cancel" | "undo" | "done";
  label: string;
};

type LocaleStrings = {
  armBadge: string;
  loggedBadge: string;
  confirmHeadline: (med: string, strength: string) => string;
  loggedHeadline: (med: string, strength: string) => string;
  confirmSubtext: string;
  loggedSubtext: string;
  confirmBtn: string;
  cancelBtn: string;
  undoBtn: string;
  doneBtn: string;
  regionConfirmAria: string;
  regionLoggedAria: string;
};

export const DEFAULT_CONFIRM_TIMEOUT_MS = 8000;
export const DEFAULT_UNDO_WINDOW_MS = 10000;
export const NEURAL_PINCH_DEBOUNCE_MS = 150;

const STRINGS_BY_LOCALE: Record<HudDoseLocale, LocaleStrings> = {
  en: {
    armBadge: "PINCH TO CONFIRM",
    loggedBadge: "DOSE LOGGED",
    confirmHeadline: (med, strength) =>
      clampHudHeadline(`Log ${med} ${strength} now`.trim()),
    loggedHeadline: (med, strength) =>
      clampHudHeadline(`Logged ${med} ${strength}`.trim()),
    confirmSubtext: "Swipe to Confirm Dose, then index pinch",
    loggedSubtext: "Saved on phone only. Pinch Undo to revert",
    confirmBtn: "Confirm Dose",
    cancelBtn: "Cancel",
    undoBtn: "Undo",
    doneBtn: "Done",
    regionConfirmAria: "Confirm medication dose logging",
    regionLoggedAria: "Medication dose logged confirmation"
  },
  fi: {
    armBadge: "VAHVISTA NIPCAUKSELLA",
    loggedBadge: "ANNOS KIRJATTU",
    confirmHeadline: (med, strength) =>
      clampHudHeadline(`Kirjaa ${med} ${strength} nyt`.trim()),
    loggedHeadline: (med, strength) =>
      clampHudHeadline(`Kirjattu ${med} ${strength}`.trim()),
    confirmSubtext: "Pyyhkäise Vahvista annos ja nipistä",
    loggedSubtext: "Tallennettu puhelimeen. Kumoa nipistämällä",
    confirmBtn: "Vahvista annos",
    cancelBtn: "Peruuta",
    undoBtn: "Kumoa",
    doneBtn: "Valmis",
    regionConfirmAria: "Vahvista lääkeannoksen kirjaus",
    regionLoggedAria: "Lääkeannos kirjattu"
  },
  sv: {
    armBadge: "NYP FÖR ATT BEKRÄFTA",
    loggedBadge: "DOS REGISTRERAD",
    confirmHeadline: (med, strength) =>
      clampHudHeadline(`Logga ${med} ${strength} nu`.trim()),
    loggedHeadline: (med, strength) =>
      clampHudHeadline(`Loggad ${med} ${strength}`.trim()),
    confirmSubtext: "Svep till Bekräfta dos och nyp",
    loggedSubtext: "Sparad lokalt på telefonen. Nyp Ångra",
    confirmBtn: "Bekräfta dos",
    cancelBtn: "Avbryt",
    undoBtn: "Ångra",
    doneBtn: "Klar",
    regionConfirmAria: "Bekräfta registrering av läkemedelsdos",
    regionLoggedAria: "Läkemedelsdos registrerad"
  }
};

export function resolveHudDoseLocale(raw?: string | null): HudDoseLocale {
  const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (clean.startsWith("fi")) {
    return "fi";
  }
  if (clean.startsWith("sv")) {
    return "sv";
  }
  return "en";
}

export function nextConfirmFocusIndex(current: number, count: number, key: string): number {
  const total = Math.trunc(Number.isFinite(count) ? count : 0);
  if (total <= 0) {
    return 0;
  }
  const base = ((Math.trunc(Number.isFinite(current) ? current : 0) % total) + total) % total;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (base + 1) % total;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (base - 1 + total) % total;
  }
  return base;
}

export function createInitialDoseConfirmState(
  overrides?: Partial<DoseConfirmState>
): DoseConfirmState {
  return {
    phase: "idle",
    medName: "",
    strength: "",
    focusIndex: 1,
    armedAtMs: null,
    loggedAtMs: null,
    ...overrides
  };
}

export function reduceDoseConfirmAction(
  state: DoseConfirmState,
  event: DoseConfirmEvent
): DoseConfirmState {
  switch (event.type) {
    case "arm": {
      const cleanMed = sanitizeHudText(event.medName);
      if (!cleanMed) {
        return state;
      }
      return {
        phase: "confirming",
        medName: cleanMed,
        strength: sanitizeHudText(event.strength),
        focusIndex: 1,
        armedAtMs: event.nowMs,
        loggedAtMs: null
      };
    }
    case "confirm": {
      if (state.phase !== "confirming") {
        return state;
      }
      return {
        ...state,
        phase: "logged",
        focusIndex: 1,
        armedAtMs: null,
        loggedAtMs: event.nowMs
      };
    }
    case "cancel":
    case "dismiss": {
      if (state.phase === "idle") {
        return state;
      }
      return createInitialDoseConfirmState();
    }
    case "undo": {
      if (state.phase !== "logged") {
        return state;
      }
      return createInitialDoseConfirmState();
    }
    case "expire": {
      const confirmWindow = event.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
      const undoWindow = event.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS;
      if (
        state.phase === "confirming" &&
        state.armedAtMs !== null &&
        event.nowMs - state.armedAtMs >= confirmWindow
      ) {
        return createInitialDoseConfirmState();
      }
      if (
        state.phase === "logged" &&
        state.loggedAtMs !== null &&
        event.nowMs - state.loggedAtMs >= undoWindow
      ) {
        return createInitialDoseConfirmState();
      }
      return state;
    }
    case "focus": {
      if (state.phase === "idle") {
        return state;
      }
      const nextIdx = nextConfirmFocusIndex(state.focusIndex, 2, event.key);
      return nextIdx === state.focusIndex ? state : { ...state, focusIndex: nextIdx };
    }
  }
}

const ROOT_BASE_STYLE: CSSProperties = {
  width: "min(90%, 500px)",
  backgroundColor: "#000000",
  color: "#ffffff",
  borderRadius: "16px",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  userSelect: "none"
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px"
};

const HEADLINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "clamp(22px, 4.6vmin, 30px)",
  fontWeight: 800,
  lineHeight: 1.18,
  letterSpacing: "0.01em",
  color: "#ffffff"
};

const SUBTEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "clamp(14px, 2.8vmin, 18px)",
  fontWeight: 700,
  lineHeight: 1.28,
  color: "#f0f6ff"
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "12px",
  width: "100%"
};

function ConfirmGlyph({ phase, color }: { phase: "confirming" | "logged"; color: string }) {
  if (phase === "logged") {
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="13" stroke={color} strokeWidth="3.5" />
        <path
          d="M10 16.5L14.2 20.6L22.5 11.8"
          stroke={color}
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M16 3.5L28.5 16L16 28.5L3.5 16L16 3.5Z"
        stroke={color}
        strokeWidth="3.4"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4" fill={color} />
    </svg>
  );
}

export function HudDoseConfirmStrip(props: HudDoseConfirmStripProps): React.JSX.Element | null {
  const {
    medName,
    strength = "",
    lang,
    initialState,
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    undoWindowMs = DEFAULT_UNDO_WINDOW_MS,
    onConfirmLogDose,
    onUndoLogDose,
    onCancel,
    onDismiss
  } = props;

  const locale = resolveHudDoseLocale(lang);
  const copy = STRINGS_BY_LOCALE[locale];

  const [state, setState] = useState<DoseConfirmState>(() =>
    createInitialDoseConfirmState({
      medName: sanitizeHudText(medName),
      strength: sanitizeHudText(strength),
      ...initialState
    })
  );

  const stateRef = useRef<DoseConfirmState>(state);
  stateRef.current = state;

  const btnRefs = useRef<Array<HTMLButtonElement | null>>([null, null]);
  const lastPinchAtRef = useRef<number>(0);

  useEffect(() => {
    if (state.phase === "idle") {
      return;
    }
    const deadlineMs =
      state.phase === "confirming"
        ? (state.armedAtMs ?? Date.now()) + confirmTimeoutMs
        : (state.loggedAtMs ?? Date.now()) + undoWindowMs;
    const delayMs = Math.max(25, deadlineMs - Date.now());
    const timer = setTimeout(() => {
      setState((prev) =>
        reduceDoseConfirmAction(prev, {
          type: "expire",
          nowMs: Date.now(),
          confirmTimeoutMs,
          undoWindowMs
        })
      );
    }, delayMs);
    const maybeNodeTimer = timer as unknown as { unref?: () => void };
    maybeNodeTimer.unref?.();
    return () => {
      clearTimeout(timer);
    };
  }, [confirmTimeoutMs, state.armedAtMs, state.loggedAtMs, state.phase, undoWindowMs]);

  const executeButtonAt = useCallback(
    (index: number) => {
      const now = Date.now();
      if (now - lastPinchAtRef.current < NEURAL_PINCH_DEBOUNCE_MS) {
        return;
      }
      const current = stateRef.current;
      if (current.phase === "idle") {
        return;
      }
      lastPinchAtRef.current = now;
      const safeIdx = ((index % 2) + 2) % 2;

      if (current.phase === "confirming") {
        if (safeIdx === 0) {
          setState((prev) => reduceDoseConfirmAction(prev, { type: "confirm", nowMs: now }));
          onConfirmLogDose?.();
        } else {
          setState((prev) => reduceDoseConfirmAction(prev, { type: "cancel" }));
          onCancel?.();
        }
        return;
      }

      if (safeIdx === 0) {
        setState((prev) => reduceDoseConfirmAction(prev, { type: "undo" }));
        onUndoLogDose?.();
      } else {
        setState((prev) => reduceDoseConfirmAction(prev, { type: "dismiss" }));
        onDismiss?.();
      }
    },
    [onCancel, onConfirmLogDose, onDismiss, onUndoLogDose]
  );

  useEffect(() => {
    if (state.phase === "idle" || typeof window === "undefined") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown"
      ) {
        event.preventDefault();
        const nextIdx = nextConfirmFocusIndex(stateRef.current.focusIndex, 2, event.key);
        setState((prev) => ({ ...prev, focusIndex: nextIdx }));
        const target = btnRefs.current[nextIdx];
        if (target && typeof target.focus === "function") {
          target.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        executeButtonAt(stateRef.current.focusIndex);
        return;
      }
      if (event.key === "Escape" || event.key === "Backspace") {
        event.preventDefault();
        const currentPhase = stateRef.current.phase;
        setState((prev) => reduceDoseConfirmAction(prev, { type: "cancel" }));
        if (currentPhase === "confirming") {
          onCancel?.();
        } else {
          onDismiss?.();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [executeButtonAt, onCancel, onDismiss, state.phase]);

  if (state.phase === "idle") {
    return null;
  }

  const isConfirming = state.phase === "confirming";
  const accentColor = isConfirming ? "#ffbb22" : "#22ff88";
  const effectiveMed = sanitizeHudText(state.medName || medName);
  const effectiveStrength = sanitizeHudText(state.strength || strength);
  const headline = isConfirming
    ? copy.confirmHeadline(effectiveMed, effectiveStrength)
    : copy.loggedHeadline(effectiveMed, effectiveStrength);
  const subtext = isConfirming ? copy.confirmSubtext : copy.loggedSubtext;
  const badgeText = isConfirming ? copy.armBadge : copy.loggedBadge;
  const regionLabel = isConfirming ? copy.regionConfirmAria : copy.regionLoggedAria;

  const buttons: readonly StripButtonSpec[] = isConfirming
    ? [
        { id: "confirm", label: copy.confirmBtn },
        { id: "cancel", label: copy.cancelBtn }
      ]
    : [
        { id: "undo", label: copy.undoBtn },
        { id: "done", label: copy.doneBtn }
      ];

  return (
    <section
      className="hud-dose-confirm-strip"
      data-dose-confirm-phase={state.phase}
      data-hud-surface="600x600-additive-strip"
      role="region"
      aria-label={regionLabel}
      aria-live="assertive"
      style={{
        ...ROOT_BASE_STYLE,
        border: `3.5px solid ${accentColor}`
      }}
    >
      <div style={HEADER_ROW_STYLE}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
          <ConfirmGlyph phase={state.phase} color={accentColor} />
          <span
            data-dose-confirm-badge={badgeText}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "3px 10px",
              borderRadius: isConfirming ? "8px" : "999px",
              border: `2px solid ${accentColor}`,
              backgroundColor: "#000000",
              color: accentColor,
              fontSize: "clamp(13px, 2.7vmin, 17px)",
              fontWeight: 800,
              letterSpacing: "0.07em",
              textTransform: "uppercase"
            }}
          >
            {badgeText}
          </span>
        </span>
      </div>

      <h2 style={HEADLINE_STYLE}>{headline}</h2>
      <p style={SUBTEXT_STYLE}>{subtext}</p>

      <div style={BUTTON_ROW_STYLE} role="group" aria-label={regionLabel}>
        {buttons.map((btn, idx) => {
          const isFocused = state.focusIndex === idx;
          const btnStyle: CSSProperties = {
            minHeight: "64px",
            padding: "10px 12px",
            borderRadius: "12px",
            backgroundColor: isFocused ? "rgba(255, 238, 0, 0.14)" : "#000000",
            color: isFocused ? "#ffee00" : "#ffffff",
            border: isFocused ? "3px solid #ffee00" : "2.5px solid rgba(240, 246, 255, 0.58)",
            outline: isFocused ? "4px solid #ffee00" : "none",
            outlineOffset: isFocused ? "3px" : "0",
            fontFamily: "inherit",
            fontSize: "clamp(16px, 3.3vmin, 21px)",
            fontWeight: 800,
            lineHeight: 1.15,
            letterSpacing: "0.02em",
            cursor: "pointer"
          };

          return (
            <button
              key={btn.id}
              ref={(el) => {
                btnRefs.current[idx] = el;
              }}
              type="button"
              data-dose-confirm-action={btn.id}
              data-focused={isFocused ? "true" : "false"}
              aria-current={isFocused ? "true" : undefined}
              style={btnStyle}
              onFocus={() => {
                setState((prev) =>
                  prev.focusIndex === idx ? prev : { ...prev, focusIndex: idx }
                );
              }}
              onClick={() => executeButtonAt(idx)}
            >
              {btn.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default HudDoseConfirmStrip;
