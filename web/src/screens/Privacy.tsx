import { useState } from "react";
import { Icon } from "../components/Icons.tsx";
import { announce } from "../lib/feedback.ts";
import { FEATURES, loadSettings, saveSettings, type Consent, type Settings } from "../lib/storage.ts";
import type { FeatureFlag } from "../../../shared/types.ts";

const FEEDBACK_LABELS: Record<"voice" | "earcons" | "haptics", string> = {
  voice: "Spoken answers",
  earcons: "Sounds (earcons)",
  haptics: "Vibration",
};

export function Privacy({ consent, onWithdraw, onReviewConsent, onDeleteAll }: { consent: Consent | null; onWithdraw: () => boolean | void; onReviewConsent: () => void; onDeleteAll: () => void }) {
  const [st, setSt] = useState<Settings>(loadSettings());
  const save = (next: Settings) => {
    setSt(next);
    saveSettings(next);
  };
  const toggleFeature = (f: FeatureFlag) => {
    save({ ...st, features: { ...st.features, [f]: !st.features[f] } });
    announce(`${FEATURES.find((x) => x.flag === f)?.label} ${st.features[f] ? "off" : "on"}. Applies from the next check.`);
  };
  const toggleQuiet = () => {
    const quiet = !st.quiet;
    save({ ...st, quiet });
    announce(`Quiet mode ${quiet ? "on" : "off"}.`);
  };
  const toggle = (k: "voice" | "haptics" | "earcons") => {
    const enabled = !st[k];
    save({ ...st, [k]: enabled });
    announce(`${FEEDBACK_LABELS[k]} ${enabled ? "on" : "off"}.`);
  };
  return (
    <div className="stack" style={{ gap: 32 }}>
      <section className="stack" aria-labelledby="data-h">
        <h2 id="data-h">Your data</h2>
        <dl className="card stack" style={{ margin: 0 }}>
          <div>
            <dt>
              <strong>Camera and microphone</strong>
            </dt>
            <dd className="muted" style={{ margin: 0 }}>
              On only during a check. Pictures (at most one per second) and your voice go over an encrypted connection to Google's Gemini AI to read the label. HoldUp keeps them in memory only and never saves them.
            </dd>
          </div>
          <div>
            <dt>
              <strong>On this phone only</strong>
            </dt>
            <dd className="muted" style={{ margin: 0 }}>
              Your medicine list, allergies, avoid list, dose log and settings. They are sent along with a check so the answer is about you, and are not kept on the server.
            </dd>
          </div>
          <div>
            <dt>
              <strong>Consent</strong>
            </dt>
            <dd className="muted" style={{ margin: 0 }}>
              {consent ? `You agreed on ${new Date(consent.ts).toLocaleString()}.` : "Not given. The camera stays off."}
            </dd>
          </div>
        </dl>
        <div className="row">
          {consent ? (
            <button
              className="btn small"
              onClick={() => {
                if (!onWithdraw()) announce("Consent withdrawn. The camera will stay off.", "assertive");
              }}
            >
              Withdraw consent
            </button>
          ) : (
            <button className="btn small primary" onClick={onReviewConsent}>
              Review and agree
            </button>
          )}
        </div>
      </section>

      <section className="stack" aria-labelledby="feat-h">
        <h2 id="feat-h">Features</h2>
        <div className="card stack" style={{ gap: 4, paddingTop: 8, paddingBottom: 8 }}>
          {FEATURES.map((x) => (
            <div key={x.flag}>
              <label className="switch">
                {x.label}
                <input type="checkbox" role="switch" checked={st.features[x.flag]} onChange={() => toggleFeature(x.flag)} aria-describedby={`feat-${x.flag}`} />
              </label>
              <p id={`feat-${x.flag}`} className="muted" style={{ fontSize: "1rem", marginTop: 6, marginBottom: 8 }}>
                {x.help}
              </p>
            </div>
          ))}
          {st.features.sonar ? (
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor="sonar-vol">Readiness tone volume: {Math.round(st.sonarVolume * 100)}%</label>
              <input
                id="sonar-vol"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={st.sonarVolume}
                onChange={(e) => save({ ...st, sonarVolume: Number(e.target.value) })}
                aria-valuetext={`${Math.round(st.sonarVolume * 100)} percent`}
              />
            </div>
          ) : null}
          <label className="switch">
            Quiet mode (no readiness tone, softer sounds)
            <input type="checkbox" role="switch" checked={st.quiet} onChange={toggleQuiet} />
          </label>
        </div>
      </section>

      <section className="stack" aria-labelledby="fb-h">
        <h2 id="fb-h">Feedback</h2>
        <div className="card" style={{ paddingTop: 8, paddingBottom: 8 }}>
          <label className="switch">
            Spoken answers
            <input type="checkbox" role="switch" checked={st.voice} onChange={() => toggle("voice")} />
          </label>
          <label className="switch">
            Sounds (earcons)
            <input type="checkbox" role="switch" checked={st.earcons} onChange={() => toggle("earcons")} />
          </label>
          <label className="switch">
            Vibration
            <input type="checkbox" role="switch" checked={st.haptics} onChange={() => toggle("haptics")} />
          </label>
        </div>
      </section>

      <section className="stack" aria-labelledby="hud-h">
        <h2 id="hud-h">Ray-Ban Display</h2>
        <p className="muted">
          Open <strong style={{ color: "var(--text)" }}>{location.origin}/hud</strong> as a Web App on the glasses. It shows the verdict in large type and connects to your latest check automatically.
        </p>
      </section>

      <section className="stack" aria-labelledby="del-h">
        <h2 id="del-h">Delete everything</h2>
        <p className="muted">Removes your medicines, allergies, dose log, settings and consent from this phone, and clears the offline copy of the app. This can't be undone.</p>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm("Delete all your HoldUp data from this phone? This can't be undone.")) onDeleteAll();
          }}
        >
          <Icon.trash size={22} /> Delete all my data
        </button>
      </section>

      <p className="muted" style={{ fontSize: "1rem" }}>
        HoldUp is a research prototype, not a CE-marked medical device. When it isn't sure, it says so. Ask a pharmacist about anything uncertain.
      </p>
    </div>
  );
}
