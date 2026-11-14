import type { Field, LabelRead, Verdict } from "../../../shared/types.ts";
import { LEVEL_WORD, VerdictGlyph } from "./Icons.tsx";

const FIELDS: [keyof LabelRead, string][] = [
  ["product", "Product"],
  ["ingredient", "Ingredient"],
  ["strength", "Strength"],
  ["dosing", "Dosing"],
  ["expiry", "Expiry"],
  ["allergens", "Allergens"],
  ["barcode", "Barcode"],
];

function show(f: Field<string | string[]>) {
  if (f.value == null) return "Not readable";
  return Array.isArray(f.value) ? f.value.join(", ") : f.value;
}

export function VerdictCard({
  verdict,
  via,
  onRepeat,
  onLog,
  onDismiss,
  headingRef,
}: {
  verdict: Verdict;
  via: string | null;
  onRepeat: () => void;
  onLog: () => void;
  onDismiss: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const v = verdict;
  const rows = FIELDS.map(([k, label]) => [label, v.read[k] as Field<string | string[]>] as const).filter(([, f]) => f && (f.value != null || f.confidence > 0));
  return (
    <section className={`verdict ${v.level}`} aria-labelledby="verdict-h">
      <div className="head">
        <span style={{ color: "var(--vc)" }}>
          <VerdictGlyph level={v.level} />
        </span>
        <div>
          <p className="kind">
            {LEVEL_WORD[v.level]}
            {via && via !== "live" ? <span className="muted"> · {via === "offline" ? "offline barcode" : "snapshot"}</span> : null}
          </p>
          <h2 id="verdict-h" className="headline" tabIndex={-1} ref={headingRef}>
            {v.headline}
          </h2>
        </div>
      </div>
      <p className="speech">{v.speech}</p>
      {v.takenToday != null && v.matchedMedId ? <p className="muted">{v.takenToday ? "Already logged today." : "Not logged today."}</p> : null}
      {v.reasons.length ? (
        <ul className="reasons" aria-label="Why">
          {v.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
      {rows.length ? (
        <details>
          <summary className="muted" style={{ cursor: "pointer", minHeight: 48, display: "flex", alignItems: "center" }}>
            What I read, and how sure I am
          </summary>
          <dl className="fields">
            {rows.map(([label, f]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>{show(f)}</dd>
                <span className={`conf ${f.confidence < 0.7 ? "low" : ""}`} aria-label={`confidence ${Math.round(f.confidence * 100)} percent`}>
                  {Math.round(f.confidence * 100)}%
                </span>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <div className="actions">
        <button className="btn small" onClick={onRepeat}>
          Repeat
        </button>
        {v.matchedMedId ? (
          <button className="btn small primary" onClick={onLog} aria-describedby="log-help">
            {v.takenToday ? "Log another dose" : "I took it"}
          </button>
        ) : null}
        <button className="btn small ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {v.matchedMedId ? (
        <p id="log-help" className="sr-only">
          Saves the time in the dose log on this phone only.
        </p>
      ) : null}
    </section>
  );
}
