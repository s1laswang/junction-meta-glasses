// /stage/ : read-only 16:9 projector view for the live demo, readable from ~10 m.
// Left: replica of what the lens shows. Centre: big captions of both sides, coach cue, readiness.
// Right: "under the hood" (model, latencies, cache, double-check, device, features).
// Attaches to the latest session via /hud-ws?role=stage (keyed like /hud). Never shows camera images.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachCue, DeviceState, FeatureFlag, LiveState, Verdict } from "../../../shared/types.ts";
import { CueArrow, Icon } from "../components/Icons.tsx";
import { HudCard, LEVEL } from "./Hud.tsx";
import { keyHeaders, withKey } from "../lib/key.ts";
import { MOCK_HUD_CHANNEL } from "../lib/mock.ts";
import { demoProfile } from "../lib/storage.ts";
import { matchVerdict, mockScene, mockWarningIbuprofen, withCrossCheck } from "../lib/verdicts.ts";
import { parseGs1 } from "../lib/gs1.ts";

/** Proposed server → stage message (see report): the last turn's timings. */
export type StageMetrics = {
  type: "metrics";
  liveModel?: string;
  /** last turn: end of the user's question (speech end or text) → first assistant audio chunk */
  firstAudioMs?: number | null;
  /** last verify_label call (wall clock) and the model that answered */
  verifyMs?: number | null;
  verifyModel?: string;
  /** last verify: served from the speculative-read / context cache? */
  cache?: "hit" | "miss" | null;
  features?: FeatureFlag[];
};

type StageMsg =
  | { type: "verdict"; verdict: Verdict }
  | { type: "coach"; cue: CoachCue; text: string }
  | { type: "status"; live: LiveState; detail?: string }
  | { type: "device"; device: DeviceState }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "checking"; phase: "start" | "end" }
  | { type: "readiness"; value: number }
  | { type: "ready"; model: string; session: string; features?: FeatureFlag[] }
  | StageMetrics;

type Line = { id: number; role: "user" | "assistant"; text: string; final: boolean };
type Conn = "connecting" | "open" | "retry";

const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const SESSION = params.get("session");
const BACKOFF = [1000, 2000, 5000];
const ALL: FeatureFlag[] = ["scene", "datamatrix", "addmed", "sonar"];
const FEATURE_WORD: Record<FeatureFlag, string> = { scene: "Which one?", datamatrix: "Pack-code check", addmed: "Hold up to add", sonar: "Readiness tone" };

