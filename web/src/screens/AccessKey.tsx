import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icons.tsx";
import { accessKey, setAccessKey } from "../lib/key.ts";

/** Shown when the server answers 401/403: it runs with HOLDUP_KEY and we have no (or a wrong) key. */
export function AccessKey({ onSave }: { onSave: () => void }) {
  const h = useRef<HTMLHeadingElement>(null);
  const [v, setV] = useState("");
  const had = !!accessKey();
  useEffect(() => h.current?.focus(), []);
  return (
    <main className="onb">
      <div className="body">
        <div className="art" style={{ borderColor: "var(--warning)", color: "var(--warning)" }}>
          <Icon.lock size={56} />
        </div>
        <h1 ref={h} tabIndex={-1}>
          Access key needed
        </h1>
        <p className="lede">
          {had ? "The access key saved on this phone wasn't accepted." : "This HoldUp server only lets in people who have its private link."} Open the full link you were given (it ends in <span style={{ fontFamily: "var(--mono)" }}>?key=…</span>), or paste the key here.
        </p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setAccessKey(v);
            onSave();
          }}
        >
          <div className="field">
            <label htmlFor="key">Access key</label>
            <input id="key" type="text" value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </div>
          <button className="btn primary wide" type="submit" disabled={!v.trim()}>
            Save and try again
          </button>
        </form>
        <p className="muted">The key is kept only on this phone and sent only to this HoldUp server.</p>
      </div>
    </main>
  );
}
