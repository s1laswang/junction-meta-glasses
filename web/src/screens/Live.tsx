import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Checker } from "../lib/checker.ts";
import { CueArrow, Icon } from "../components/Icons.tsx";
import { POSITION_WORD, VerdictCard } from "../components/VerdictCard.tsx";
import { DevicePanel } from "../components/DevicePanel.tsx";
import { AddSheet } from "../components/AddSheet.tsx";
import { frameFromFile } from "../lib/frames.ts";
import { IS_MOCK } from "../lib/mock.ts";
import { loadSettings, saveSettings } from "../lib/storage.ts";

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return !!el.closest("input, textarea, select, button, a, summary, [contenteditable=true], dialog");
}

export function Live({ checker, consented, onReviewConsent, onFixPermissions }: { checker: Checker; consented: boolean; onReviewConsent: () => void; onFixPermissions: () => void }) {
  const s = useSyncExternalStore(checker.subscribe, checker.get);
  const videoRef = useRef<HTMLVideoElement>(null);
  const verdictRef = useRef<HTMLHeadingElement>(null);
  const bigBtnRef = useRef<HTMLButtonElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const capsRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [panel, setPanel] = useState(DEBUG || loadSettings().showPanel);

  useEffect(() => {
    checker.attachVideo(videoRef.current);
    return () => checker.attachVideo(null);
  }, [checker, s.source]);

  // move focus to a new verdict so its actions are one swipe away
  const lastVerdict = useRef(s.verdict);
  const dismissFocus = useRef(false);
  useEffect(() => {
    const isNewVerdict = !!s.verdict && s.verdict !== lastVerdict.current && s.verdict.headline !== lastVerdict.current?.headline;
    if (s.verdict && s.verdict !== lastVerdict.current && s.verdict.headline !== lastVerdict.current?.headline) verdictRef.current?.focus();
    else if (!s.verdict && dismissFocus.current) {
      dismissFocus.current = false;
      bigBtnRef.current?.focus();
    }
    if (isNewVerdict) {
      // the action buttons sit at the bottom of the card: bring them clear of the sticky Start/Stop bar
      const actions = verdictRef.current?.closest(".verdict")?.querySelector(".actions") as HTMLElement | null | undefined;
      if (actions && typeof actions.scrollIntoView === "function") actions.scrollIntoView({ block: "nearest" });
    }
    lastVerdict.current = s.verdict;
  }, [s.verdict]);

  useEffect(() => {
    const el = capsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.captions]);

  // Space / Enter / media keys / volume keys (where the browser forwards them) = the big button
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!consented) return;
      if (e.key === "Escape" && s.verdict && !s.addProposal && !isTypingTarget(e.target) && !e.repeat) {
        e.preventDefault();
        checker.dismissVerdict();
        return;
      }
      const media = ["MediaPlayPause", "MediaPlay", "MediaPause", "AudioVolumeUp", "AudioVolumeDown", "MediaStop"].includes(e.key);
      if (media || ((e.key === " " || e.key === "Enter") && !isTypingTarget(e.target) && !e.repeat)) {
        e.preventDefault();
        if (e.key === "MediaStop") void checker.stop();
        else checker.primary();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checker, consented, s.verdict, s.addProposal]);

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (s.mode === "offline") return void checker.offlineCheckImage(f);
    const frame = await frameFromFile(f);
    await checker.snapshot(frame, text.trim() || undefined);
  }

  const big = !s.running
    ? { label: "Start check", hint: "Space", cls: "" }
    : s.mode === "snapshot"
      ? { label: s.snapshotBusy ? "Checking…" : "Check label", hint: "Space", cls: "" }
      : { label: "Stop", hint: "Space", cls: "stop" };

  if (!consented)
    return (
      <section className="card stack" aria-labelledby="needconsent">
        <h2 id="needconsent">HoldUp needs your OK first</h2>
        <p>Before the camera can be used, please read what HoldUp captures and where it goes. You can still look at and edit your profile.</p>
        <button className="btn primary" onClick={onReviewConsent}>
          Review and agree
        </button>
      </section>
    );

  const bannerIcon = s.banner?.tone === "bad" ? <Icon.alert /> : s.mode === "offline" ? <Icon.wifiOff /> : s.banner?.tone === "good" ? <Icon.check /> : <Icon.info />;
  const cameraOn = s.camera === "on" && s.source === "phone";
  const viewLabel =
    s.source === "glasses"
      ? `Using glasses camera. ${s.device ? (s.device.connected !== false ? (s.device.worn !== false ? "Glasses streaming." : "Glasses not worn.") : "Glasses not connected.") : "Waiting for the glasses."}`
      : cameraOn
        ? `Camera on. Picture sharpness ${Math.round(s.sharpness * 100)} percent.`
        : `Camera ${s.camera === "paused" ? "paused" : s.camera === "error" ? "unavailable" : "off"}.`;
  const lastFinal = [...s.captions].reverse().find((c) => c.final && c.role !== "user");

  return (
    <>
      {s.banner ? (
        <div className={`banner ${s.banner.tone}`} role="region" aria-label="Status">
          {bannerIcon}
          <div className="stack" style={{ gap: 4 }}>
            <strong>{s.banner.title}</strong>
            {s.banner.detail ? <span>{s.banner.detail}</span> : null}
          </div>
          {s.banner.action ? (
            <div className="actions">
              {s.banner.action === "settings" ? (
                <button className="btn small" onClick={onFixPermissions}>
                  How to turn it on
                </button>
              ) : null}
              {s.banner.action === "snapshot" || s.camera === "error" ? (
                <button className="btn small" onClick={() => photoRef.current?.click()}>
                  Take a photo instead
                </button>
              ) : null}
              {s.running && s.mode === "snapshot" && s.online ? (
                <button className="btn small" onClick={() => checker.backToLive()}>
                  Try live again
                </button>
              ) : null}
              {s.banner.action === "retry" ? (
                <button className="btn small" onClick={() => void checker.snapshot()}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {s.verdict ? (
        <VerdictCard
          verdict={s.verdict}
          via={s.verdictVia}
          headingRef={verdictRef}
          onRepeat={() => checker.repeat()}
          onLog={() => checker.logDose()}
          onDismiss={() => {
            dismissFocus.current = true;
            checker.dismissVerdict();
            queueMicrotask(() => {
              if (!checker.get().verdict) {
                dismissFocus.current = false;
                bigBtnRef.current?.focus();
              }
            });
          }}
        />
      ) : s.checking ? (
        <div className="cue checking" aria-busy="true">
          <span className="arrow">
            <span className="spinner" aria-hidden="true" />
          </span>
          <p className="text">Checking the label…</p>
        </div>
      ) : (
        <div className={`cue ${s.cue ? "" : "idle"}`}>
          <span className="arrow">
            <CueArrow cue={s.cue?.cue ?? null} />
          </span>
          <p className="text">
            {s.cue
              ? s.cue.text
              : !s.running
                ? "Press Start, then hold the box up in front of you."
                : s.mode === "snapshot"
                  ? "Hold the label steady, then press Check label."
                  : s.mode === "offline"
                    ? "Show me the barcode side of your medicine box."
                    : s.speaking
                      ? "Listening and watching…"
                      : "Ask: “Is this my evening pill?”"}
          </p>
        </div>
      )}

      <div className="viewfinder" aria-label={viewLabel} role="img">
        {s.source === "phone" ? <video ref={videoRef} playsInline muted autoPlay aria-hidden="true" /> : null}
        {s.source === "glasses" ? (
          <div className="glasses-overlay">
            <div className="stack" style={{ alignItems: "center" }}>
              <Icon.glasses size={64} />
              <strong>Using glasses camera</strong>
              <span className="muted">{s.device ? (s.device.connected !== false ? (s.device.worn !== false ? `Glasses streaming${s.device.battery != null ? ` · battery ${s.device.battery}%` : ""}` : "Glasses are not being worn") : "Glasses not connected") : "Waiting for the glasses bridge"}</span>
            </div>
          </div>
        ) : !cameraOn ? (
          <div className="placeholder">
            {s.camera === "paused" ? "Camera paused while HoldUp is in the background" : s.camera === "error" ? s.cameraMsg || "Camera unavailable" : s.camera === "starting" ? "Starting camera…" : "Camera off. Press Start check."}
          </div>
        ) : null}
        {cameraOn && s.verdict?.mode === "scene" && s.verdict.items?.some((i) => i.box) ? (
          <div aria-hidden="true">
            {s.verdict.items.map((it, i) =>
              it.box ? (
                <div
                  key={i}
                  className={`scene-box ${it.level}`}
                  style={{ top: `${it.box[0] / 10}%`, left: `${it.box[1] / 10}%`, height: `${(it.box[2] - it.box[0]) / 10}%`, width: `${(it.box[3] - it.box[1]) / 10}%` }}
                >
                  <span>
                    {it.level === "match" ? "✓" : it.level === "warning" ? "⚠" : it.level === "info" ? "i" : "?"} {POSITION_WORD[it.position]}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        ) : null}
        {cameraOn ? (
          <>
            <div className={`brackets ${s.sharpness > 0.55 ? "sharp" : ""}`} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="camon">
              <span className="dot" aria-hidden="true" /> CAMERA ON
            </div>
            <div className={`sharpmeter ${s.readiness != null ? "ready" : ""}`} aria-hidden="true">
              <span style={{ width: `${Math.round((s.readiness ?? s.sharpness) * 100)}%` }} />
            </div>
            {s.readiness != null ? (
              <div className="readytag" aria-hidden="true">
                Readable {Math.round(s.readiness * 100)}%
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="seg" role="group" aria-label="Camera source">
        <button aria-pressed={s.source === "phone"} onClick={() => void checker.setSource("phone")}>
          Phone camera
        </button>
        <button aria-pressed={s.source === "glasses"} onClick={() => void checker.setSource("glasses")}>
          Glasses camera
        </button>
      </div>

      <section aria-labelledby="caps-h" className="stack" style={{ gap: 8 }}>
        <h2 id="caps-h" className="sr-only">
          Conversation
        </h2>
        {/* finished caption lines only, so a screen reader isn't flooded by partial updates */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {lastFinal ? `${lastFinal.role === "assistant" ? "HoldUp" : "Note"}: ${lastFinal.text}` : ""}
        </p>
        {s.captions.length ? (
          <div className="captions" ref={capsRef} role="log" aria-live="off" aria-label="Conversation captions" tabIndex={0}>
            {s.captions.map((c) => (
              <p key={c.id} className={`${c.role} ${c.final ? "" : "partial"}`}>
                <span className="who">{c.role === "user" ? "You" : c.role === "assistant" ? "HoldUp" : "Note"}:</span>
                {c.text}
              </p>
            ))}
          </div>
        ) : null}
        <label htmlFor="ask" className="asklabel">
          Or type a question
        </label>
        <form
          className="textask"
          onSubmit={(e) => {
            e.preventDefault();
            if (!s.running) void checker.start().then(() => checker.sendText(text));
            else checker.sendText(text);
            setText("");
          }}
        >
          <input id="ask" type="text" placeholder="Is this my evening pill?" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" enterKeyHint="send" />
          <button className="btn" type="submit" disabled={!text.trim()}>
            Ask
          </button>
        </form>
        <div className="row">
          <button className="btn small" onClick={() => photoRef.current?.click()}>
            <Icon.camera size={22} /> Take a photo instead
          </button>
          <input ref={photoRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} aria-hidden="true" tabIndex={-1} />
        </div>
      </section>

      <DevicePanel
        s={s}
        checker={checker}
        open={panel}
        onToggle={(o) => {
          setPanel(o);
          saveSettings({ ...loadSettings(), showPanel: o });
        }}
      />

      {s.addProposal ? (
        <AddSheet med={s.addProposal.med} speech={s.addProposal.speech} expiresAt={s.addProposal.expiresAt} onAnswer={(a) => checker.answerProposal(a)} />
      ) : null}

      <div className="bigbtn-wrap">
        <button ref={bigBtnRef} className={`bigbtn ${big.cls}`} onClick={() => checker.primary()} aria-describedby="big-hint" disabled={s.snapshotBusy}>
          {s.running && s.mode !== "snapshot" ? <span className="dot" style={{ background: "var(--rec)", width: 20, height: 20 }} aria-hidden="true" /> : null}
          {big.label}
        </button>
        <p id="big-hint" className="sr-only">
          Shortcut: Space or Enter, or tap your Bluetooth glasses or headset.
        </p>
        {s.running && s.mode === "snapshot" ? (
          <button className="btn small ghost wide" onClick={() => void checker.stop()}>
            Stop check
          </button>
        ) : null}
        {IS_MOCK ? (
          <p className="muted" style={{ textAlign: "center", fontSize: "1rem", marginTop: 4 }}>
            Demo mode: scripted answers, no real AI
          </p>
        ) : null}
      </div>
    </>
  );
}