export function Stage() {
  const [conn, setConn] = useState<Conn>("connecting");
  const [keyNeeded, setKeyNeeded] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [cue, setCue] = useState<{ cue: CoachCue; text: string; ts: number } | null>(null);
  const [readiness, setReadiness] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [metrics, setMetrics] = useState<StageMetrics | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureFlag[] | null>(null);
  const idRef = useRef(0);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMsg = useCallback((m: StageMsg) => {
    switch (m.type) {
      case "transcript":
        setLines((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          // transcripts are cumulative per utterance: replace the open line until final
          if (last && last.role === m.role && !last.final) next[next.length - 1] = { ...last, text: m.text, final: m.final };
          else next.push({ id: ++idRef.current, role: m.role, text: m.text, final: m.final });
          return next.slice(-12);
        });
        break;
      case "verdict":
        setVerdict(m.verdict);
        setCue(null);
        setChecking(false);
        setReadiness(null);
        break;
      case "coach":
        setCue({ cue: m.cue, text: m.text, ts: Date.now() });
        break;
      case "checking":
        setChecking(m.phase === "start");
        break;
      case "readiness":
        setReadiness(m.value);
        if (readyTimer.current) clearTimeout(readyTimer.current);
        readyTimer.current = setTimeout(() => setReadiness(null), 2000);
        break;
      case "status":
        setLive(m.live);
        break;
      case "device":
        setDevice(m.device);
        break;
      case "ready":
        setModel(m.model);
        if (m.features) setFeatures(m.features);
        setVerdict(null);
        break;
      case "metrics":
        setMetrics((prev) => ({ ...prev, ...m }));
        if (m.features) setFeatures(m.features);
        if (m.liveModel) setModel(m.liveModel);
        break;
    }
  }, []);

  // coach cues clear after ~3 s, like the lens
  useEffect(() => {
    if (!cue) return;
    const t = setTimeout(() => setCue((c) => (c && Date.now() - c.ts >= 2900 ? null : c)), 3000);
    return () => clearTimeout(t);
  }, [cue]);

  useEffect(() => {
    if (MOCK) return runMock(onMsg, setConn);
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const q = new URLSearchParams({ role: "stage", ...(SESSION ? { session: SESSION } : {}) });
      ws = new WebSocket(withKey(`${proto}//${location.host}/hud-ws?${q}`));
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
  }, [onMsg]);

  const stale = conn !== "open" && !!verdict;
  const shown = lines.slice(-5);
  const xc = verdict?.crossCheck;
  const camText = device ? (device.source === "glasses" && device.connected !== false && device.worn !== false ? "Glasses camera" : "Phone camera") : "–";
  const glasses = device
    ? `${device.connected === false ? "Disconnected" : "Connected"} · ${device.worn == null ? "worn ?" : device.worn ? "worn" : "not worn"}${device.battery != null ? ` · ${device.battery}%` : ""}`
    : "–";
  const ms = (v?: number | null) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

  return (
    <div className="stage">
      <header className="stage-top">
        <h1>
          HoldUp <span className="muted">· live</span>
        </h1>
        <span className={`hud-dot ${conn}`} aria-hidden="true" />
        <span>{keyNeeded ? "Access key needed" : conn === "open" ? (live === "degraded" ? "Snapshot mode" : "Connected") : conn === "retry" ? "Reconnecting…" : "Connecting…"}</span>
        {MOCK ? <span className="chip mock">Demo data</span> : null}
        <span className="stage-privacy">
          <Icon.lock size={22} /> No camera images on this screen
        </span>
      </header>

      <section className="stage-col stage-left" aria-labelledby="st-lens">
        <h2 id="st-lens" className="stage-h">
          <Icon.glasses size={26} /> On the lens
        </h2>
        <div className="stage-lens">
          <HudCard verdict={verdict} cue={cue} stale={stale} keyNeeded={keyNeeded} />
        </div>
      </section>

      <section className="stage-col stage-mid" aria-labelledby="st-caps">
        <h2 id="st-caps" className="stage-h">
          <Icon.mic size={26} /> Conversation
        </h2>
        <ol className="stage-caps" aria-live="polite" aria-relevant="additions">
          {shown.length ? (
            shown.map((l) => (
              <li key={l.id} className={`${l.role} ${l.final ? "" : "partial"}`}>
                <span className="who">{l.role === "user" ? "YOU" : "HOLDUP"}</span>
                <span className="said">{l.text}</span>
              </li>
            ))
          ) : (
            <li className="assistant empty">
              <span className="who">HOLDUP</span>
              <span className="said">Waiting for a check to start…</span>
            </li>
          )}
        </ol>
        <div className="stage-now">
          {checking ? (
            <p className="stage-cue">
              <span className="spinner" aria-hidden="true" /> Checking the label…
            </p>
          ) : cue ? (
            <p className="stage-cue">
              <span className="arrow" aria-hidden="true">
                <CueArrow cue={cue.cue} size={64} />
              </span>
              {cue.text}
            </p>
          ) : null}
          {readiness != null ? (
            <div className="stage-ready">
              <span>Label readable</span>
              <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(readiness * 100)} aria-label="Label readability">
                <span style={{ width: `${Math.round(readiness * 100)}%` }} />
              </div>
              <strong>{Math.round(readiness * 100)}%</strong>
            </div>
          ) : null}
        </div>
      </section>

      <section className="stage-col stage-right" aria-labelledby="st-hood">
        <h2 id="st-hood" className="stage-h">Under the hood</h2>
        <dl className="stage-kv">
          <dt>Live model</dt>
          <dd>{model ?? "–"}</dd>
          <dt>Question → first audio</dt>
          <dd>{ms(metrics?.firstAudioMs)}</dd>
          <dt>Label verify</dt>
          <dd>
            {ms(metrics?.verifyMs)}
            {metrics?.verifyModel ? ` · ${metrics.verifyModel}` : ""}
          </dd>
          <dt>Cache</dt>
          <dd>{metrics?.cache == null ? "–" : metrics.cache === "hit" ? "Hit (reused read)" : "Miss"}</dd>
          <dt>Pack-code check</dt>
          <dd className={xc?.agrees === true ? "ok" : xc?.agrees === false ? "bad" : undefined}>
            {xc ? (
              xc.agrees === true ? (
                <>
                  <Icon.shield size={22} /> Double-checked
                </>
              ) : xc.agrees === false ? (
                <>
                  <Icon.alert size={22} /> Label ≠ pack code
                </>
              ) : (
                "Pack code read"
              )
            ) : (
              "–"
            )}
          </dd>
          <dt>Verdict</dt>
          <dd>{verdict ? `${LEVEL[verdict.level].glyph} ${LEVEL[verdict.level].word}${verdict.mode === "scene" ? " · which one" : ""}` : "–"}</dd>
          <dt>Glasses</dt>
          <dd>{glasses}</dd>
          <dt>Camera</dt>
          <dd>{camText}</dd>
          <dt>Network</dt>
          <dd>
            {conn === "open" ? "Online" : "Reconnecting"}
            {live ? ` · AI ${live}` : ""}
          </dd>
          <dt>Features</dt>
          <dd>
            <ul className="stage-flags">
              {ALL.map((f) => {
                const on = features ? features.includes(f) : null;
                return (
                  <li key={f}>
                    {on == null ? "·" : on ? "✓" : "✗"} {FEATURE_WORD[f]}
                    <span className="sr-only">{on == null ? " unknown" : on ? " on" : " off"}</span>
                  </li>
                );
              })}
            </ul>
          </dd>
        </dl>
      </section>
    </div>
  );
}

