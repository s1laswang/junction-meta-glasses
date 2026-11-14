# HoldUp: Hold it up. Know it is the right one.

Hands-free medication and allergen label assistant for blind, low-vision, and older adults on **Meta AI Glasses**, powered by **Gemini Live**.

Built at **Junction 2026** for **Meta "AI Glasses for Everyone, Everyday"** and **Google DeepMind "Best Use of Gemini API"**.

Hold up a medicine box or a food package. HoldUp coaches your hands in real time until the label is sharp, extracts printed fields with per-field confidence, checks them deterministically against *your* medication schedule, drug-class avoid rules, and allergies (stored on your device only), and speaks a clear answer while projecting a high-contrast card on Ray-Ban Display. **It never guesses a dose.**

1. **Ask naturally**: *"Is this my evening pill?"* or *"Does this contain nuts?"* via the glasses open-ear mic, capture button, or Meta Neural Band.
2. **Active physical coaching**: **Gemini Live** (`gemini-3.8-live`) watches ~1 fps first-person frames and speaks short body-relative cues (*"Turn it left... move closer... hold still"*) until the text is readable.
3. **Multi-frame verified read**: `verify_label` selects the 1-3 sharpest frames from an in-memory ring buffer and runs schema-locked extraction on **`gemini-3.8-flash`** (`shared/label_schema.json`) with `[0, 1]` confidence per field.
4. **Deterministic personal safety check**: `server/src/safety.ts` cross-checks active ingredients, brand/INN synonyms (EN/FI/SV), drug classes (NSAIDs, penicillins, statins), allergen synonyms, expiry dates, and daily dose logs behind a hard **`STRENGTH_MIN_CONF = 0.80` never-guess gate**.
5. **Confirm & log**: Speaks a 2-sentence verdict over open-ear audio, renders a 4-channel HUD card on Ray-Ban Display, and logs taken doses locally by voice or pinch (with 1-tap plain-text caregiver summary export).

---

## The Everyday Problem & Why Glasses Beat a Phone

- **Who it serves**: Roughly **2.2 billion people worldwide** live with vision impairment (**~80,000 in Finland**, with **>80% aged 65+**), alongside older adults managing daily polypharmacy with declining sight.
- **The daily high-stakes moment**: Several times a day, nearly identical white pharmacy boxes or fine-print food cartons force the question: *"Is this Amlodipine 5 mg or Ibuprofen 400 mg? Has it expired? Are hazelnuts listed?"*
- **Why smartphone OCR fails in practice**:
  - **Needs three hands**: Two hands hold and rotate a curved bottle (or steady a cane and a glass of water); holding and blind-aiming a phone demands a third.
  - **Single-shot roulette**: Static snapshot apps read raw unprioritized text with zero physical guidance when the barcode or blank side faces the lens, and zero awareness of the user's prescriptions or allergies.
  - **Loss of privacy & autonomy**: Calling a relative or remote volunteer is slow and exposes private medication routines.
- **Why first-person Meta AI Glasses change the interaction**:
  - **Both hands stay free**: The head-mounted camera already points where proprioception naturally holds an item at chest height.
  - **Streaming body-relative coaching**: Continuous ~1 fps frames let Gemini Live guide hand rotation, distance, and lighting before locking a read.
  - **Private open-ear audio**: Bluetooth HFP open-ear speakers deliver answers privately while keeping ears open to the room.
  - **Additive waveguide confirmation**: **Meta Ray-Ban Display** projects a bounded, high-contrast verdict card (`MATCH`, `WARNING`, `UNSURE`, `INFO`) so low-vision wearers get synchronized audio and visual confirmation.
- **Adoption & pilot path**: Built within the **EU MDR non-medical assistive reader** boundary (digital reading glasses + user-owned checklist lookup), enabling straightforward community pilots with visual-impairment organizations (such as **Nakovammaisten liitto** in Finland) and pharmacies via EAN/GTIN dispensing-box barcode onboarding.

