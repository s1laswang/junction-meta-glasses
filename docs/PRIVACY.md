# HoldUp Privacy, Consent, Bystander Protection & Regulatory Architecture

HoldUp assists blind and low-vision users in reading medicine boxes and food packages hands-free on Meta AI glasses. Because medication schedules, allergies, and first-person camera streams are deeply sensitive, HoldUp enforces privacy, active-capture minimisation, bystander protection, secret isolation, and deterministic safety boundaries directly in code rather than relying on policy promises alone.

---

## 1. End-to-End Data Flow & Storage Matrix

### Architecture & Data Flow Diagram

```text
+-----------------------------------------------------------------------------------+
| WEARER & RAY-BAN META / DISPLAY GLASSES                                           |
|  - Hardware Capture LED: locked ON by firmware + DAT SDK during camera streaming  |
|  - Camera (DAT SDK 1.0.1): 720x1280 @ 2 fps -> ~1 fps JPEG to HoldUp Bridge       |
|  - Audio (Bluetooth HFP): open-ear speakers + mic paired to user's phone          |
|  - Display HUD (/hud -> /hud-ws): receives verdict/coach/status/device cards only |
+-------------------+-----------------------------------+---------------------------+
                    | JPEG frames                       | BT HFP audio
                    v                                   v
+-----------------------------------------------------------------------------------+
| USER DEVICE: PHONE PWA (web/) + ANDROID DAT BRIDGE (android-dat/)                 |
|  - Persistent on-device localStorage ONLY (wiped in 1 tap via wipeAllLocalData()):|
|      * Profile: meds[], allergies[], avoid[], doseLog[], lang                     |
|      * ConsentRecord: accepted, acceptedAt, version                               |
|  - Offline mode: local BarcodeDetector vs localStorage meds[].barcode (0 network) |
+-------------------+-----------------------------------+---------------------------+
                    | WSS /live?session=<id>            | HTTPS POST /api/verify
                    | HTTPS POST /ingest/frame          | HTTPS POST /api/tts
                    v (TLS in transit)                  v (TLS in transit)
+-----------------------------------------------------------------------------------+
| HOLDUP EPHEMERAL RELAY SERVER (server/src/) - ZERO USER CONTENT ON DISK           |
|  - Hub (hub.ts):                                                                  |
|      * FrameRing(8) in RAM: cleared immediately on ws.close -> hub.ring.clear()   |
|        and swept by 10-min idle GC (hub.gc); session-less frames dropped (204)    |
|      * Hub.profile in RAM: used by deterministic checkLabel() (safety.ts);        |
|        never written to disk, never sent to readLabel() vision extraction         |
|  - LiveProxy (live.ts):                                                           |
|      * Throttles video to <= ~1 fps (Date.now() - lastVideoAt >= 900 ms)          |
|      * Auto-stops camera after 45 s idle (IDLE_STOP_MS = 45000)                   |
|      * Streams PCM16 audio pass-through (zero audio buffer on server)             |
|  - Redacting Logger (log.ts): DENY key filter + 48-ch cap + AIza... key scrubber  |
|  - Usage Ledger (ledger.ts): token counts + latency metadata ONLY (gitignored)    |
|  - Secret Isolation (env.ts): GEMINI_API_KEY stays in server RAM, never client    |
+-------------------+-----------------------------------+---------------------------+
                    | ~1 fps coaching JPEG + PCM16      | 1-3 sharpest JPEGs +
                    | + med names/allergies context     | question (NO Profile)
                    v (TLS, @google/genai v1beta)       v (TLS, @google/genai v1beta)
+-----------------------------------+   +-------------------------------------------+
| GEMINI LIVE (gemini-3.8-live)     |   | GEMINI VERIFY (gemini-3.8-flash)          |
|  - Sliding-window compression     |   |  - Schema-locked LabelRead JSON           |
|  - Prompt: ignore people & faces  |   |  - Prompt: ignore people, faces & hands   |
+-----------------------------------+   +-------------------------------------------+
```

### Data Element Storage & Retention Matrix

