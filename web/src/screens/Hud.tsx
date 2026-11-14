// /hud : Ray-Ban Display Web App. 600x600 additive display, so black is transparent:
// black background, large saturated elements, no big white areas.
// Input: Neural Band arrives as ArrowUp/Down/Left/Right + Enter keydown; "Back" calls history.back().
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachCue, DeviceState, LiveState, Verdict } from "../../../shared/types.ts";
import { CueArrow, LEVEL_WORD, VerdictGlyph } from "../components/Icons.tsx";
import { matchVerdict, mockUnsureStrength, mockWarningIbuprofen } from "../lib/verdicts.ts";
import { demoProfile } from "../lib/storage.ts";

type HudMsg =
  | { type: "verdict"; verdict: Verdict }
  | { type: "coach"; cue: CoachCue; text: string }
  | { type: "status"; live: LiveState; detail?: string }
  | { type: "device"; device: DeviceState };

const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const SESSION = params.get("session");

type Conn = "connecting" | "open" | "retry";

export function Hud() {
  const [conn, setConn] = useState<Conn>("connecting");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [cue, setCue] = useState<{ cue: CoachCue; text: string } | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [toast, setToast] = useState("");
  const sendRef = useRef<(name: "repeat" | "log_dose" | "dismiss") => void>(() => {});
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

  const onMsg = useCallback((m: HudMsg) => {
    if (m.type === "verdict") {
      setVerdict(m.verdict);
      setCue(null);
      navigator.vibrate?.(m.verdict.level === "warning" ? [200, 80, 200] : 80);
    } else if (m.type === "coach") {
      setCue({ cue: m.cue, text: m.text });
      if (m.cue !== "ok") setVerdict(null);
    } else if (m.type === "status") setLive(m.live);
    else if (m.type === "device") setDevice(m.device);
  }, []);

  // ---- transport: real /hud-ws with backoff, or mock (BroadcastChannel from a phone tab + scripted loop)
  useEffect(() => {
    if (MOCK) {
      setConn("open");
      let gotPhone = false;
      let ch: BroadcastChannel | null = null;
      if (SESSION) {
        try {
          ch = new BroadcastChannel("holdup-hud-" + SESSION.toUpperCase());
          ch.onmessage = (e) => {
            gotPhone = true;
            onMsg(e.data as HudMsg);
          };
        } catch {
          /* no BroadcastChannel */
        }
      }
      sendRef.current = (name) => ch?.postMessage({ type: "hud_event", name });
      const p = demoProfile();
      const script: [number, HudMsg][] = [
        [0, { type: "status", live: "open" }],
        [600, { type: "device", device: { connected: true, worn: true, battery: 78, streaming: true, source: "glasses" } }],
        [1500, { type: "coach", cue: "other_side", text: "Turn it around" }],
        [4000, { type: "coach", cue: "closer", text: "A bit closer" }],
        [6000, { type: "coach", cue: "hold_still", text: "Hold still" }],
        [8000, { type: "verdict", verdict: matchVerdict(p, p.meds[0]) }],
        [16000, { type: "coach", cue: "rotate_left", text: "Turn it left" }],
        [18500, { type: "verdict", verdict: mockWarningIbuprofen() }],
        [26000, { type: "coach", cue: "more_light", text: "More light" }],
        [28500, { type: "verdict", verdict: mockUnsureStrength() }],
      ];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const run = () => {
        for (const [ms, m] of script) timers.push(setTimeout(() => !gotPhone && onMsg(m), ms));
        timers.push(setTimeout(() => !gotPhone && run(), 36000));
      };
      run();
      return () => {
        timers.forEach(clearTimeout);
        ch?.close();
      };
    }

    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/hud-ws${SESSION ? `?session=${encodeURIComponent(SESSION)}` : ""}`);
      setConn(attempt ? "retry" : "connecting");
      ws.onopen = () => {
        attempt = 0;
        setConn("open");
      };
      ws.onmessage = (e) => {
        try {
          onMsg(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setConn("retry");
        const delay = Math.min(8000, 500 * 2 ** attempt++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    sendRef.current = (name) => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "event", name }));
    };
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [onMsg]);

  const act = useCallback((name: "repeat" | "log_dose" | "dismiss") => {
    sendRef.current(name);
    if (name === "dismiss") {
      setVerdict(null);
      setCue(null);
    }
    setToast(name === "repeat" ? "Repeating" : name === "log_dose" ? "Dose logged" : "");
    setTimeout(() => setToast(""), 1600);
  }, []);

  // ---- input: D-pad focus movement, Enter = click (native), Escape / Back = dismiss
  useEffect(() => {
    history.pushState({ hud: 1 }, "");
    const onPop = () => {
      act("dismiss");
      history.pushState({ hud: 1 }, ""); // stay in the app
    };
    const onKey = (e: KeyboardEvent) => {
      const list = btns.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        list[(i + 1 + list.length) % list.length]?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      } else if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        act("dismiss");
      } else if (e.key === "Enter" && i < 0) {
        e.preventDefault();
        act("repeat");
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    btns.current[0]?.focus();
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, [act]);

  const level = verdict?.level ?? "";
  const glassesNote = device && (!device.connected || !device.worn) ? "Using phone camera" : device?.battery != null && device.battery <= 15 ? `Glasses battery ${device.battery}%` : "";

  return (
    <div className={`hud ${level}`}>
      <div className="top">
        <span className={`conn ${conn === "open" ? "on" : conn === "retry" ? "retry" : ""}`} aria-hidden="true" />
        <span>{conn === "open" ? (live === "degraded" ? "Snapshot mode" : "HoldUp") : conn === "retry" ? "Reconnecting…" : "Connecting…"}</span>
        <span style={{ marginLeft: "auto", color: "#bbb" }}>{toast || glassesNote}</span>
      </div>

      <div className="center" role="status" aria-live="assertive" aria-atomic="true">
        {verdict ? (
          <>
            <div className="vrow">
              <span style={{ color: `var(--${verdict.level === "info" ? "muted" : verdict.level})` }}>
                <VerdictGlyph level={verdict.level} size={96} />
              </span>
              <span className="lvl">{LEVEL_WORD[verdict.level]}</span>
            </div>
            <p className="big">{verdict.headline}</p>
            {verdict.matchedMedId && verdict.takenToday != null ? <p className="sub">{verdict.takenToday ? "Already taken today" : "Not taken today"}</p> : null}
          </>
        ) : cue ? (
          <>
            <span style={{ color: "var(--accent)" }}>
              <CueArrow cue={cue.cue} size={120} />
            </span>
            <p className="big">{cue.text}</p>
          </>
        ) : (
          <>
            <p className="big" style={{ color: "var(--accent)" }}>
              Hold it up.
            </p>
            <p className="sub">Ask: "Is this my evening pill?"</p>
          </>
        )}
      </div>

      <div className="acts">
        <button ref={(el) => void (btns.current[0] = el)} onClick={() => act("repeat")}>
          Repeat
        </button>
        <button ref={(el) => void (btns.current[1] = el)} onClick={() => act("log_dose")} disabled={!verdict?.matchedMedId} style={!verdict?.matchedMedId ? { opacity: 0.4 } : undefined}>
          I took it
        </button>
        <button ref={(el) => void (btns.current[2] = el)} onClick={() => act("dismiss")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