/** ?mock=1: follow a mock phone tab in this browser, or play a scripted demo when there is none. */
function runMock(onMsg: (m: StageMsg) => void, setConn: (c: Conn) => void) {
  setConn("open");
  let gotPhone = false;
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(MOCK_HUD_CHANNEL);
    ch.onmessage = (e) => {
      gotPhone = true;
      onMsg(e.data as StageMsg);
    };
  } catch {
    /* ignore */
  }
  const p = demoProfile();
  const code = parseGs1("]d201064165420021491727083110A1234\x1d21SN0001")!;
  const script: [number, StageMsg][] = [
    [0, { type: "ready", model: "gemini-3.8-live", session: "DEMO", features: ALL }],
    [200, { type: "status", live: "open" }],
    [300, { type: "device", device: { connected: true, worn: true, battery: 81, streaming: true, source: "glasses" } }],
    [800, { type: "transcript", role: "user", text: "Is this my", final: false }],
    [1300, { type: "transcript", role: "user", text: "Is this my evening pill?", final: true }],
    [1900, { type: "coach", cue: "other_side", text: "Turn it around" }],
    [2000, { type: "transcript", role: "assistant", text: "I can see a box, but the label is on the other side.", final: false }],
    [2600, { type: "transcript", role: "assistant", text: "I can see a box, but the label is on the other side. Turn it around.", final: true }],
    [4300, { type: "coach", cue: "closer", text: "A bit closer" }],
    [4400, { type: "transcript", role: "assistant", text: "A bit closer.", final: true }],
    [6300, { type: "coach", cue: "hold_still", text: "Hold still" }],
    [7600, { type: "checking", phase: "start" }],
    [10200, { type: "checking", phase: "end" }],
    [10200, { type: "verdict", verdict: withCrossCheck(matchVerdict(p, p.meds[0]), true, ["GTIN 06416542002149 = your Amlodipine", "expiry: code 2027-08-31 = print 2027-08-31"], code) }],
    [10300, { type: "transcript", role: "assistant", text: "Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.", final: true }],
    [10400, { type: "metrics", liveModel: "gemini-3.8-live", firstAudioMs: 720, verifyMs: 2580, verifyModel: "gemini-3.8-flash", cache: "miss", features: ALL }],
    [16000, { type: "transcript", role: "user", text: "Which one is my evening pill?", final: true }],
    [16200, { type: "coach", cue: "hold_still", text: "Hold still" }],
    [17500, { type: "checking", phase: "start" }],
    [19600, { type: "checking", phase: "end" }],
    [19600, { type: "verdict", verdict: mockScene(p) }],
    [19700, { type: "transcript", role: "assistant", text: "Your evening pill is the one on the right. The middle one is ibuprofen, which you avoid.", final: true }],
    [19800, { type: "metrics", firstAudioMs: 640, verifyMs: 2050, cache: "hit" }],
    [25000, { type: "transcript", role: "user", text: "And this one?", final: true }],
    [26800, { type: "verdict", verdict: mockWarningIbuprofen() }],
    [26900, { type: "transcript", role: "assistant", text: "This is Ibuprofen 400 milligrams. It isn't on your list, and your list says to avoid NSAIDs.", final: true }],
    [27000, { type: "metrics", firstAudioMs: 690, verifyMs: 2310, cache: "miss" }],
  ];
  // readiness rises while the user turns the box
  for (let t = 1900; t <= 7500; t += 250) script.push([t, { type: "readiness", value: Math.min(0.96, 0.1 + ((t - 1900) / 5600) * 0.86) }]);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = () => {
    for (const [ms, m] of script) timers.push(setTimeout(() => !gotPhone && onMsg(m), ms));
    timers.push(setTimeout(() => !gotPhone && run(), 33000));
  };
  run();
  return () => {
    timers.forEach(clearTimeout);
    ch?.close();
  };
}