| Data Element | Where It Lives | Retention & Deletion Policy | Code Enforcement |
|---|---|---|---|
| **Medication list & allergies** (`Profile.meds`, `allergies`, `avoid`) | Browser `localStorage` on user's phone; transient in-memory copy on `Hub.profile` during active session; med names/allergies/avoid passed in Live `systemInstruction` (`readLabel()` receives **zero** profile data) | Persists on user device until 1-tap `wipeAllLocalData()`; server RAM copy deleted on 10-min idle GC (`hubs.delete(id)`) or process exit; **zero server disk storage** | `shared/types.ts`, `server/src/hub.ts`, `server/src/verify.ts` (`toProfile`, `readLabel`), `server/src/safety.ts` (`checkLabel`) |
| **Dose log** (`Profile.doseLog`) | Browser `localStorage` on user's phone; transient in-memory copy on `Hub.profile.doseLog` (capped to last 500 entries by `toProfile()`) | Persists on user device until 1-tap `wipeAllLocalData()`; evaluated deterministically in `dosesToday()` without model calls; dropped from server RAM on 10-min `hub.gc`; **zero server disk storage** | `server/src/verify.ts` (`toProfile`), `server/src/safety.ts` (`dosesToday`), `server/src/live.ts` (`logDose`) |
| **Camera JPEG frames** (`phone` `getUserMedia` or `glasses` DAT `/ingest/frame`) | Bounded `FrameRing(8)` in server RAM (`Hub.ring`); up to ~1 fps forwarded to Gemini Live; 1 to 3 sharpest frames sent to `readLabel()` or `POST /api/verify` | Max 8 frames in RAM (FIFO overwrite); cleared **immediately** on `ws.close` via `hub.ring.clear()` when `hub.clients.size === 0`, or on 10-min `hub.gc`; `/ingest/frame` without an active session is dropped immediately (`204`); **zero disk image storage** | `server/src/verify.ts` (`FrameRing`), `server/src/hub.ts`, `server/src/index.ts` (`onLive`, `/ingest/frame`) |
| **PCM16 audio** (16 kHz mic input, 24 kHz voice reply, `/api/tts` WAV) | Streamed in ~100 ms base64 chunks over `/live` WebSocket -> `LiveProxy.audio()` -> Gemini Live over TLS | Streamed pass-through in socket buffers only; never buffered in `Hub`, never logged (`audio` & `data` blocked by `DENY`), **zero disk audio storage** | `server/src/live.ts` (`audio`, `onMessage`), `server/src/index.ts` (`/api/tts`), `server/src/log.ts` |
| **Transcripts** (`inputAudioTranscription`, `outputAudioTranscription`, typed `text`) | Transient per-utterance strings (`userText`, `botText`) in `LiveProxy` RAM; ephemeral `SessionSnapshot.transcripts` in client state | Server strings reset to `""` as soon as each turn completes or interrupts (`sc.inputTranscription.finished`, `sc.turnComplete`, `sc.interrupted`); blocked from stdout logs by `DENY`; **zero server disk storage** | `server/src/live.ts` (`onMessage`), `web/src/types.ts` (`SessionSnapshot`), `server/src/log.ts` |
| **API key** (`GEMINI_API_KEY`) | Host `.env` file (gitignored) -> `env.apiKey` in Node server memory -> `@google/genai` client | Server process lifetime only; never bundled into `web/`, never sent over HTTP/WS to browser, `/hud`, or `android-dat` APK; scrubbed from logs/errors via regex | `.gitignore`, `server/src/env.ts`, `server/src/gemini.ts`, `server/src/log.ts` |
| **Usage ledger** (`LedgerLine`) | `server/logs/ledger.jsonl` (gitignored) and aggregated summary at `GET /api/stats` | Local ops telemetry containing `ts`, `feature`, `model`, token counts (`in`, `out`, `thinking`, `cached`), `latency_s`, `ok`, and turn/tool timing counters **only**; zero prompts, frames, transcripts, session IDs, or verdicts | `server/src/ledger.ts` (`ledger`, `usage`, `stats`), `.gitignore` |

---

## 2. Active Capture Minimisation

HoldUp is strictly an on-demand assistive reader, never an always-on lifelogging or continuous surveillance tool.

1. **Explicit User-Initiated Check Only**:
   - Neither the phone camera/microphone nor the glasses DAT stream starts on app launch. Capture begins only when the wearer explicitly starts a check (via the PWA Start control, glasses capture button / Neural Band trigger, or starting streaming in HoldUp Bridge), sending `{ type: "start", ... }` on `/live` or a single-check `POST /api/verify`.
   - At any moment, `{ type: "event", name: "stop" }` (`LiveProxy.handleEvent("stop")`), tapping Stop, or closing the tab immediately halts capture and clears server RAM (`hub.ring.clear()`).

