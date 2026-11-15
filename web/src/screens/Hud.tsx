// /hud/ : Ray-Ban Display Web App (see docs/HUD_SPEC.md).
// Additive 600x600 display: black is transparent, so draw one bounded card, bright and thick.
// Input: the glasses' Chromium does spatial navigation on arrow keys and Enter clicks the focused
// native <button>. We don't intercept arrows/Enter. System Back calls history.back().
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachCue, DeviceState, LiveState, ScenePosition, Verdict, VerdictLevel } from "../../../shared/types.ts";
import { CueArrow } from "../components/Icons.tsx";
import { matchVerdict, mockFoodNuts, mockScene, mockUnsureStrength, mockWarningIbuprofen } from "../lib/verdicts.ts";
import { demoProfile } from "../lib/storage.ts";
import { MOCK_HUD_CHANNEL } from "../lib/mock.ts";
import { keyHeaders, withKey } from "../lib/key.ts";

type HudMsg =
  | { type: "verdict"; verdict: Verdict }
  | { type: "coach"; cue: CoachCue; text: string }
  | { type: "status"; live: LiveState; detail?: string }
  | { type: "device"; device: DeviceState };

const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const SESSION = params.get("session");
const BACKOFF = [1000, 2000, 5000];
const SPEAK_KEY = "holdup.hud.speak";

export const LEVEL: Record<VerdictLevel, { glyph: string; word: string; color: string }> = {
  match: { glyph: "✓", word: "RIGHT ONE", color: "#66BB6A" },
  warning: { glyph: "⚠", word: "CHECK", color: "#FFCA28" },
  unsure: { glyph: "?", word: "NOT SURE", color: "#4FC3F7" },
  info: { glyph: "i", word: "INFO", color: "#FFFFFF" },
};

type Conn = "connecting" | "open" | "retry";

const SLOT: Record<ScenePosition, number> = { far_left: 0, left: 1, center: 2, right: 3, far_right: 4 };
const POS_WORD: Record<ScenePosition, string> = { far_left: "far left", left: "left", center: "middle", right: "right", far_right: "far right" };

function hudSpeechLang() {
  try {
    const raw = localStorage.getItem("holdup.profile");
    const lang = raw ? (JSON.parse(raw) as { lang?: unknown } | null)?.lang : undefined;
    if (lang === "fi") return "fi-FI";
    if (lang === "sv") return "sv-SE";
  } catch {}
  return "en-US";
}

function stopHudSpeech() {
  try {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  } catch {}
}

