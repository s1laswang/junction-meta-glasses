# HoldUp: team, owners, interfaces, milestones

## Claude engineering team (subagents run by the CEO)

| Role | Agent | Owns | First deliverable |
|---|---|---|---|
| CEO / integrator | meta-glasses-ceo | PLAN, TEAM, merges to main, scope calls, demo script | M0 docs + scaffold |
| **Server engineer** | `server` | `server/`: Gemini Live proxy, `verify_label`, safety check, `/api/*`, HUD fan-out, frame ingest from glasses, model fallback, logging redaction | M1: `/live` WS end-to-end with a real Gemini Live session |
| **Web/UX engineer** | `web` | `web/`: PWA phone app (consent, profile, live screen, device panel, snapshot and offline modes, permission flows, a11y) and the `/hud` Display page | M1: phone page that streams mic and camera and plays the reply audio |
| **Glasses engineer** | `glasses` | `android-dat/` (Kotlin DAT bridge), `docs/HARDWARE_NOTES.md`, the Display Web App packaging for `/hud` | M2: bridge APK that posts glasses frames and state to the server |
| **Eval / Gemini workforce** | `eval` | `eval/`: synthetic label dataset (Gemini image), ground truth, eval harness for `verify_label` and the safety check, Slurm jobs on freighter, `docs/EVAL.md` | M2: eval v1 numbers |
| **Pitch / QA** | `pitch` (starts at M2) | `deck/` (HTML slides), README, demo video script, adoption and pilot story, privacy one-pager, bug bash | M3: deck draft |

Rules for all agents: work in your own directory and git worktree branch, commit small, rebase on main, and push to a branch. The CEO merges. Never print or commit secrets (`.env` is gitignored). Nothing heavy runs on the laptop: anything long or batch goes to `ssh freighter` with Slurm (`-p normal --time=...`).

## Human teammates

| Who | Role | Tasks (Saturday → Sunday) |
|---|---|---|
| **Silas** | Founder and presenter | Answer the "Questions for Silas" in PLAN.md. Presents the demo on Sunday. Reviews the deck at 03:00 and 06:00. 06:30 rehearsal. Submits on the Junction platform at 09:30. |
| **Momin010** | Hardware lead | 15:30 pick up the glasses at the Meta booth (Amanda Le). Get DAT developer mode working on the Android phone and build and install the `android-dat` bridge (Android Studio). Owns test slots 1 (19:30) and 2 (06:30). Returns the hardware. |
| **ivarakerholm-wq** | Accessibility and real data lead | (1) By 18:00, photograph **30 real labels**: 15 medicine boxes and bottles (pharmacy or home, any language including Finnish), 10 food packages with allergen panels, 5 "hard" ones (glare, curved bottle, tiny print). Shoot from the head position at about 30–40 cm, and also include bad angles. Put them in `eval/real/` (photos with no faces or personal data, and blur any patient name on the pharmacy sticker). Write the ground truth in `eval/real/labels.csv` (template provided). (2) Ask mentors or attendees for 10-minute feedback on the flow, with a screen reader user if possible, and write it in `docs/USER_FEEDBACK.md`. (3) Buy or bring demo props: 3 similar white medicine boxes (for example amlodipine, ibuprofen, paracetamol, or empty boxes) and one snack with nuts. |
| **Chintufp** | Story and deck lead | (1) Gather problem stats with sources (vision impairment prevalence, medication errors among older or low-vision people, Finland numbers) in `docs/RESEARCH.md` by 21:00. (2) Own the deck narrative with the `pitch` agent, reviewing the slides at 03:00. (3) Film the backup demo video at 06:30 to 08:30, with the phone screen recording and the glasses POV. (4) Backup for the hardware pickup. |

## Interfaces (contract between `server` and `web` / `glasses`; change only through the CEO)

### Ports and processes
- Server: `http://localhost:8787` (HTTP plus WebSocket on the same port). Web dev: Vite `5173`, which proxies `/api`, `/live`, `/hud-ws` and `/ingest` to 8787.
- In production the server serves `web/dist`, so there is one origin and one tunnel.

### WebSocket `/live?session=<id>` (phone ⇄ server)
Client → server (JSON text frames unless noted):
```jsonc
{ "type": "start", "profile": Profile, "lang": "en", "voice": true, "source": "phone"|"glasses" }
{ "type": "audio", "data": "<base64 PCM16 mono 16 kHz>" }      // ~100 ms chunks
{ "type": "frame", "data": "<base64 JPEG>", "w": 768, "h": 768, "sharpness": 0.0-1.0, "ts": 0 }
{ "type": "text", "text": "is this my evening pill?" }          // typed or accessibility input
{ "type": "event", "name": "log_dose"|"repeat"|"stop" }
{ "type": "ping", "t": 0 }
```
Server → client:
```jsonc
{ "type": "ready", "model": "gemini-3.8-live", "session": "id" }
{ "type": "audio", "data": "<base64 PCM16 mono 24 kHz>" }
{ "type": "transcript", "role": "user"|"assistant", "text": "...", "final": bool }
{ "type": "coach", "cue": "rotate_left"|"closer"|"farther"|"more_light"|"hold_still"|"other_side"|"ok", "text": "Turn it left" }
{ "type": "verdict", "verdict": Verdict }
{ "type": "status", "live": "connecting"|"open"|"reconnecting"|"degraded"|"closed", "detail": "..." }
{ "type": "error", "code": "gemini_unavailable"|"quota"|"bad_input"|..., "message": "...", "recoverable": bool }
{ "type": "pong", "t": 0 }
```