---

## Architecture (One Backend, Three Thin Clients)

Ray-Ban Display Web Apps have no camera or raw microphone stream (`getUserMedia` is unavailable on-lens), whereas first-person camera access runs through the native **Meta Wearables Device Access Toolkit (DAT)**. HoldUp unifies **one Node 24 TypeScript backend** with **three thin clients** so full glasses hardware and phone-only fallbacks share one live session hub:

```text
+-----------------------------------------------------------------------------------+
| META AI GLASSES (Ray-Ban Meta Gen 2 + Meta Ray-Ban Display + Neural Band)         |
|  - First-person camera (DAT 1.0.1)   - Open-ear mic/speaker (BT HFP)              |
|  - Hardware Capture LED (firmware)   - 600x600 additive waveguide HUD (/hud)      |
+-----------------+----------------------------------+----------------------+-------+
                  | 720x1280 @ 2fps                  | BT HFP audio         ^
                  v                                  v                      |
+----------------------------------+  +----------------------------------+  |
| 1. ANDROID DAT BRIDGE            |  | 2. PHONE / LAPTOP PWA (web/)     |  |
|    (android-dat/, Kotlin)        |  |  - VoiceOver / TalkBack React 19 |  |
|  - mwdat-core & mwdat-camera     |  |  - Web Audio PCM16 (16k -> 24k)  |  |
|    SDK 1.0.1 (Dev Mode app ID 0) |  |  - getUserMedia phone-cam backup |  |
|  - Throttles <= ~1 fps JPEG      |  |  - 7-fixture Demo Prop Mode      |  |
|  - Reports worn/battery state    |  |  - Offline BarcodeDetector       |  |
+-----------------+----------------+  +-----------------+----------------+  |
                  | POST /ingest/frame                  | WSS /live         | WSS /hud-ws
                  | POST /ingest/state                  | POST /api/verify  | (zero-code
                  v                                     v                   |  session
+------------------------------------------------------------------------+  |  attach +
| NODE 24 TYPESCRIPT BACKEND (server/, Express 5 + ws + @google/genai)   |--+  replay)
|  - Hub & FrameRing(8): RAM-only frame buffer + zero-code /hud fan-out  |  |
|  - LiveProxy (gemini-3.8-live): 2-way voice coaching, barge-in & tools |  |
|  - verify_label (gemini-3.8-flash): 1-3 sharpest frames -> JSON schema |  |
|  - Safety Engine (server/src/safety.ts): STRENGTH_MIN_CONF = 0.80 gate |  |
+------------------------------------------------------------------------+  |
                                                                            |
                                      +----------------------------------+  |
                                      | 3. RAY-BAN DISPLAY WEB APP (/hud)|<-+
                                      |  - Pure #000000 waveguide card   |
                                      |  - Neural Band Arrow* / Enter    |
                                      +----------------------------------+
```