2. **1 fps Live Coaching Cap & Bounded Sharpness Selection**:
   - In `server/src/live.ts`, `LiveProxy.frame(data)` enforces a hard minimum spacing of 900 ms (`if (Date.now() - this.lastVideoAt < 900) return;` i.e. `Date.now() - lastVideoAt >= 900` ms, ~1 fps cap) before forwarding any JPEG frame to Gemini Live for physical coaching cues.
   - On the glasses hardware path (`docs/HARDWARE_NOTES.md`), `android-dat` requests `2 fps` (the lowest rate permitted by the Meta Wearables DAT SDK `StreamConfiguration`, whose valid steps are `2/7/15/24/30`), JPEG-encodes at most ~1 frame/s, and drops frames locally whenever an HTTP `POST /ingest/frame` is still in flight.
   - When `verify_label` is called, `hub.ring.pick(2, 5000)` (`server/src/verify.ts`) selects only the **2 sharpest frames** from the 8-frame ring buffer (`readLabel()` hard-caps input to `frames.slice(0, 3)`).
   - Upstream Gemini Live sessions enable `contextWindowCompression: { slidingWindow: {} }` (`server/src/live.ts`) so older frames roll out of the upstream model context window automatically.

3. **Automatic 45-Second Idle Camera Shutoff**:
   - Configured by `IDLE_STOP_MS = 45000` (`env.idleStopMs` in `server/src/env.ts`).
   - Polled every `2000` ms in `LiveProxy.start()` (`server/src/live.ts`): if `Date.now() - this.lastFrameAt > env.idleStopMs` (45 seconds without incoming camera frames), HoldUp emits `{ type: "coach", cue: "ok", text: "Camera stopped" }` and invokes `this.stop("auto-stopped: no camera frames for 45 s")`, terminating the Gemini Live connection and notifying all connected clients (`{ type: "status", live: "closed", ... }`).
   - Client state tracks both `cameraActive` and `autoStopRemainingSec` (`SessionSnapshot` in `web/src/types.ts`).

4. **Multi-Modal Active Capture Indicators (Audio + Haptic + High-Contrast Visual)**:
   - Because blind and low-vision users cannot rely solely on tiny status icons, HoldUp announces camera activation/shutoff via synthesised Web Audio earcons and haptics (`playEarcon("camera_on")` and `playEarcon("camera_off")` in `web/src/audio/earcons.ts`), spoken/caption cues (`"Camera stopped"`, plus `{ type: "checking", phase: "start" | "end" }` pulses via `startCheckingPulse()`), a WCAG 2.2 AA/AAA high-contrast `CAMERA ON` banner in the PWA (`ThemeMode` supports `"high-contrast"` in `web/src/styles/tokens.css`), and an Android foreground-service notification (`"HoldUp is streaming from your glasses"`).

---

## 3. Bystander & Third-Party Privacy

First-person wearables in kitchens, pharmacies, and grocery aisles require technical safeguards for people nearby:

1. **Hardware Capture LED Enforced by Meta Wearables DAT SDK**:
   - Glasses camera access on Ray-Ban Meta Gen 2 and Ray-Ban Display runs exclusively through the official Meta Wearables Device Access Toolkit (`com.meta.wearable:mwdat-*:1.0.1`, firmware `V128+`).
   - Whenever `session.addCamera(...)` streams frames, the glasses' front-facing hardware capture LED stays illuminated. This indicator is enforced by Meta glasses firmware and the DAT SDK; HoldUp cannot dim, suppress, or bypass it, and stopping the stream in HoldUp Bridge immediately extinguishes the LED (`docs/HARDWARE_NOTES.md` §5.7).