### HTTP
- `GET /api/health` → `{ ok, gemini: "ok"|"down", models: {...}, version }`
- `POST /api/verify` body `{ frames: [base64 jpeg...], profile: Profile, question?: string }` → `Verdict` (snapshot mode, used when Live is down)
- `POST /api/tts` body `{ text }` → audio/wav (optional, falls back to browser `speechSynthesis`)
- `POST /ingest/frame?session=<id>` (glasses bridge) body `image/jpeg` → 204. The frame is injected into that live session.
- `POST /ingest/state?session=<id>` body `{ connected, worn, battery, streaming }` → 204, forwarded to the phone as `{type:"device", ...}` and to the HUD.

**Session default (CEO decision, Sat 15:10):** on `/hud-ws`, `/ingest/frame` and `/ingest/state`, the `session` parameter is **optional**. When it's missing, the server attaches to the **most recently started live session** (single-wearer demo), so the Display Web App URL (`https://<host>/hud`) and the bridge never need a code re-entered. The server buffers the last verdict and device state and replays them to a HUD that connects late.

### Push-to-10 features (server notes, Sat 19:00 contract)
- **Flags.** Server env `FEATURES` (default `scene,datamatrix,addmed,sonar`) ∩ `start.features` (all, if omitted). `ready.features` lists what's on for the session. With every flag off, the Live tools, prompt and messages are exactly the M1 ones.
- **`scene`** adds the Live tool `find_item({target?})`. Server: `server/src/find.ts`. Prompt `shared/find_prompt.md` + `shared/verify_prompt.md`, schema `shared/scene_schema.json` (each item's `read` is `label_schema.json`). Each package goes through the same safety check as a held item, so a scene item is never a `match` unless it would be one held up. The phone and HUD get `checking` start/end and a `verdict` with `mode:"scene"` and `items` (left to right; `position` is relative for 2–5 items). Speech is ≤ 2 sentences, e.g. "Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list." An uncertain best guess gets `unsure` with "I think it's the one on the right. Pick it up so I can check the label."
- **`datamatrix`.** The phone sends `{type:"datamatrix", raw, ts}`. The server also decodes glasses frames itself (zxing-wasm with local wasm, at most one decode every 1.5 s, paused for 10 s after a decode slower than 150 ms). A code is used for the current item while it's < 10 s old. `checkLabel` adds `crossCheck` with these outcomes:
  - agreement → "…, double-checked with the pack's code.";
  - an expiry conflict, or a GTIN that belongs to a different saved med (or the print names an unlisted med) → `unsure`, "The printed label and the pack's code disagree. Please ask a pharmacist.";
  - the code's expiry is in the past → `warning`;
  - the GTIN is a saved med's but there's no legible text → `unsure`;
  - the code's expiry fills in an illegible printed one.
  Med GTINs compare with `Med.gtin`, or with `Med.barcode` (EAN-13). The parser `server/src/gs1.ts` is kept identical to `web/src/lib/gs1.ts`. Codes are never logged (only `dm_decoded` with counts).
- **`addmed`** adds the Live tool `add_medication({schedule, name?})`. It needs the last held-item read (< 3 min old) with name and strength confidence ≥ 0.8, else the tool tells the model to coach. The server sends `{type:"profile_add", proposalId, med, speech}`. **Nothing is added** to the session profile until `{type:"profile_add_result", proposalId, accepted:true, med?}` arrives (an edited `med` is accepted). Then the server tells the model "saved", or "declined" on `accepted:false`. Proposals time out after 60 s, and the model is told that too. A duplicate (same ingredient and strength) is refused. `med.gtin` comes from a fresh DataMatrix.
- **`sonar`** sends `{type:"readiness", value}` to the phone only, at most 4/s, on a change > 0.05: `max(0.6·sharpness, 0.35·sharpness + 0.65·readability·decay)`, where readability comes from the last speculative read and decays after 3 s. Sharpness alone tops out at 0.6. No extra Gemini calls.
- `POST /api/verify {session}` (snapshot) also applies the session's fresh DataMatrix code.

### WebSocket `/hud-ws?session=<id>` (server → Display HUD)
Pushes `{ type: "verdict"|"coach"|"status"|"device", ... }`, the same shapes as above. The HUD sends `{ type:"event", name:"repeat"|"log_dose"|"dismiss" }`.

### Shared types (`shared/types.ts`, imported by server and web)
```ts
type Med = { id: string; name: string; ingredient: string; strength: string; schedule: string[]; barcode?: string; notes?: string };
type Profile = { meds: Med[]; allergies: string[]; avoid: string[]; doseLog: { medId: string; ts: number }[]; lang: string };
type Field<T> = { value: T | null; confidence: number };       // 0..1, value null when not readable
type LabelRead = {
  kind: "medication"|"food"|"other"|"unreadable";
  product: Field<string>; ingredient: Field<string>; strength: Field<string>;
  dosing: Field<string>; expiry: Field<string>; allergens: Field<string[]>;
  barcode: Field<string>; readability: number; guidance?: string;
};
type Verdict = {
  level: "match"|"warning"|"unsure"|"info";
  headline: string;            // ≤ 8 words, for the HUD
  speech: string;              // ≤ 2 sentences, spoken
  read: LabelRead; matchedMedId?: string; reasons: string[]; takenToday?: boolean;
};
```

## Milestones
- **M0 (Sat 15:00)**: docs pushed, scaffold on main (`npm run dev` boots an empty server and web), agents spawned.
- **M1 (Sat 19:00)**: phone vertical slice with a real Gemini Live session, coaching and verdict. Merged to main and demoable through the tunnel.
- **M2 (Sat 23:00)**: snapshot and offline modes, device panel, permissions, reconnect, HUD, glasses bridge (or documented blocker), eval v1.
- **M3 (Sun 03:00)**: a11y pass, latency, eval v2 with real photos, deck draft.
- **Freeze (Sun 06:00)**: main is submission-ready. Changes only through PR plus a smoke check.