- **Phone / Laptop PWA (`web/`)**: Screen-reader-first React 19 + Vite 6 client (WCAG 2.2 AA, `dark` / `light` / `high-contrast` themes, dual-slot ARIA live announcer, accessible keyboard shortcuts), Web Audio PCM16 streaming + synthesized earcons, `getUserMedia` camera fallback, **Demo Prop Mode** (`7` realistic medication, allergen, blurry, expired, and back-of-box fixtures), and on-device **`BarcodeDetector`**. Paired Ray-Ban Meta glasses act immediately as a hands-free Bluetooth HFP mic and speaker.
- **Meta Ray-Ban Gen 2 Camera Bridge (`android-dat/`)**: Thin Kotlin app built on **Meta Wearables DAT SDK `1.0.1`** (`com.meta.wearable:mwdat-core`, `mwdat-camera` on Maven Central; Developer Mode ID `0`), streaming `720x1280` frames throttled to ~1 fps JPEG (`/ingest/frame`) plus real-time `connected`, `worn`, `battery`, and `streaming` telemetry (`/ingest/state`).
- **Meta Ray-Ban Display Web App (`/hud`)**: Pure-black `#000000` additive waveguide UI (`600x600` viewport, `<= 65%` lit pixel fill budget, `<= 8` word headline cap, 4-channel geometric shape + icon + uppercase badge + high-luma color encoding), **Meta Neural Band** spatial focus (`Arrow*` / `Enter`, `<= 2`-entry `popstate` history cap), and zero-code session attach (`/hud-ws` auto-binds to the latest active session and replays buffered state).
- **Node 24 TypeScript Backend (`server/`) & Gemini Workforce**: Orchestrates **Gemini Live** (`gemini-3.8-live`) with sliding-window context compression, `sessionResumption`, and tool calling (`show_cue`, `verify_label`, `log_dose`); schema-constrained multi-frame extraction on **`gemini-3.8-flash`** (`ThinkingLevel.LOW`); and deterministic verification in `server/src/safety.ts`. Offline scripts also use Gemini to generate degraded test fixtures (`server/scripts/generate-demo-fixtures.ts`) and score coaching quality and bystander privacy (`eval/judge_coaching.py`).

---

## Graceful Degradation & Resilience Matrix

Judges can trigger and inspect every fallback live via the in-app **Device & Resilience Panel**:

| Failure / Constraint | Runtime Detection | Automatic HoldUp Behavior |
|---|---|---|
| **Permission Denied** (Camera or Mic) | `PermissionStateSummary` (`denied`) | Plain-language recovery steps; mic denial runs camera-only **Snapshot Mode** (`POST /api/verify` + typed input + TTS); camera denial still unlocks **Demo Prop Mode** fixtures. |
| **Live WS Drop -> HTTP Snapshot + TTS** | WebSocket `close`/`error` or `live: "degraded"` | Exponential-backoff reconnect (`300 ms` to `8000 ms` cap) + Gemini `sessionResumption` handle; seamlessly switches to **Snapshot Mode** (`POST /api/verify` + `/api/tts` or browser `speechSynthesis`). |
| **Complete Offline -> On-Device Barcode Match** | `navigator.onLine === false` | Switches to **Offline Mode**: local `BarcodeDetector` matches EAN/UPC/QR codes against saved `localStorage` `meds[].barcode` and `doseLog` with zero network calls, clearly stating unsaved labels cannot be read offline. |
| **Slow Wi-Fi -> RTT-Adaptive FPS / JPEG** | 5s WebSocket `ping` / `pong` RTT probe | Scales capture dynamically (`<= 250 ms`: `1.0 fps`, `768 px`, JPEG `0.78-0.80`; `<= 600-650 ms`: `0.75 fps`, `640 px`, JPEG `0.64-0.65`; `> 650 ms`: `0.5-0.25 fps`, `512 px`, JPEG `0.40-0.50`). |
| **Glasses Doffed / Low Battery -> Phone Camera** | DAT `/ingest/state` (`!connected`, `!worn`, or `battery < 15%`) | Announces state transition aloud and hot-swaps active eye `source` from `"glasses"` to `"phone"` mid-session without losing conversation or profile state. |
| **Gemini 3-Model Fallback Chain** | HTTP `429` quota, timeout, `5xx`, or WS close | Retries with jittered backoff, then walks fallback chains: Live (`gemini-3.8-live` -> `gemini-3.1-flash-live-preview` -> `gemini-2.5-flash-native-audio-latest`) and Verify (`gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3-flash-preview`). |

---

## Consent, Privacy & Bystander Safety

