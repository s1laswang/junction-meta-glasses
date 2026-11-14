import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  CoachCue,
  DeviceState,
  LiveState,
  ServerMsg,
  Verdict,
  VerdictLevel
} from "../../../shared/types.ts";

export type HudState = {
  connected: boolean;
  live: LiveState;
  coach: { cue: CoachCue; text: string } | null;
  verdict: Verdict | null;
  device: DeviceState | null;
  dismissed: boolean;
  speechEnabled: boolean;
  focusIndex: number;
};

export type HudWsLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type HudAppProps = {
  sessionParam?: string | null;
  speak?: boolean;
  initialState?: Partial<HudState>;
  createWs?: (url: string) => HudWsLike;
};

type HudActionName = "log_dose" | "repeat" | "dismiss";

type HudActionSpec = {
  name: HudActionName;
  label: string;
};

type VerdictChannelSpec = {
  badge: "MATCH" | "WARNING" | "UNSURE" | "INFO";
  shape: "circle" | "triangle" | "diamond" | "square";
  color: string;
};

const HUD_ACTIONS: readonly HudActionSpec[] = [
  { name: "log_dose", label: "Log Dose" },
  { name: "repeat", label: "Repeat" },
  { name: "dismiss", label: "Dismiss" }
];

const VERDICT_CHANNELS: Record<VerdictLevel, VerdictChannelSpec> = {
  match: { badge: "MATCH", shape: "circle", color: "#22ff88" },
  warning: { badge: "WARNING", shape: "triangle", color: "#ffbb22" },
  unsure: { badge: "UNSURE", shape: "diamond", color: "#38d6ff" },
  info: { badge: "INFO", shape: "square", color: "#f0f6ff" }
};

const COACH_BADGES: Record<CoachCue, string> = {
  rotate_left: "ROTATE LEFT",
  rotate_right: "ROTATE RIGHT",
  closer: "MOVE CLOSER",
  farther: "MOVE FARTHER",
  more_light: "MORE LIGHT",
  hold_still: "HOLD STILL",
  other_side: "OTHER SIDE",
  ok: "LOCKED ON"
};

const SESSION_ID_PATTERN = /^[\w-]{4,64}$/;
const WS_READY_OPEN = 1;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;
const ACTION_DEBOUNCE_MS = 150;
const HEADLINE_MAX_WORDS = 8;
const EM_DASH_CHAR = String.fromCharCode(8212);
const EN_DASH_CHAR = String.fromCharCode(8211);
const DOUBLE_SLASH = "\x2f\x2f";
const HUD_CSS_HREF = new URL("./hud.css", import.meta.url).href;

export function sanitizeHudText(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  return input
    .split(EM_DASH_CHAR)
    .join(": ")
    .split(EN_DASH_CHAR)
    .join("-")
    .replace(/\s+/g, " ")
    .trim();
}

export function clampHudHeadline(raw: string): string {
  const cleaned = sanitizeHudText(raw);
  if (!cleaned) {
    return "";
  }
  const tokens = cleaned.split(/\s+/);
  if (tokens.length <= HEADLINE_MAX_WORDS) {
    return tokens.join(" ").replace(/[,.;:]+$/, "");
  }
  return tokens
    .slice(0, HEADLINE_MAX_WORDS)
    .join(" ")
    .replace(/[,.;:]+$/, "");
}

