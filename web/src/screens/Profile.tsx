import { useEffect, useRef, useState } from "react";
import type { Med, Profile as P } from "../../../shared/types.ts";
import { Icon } from "../components/Icons.tsx";
import { announce } from "../lib/feedback.ts";
import { barcodeSupported, detectCodes } from "../lib/barcode.ts";
import { expiryWords, parseGs1 } from "../lib/gs1.ts";
import { getCamera } from "../lib/media.ts";
import { demoProfile, emptyMed, LANGS, loadSettings, newMedId, saveProfile, takenToday } from "../lib/storage.ts";

const SLOTS = ["morning", "midday", "evening", "night"];

export function Profile({ profile, onChange }: { profile: P; onChange: (p: P) => void }) {
  const [editing, setEditing] = useState<Med | null>(null);
  const update = (p: P) => {
    saveProfile(p);
    onChange(p);
  };

  return (
    <div className="stack" style={{ gap: 32 }}>
      <section className="stack" aria-labelledby="meds-h">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="meds-h">My medicines</h2>
          <button className="btn small primary" onClick={() => setEditing(emptyMed())}>
            Add medicine
          </button>
        </div>
        <p className="muted">
          <Icon.lock size={20} /> Saved only on this phone.
        </p>
        {profile.meds.length ? (
          <ul className="medlist">
            {profile.meds.map((m) => (
              <li key={m.id}>
                <div>
                  <p className="name">
                    {m.name} <span className="strength">{m.strength}</span>
                  </p>
                  <p className="meta">
                    {[m.schedule.join(", "), m.ingredient, m.barcode ? "barcode saved" : null, m.gtin ? "pack code saved" : null, takenToday(profile, m.id) ? "taken today" : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <button className="btn small" onClick={() => setEditing(m)} aria-label={`Edit ${m.name} ${m.strength}`}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card">No medicines yet. Add the ones you take so HoldUp can tell you if a box is yours.</p>
        )}
      </section>

      <TagList
        id="allergies"
        title="Allergies"
        help="For example: peanut, tree nuts, lactose, penicillin"
        items={profile.allergies}
        onChange={(allergies) => update({ ...profile, allergies })}
      />
      <TagList id="avoid" title="Avoid" help="Medicine groups your doctor told you to avoid, for example NSAIDs" items={profile.avoid} onChange={(avoid) => update({ ...profile, avoid })} />

      <section className="stack" aria-labelledby="lang-h">
        <h2 id="lang-h">Language</h2>
        <div className="field">
          <label htmlFor="lang">Language HoldUp speaks</label>
          <select id="lang" value={profile.lang || "en"} onChange={(e) => {
            update({ ...profile, lang: e.target.value });
            announce(`Language set to ${LANGS.find((l) => l.code === e.target.value)?.label}.`);
          }} aria-describedby="lang-help">
            {LANGS.map((l) => (
              <option key={l.code} value={l.code} lang={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <p id="lang-help" className="help">
            Used for spoken coaching and answers. The screens are in English for now.
          </p>
        </div>
      </section>

      <section className="stack" aria-labelledby="log-h">
        <h2 id="log-h">Dose log</h2>
        {profile.doseLog.length ? (
          <ul className="medlist">
            {[...profile.doseLog]
              .reverse()
              .slice(0, 10)
              .map((d, i) => {
                const m = profile.meds.find((x) => x.id === d.medId);
                return (
                  <li key={i}>
                    <span>
                      <strong>{m ? `${m.name} ${m.strength}` : d.medId}</strong>
                    </span>
                    <span className="muted">{new Date(d.ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                );
              })}
          </ul>
        ) : (
          <p className="muted">No doses logged yet. After a match, press "I took it".</p>
        )}
      </section>

      <div className="row">
        <button
          className="btn small"
          onClick={() => {
            if (confirm("Replace your profile with the demo profile?")) {
              update(demoProfile());
              announce("Demo profile loaded.");
            }
          }}
        >
          Load demo profile
        </button>
      </div>

      {editing ? (
        <MedEditor
          med={editing}
          onCancel={() => setEditing(null)}
          onDelete={
            editing.id
              ? () => {
                  update({ ...profile, meds: profile.meds.filter((m) => m.id !== editing.id) });
                  announce(`${editing.name} removed.`);
                  setEditing(null);
                }
              : undefined
          }
          onSave={(m) => {
            const meds = m.id ? profile.meds.map((x) => (x.id === m.id ? m : x)) : [...profile.meds, { ...m, id: newMedId(m.name) }];
            update({ ...profile, meds });
            announce(`${m.name} saved.`);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TagList({ id, title, help, items, onChange }: { id: string; title: string; help: string; items: string[]; onChange: (x: string[]) => void }) {
  const [v, setV] = useState("");
  return (
    <section className="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {items.length ? (
        <ul className="tags" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((a) => (
            <li key={a} className="tag">
              {a}
              <button
                aria-label={`Remove ${a}`}
                onClick={() => {
                  onChange(items.filter((x) => x !== a));
                  announce(`${a} removed.`);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      <form
        className="textask"
        onSubmit={(e) => {
          e.preventDefault();
          const t = v.trim();
          if (t && !items.some((x) => x.toLowerCase() === t.toLowerCase())) {
            onChange([...items, t]);
            announce(`${t} added.`);
          }
          setV("");
        }}
      >
        <label className="sr-only" htmlFor={`${id}-in`}>
          Add to {title}
        </label>
        <input id={`${id}-in`} type="text" value={v} onChange={(e) => setV(e.target.value)} placeholder={help} aria-describedby={`${id}-help`} />
        <button className="btn" type="submit" disabled={!v.trim()}>
          Add
        </button>
      </form>
      <p id={`${id}-help`} className="sr-only">
        {help}
      </p>
    </section>
  );
}

function MedEditor({ med, onSave, onCancel, onDelete }: { med: Med; onSave: (m: Med) => void; onCancel: () => void; onDelete?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [m, setM] = useState<Med>(med);
  const [scan, setScan] = useState<false | "barcode" | "pack">(false);
  const dmOn = loadSettings().features.datamatrix;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const set = (p: Partial<Med>) => setM((x) => ({ ...x, ...p }));
  const valid = m.name.trim() && m.strength.trim();

  return (
    <dialog ref={ref} aria-labelledby="med-h" onCancel={(e) => (e.preventDefault(), onCancel())}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave({ ...m, name: m.name.trim(), strength: m.strength.trim(), ingredient: m.ingredient.trim(), barcode: m.barcode?.trim() || undefined, gtin: m.gtin?.replace(/\D/g, "") || undefined });
        }}
      >
        <h2 id="med-h">{med.id ? `Edit ${med.name}` : "Add medicine"}</h2>
        <div className="field">
          <label htmlFor="m-name">Name on the box</label>
          <input id="m-name" type="text" required value={m.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="m-ing">Active ingredient</label>
          <input id="m-ing" type="text" value={m.ingredient} onChange={(e) => set({ ingredient: e.target.value })} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="m-str">Strength</label>
          <input id="m-str" type="text" required value={m.strength} onChange={(e) => set({ strength: e.target.value })} placeholder="for example 5 mg" autoComplete="off" />
        </div>
        <fieldset>
          <legend>When you take it</legend>
          <div className="checks">
            {SLOTS.map((slot) => (
              <label key={slot}>
                <input type="checkbox" checked={m.schedule.includes(slot)} onChange={(e) => set({ schedule: e.target.checked ? [...m.schedule, slot].sort((a, b) => SLOTS.indexOf(a) - SLOTS.indexOf(b)) : m.schedule.filter((x) => x !== slot) })} />
                {slot}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="m-bc">Barcode (optional)</label>
          <div className="textask">
            <input id="m-bc" type="text" inputMode="numeric" value={m.barcode ?? ""} onChange={(e) => set({ barcode: e.target.value })} aria-describedby="m-bc-help" autoComplete="off" />
            <button type="button" className="btn" onClick={() => setScan("barcode")} disabled={!barcodeSupported}>
              <Icon.scan size={22} /> Scan
            </button>
          </div>
          <p id="m-bc-help" className="help">
            {barcodeSupported ? "Lets HoldUp recognise this box even when you're offline." : "This browser can't scan barcodes. You can type the number under the stripes."}
          </p>
        </div>
        {dmOn ? (
          <div className="field">
            <label htmlFor="m-gtin">Pack code GTIN (optional)</label>
            <div className="textask">
              <input id="m-gtin" type="text" inputMode="numeric" value={m.gtin ?? ""} onChange={(e) => set({ gtin: e.target.value })} aria-describedby="m-gtin-help" autoComplete="off" />
              <button type="button" className="btn" onClick={() => setScan("pack")} disabled={!barcodeSupported}>
                <Icon.scan size={22} /> Scan pack code
              </button>
            </div>
            <p id="m-gtin-help" className="help">
              The small square code on prescription packs. HoldUp uses it to double-check the label and to recognise this exact medicine offline, with its expiry date.
            </p>
          </div>
        ) : null}
        {scan ? (
          <BarcodeScanner
            mode={scan}
            onResult={(code) => {
              if (scan === "pack") {
                const g = parseGs1(code);
                if (!g?.gtin) return announce("That wasn't a medicine pack code. Try the small square code.", "assertive");
                set({ gtin: g.gtin, barcode: m.barcode || g.gtin.replace(/^0/, "") });
                announce(`Pack code saved${g.expiry ? `. This pack expires ${expiryWords(g.expiry)}` : ""}.`, "assertive");
              } else {
                set({ barcode: code });
                announce(`Barcode ${code.split("").join(" ")} saved.`, "assertive");
              }
              setScan(false);
            }}
            onClose={() => setScan(false)}
          />
        ) : null}
        <div className="field">
          <label htmlFor="m-notes">Notes (optional)</label>
          <input id="m-notes" type="text" value={m.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </div>
        <div className="row">
          <button className="btn primary" type="submit" disabled={!valid}>
            Save
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          {onDelete ? (
            <button className="btn danger" type="button" onClick={() => confirm(`Remove ${med.name} from your list? Its dose history stays in the log.`) && onDelete()} style={{ marginLeft: "auto" }}>
              Remove
            </button>
          ) : null}
        </div>
      </form>
    </dialog>
  );
}

function BarcodeScanner({ onResult, onClose, mode = "barcode" }: { onResult: (code: string) => void; onClose: () => void; mode?: "barcode" | "pack" }) {
  const v = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState("Starting camera…");
  const cb = useRef(onResult);
  cb.current = onResult;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    void (async () => {
      try {
        stream = await getCamera();
        if (!v.current) return;
        v.current.srcObject = stream;
        await v.current.play().catch(() => {});
        const what = mode === "pack" ? "the small square pack code" : "the barcode";
        setMsg(`Point the camera at ${what}. Hold it about a hand's length away.`);
        announce(`Scanning. Point the camera at ${what}.`, "assertive");
        timer = setInterval(async () => {
          if (done || !v.current) return;
          const codes = await detectCodes(v.current);
          const hit = mode === "pack" ? codes.find((c) => c.format === "data_matrix" || !!parseGs1(c.rawValue)?.gtin) : codes[0];
          const code = hit?.rawValue;
          if (code) {
            done = true;
            navigator.vibrate?.([60, 40, 60]);
            cb.current(code);
          }
        }, 300);
      } catch {
        setMsg("Can't open the camera. Type the barcode number instead.");
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <div className="scanbox stack" role="group" aria-label="Barcode scanner">
      <video ref={v} playsInline muted aria-hidden="true" />
      <p role="status">{msg}</p>
      <button type="button" className="btn" onClick={onClose}>
        Cancel scan
      </button>
    </div>
  );
}