- **Explicit Active Check Only + 45s Auto-Stop**: Zero background listening or lifelogging. Capture begins only on explicit user action, signals activation via `camera_on`/`camera_off` earcons, haptics, and a high-contrast `CAMERA ON` banner, throttles live coaching to `<= 1 fps` (`>= 900 ms` interval), and auto-stops after **45 seconds** without frames (`IDLE_STOP_MS = 45000`).
- **Zero Server Frame or Audio Retention**: Camera frames reside only in a bounded 8-slot RAM `FrameRing` cleared immediately on WebSocket close (`hub.ring.clear()`) and by a 10-minute idle GC. PCM16 audio streams pass-through in RAM only. `server/src/log.ts` redacts `DENY`-listed keys, caps strings at `48` chars, and scrubs `AIza...` secrets (`GEMINI_API_KEY` stays strictly in server RAM).
- **On-Device Health Data & 1-Tap Wipe**: Medication schedules, allergies, avoid-lists, `doseLog`, and `ConsentRecord` persist exclusively in phone `localStorage` (`holdup.*`), never on server disk or loaner Display glasses (`/hud` writes zero storage), and `readLabel()` receives zero profile data. Invoking `wipeAllLocalData()` erases all local state in one tap.
- **Hardware Capture LED & Bystander Face-Ignore Invariant**: Meta DAT SDK `1.0.1` + firmware `V128+` lock the glasses front-facing capture LED ON whenever streaming. Both `server/src/prompts/live.md` and `shared/verify_prompt.md` forbid describing people, faces, or hands, enforced downstream by strict JSON schema validation.
- **Non-Medical-Device Pharmacist Handoff**: Assistive label reader under EU MDR Art. 2(1). Gemini Live is barred from reading doses from its own video stream, `STRENGTH_MIN_CONF = 0.80` refuses uncertain strengths, and any ambiguity, mismatched dose, or expired pack directs the user to verify with a pharmacist.

---

## Run & Test in One Command

Copy `.env.example` to `.env`, add your `GEMINI_API_KEY`, and start both the Node backend (`:8787`) and Vite PWA (`:5173`):

```bash
cp .env.example .env
npm install && npm run dev
```

Open `http://localhost:5173` for the main PWA and `http://localhost:5173/hud` for the Ray-Ban Display HUD. To serve a single-origin production build over HTTPS for phones and Meta AI `Connect Web App` (`cloudflared` tunnel to `:8787`), run in two terminals:

```bash
npm start
npm run tunnel
```

Run static typechecking, unit test suites (`server` and `web`), and the end-to-end live WebSocket + HUD + snapshot smoke check:

```bash
npm run typecheck
npm -w server test
npm -w web test
npm -w server run smoke
```

---

## Documentation & Pitch Deck Index

| Artifact | Summary |
|---|---|
| [`deck/index.html`](deck/index.html) | Submission pitch deck (HTML slide deck) |
| [`docs/PLAN.md`](docs/PLAN.md) | Product thesis, platform decision, system architecture, and 3-minute demo script |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | End-to-end data flow, retention matrix, log redaction, GDPR & EU MDR safety boundary |
| [`docs/HUD_SPEC.md`](docs/HUD_SPEC.md) | Ray-Ban Display 600x600 additive waveguide rules, Neural Band input & zero-code session attach |
| [`docs/HARDWARE_NOTES.md`](docs/HARDWARE_NOTES.md) | Meta Wearables DAT SDK 1.0.1 Android bridge setup, pairing & Display Web App runbook |
| [`docs/EVAL.md`](docs/EVAL.md) | Label extraction accuracy, confidence calibration, and Gemini coaching/privacy evaluation |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Vision impairment prevalence, medication error research, and Finland adoption context |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Live stage choreography covering glasses coaching, safety catches, and fault recovery |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Local HTTPS tunnel, Cloud Run deployment, and environment configuration |
| [`docs/ACCESSIBILITY_AUDIT.md`](docs/ACCESSIBILITY_AUDIT.md) | WCAG 2.2 AA, VoiceOver/TalkBack screen-reader flow, earcons, and keyboard shortcuts |
| [`docs/TEAM.md`](docs/TEAM.md) | Team roles, `/live` and `/hud-ws` wire contracts, and shared TypeScript schemas |