export function validateHudSessionParam(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readSearchParams(search: string | undefined): URLSearchParams {
  if (typeof search !== "string" || search.length === 0) {
    return new URLSearchParams();
  }
  const withoutHash = search.split("#")[0] ?? "";
  return new URLSearchParams(withoutHash);
}

export function resolveHudSession(
  explicitSession?: string | null,
  search?: string
): string | null {
  if (explicitSession !== undefined) {
    return validateHudSessionParam(explicitSession);
  }
  const effectiveSearch =
    search !== undefined
      ? search
      : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
  const params = readSearchParams(effectiveSearch);
  return validateHudSessionParam(params.get("session"));
}

export function resolveHudSpeak(explicitSpeak?: boolean, search?: string): boolean {
  if (typeof explicitSpeak === "boolean") {
    return explicitSpeak;
  }
  const effectiveSearch =
    search !== undefined
      ? search
      : typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
  const params = readSearchParams(effectiveSearch);
  const raw = params.get("speak");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function buildHudWsUrl(
  sessionParam?: string | null,
  locationLike?: { protocol?: string; host?: string; search?: string }
): string {
  const loc =
    locationLike ??
    (typeof window !== "undefined" && window.location ? window.location : undefined);
  const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host =
    typeof loc?.host === "string" && loc.host.trim().length > 0
      ? loc.host.trim()
      : "localhost:8787";
  const resolvedSession = resolveHudSession(sessionParam, loc?.search);
  const base = `${protocol}${DOUBLE_SLASH}${host}/hud-ws`;
  return resolvedSession ? `${base}?session=${encodeURIComponent(resolvedSession)}` : base;
}

export function computeHudReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(10, Math.trunc(Number.isFinite(attempt) ? attempt : 0)));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** safeAttempt);
}

export function initialHudState(opts?: { speechEnabled?: boolean }): HudState {
  return {
    connected: false,
    live: "closed",
    coach: null,
    verdict: null,
    device: null,
    dismissed: false,
    speechEnabled: Boolean(opts?.speechEnabled),
    focusIndex: 1
  };
}

export function reduceHudServerMsg(state: HudState, msg: ServerMsg): HudState {
  switch (msg.type) {
    case "verdict":
      return {
        ...state,
        verdict: msg.verdict,
        dismissed: false,
        coach: null
      };
    case "coach":
      return {
        ...state,
        coach: {
          cue: msg.cue,
          text: sanitizeHudText(msg.text)
        }
      };
    case "status":
      return {
        ...state,
        live: msg.live
      };
    case "device":
      return {
        ...state,
        device: msg.device
      };
    default:
      return state;
  }
}

export function nextFocusIndex(current: number, count: number, key: string): number {
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

function parseHudWireMessage(raw: unknown): ServerMsg | null {
  try {
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        return parsed as ServerMsg;
      }
      return null;
    }
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const text = new TextDecoder().decode(raw);
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        return parsed as ServerMsg;
      }
      return null;
    }
    if (raw && typeof raw === "object" && "type" in raw) {
      return raw as ServerMsg;
    }
  } catch {
    return null;
  }
  return null;
}

function speakOnGlasses(text: string): void {
  const clean = sanitizeHudText(text);
  if (!clean) {
    return;
  }
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = "en-US";
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {
    return;
  }
}

function cancelGlassesSpeech(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    return;
  }
}

function defaultCreateHudWs(url: string): HudWsLike {
  return new WebSocket(url) as unknown as HudWsLike;
}

function VerdictChannelIcon({ level, color }: { level: VerdictLevel; color: string }) {
  if (level === "match") {
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <circle cx="20" cy="20" r="16" stroke={color} strokeWidth="3.6" />
        <path
          d="M12.5 20.5L17.6 25.6L28 14.8"
          stroke={color}
          strokeWidth="3.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (level === "warning") {
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M20 4.5L36.5 34H3.5L20 4.5Z"
          stroke={color}
          strokeWidth="3.6"
          strokeLinejoin="round"
        />
        <path d="M20 15V24" stroke={color} strokeWidth="3.8" strokeLinecap="round" />
        <circle cx="20" cy="29.2" r="2.1" fill={color} />
      </svg>
    );
  }

  if (level === "unsure") {
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M20 3L37 20L20 37L3 20L20 3Z"
          stroke={color}
          strokeWidth="3.6"
          strokeLinejoin="round"
        />
        <path
          d="M16.4 15.6C16.4 13.5 18 12 20.2 12C22.4 12 24 13.4 24 15.3C24 17.1 22.8 18 21.3 19C20.3 19.7 20 20.4 20 21.8"
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx="20" cy="26.8" r="2" fill={color} />
      </svg>
    );
  }

  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="30" height="30" stroke={color} strokeWidth="3.6" />
      <circle cx="20" cy="13.2" r="2.1" fill={color} />
      <path d="M20 18.8V28.5" stroke={color} strokeWidth="3.8" strokeLinecap="round" />
    </svg>
  );
}