2. **System Prompt Invariants Against Person/Face Description**:
   - **Conversational Live Model (`server/src/prompts/live.md`, line 7)**:
     > *"Never describe what the person, their hands or other people look like. Ignore people and faces completely; if asked about a person, say you only help with labels."*
   - **Label Verification Model (`shared/verify_prompt.md`, Hard Rule #5, line 8)**:
     > *"Ignore people, faces, hands and the background. Never describe a person."*

3. **Schema-Constrained Extraction & Evaluation Hygiene**:
   - `readLabel()` (`server/src/verify.ts`) enforces `responseMimeType: "application/json"` with `responseJsonSchema: LABEL_SCHEMA` (`shared/label_schema.json`) and passes the output through `toLabelRead()`, which accepts only structured product/label fields (`kind`, `product`, `ingredient`, `strength`, `dosing`, `expiry`, `allergens`, `barcode`, `readability`, and max-120-char `guidance`). Free-form descriptions of bystanders or rooms cannot pass through the verification pipeline.
   - Real-world test images in `eval/real/` (`docs/TEAM.md`) follow a strict collection rule: zero faces or bystander personal data, with patient names on pharmacy stickers blurred prior to commit.

---

## 4. Log Redaction & Secret Isolation

### Redacting Logger (`server/src/log.ts`)
Server logs are designed so an operator or judge watching live terminal output during a check sees operational telemetry (`ws.live.connect`, `live.open`, `live.tool`, `live.verify_done`, `hub.gc`) and **never** sees what medicine a user takes, what they said, or what their camera captured:

- **Explicit `DENY` Key Filter**:
  `redact()` checks every log metadata key against:
  ```ts
  const DENY = /^(text|data|transcript|image|frame|frames|audio|profile|speech|headline|question|args|prompt|body|key|apikey|api_key|value)$/i;
  ```
  Any matching key (`text`, `data`, `transcript`, `frame`, `audio`, `profile`, `speech`, `headline`, `question`, `image`, `frames`, `args`, `prompt`, `body`, `key`, `apikey`, `api_key`, `value`) is replaced with `"[redacted]"`.
- **48-Character String Cap**:
  Any non-denied string value longer than `48` characters is replaced with `"[redacted:<length>ch]"` (`err` summaries from `errSummary()` are capped at `160` single-line characters). Base64 media, label text, or accidental payload fields cannot leak through unrecognised key names.
- **`AIza...` Key Scrubber & Session Truncation**:
  Both `redact()` and `errSummary()` scrub Google API keys matching `/AIza[0-9A-Za-z_-]{10,}/g` to `"[key]"`, including inside `unhandledRejection` and `uncaughtException` handlers (`server/src/index.ts`). Session identifiers are truncated to 8 characters via `shortId(id)`. Automated regression tests in `server/test/log-verify.test.ts` verify all `DENY` keys, 48/160-char caps, `AIza...` scrubbing, `FrameRing` eviction/clear, and `toProfile()` input sanitisation.

### Server-Side Secret Isolation (`server/src/env.ts`)
- `GEMINI_API_KEY` is loaded exclusively in `server/src/env.ts` from `.env` (excluded from git via `.gitignore`) and consumed only by `new GoogleGenAI({ apiKey: env.apiKey, ... })` in `server/src/gemini.ts`.
- The key is **never** exposed to `VITE_*` client environment variables, HTTP responses (`/api/health` reports only `gemini: "ok" | "down"`), WebSocket messages, the `/hud` Display Web App, or the `android-dat` APK (which uses Developer Mode `0` placeholders in gitignored `local.properties`).

### Gemini API Data Governance (Paid Tier vs. Free Tier)
- **Paid Billing Tier (Production & Verified Demo Configuration)**: Under Google's Paid Services Gemini API data governance terms, Google **does not** use prompts, camera frames, audio streams, or model outputs to train or fine-tune foundation models.
- **Free Tier Disclosure**: On an unpaid Google AI Studio free-tier key, Google's terms permit human review and model-training use of API inputs. HoldUp explicitly discloses the upstream Google Gemini API transfer during consent onboarding and (`docs/PLAN.md` §Questions #3) restricts any "not used to train models" claim strictly to paid-tier billing deployments.
- **Architectural Split Minimises Upstream Exposure**: Even during paid-tier API calls, `readLabel()` (`server/src/verify.ts`) sends **only** 1 to 3 label JPEG frames and the user's short question (`<= 300` chars) without attaching `Profile`. Matching against `meds`, `allergies`, `avoid`, and `doseLog` executes locally in deterministic TypeScript (`checkLabel()` in `server/src/safety.ts`). Similarly, `/hud-ws` fan-out (`HUD_TYPES` in `server/src/hub.ts`) sends only `verdict`, `coach`, `status`, and `device` events, never raw frames or full profiles.

---

## 5. Informed Consent, GDPR Rights & Non-Medical-Device Safety Boundary

### Contextual Consent & Degraded Privacy/Permission Modes
1. **Plain-Language Consent Onboarding (`ConsentRecord`)**:
   - Before requesting any hardware permission or opening `/live`, HoldUp presents a screen-reader-first (VoiceOver / TalkBack, WCAG 2.2 AA) onboarding screen explaining what is captured (on-demand 1 fps label frames + voice during a check), where it goes (Google Gemini API over HTTPS/WSS for reading/coaching), and what stays on the device (`Profile` and `doseLog` in `localStorage`). Acceptance is stored locally in `ConsentRecord` (`{ accepted, acceptedAt, version }` in `web/src/types.ts`).
2. **Contextual Permissions & Non-Coercive Fallbacks**:
   - Browser `camera` and `microphone` permissions (`PermissionStateSummary`) and DAT `Permission.CAMERA` are requested in context when starting a check. Declining optional capabilities never bricks the app:
     - **Microphone declined or muted (`voice: false` / Snapshot mode)**: Users can type questions (`{ type: "text" }`) or use camera-only **Snapshot mode** (`POST /api/verify` + visual card + local `speechSynthesis`), sending zero audio.
     - **Glasses disconnected or doffed (`DeviceState.worn === false`)**: Announces the transition and falls back cleanly to the phone camera.
     - **Network declined or offline (`TransportMode = "offline"`)**: Uses local `BarcodeDetector` to match EAN/GTIN barcodes against saved `Profile.meds[].barcode` entirely on-device with zero network requests, while clearly stating that unsaved labels cannot be read offline.

### GDPR Alignment & One-Tap Local Wipe (`wipeAllLocalData()`)
- **Lawful Basis & Data Minimisation (GDPR Art. 5, Art. 6(1)(a), Art. 9(2)(a))**: Special-category health data (`meds`, `allergies`, `avoid`, `doseLog`) resides persistently **only** on the user's own phone (`localStorage`), never in a central HoldUp database. Transient processing during an active label check occurs solely on explicit user action with immediate post-session frame erasure (`hub.ring.clear()`).
- **One-Button Erasure & Consent Withdrawal (GDPR Art. 7(3), Art. 17)**: Invoking `wipeAllLocalData()` from the app settings immediately deletes the medication list, allergies, avoid-list, `doseLog`, and `ConsentRecord` from `localStorage` and terminates any open `/live` session (clearing `Hub` frames in server RAM). Because the server stores zero user records on disk, local wipe achieves complete erasure.

### EU MDR Non-Medical-Device Safety Boundary (Regulation (EU) 2017/745)
Under EU MDR Article 2(1) and MDCG 2019-11 software qualification guidance, **HoldUp is an assistive label-reading and personal-checklist lookup tool, not a medical device**:

- **Assistive Equivalence**: HoldUp performs the digital equivalent of reading glasses combined with looking up an item on the user's own written medication schedule and allergy list. It reads printed packaging text and compares that text deterministically against user-entered strings.
- **No Diagnosis, Prescription, or Autonomous Clinical Judgment**:
  - HoldUp never diagnoses conditions, never recommends treatments, never alters prescribed regimens, and never invents dosing advice.
  - `server/src/prompts/live.md` enforces *"The one hard rule: never read safety facts from your own vision"*: the Live voice model is forbidden from stating medicine names, strengths, doses, expiries, or allergens from its own video stream, must invoke `verify_label`, and must speak the returned `speech` field verbatim without softening warnings or upgrading `"unsure"` into `"match"`.
  - `shared/verify_prompt.md` forbids guessing from pack colour, shape, or memory: if any strength digit is ambiguous (`5` vs `6` vs `8`, `2.5` vs `25`), the model must output `value: null` and `confidence <= 0.3`.
- **Deterministic Confidence Gate (`STRENGTH_MIN_CONF = 0.80` in `server/src/safety.ts`)**:
  - Every extracted field carries a `[0, 1]` confidence clamped by `toLabelRead()` (`server/src/verify.ts`).
  - In `server/src/safety.ts`, `STRENGTH_MIN_CONF = 0.8` (`0.80`) acts as a hard deterministic gate (`const strengthOk = !!read.strength.value && read.strength.confidence >= STRENGTH_MIN_CONF`). Even if the active ingredient matches the user's saved medicine (`NAME_MIN_CONF = 0.6`), any missing strength or confidence `< 0.80` forces `checkLabel()` to return `level: "unsure"` (*"It looks like \<name\>, but I can't read the strength confidently..."*), never `"match"`.
  - Likewise, unreadable food allergen panels (`confidence < ALLERGEN_MIN_CONF`, `0.6`) return `level: "unsure"`, never `"safe"`.
- **Mandatory Pharmacist Handoff**:
  - Whenever a strength, name, or allergen panel remains unclear, differs from the user's saved strength (`!sameStrength()`), is expired (`isExpired()`), or produces two `"unsure"` reads in a row, `server/src/safety.ts` and `server/src/prompts/live.md` explicitly direct the user not to guess and to verify with a pharmacist (*"Don't take it before checking with a pharmacist"*, *"ask a pharmacist"*). For any clinical question beyond what is printed on the box (missed doses, new interactions, symptoms), HoldUp declines and refers the user to a pharmacist.
