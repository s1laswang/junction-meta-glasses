import { useEffect, useRef, useState } from "react";
import type { Med } from "../../../shared/types.ts";
import { Icon } from "./Icons.tsx";

function isConnectedEl(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el || typeof el.focus !== "function") return false;
  if (typeof el.isConnected === "boolean") return el.isConnected;
  let cur: Node | null = el;
  while (cur) {
    if (cur === document) return true;
    cur = cur.parentNode;
  }
  return false;
}

/**
 * "Hold up to add" confirmation. A modal sheet (focus trapped by <dialog>), announced by its title and
 * description, focus on Add. Double-tap/double-click anywhere on the sheet also adds. Times out after 60 s.
 */
export function AddSheet({ med, speech, expiresAt, onAnswer }: { med: Med; speech: string; expiresAt: number; onAnswer: (accepted: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    addRef.current?.focus();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      d?.close();
      if (prev && prev !== document.body && isConnectedEl(prev)) prev.focus();
    };
  }, []);
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  const when = med.schedule.length ? med.schedule.join(" and ") : "no fixed time";
  return (
    <dialog
      ref={ref}
      className="addsheet"
      aria-labelledby="add-h"
      aria-describedby="add-d"
      onCancel={(e) => {
        e.preventDefault();
        onAnswer(false);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onAnswer(true);
      }}
    >
      <div className="stack">
        <p className="kind" style={{ color: "var(--accent)" }}>
          <Icon.list size={22} /> Add to your list?
        </p>
        <h2 id="add-h" className="add-title">
          Add {med.name} {med.strength}, {when}, to your list?
        </h2>
        <div id="add-d" className="stack" style={{ gap: 6 }}>
          <p className="muted">{speech}</p>
          <dl className="kv" style={{ padding: 0 }}>
            <dt>Name</dt>
            <dd>{med.name}</dd>
            {med.ingredient && med.ingredient.toLowerCase() !== med.name.toLowerCase() ? (
              <>
                <dt>Ingredient</dt>
                <dd>{med.ingredient}</dd>
              </>
            ) : null}
            <dt>Strength</dt>
            <dd>{med.strength}</dd>
            <dt>When</dt>
            <dd>{when}</dd>
            {med.gtin ? (
              <>
                <dt>Pack code</dt>
                <dd>{med.gtin}</dd>
              </>
            ) : null}
          </dl>
          <p className="muted">Nothing is saved unless you press Add. It's saved on this phone only.</p>
        </div>
        <button ref={addRef} className="bigbtn" onClick={() => onAnswer(true)}>
          <Icon.check size={36} /> Add
        </button>
        <button className="btn wide" style={{ minHeight: 72, fontSize: "var(--t-md)" }} onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <p className="muted" style={{ textAlign: "center" }} aria-live="off">
          Double-tap anywhere to add · closes without adding in {left} s
        </p>
      </div>
    </dialog>
  );
}