function CoachDirectionSvg({ cue }: { cue: CoachCue }) {
  const color = cue === "ok" ? "#22ff88" : cue === "more_light" ? "#ffbb22" : "#38d6ff";

  switch (cue) {
    case "rotate_left":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M46 44A18 18 0 1 0 20 20"
            stroke={color}
            strokeWidth="4.2"
            strokeLinecap="round"
          />
          <path
            d="M18 10V22H30"
            stroke={color}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "rotate_right":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M18 44A18 18 0 1 1 44 20"
            stroke={color}
            strokeWidth="4.2"
            strokeLinecap="round"
          />
          <path
            d="M46 10V22H34"
            stroke={color}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "closer":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M32 50V16M20 28L32 16L44 28"
            stroke={color}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 20V12H20M52 20V12H44"
            stroke={color}
            strokeWidth="3.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "farther":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M32 14V48M20 36L32 48L44 36"
            stroke={color}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 44V52H20M52 44V52H44"
            stroke={color}
            strokeWidth="3.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "more_light":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <circle cx="32" cy="32" r="10.5" stroke={color} strokeWidth="4" />
          <path
            d="M32 8V15M32 49V56M8 32H15M49 32H56M15 15L20 20M44 44L49 49M49 15L44 20M20 44L15 49"
            stroke={color}
            strokeWidth="3.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "hold_still":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M14 24V14H24M50 24V14H40M14 40V50H24M50 40V50H40"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="32" cy="32" r="5.5" fill={color} />
        </svg>
      );
    case "other_side":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path
            d="M12 24H50L41 15M52 40H14L23 49"
            stroke={color}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "ok":
      return (
        <svg width="76" height="76" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <circle cx="32" cy="32" r="22" stroke={color} strokeWidth="4" />
          <path
            d="M21 32.8L28.5 40.2L43.5 24.8"
            stroke={color}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function StandbyReticleSvg() {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true">
      <path
        d="M14 32V14H32M64 14H82V32M14 64V82H32M64 82H82V64"
        stroke="#22ff88"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="48" cy="48" r="4" fill="#22ff88" />
    </svg>
  );
}

function formatDeviceIndicator(device: DeviceState | null): {
  label: string;
  warn: boolean;
} {
  if (!device) {
    return { label: "GLASSES STANDBY", warn: false };
  }
  const hasBattery = typeof device.battery === "number" && Number.isFinite(device.battery);
  const clampedBattery = hasBattery
    ? Math.max(0, Math.min(100, Math.round(device.battery as number)))
    : null;
  const batteryText = clampedBattery !== null ? ` ${clampedBattery}%` : "";
  const lowBattery = clampedBattery !== null && clampedBattery < 15;

  if (device.connected) {
    const wornLabel = device.worn ? "WORN" : "DOFFED";
    return {
      label: `${wornLabel}${batteryText}`,
      warn: !device.worn || lowBattery
    };
  }
  if (device.source === "glasses") {
    return { label: `GLASSES OFF${batteryText}`, warn: true };
  }
  return { label: "PHONE EYE", warn: false };
}

export function HudApp(): React.JSX.Element;
export function HudApp(props: HudAppProps): React.JSX.Element;
export function HudApp(props: HudAppProps = {}): React.JSX.Element {
  const resolvedSession = resolveHudSession(props.sessionParam);
  const resolvedSpeak = resolveHudSpeak(props.speak);
  const createWsRef = useRef<(url: string) => HudWsLike>(props.createWs ?? defaultCreateHudWs);
  createWsRef.current = props.createWs ?? defaultCreateHudWs;

  const [state, setState] = useState<HudState>(() => ({
    ...initialHudState({ speechEnabled: resolvedSpeak }),
    ...props.initialState
  }));

  const stateRef = useRef<HudState>(state);
  stateRef.current = state;

  const wsRef = useRef<HudWsLike | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([null, null, null]);
  const lastActionAtRef = useRef<number>(0);
  const verdictHistoryPushedRef = useRef<boolean>(false);

  useEffect(() => {
    setState((prev) =>
      prev.speechEnabled === resolvedSpeak ? prev : { ...prev, speechEnabled: resolvedSpeak }
    );
  }, [resolvedSpeak]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const prevHtmlBg = htmlEl.style.backgroundColor;
    const prevBodyBg = bodyEl.style.backgroundColor;
    const prevBodyMargin = bodyEl.style.margin;
    const prevBodyOverflow = bodyEl.style.overflow;

    htmlEl.style.backgroundColor = "#000000";
    bodyEl.style.backgroundColor = "#000000";
    bodyEl.style.margin = "0";
    bodyEl.style.overflow = "hidden";

    return () => {
      htmlEl.style.backgroundColor = prevHtmlBg;
      bodyEl.style.backgroundColor = prevBodyBg;
      bodyEl.style.margin = prevBodyMargin;
      bodyEl.style.overflow = prevBodyOverflow;
    };
  }, []);

  const sendHudEvent = useCallback((name: HudActionName): void => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WS_READY_OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "event", name }));
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (typeof WebSocket === "undefined" && !props?.createWs) {
      return;
    }

    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      const wsUrl = buildHudWsUrl(props?.sessionParam);
      let socket: HudWsLike;
      try {
        socket = createWsRef.current(wsUrl);
      } catch {
        const delay = computeHudReconnectDelayMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
        return;
      }

      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed || wsRef.current !== socket) {
          return;
        }
        attempt = 0;
        setState((prev) => ({ ...prev, connected: true }));
      };

      socket.onmessage = (ev) => {
        if (disposed || wsRef.current !== socket) {
          return;
        }
        const parsed = parseHudWireMessage(ev.data);
        if (!parsed) {
          return;
        }
        setState((prev) => reduceHudServerMsg(prev, parsed));
        if (parsed.type === "verdict" && stateRef.current.speechEnabled) {
          speakOnGlasses(parsed.verdict.speech);
        }
      };

      socket.onerror = () => {};

      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
        if (disposed) {
          return;
        }
        setState((prev) => ({ ...prev, connected: false }));
        clearReconnect();
        const delay = computeHudReconnectDelayMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearReconnect();
      cancelGlassesSpeech();
      const active = wsRef.current;
      wsRef.current = null;
      if (active) {
        active.onopen = null;
        active.onmessage = null;
        active.onclose = null;
        active.onerror = null;
        try {
          active.close();
        } catch {
          return;
        }
      }
    };
  }, [props?.sessionParam, props?.createWs]);

  const activeVerdict = state.verdict && !state.dismissed ? state.verdict : null;

  useEffect(() => {
    if (typeof window === "undefined" || !window.history) {
      return;
    }
    try {
      const currentState = window.history.state as { hudView?: string } | null;
      if (!currentState || typeof currentState.hudView !== "string") {
        window.history.replaceState({ hudView: "standby" }, "");
      }
    } catch {
      return;
    }

    const onPopState = () => {
      verdictHistoryPushedRef.current = false;
      cancelGlassesSpeech();
      setState((prev) => (prev.dismissed ? prev : { ...prev, dismissed: true }));
      sendHudEvent("dismiss");
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [sendHudEvent]);

  useEffect(() => {
    if (!activeVerdict || typeof window === "undefined" || !window.history) {
      return;
    }
    try {
      const currentState = window.history.state as { hudView?: string } | null;
      if (verdictHistoryPushedRef.current || currentState?.hudView === "verdict") {
        window.history.replaceState({ hudView: "verdict" }, "");
      } else {
        window.history.pushState({ hudView: "verdict" }, "");
        verdictHistoryPushedRef.current = true;
      }
    } catch {
      return;
    }
  }, [activeVerdict]);

  const triggerActionAt = useCallback(
    (index: number) => {
      const now = Date.now();
      if (now - lastActionAtRef.current < ACTION_DEBOUNCE_MS) {
        return;
      }
      const total = HUD_ACTIONS.length;
      const safeIndex = ((index % total) + total) % total;
      const action = HUD_ACTIONS[safeIndex];
      const current = stateRef.current;
      const logDoseEnabled = Boolean(
        !current.dismissed && current.verdict?.matchedMedId && !current.verdict?.takenToday
      );

      if (action.name === "log_dose") {
        if (!logDoseEnabled) {
          return;
        }
        lastActionAtRef.current = now;
        setState((prev) => ({ ...prev, focusIndex: safeIndex }));
        sendHudEvent("log_dose");
        return;
      }

      if (action.name === "repeat") {
        lastActionAtRef.current = now;
        setState((prev) => ({ ...prev, focusIndex: safeIndex }));
        sendHudEvent("repeat");
        if (current.speechEnabled && current.verdict && !current.dismissed) {
          speakOnGlasses(current.verdict.speech);
        }
        return;
      }

      lastActionAtRef.current = now;
      cancelGlassesSpeech();
      setState((prev) => ({
        ...prev,
        focusIndex: safeIndex,
        dismissed: true
      }));
      sendHudEvent("dismiss");
    },
    [sendHudEvent]
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowRight" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        const nextIdx = nextFocusIndex(
          stateRef.current.focusIndex,
          HUD_ACTIONS.length,
          event.key
        );
        setState((prev) => ({ ...prev, focusIndex: nextIdx }));
        const btn = buttonRefs.current[nextIdx];
        if (btn && !btn.disabled) {
          btn.focus({ preventScroll: true });
        } else if (typeof document !== "undefined") {
          const active = document.activeElement as HTMLElement | null;
          if (active && typeof active.blur === "function") {
            active.blur();
          }
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        triggerActionAt(stateRef.current.focusIndex);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [triggerActionAt]);

  const canLogDose = Boolean(
    !state.dismissed && state.verdict?.matchedMedId && !state.verdict?.takenToday
  );
  const deviceInfo = formatDeviceIndicator(state.device);
  const connText = state.connected
    ? state.live === "open"
      ? "HUD LIVE"
      : state.live === "reconnecting" || state.live === "degraded"
        ? `HUD ${state.live.toUpperCase()}`
        : "HUD SYNC"
    : "RECONNECTING";
  const sessionLabel = resolvedSession
    ? `SESSION ${resolvedSession.slice(0, 8)}`
    : "AUTO SESSION";
  const shouldLinkStylesheet =
    typeof window !== "undefined" && !HUD_CSS_HREF.startsWith("file:");

  const renderMainCard = () => {
    if (activeVerdict) {
      const channel = VERDICT_CHANNELS[activeVerdict.level];
      const clampedHeadline = clampHudHeadline(activeVerdict.headline);
      const isMedication =
        activeVerdict.read.kind === "medication" ||
        Boolean(activeVerdict.matchedMedId) ||
        typeof activeVerdict.takenToday === "boolean";
      const productText = sanitizeHudText(activeVerdict.read.product.value ?? "");
      const strengthText = sanitizeHudText(activeVerdict.read.strength.value ?? "");
      const speechCaption = sanitizeHudText(activeVerdict.speech);

      return (
        <section
          className={`hud-card hud-card--${activeVerdict.level}`}
          data-verdict-level={activeVerdict.level}
          data-verdict-shape={channel.shape}
          aria-label={`${channel.badge} verdict card`}
          style={{
            backgroundColor: "#000000",
            borderColor: channel.color
          }}
        >
          <div className="hud-card-header">
            <div className="hud-badge-wrap">
              <span className="hud-shape-frame" data-shape={channel.shape}>
                <VerdictChannelIcon level={activeVerdict.level} color={channel.color} />
              </span>
              <span
                className={`hud-badge hud-badge--${activeVerdict.level}`}
                style={{ color: channel.color, borderColor: channel.color }}
              >
                {channel.badge}
              </span>
            </div>
          </div>

          <h1 className="hud-headline">{clampedHeadline}</h1>

          {isMedication && (productText || strengthText || typeof activeVerdict.takenToday === "boolean") ? (
            <div className="hud-meta-row">
              {productText ? (
                <span className="hud-chip">{productText}</span>
              ) : null}
              {strengthText ? (
                <span className="hud-chip hud-chip--strength" data-hud-strength={strengthText}>
                  {strengthText}
                </span>
              ) : null}
              {typeof activeVerdict.takenToday === "boolean" ? (
                <span
                  className={`hud-chip ${activeVerdict.takenToday ? "hud-chip--taken" : "hud-chip--ready"}`}
                  data-taken-today={activeVerdict.takenToday ? "true" : "false"}
                >
                  {activeVerdict.takenToday ? "TAKEN TODAY" : "NOT TAKEN TODAY"}
                </span>
              ) : null}
            </div>
          ) : null}

          {speechCaption ? (
            <p className="hud-speech-caption">{speechCaption}</p>
          ) : null}
        </section>
      );
    }

    if (state.coach) {
      const cueModifier =
        state.coach.cue === "ok"
          ? " hud-coach-card--ok"
          : state.coach.cue === "more_light"
            ? " hud-coach-card--light"
            : "";
      return (
        <div
          className={`hud-coach-card${cueModifier}`}
          data-coach-cue={state.coach.cue}
          role="status"
          aria-live="polite"
          style={{ backgroundColor: "#000000" }}
        >
          <CoachDirectionSvg cue={state.coach.cue} />
          <span className="hud-coach-cue-badge">{COACH_BADGES[state.coach.cue]}</span>
          <p className="hud-coach-text">{sanitizeHudText(state.coach.text)}</p>
        </div>
      );
    }

    return (
      <div
        className="hud-standby"
        data-hud-standby="true"
        role="status"
        aria-live="polite"
        style={{ backgroundColor: "#000000" }}
      >
        <StandbyReticleSvg />
        <p className="hud-standby-label">HoldUp Ready: Hold item in view</p>
      </div>
    );
  };

  return (
    <main
      className="hud-root"
      data-hud-surface="600x600-additive"
      aria-label="HoldUp Ray-Ban Display HUD"
      style={{ backgroundColor: "#000000", color: "#ffffff" }}
    >
      {shouldLinkStylesheet ? <link rel="stylesheet" href={HUD_CSS_HREF} /> : null}

      <header className="hud-topbar" aria-label="Waveguide status strip">
        <span className="hud-status-cluster">
          <span
            className={`hud-conn-dot ${state.connected ? "hud-conn-dot--online" : "hud-conn-dot--offline"}`}
            aria-hidden="true"
          />
          <span>{connText}</span>
        </span>

        <span className={`hud-device-pill${deviceInfo.warn ? " hud-device-pill--warn" : ""}`}>
          {deviceInfo.label}
        </span>

        <span className="hud-session-pill">
          {sessionLabel}
          {state.speechEnabled ? " | SPEAK" : ""}
        </span>
      </header>

      <div className="hud-stage">{renderMainCard()}</div>

      <nav className="hud-actions" aria-label="Neural Band HUD actions">
        {HUD_ACTIONS.map((action, idx) => {
          const isFocused = state.focusIndex === idx;
          const isDisabled = action.name === "log_dose" && !canLogDose;
          return (
            <button
              key={action.name}
              ref={(el) => {
                buttonRefs.current[idx] = el;
              }}
              type="button"
              className="hud-action-btn"
              disabled={isDisabled}
              aria-disabled={isDisabled}
              data-hud-action={action.name}
              data-focused={isFocused ? "true" : "false"}
              aria-current={isFocused ? "true" : undefined}
              onFocus={() => {
                setState((prev) =>
                  prev.focusIndex === idx ? prev : { ...prev, focusIndex: idx }
                );
              }}
              onClick={() => triggerActionAt(idx)}
            >
              {action.label}
            </button>
          );
        })}
      </nav>
    </main>
  );
}

export default HudApp;
