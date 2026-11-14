import { useEffect, useState } from "react";
import type { Checker, CheckState } from "../lib/checker.ts";
import { IS_MOCK, mockCtl, mockSetDevice, mockSetGeminiDown } from "../lib/mock.ts";
import { barcodeSupported } from "../lib/barcode.ts";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const tone = (ok: boolean | null) => (ok == null ? undefined : ok ? "ok" : "bad");

export function DevicePanel({ s, checker, open, onToggle }: { s: CheckState; checker: Checker; open: boolean; onToggle: (o: boolean) => void }) {
  const now = useNow(open && s.running);
  const [, force] = useState(0);
  const d = s.device;
  const autoStop = s.autoStopAt ? Math.max(0, Math.round((s.autoStopAt - now) / 1000)) : null;
  const sim = (fn: () => void) => () => {
    fn();
    force((x) => x + 1);
  };

  return (
    <details className="panel" open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary>Device state</summary>
      <dl className="kv">
        <dt>Mode</dt>
        <dd className={s.mode === "live" ? "ok" : "warn"}>{s.mode}{IS_MOCK ? " (mock server)" : ""}</dd>
        <dt>Camera source</dt>
        <dd>{s.source === "glasses" ? "glasses (via bridge)" : "phone rear camera"}</dd>
        <dt>Camera</dt>
        <dd className={s.camera === "on" ? "ok" : s.camera === "error" ? "bad" : undefined}>
          {s.camera}
          {s.cameraMsg ? ` · ${s.cameraMsg}` : ""}
        </dd>
        <dt>Mic</dt>
        <dd className={s.mic === "on" ? "ok" : s.mic === "error" ? "bad" : undefined}>
          {s.mic}
          {s.mic === "on" ? ` · level ${Math.round(Math.min(1, s.micLevel * 6) * 100)}%` : ""}
          {s.micLabel ? ` · ${s.micLabel}` : ""}
        </dd>
        <dt>Audio route</dt>
        <dd>{s.route || "default"}{s.speaking ? " · speaking" : ""}</dd>
        <dt>Network</dt>
        <dd className={tone(s.online)}>{s.online ? "online" : "offline"} · server {s.health}</dd>
        <dt>RTT</dt>
        <dd className={s.rtt == null ? undefined : s.rtt < 700 ? "ok" : "warn"}>{s.rtt == null ? "–" : `${s.rtt} ms`} · {s.policy.tier}</dd>
        <dt>Live socket</dt>
        <dd className={s.conn === "open" ? "ok" : s.conn === "reconnecting" ? "warn" : undefined}>
          {s.conn}
          {s.conn === "reconnecting" && s.nextRetryMs != null ? ` · try ${s.connAttempt} in ${(s.nextRetryMs / 1000).toFixed(1)} s` : ""}
        </dd>
        <dt>Gemini Live</dt>
        <dd className={s.serverLive === "open" ? "ok" : s.serverLive ? "warn" : undefined}>
          {s.serverLive ?? "–"}
          {s.model ? ` · ${s.model}` : ""}
        </dd>
        <dt>Frames sent</dt>
        <dd>
          {s.fps} fps · {s.framesSent} total · target {s.policy.fps} fps q{s.policy.quality} · sharp {Math.round(s.sharpness * 100)}%
        </dd>
        <dt>Glasses</dt>
        <dd className={d ? tone(d.connected && d.worn) : undefined}>
          {d ? `${d.connected ? "connected" : "disconnected"} · ${d.worn ? "worn" : "not worn"} · battery ${d.battery ?? "?"}% · ${d.streaming ? "streaming" : "idle"}` : "no state yet"}
        </dd>
        <dt>Display (HUD)</dt>
        <dd className={tone(s.hudConnected)}>{s.hudConnected == null ? "–" : s.hudConnected ? "connected" : "not connected"}</dd>
        <dt>Auto-stop</dt>
        <dd>{autoStop == null ? "–" : `${autoStop} s`}</dd>
        <dt>Session</dt>
        <dd>{s.session}</dd>
        <dt>Barcode</dt>
        <dd>{barcodeSupported ? "supported" : "not supported in this browser"}</dd>
        {s.lastError ? (
          <>
            <dt>Last error</dt>
            <dd className="bad">{s.lastError}</dd>
          </>
        ) : null}
      </dl>
      <div className="sim">
        <h3>Demo controls</h3>
        <button className="btn small" onClick={() => checker.simulateDrop()} disabled={!s.running}>
          Drop connection
        </button>
        <button className="btn small" onClick={() => checker.toggleSnapshotMode()} disabled={!s.running}>
          {s.mode === "snapshot" ? "Back to live" : "Force snapshot"}
        </button>
        {IS_MOCK ? (
          <>
            <button className="btn small" aria-pressed={mockCtl.slow} onClick={sim(() => (mockCtl.slow = !mockCtl.slow))}>
              Slow network {mockCtl.slow ? "on" : "off"}
            </button>
            <button className="btn small" aria-pressed={mockCtl.geminiDown} onClick={sim(() => mockSetGeminiDown(!mockCtl.geminiDown))}>
              Gemini down {mockCtl.geminiDown ? "on" : "off"}
            </button>
            <button
              className="btn small"
              aria-pressed={mockCtl.offline}
              onClick={sim(() => {
                mockCtl.offline = !mockCtl.offline;
                window.dispatchEvent(new Event(mockCtl.offline ? "offline" : "online"));
              })}
            >
              Offline {mockCtl.offline ? "on" : "off"}
            </button>
            <button className="btn small" onClick={sim(() => mockSetDevice({ connected: true, worn: true, battery: 82, streaming: true, source: "glasses" }))}>
              Glasses on
            </button>
            <button className="btn small" onClick={sim(() => mockSetDevice({ worn: false, streaming: false }))}>
              Glasses off face
            </button>
            <button className="btn small" onClick={sim(() => mockSetDevice({ connected: false, worn: false, streaming: false }))}>
              Glasses disconnect
            </button>
            <button className="btn small" onClick={sim(() => mockSetDevice({ battery: 12 }))}>
              Battery 12%
            </button>
          </>
        ) : null}
      </div>
    </details>
  );
}
