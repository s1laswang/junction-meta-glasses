import type { CrossCheck, Field, LabelRead, SceneItem, ScenePosition, Verdict } from "../../../shared/types.ts";
import { Icon, LEVEL_WORD, VerdictGlyph } from "./Icons.tsx";

export const POSITION_WORD: Record<ScenePosition, string> = { far_left: "Far left", left: "Left", center: "Middle", right: "Right", far_right: "Far right" };
const POS_ORDER: ScenePosition[] = ["far_left", "left", "center", "right", "far_right"];

export function sortedItems(items: SceneItem[]) {
  return [...items].sort((a, b) => POS_ORDER.indexOf(a.position) - POS_ORDER.indexOf(b.position));
}
export function targetIndex(items: SceneItem[], targetId?: string) {
  const i = targetId ? items.findIndex((x) => x.matchedMedId === targetId) : -1;
  return i >= 0 ? i : items.findIndex((x) => x.level === "match");
}

/** "Which one?": one card per package, left to right; the target is the largest. */
function SceneRow({ items, targetId }: { items: SceneItem[]; targetId?: string }) {
  const list = sortedItems(items);
  const t = targetIndex(list, targetId);
  return (
    <ol className="scene" aria-label={`${list.length} packages, left to right`} style={{ gridTemplateColumns: list.map((_, i) => (i === t ? "1.5fr" : "1fr")).join(" ") }}>
      {list.map((it, i) => (
        <li key={i} className={`scene-item ${it.level} ${i === t ? "target" : ""}`} aria-current={i === t ? "true" : undefined}>
          <span className="scene-pos">{POSITION_WORD[it.position]}</span>
          <span className="scene-glyph" style={{ color: `var(--${it.level === "info" ? "muted" : it.level})` }}>
            <VerdictGlyph level={it.level} size={i === t ? 48 : 32} />
          </span>
          <span className="scene-word">{LEVEL_WORD[it.level]}</span>
          <span className="scene-head">{it.headline}</span>
          {i === t ? <span className="sr-only">This is the one you asked about.</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** DataMatrix cross-check: the pack's own machine code against the AI read of the printed label. */
function CrossCheckBadge({ c }: { c: CrossCheck }) {
  if (c.agrees === true)
    return (
      <div className="xcheck ok" role="note">
        <Icon.shield size={28} />
        <div>
          <strong>Double-checked: printed label = pack code</strong>
          {c.details.length ? <p className="muted">{c.details.join(" · ")}</p> : null}
        </div>
      </div>
    );
  if (c.agrees === false)
    return (
      <div className="xcheck bad" role="note">
        <Icon.alert size={28} />
        <div>
          <strong>The printed label and the pack code disagree</strong>
          <p>{c.details.length ? c.details.join(" · ") : "What I read on the box doesn't match the code printed on it."} Don't rely on this answer; ask a pharmacist.</p>
        </div>
      </div>
    );
  return (
    <div className="xcheck info" role="note">
      <Icon.scan size={28} />
      <div>
        <strong>Read from the pack code</strong>
        {c.details.length ? <p className="muted">{c.details.join(" · ")}</p> : null}
      </div>
    </div>
  );
}

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
            {v.mode === "scene" ? <span className="muted"> · which one</span> : null}
            {via && via !== "live" ? <span className="muted"> · {via === "offline" ? (v.crossCheck ? "offline pack code" : "offline barcode") : "snapshot"}</span> : null}
          </p>
          <h2 id="verdict-h" className="headline" tabIndex={-1} ref={headingRef}>
            {v.headline}
          </h2>
        </div>
      </div>
      {v.mode === "scene" && v.items?.length ? <SceneRow items={v.items} targetId={v.matchedMedId} /> : null}
      <p className="speech">{v.speech}</p>
      {v.crossCheck ? <CrossCheckBadge c={v.crossCheck} /> : null}
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
                <dd className={`conf ${f.confidence < 0.7 ? "low" : ""}`} aria-label={`confidence ${Math.round(f.confidence * 100)} percent`}>
                  {Math.round(f.confidence * 100)}%
                </dd>
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
