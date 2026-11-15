// /stage : projector view for the live judging demo. 16:9, read-only, readable from ~10 m.
// Left: a live replica of the Ray-Ban Display HUD (the same HudCard markup). Centre: captions, coach cue,
// readiness. Right: "under the hood" numbers. Never shows camera images (the server never sends them here).
// Transport: /hud-ws?role=stage (HOLDUP_KEY as ?key=, like the HUD) or ?mock=1.
import { useEffect, useReducer, useState } from "react";
import type { CoachCue } from "../../../shared/types.ts";
import { CueArrow, Logo } from "../components/Icons.tsx";
import { HudCard } from "./Hud.tsx";
import { keyHeaders, withKey } from "../lib/key.ts";
import { MOCK_HUD_CHANNEL, MOCK_STAGE_CHANNEL } from "../lib/mock.ts";
import { demoProfile } from "../lib/storage.ts";
import {
  ALL_FEATURES,
  FEATURE_LABEL,
  STAGE_MSG_TYPES,
  VERIFY_SOURCE,
  crossCheckBadge,
  fmtMs,
  fmtSeconds,
  initialStage,
  stageReduce,
  wornText,
  type StageMsg,
  type StageState,
} from "../lib/stage.ts";
import { scriptLength, stageScript } from "../lib/stageMock.ts";

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const MOCK = params.get("mock") === "1";
const SESSION = params.get("session");
const BACKOFF = [1000, 2000, 5000];

type Conn = "connecting" | "open" | "retry";

const CUE_WORD: Record<CoachCue, string> = {
  rotate_left: "Turn left",
  rotate_right: "Turn right",
  closer: "Closer",
  farther: "Farther",
  more_light: "More light",
  hold_still: "Hold still",
  other_side: "Other side",
  ok: "Got it",
};

function reducer(s: StageState, m: StageMsg | { type: "tick" } | { type: "reset" }) {
  return m.type === "reset" ? initialStage() : stageReduce(s, m);
}

export function Stage() {
  const [s, dispatch] = useReducer(reducer, undefined, initialStage);
  const [conn, setConn] = useState<Conn>("connecting");
  const [keyNeeded, setKeyNeeded] = useState(false);
  const [driver, setDriver] = useState<"script" | "phone" | "server">(MOCK ? "script" : "server");

  useEffect(() => {
    document.title = "HoldUp stage";
    document.body.classList.add("stage-body");
    return () => document.body.classList.remove("stage-body");
  }, []);

  // cue expiry (HUD: 3 s, centre: 6 s)
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "tick" }), 250);
    return () => clearInterval(t);
  }, []);

  // ---- transport
  useEffect(() => {
    if (MOCK) {
      setConn("open");
      let fromPhone = false;
      let stageCh: BroadcastChannel | null = null;
      let hudCh: BroadcastChannel | null = null;
      try {
        stageCh = new BroadcastChannel(MOCK_STAGE_CHANNEL);
        stageCh.onmessage = (e) => {
          const m = e.data as StageMsg;
          if (!m || !STAGE_MSG_TYPES.has(m.type)) return;
          if (!fromPhone) {
            // a phone tab in mock mode took over: drop the script and follow it
            fromPhone = true;
            stop();
            dispatch({ type: "reset" });
            setDriver("phone");
          }
          dispatch(m);
        };
        // the HUD tab's own buttons (Dismiss) arrive on the HUD channel
        hudCh = new BroadcastChannel(MOCK_HUD_CHANNEL);
        hudCh.onmessage = (e) => {
          const m = e.data as StageMsg;
          if (m?.type === "hud_event") dispatch(m);
        };
      } catch {
        /* no BroadcastChannel: the script still runs */
      }
      const script = stageScript(demoProfile());
      const len = scriptLength(script);
      let timers: ReturnType<typeof setTimeout>[] = [];
      const run = () => {
        for (const [ms, m] of script) timers.push(setTimeout(() => dispatch(m), ms));
        timers.push(setTimeout(run, len));
      };
      const stop = () => {
        timers.forEach(clearTimeout);
        timers = [];
      };
      run();
      return () => {
        stop();
        stageCh?.close();
        hudCh?.close();
      };
    }

    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const q = new URLSearchParams({ role: "stage" });
      if (SESSION) q.set("session", SESSION);
      ws = new WebSocket(withKey(`${proto}//${location.host}/hud-ws?${q}`));
      setConn(attempt ? "retry" : "connecting");
      ws.onopen = () => {
        attempt = 0;
        setConn("open");
        setKeyNeeded(false);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data) as StageMsg;
          if (m && STAGE_MSG_TYPES.has(m.type)) dispatch(m);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setConn("retry");
        // same check as the HUD: a refused upgrade looks like any drop, so ask the HTTP side why
        void fetch("/api/stats", { headers: keyHeaders(), cache: "no-store" })
          .then((r) => setKeyNeeded(r.status === 401 || r.status === 403))
          .catch(() => {});
        timer = setTimeout(connect, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
      };
    };
    connect();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return <StageView s={s} conn={conn} keyNeeded={keyNeeded} driver={driver} />;
}