/** "Which one?" on the display: glyphs on a left-to-right strip, the target big, its headline below. */
function HudScene({ verdict, stale }: { verdict: Verdict; stale: boolean }) {
  const items = [...(verdict.items ?? [])].sort((a, b) => SLOT[a.position] - SLOT[b.position]);
  let t = verdict.matchedMedId ? items.findIndex((i) => i.matchedMedId === verdict.matchedMedId) : -1;
  if (t < 0) t = items.findIndex((i) => i.level === "match");
  const target = t >= 0 ? items[t] : null;
  // use 3 columns when only left/center/right appear, 5 otherwise
  const five = items.some((i) => i.position === "far_left" || i.position === "far_right");
  const col = (p: ScenePosition) => (five ? SLOT[p] + 1 : ({ far_left: 1, left: 1, center: 2, right: 3, far_right: 3 } as const)[p]);
  return (
    <section className={`hud-card scene-card ${stale ? "stale" : ""}`} style={{ "--lvl": target ? LEVEL[target.level].color : "#fff" } as React.CSSProperties}>
      <p className="hud-level">
        WHICH ONE{stale ? <span className="hud-old"> (old)</span> : null}
      </p>
      <ol className="hud-strip" style={{ gridTemplateColumns: `repeat(${five ? 5 : 3}, 1fr)` }} aria-label="Packages, left to right">
        {items.map((it, i) => (
          <li key={i} className={`hud-slot ${i === t ? "target" : ""}`} style={{ gridColumn: col(it.position), "--lvl": LEVEL[it.level].color } as React.CSSProperties}>
            <span className="hud-glyph" aria-hidden="true">
              {LEVEL[it.level].glyph}
            </span>
            <span className="sr-only">
              {POS_WORD[it.position]}: {LEVEL[it.level].word}, {it.headline}
            </span>
          </li>
        ))}
      </ol>
      <p className="hud-headline">{verdict.headline}</p>
      {target ? (
        <p className="hud-fields">
          {POS_WORD[target.position].toUpperCase()}: {target.headline}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The card the Display shows (key prompt, coach cue, scene strip, verdict or idle). Pure, so the /stage
 * projector renders the exact same markup as a live replica.
 */
export function HudCard({ keyNeeded, cue, verdict, stale }: { keyNeeded: boolean; cue: { cue: CoachCue; text: string } | null; verdict: Verdict | null; stale: boolean }) {
  const L = verdict ? LEVEL[verdict.level] : null;
  const headline = verdict?.headline.toLowerCase() ?? "";
  const keyFields = [verdict?.read.product.value, verdict?.read.strength.value].filter((x): x is string => !!x && !headline.includes(x.toLowerCase()));
  return (
    keyNeeded ? (
      <section className="hud-card" style={{ borderColor: "#FFCA28" }}>
        <p className="hud-headline">Access key needed</p>
        <p className="hud-small">Open the HUD link with its ?key=… (set it in the Meta AI app).</p>
      </section>
    ) : cue && !verdict ? (
      <section className="hud-card cue-card">
        <span className="hud-cue-glyph">
          <CueArrow cue={cue.cue} size={104} />
        </span>
        <p className="hud-headline">{cue.text}</p>
      </section>
    ) : verdict && L && verdict.mode === "scene" && verdict.items?.length ? (
      <HudScene verdict={verdict} stale={stale} />
    ) : verdict && L ? (
      <section className={`hud-card verdict-card ${stale ? "stale" : ""}`} style={{ "--lvl": L.color } as React.CSSProperties}>
        <p className="hud-level">
          <span className="hud-glyph" aria-hidden="true">
            {L.glyph}
          </span>{" "}
          {L.word}
          {stale ? <span className="hud-old"> (old)</span> : null}
        </p>
        <p className="hud-headline">{verdict.headline}</p>
        {keyFields.length ? <p className="hud-fields">{keyFields.join(" · ")}</p> : null}
        {verdict.crossCheck ? <p className="hud-small">{verdict.crossCheck.agrees === true ? "✓ Double-checked with pack code" : verdict.crossCheck.agrees === false ? "⚠ Pack code mismatch" : "Pack code read"}</p> : null}
        {verdict.matchedMedId && verdict.takenToday != null ? <p className="hud-small">{verdict.takenToday ? "Already taken today" : "Not taken today"}</p> : null}
        {verdict.reasons[0] ? <p className="hud-small">{verdict.reasons[0]}</p> : null}
      </section>
    ) : (
      <section className="hud-card idle-card">
        <p className="hud-headline hud-accent">Hold it up.</p>
        <p className="hud-small">Ask: "Is this my evening pill?"</p>
      </section>
    )
  );
}

export function Hud() {
  const [conn, setConn] = useState<Conn>("connecting");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [cue, setCue] = useState<{ cue: CoachCue; text: string; ts: number } | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [toast, setToast] = useState("");
  const [keyNeeded, setKeyNeeded] = useState(false);
  const [ownBattery, setOwnBattery] = useState<number | null>(null);
  const [speakOn, setSpeakOn] = useState(() => {
    try {
      return localStorage.getItem(SPEAK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const sendRef = useRef<(name: "repeat" | "log_dose" | "dismiss") => void>(() => {});
  const takeRef = useRef<HTMLButtonElement>(null);
  const repeatRef = useRef<HTMLButtonElement>(null);
  const pushed = useRef(false);
  const speakRef = useRef(speakOn);
  speakRef.current = speakOn;
  const activeRef = useRef(false);
  activeRef.current = !!(verdict || cue);

  const say = useCallback((text: string) => {
    if (!speakRef.current || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = hudSpeechLang();
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }, []);

  const onMsg = useCallback(
    (m: HudMsg) => {
      if (m.type === "verdict") {
        setVerdict(m.verdict);
        setCue(null);
        // short on purpose: the glasses speaker is audible to bystanders
        say(`${LEVEL[m.verdict.level].word.toLowerCase()}. ${m.verdict.headline}`);
      } else if (m.type === "coach") {
        setCue({ cue: m.cue, text: m.text, ts: Date.now() });
      } else if (m.type === "status") setLive(m.live);
      else if (m.type === "device") {
        setDevice(m.device);
        if (m.device.worn === false) stopHudSpeech();
      }
    },
    [say],
  );

  // coach cues clear themselves after ~3 s
  useEffect(() => {
    if (!cue) return;
    const t = setTimeout(() => setCue((c) => (c && Date.now() - c.ts >= 2900 ? null : c)), 3000);
    return () => clearTimeout(t);
  }, [cue]);

  // a new verdict: focus the most likely action, and give Back something to dismiss (one entry only)
  useEffect(() => {
    if (!verdict) return;
    (verdict.level === "match" && verdict.matchedMedId ? takeRef : repeatRef).current?.focus();
    if (!pushed.current) {
      history.pushState({ hudVerdict: 1 }, "");
      pushed.current = true;
    }
  }, [verdict]);
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      stopHudSpeech();
      setVerdict(null);
      setCue(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => () => stopHudSpeech(), []);

  // the Display's own battery, where exposed
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener: (e: string, f: () => void) => void }> };
    if (!nav.getBattery) return;
    void nav
      .getBattery()
      .then((b) => {
        const upd = () => setOwnBattery(Math.round(b.level * 100));
        upd();
        b.addEventListener("levelchange", upd);
      })
      .catch(() => {});
  }, []);

  // ---- transport: /hud-ws (session optional) with 1 s → 2 s → 5 s backoff, or ?mock=1
  useEffect(() => {
    if (MOCK) {
      setConn("open");
      let gotPhone = false;
      let ch: BroadcastChannel | null = null;
      try {
        ch = new BroadcastChannel(MOCK_HUD_CHANNEL);
        ch.onmessage = (e) => {
          const d = e.data as { type?: string } | undefined;
          if (!d || (d.type !== "verdict" && d.type !== "coach" && d.type !== "status" && d.type !== "device")) return;
          gotPhone = true;
          onMsg(d as HudMsg);
        };
        ch.postMessage({ type: "hud_hello" });
      } catch {}
      sendRef.current = (name) => ch?.postMessage({ type: "hud_event", name });
      const p = demoProfile();
      const cycle: HudMsg[] = [
        { type: "coach", cue: "other_side", text: "Turn it around" },
        { type: "verdict", verdict: matchVerdict(p, p.meds[0]) },
        { type: "coach", cue: "closer", text: "A bit closer" },
        { type: "verdict", verdict: mockWarningIbuprofen() },
        { type: "coach", cue: "rotate_left", text: "Turn it left" },
        { type: "verdict", verdict: mockUnsureStrength() },
        { type: "verdict", verdict: mockFoodNuts() },
        { type: "coach", cue: "hold_still", text: "Hold still" },
        { type: "verdict", verdict: mockScene(p) },
      ];
      onMsg({ type: "status", live: "open" });
      onMsg({ type: "device", device: { connected: true, worn: true, battery: 78, streaming: true, source: "glasses" } });
      let i = 0;
      const tick = () => !gotPhone && onMsg(cycle[i++ % cycle.length]);
      tick();
      const t = setInterval(tick, 4000);
      return () => {
        clearInterval(t);
        ch?.close();
      };
    }

    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(withKey(`${proto}//${location.host}/hud-ws${SESSION ? `?session=${encodeURIComponent(SESSION)}` : ""}`));
      setConn(attempt ? "retry" : "connecting");
      ws.onopen = () => {
        attempt = 0;
        setConn("open");
        setKeyNeeded(false);
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
        // a WS upgrade refused for a missing/wrong key looks like any drop: ask the HTTP side why
        // /api/health is open even with HOLDUP_KEY; /api/stats is protected
        void fetch("/api/stats", { headers: keyHeaders(), cache: "no-store" })
          .then((r) => setKeyNeeded(r.status === 401 || r.status === 403))
          .catch(() => {});
        timer = setTimeout(connect, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
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

  const clear = () => {
    stopHudSpeech();
    setVerdict(null);
    setCue(null);
    if (pushed.current) history.back(); // pops our one entry; popstate resets the flag
  };

  const act = (name: "repeat" | "log_dose" | "dismiss") => {
    sendRef.current(name);
    if (name === "dismiss") clear();
    if (name === "repeat" && verdict) say(verdict.headline);
    setToast(name === "repeat" ? "Repeating" : name === "log_dose" ? "Dose logged" : "");
    setTimeout(() => setToast(""), 1800);
  };

  // Escape also dismisses (desktop testing); arrows and Enter are left to the browser
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeRef.current) stopHudSpeech();
        setVerdict(null);
        setCue(null);
        if (pushed.current) history.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stale = conn !== "open" && !!verdict;
  // worn/battery may be null (unknown): only a definite false means "not usable"
  const camText = device ? (device.source === "glasses" && device.connected !== false && device.worn !== false ? "glasses camera" : "phone camera") : "";
  const batt = device?.battery != null ? `glasses ${device.battery}%` : ownBattery != null ? `display ${ownBattery}%` : "";

  return (
    <div className="hud">
      <main className="hud-main">
        <h1 className="sr-only">HoldUp display</h1>
        <div className="hud-live" aria-live="assertive" aria-atomic="true">
        <HudCard keyNeeded={keyNeeded} cue={cue} verdict={verdict} stale={stale} />
        </div>
      </main>

      <div className="hud-acts">
        <button ref={repeatRef} type="button" onClick={() => act("repeat")}>
          Repeat
        </button>
        <button ref={takeRef} type="button" onClick={() => act("log_dose")} disabled={!verdict?.matchedMedId}>
          I took it
        </button>
        <button type="button" onClick={() => act("dismiss")}>
          Dismiss
        </button>
      </div>

      <footer className="hud-status">
        <span className={`hud-dot ${conn}`} aria-hidden="true" />
        <span>{toast || (conn === "open" ? (live === "degraded" ? "snapshot mode" : live === "reconnecting" ? "AI reconnecting…" : "connected") : conn === "retry" ? "Reconnecting…" : "Connecting…")}</span>
        {camText ? <span>{camText}</span> : null}
        {batt ? <span>{batt}</span> : null}
        <button
          type="button"
          className="hud-speak"
          aria-pressed={speakOn}
          onClick={() => {
            const v = !speakOn;
            speakRef.current = v;
            setSpeakOn(v);
            if (!v) stopHudSpeech();
            try {
              localStorage.setItem(SPEAK_KEY, v ? "1" : "0");
            } catch {
              /* ignore */
            }
          }}
        >
          Speak {speakOn ? "on" : "off"}
        </button>
      </footer>
    </div>
  );
}