/** Pure view (exported for tests). */
export function StageView({ s, conn, keyNeeded, driver }: { s: StageState; conn: Conn; keyNeeded: boolean; driver: "script" | "phone" | "server" }) {
  const stale = conn !== "open" && !!s.hudVerdict;
  const m = s.metrics;
  const badge = crossCheckBadge(s.lastVerdict);
  const features = s.features ?? m?.features ?? null;
  const d = s.device;
  const source = d?.source ?? m?.source ?? null;
  const camText = source === "glasses" && d?.connected !== false && d?.worn !== false ? "Glasses camera" : source ? "Phone camera" : "–";
  const liveWord = s.live === "open" ? "Live" : s.live === "degraded" ? "Snapshot mode" : s.live === "reconnecting" ? "AI reconnecting" : s.live === "connecting" ? "Connecting" : s.live === "closed" ? "Session ended" : "Idle";
  const linkWord = conn === "open" ? (driver === "script" ? "Scripted demo" : driver === "phone" ? "Mock phone" : "Connected") : conn === "retry" ? "Reconnecting…" : "Connecting…";
  const readiness = s.readiness;
  const pct = readiness == null ? null : Math.round(readiness * 100);
  // the newer of the two lines is the one being spoken
  const userNewer = !!s.user && (!s.assistant || s.user.ts > s.assistant.ts);

  return (
    <div className="stage-fit">
      <div className="stage">
        <header className="stage-head">
          <span className="stage-brand">
            <Logo size={44} />
            HoldUp
          </span>
          <span className="stage-sub">Live demo · Meta Ray-Ban Display + Gemini Live</span>
          {driver !== "server" ? <span className="stage-mock">{driver === "script" ? "SCRIPTED (mock)" : "MOCK"}</span> : null}
          <span className={`stage-conn ${conn}`} role="status">
            <span className="stage-dot" aria-hidden="true" />
            {keyNeeded ? "Access key needed" : linkWord}
          </span>
        </header>

        <main className="stage-cols">
          <h1 className="sr-only">HoldUp stage view</h1>

          <section className="stage-col stage-left" aria-labelledby="stage-h-hud">
            <h2 id="stage-h-hud" className="stage-h">
              On the glasses
            </h2>
            <div className="stage-lens">
              <div className="hud stage-hud">
                <div className="hud-main">
                  <div className="hud-live">
                    <HudCard keyNeeded={keyNeeded} cue={s.hudCue} verdict={s.hudVerdict} stale={stale} />
                  </div>
                </div>
              </div>
            </div>
            <p className="stage-note">Ray-Ban Display, live replica{m ? (m.hud ? " · HUD attached" : " · no HUD attached") : ""}</p>
          </section>

          <section className="stage-col stage-centre" aria-labelledby="stage-h-talk">
            <h2 id="stage-h-talk" className="stage-h">
              Conversation
            </h2>
            <div className="stage-captions">
              <p className={`stage-cap user ${userNewer ? "now" : ""}`}>
                <span className="stage-who">You</span>
                <span className="stage-said">{s.user?.text || "…"}</span>
              </p>
              <p className={`stage-cap assistant ${!userNewer && s.assistant ? "now" : ""}`}>
                <span className="stage-who">HoldUp</span>
                <span className="stage-said">{s.assistant?.text || "…"}</span>
              </p>
            </div>

            <div className={`stage-cue ${s.checking ? "checking" : s.coach ? "on" : ""}`}>
              <span className="stage-cue-glyph">{s.checking ? <span className="stage-spin" aria-hidden="true" /> : <CueArrow cue={s.coach?.cue ?? null} size={88} />}</span>
              <span className="stage-cue-text">
                <span className="stage-k">{s.checking ? "Reading the label" : "Coach cue"}</span>
                <span className="stage-v">{s.checking ? "Checking…" : s.coach ? s.coach.text || CUE_WORD[s.coach.cue] : "–"}</span>
              </span>
            </div>

            <div className="stage-ready">
              <span className="stage-k" id="stage-ready-label">
                Label readiness (sonar)
              </span>
              <div className="stage-meter" role="meter" aria-labelledby="stage-ready-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-valuetext={pct == null ? "no reading yet" : `${pct} percent${pct >= 80 ? ", readable" : ""}`}>
                <span className="stage-meter-fill" style={{ width: `${pct ?? 0}%` }} />
                <span className="stage-meter-mark" aria-hidden="true" />
              </div>
              <span className="stage-ready-val">{pct == null ? "–" : `${pct}%${pct >= 80 ? " · readable" : ""}`}</span>
            </div>
          </section>

          <section className="stage-col stage-right" aria-labelledby="stage-h-hood">
            <h2 id="stage-h-hood" className="stage-h">
              Under the hood
            </h2>
            <dl className="stage-tiles">
              <div className="stage-tile wide">
                <dt>Live model</dt>
                <dd className="mono">{s.model ?? m?.model ?? "–"}</dd>
              </div>
              <div className="stage-tile">
                <dt>Ask → voice</dt>
                <dd>{fmtSeconds(m?.firstAudioS)}</dd>
                {m?.firstAudioP50S != null ? <dd className="stage-tile-sub">p50 {fmtSeconds(m.firstAudioP50S)} · n={m.turns}</dd> : null}
              </div>
              <div className="stage-tile">
                <dt>Label check</dt>
                <dd>{fmtMs(m?.verify?.ms)}</dd>
                {m?.verify ? <dd className="stage-tile-sub">{VERIFY_SOURCE[m.verify.source]}</dd> : null}
              </div>
              <div className="stage-tile">
                <dt>Read cache</dt>
                <dd>
                  {m ? (
                    <>
                      {m.cache.hits} hit · {m.cache.misses} miss
                    </>
                  ) : (
                    "–"
                  )}
                </dd>
              </div>
              <div className="stage-tile">
                <dt>Network</dt>
                <dd>{liveWord}</dd>
                <dd className="stage-tile-sub">{m ? `${m.phone ? "phone on" : "no phone"} · ${m.fps} fps${m.frameKb != null ? ` · ${Math.round(m.frameKb)} KB` : ""}` : linkWord}</dd>
              </div>
              <div className={`stage-tile wide stage-badge ${badge.tone}`}>
                <dt>EU pack code (DataMatrix)</dt>
                <dd>
                  <span className="stage-badge-glyph" aria-hidden="true">
                    {badge.glyph}
                  </span>
                  {badge.text}
                </dd>
                {badge.detail ? <dd className="stage-tile-sub">{badge.detail}</dd> : null}
              </div>
              <div className="stage-tile">
                <dt>Glasses</dt>
                <dd>{wornText(d)}</dd>
                {d?.battery != null ? <dd className="stage-tile-sub">battery {d.battery}%</dd> : null}
              </div>
              <div className="stage-tile">
                <dt>Camera</dt>
                <dd>{camText}</dd>
                {d?.streaming ? <dd className="stage-tile-sub">streaming</dd> : null}
              </div>
              <div className="stage-tile wide">
                <dt>Features</dt>
                <dd>
                  <ul className="stage-flags">
                    {ALL_FEATURES.map((f) => {
                      const on = features ? features.includes(f) : null;
                      return (
                        <li key={f} className={on ? "on" : on === false ? "off" : ""}>
                          <span aria-hidden="true">{on ? "✓" : on === false ? "✕" : "·"}</span> {FEATURE_LABEL[f]}
                          <span className="sr-only">{on ? " on" : on === false ? " off" : " unknown"}</span>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </div>
            </dl>
          </section>
        </main>
        <footer className="stage-foot">Read-only view. No camera images are shown or sent here.</footer>
      </div>
    </div>
  );
}
