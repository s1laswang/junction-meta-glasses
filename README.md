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

## Verified Safety, Optical & Latency Benchmarks

Every metric below is measured from real Gemini API runs and deterministic safety checks committed in `eval/*.json` (full methodology and per-case tables in [`docs/EVAL.md`](docs/EVAL.md)):

| Benchmark / Dimension | Artifact (`eval/*.json`) | Measured Result |
|---|---|---|
| **Never-Guess Safety Invariant (`STRENGTH_MIN_CONF = 0.80`)** | All `16` `eval/*.json` suites (`165` label reads) | **`0` confident-wrong dose reads** across every clean, thumb-occluded, curved-bottle, blister-glare, low-light, motion-blurred, bystander-PII, LASA polypharmacy, and 6-language European package check; **`0` false-safe allergen verdicts** |
| **Core 4-Suite Label Verification (`53` cases)** | `eval/combined_summary.json` | **`98.1%` (`52/53`) overall verdict accuracy**, **`100.0%` clean field accuracy**, **`98.2%` occluded/unreadable abstention**, `gemini-3.8-flash` latency **`p50 = 3537.1 ms`** (`p95 = 5638.1 ms`) |
| **Strength Confidence Calibration (`16` reads)** | `eval/calibration_curve.json` | **`ECE = 0.0138`**, **`Brier = 0.0005`**, **`100.0%` clean recall & `100.0%` unreadable abstention** at `0.80` (`0.9875` clean mean confidence vs `0.0000` heavy/occluded; `p50 = 3424.9 ms`) |
| **Curved Bottles, Jars & Silver Blister Foil Glare (`10` cases)** | `eval/curved_blister_results.json` | **`10/10` (`100.0%`) verdict accuracy**, `100.0%` readable recall on curved bottles & embossed foil, `100.0%` abstention on `55 deg` wrap-around, specular glare & torn pockets, `0` wrong doses (`p50 = 3987.5 ms`) |
| **Low-Light, Flashlight Hotspot & Hand-Tremor Blur (`12` cases)** | `eval/lighting_motion_results.json` | **`12/12` (`100.0%`) verdict accuracy**, `100.0%` recall at `25%` dim indoor light & `3 px` tremor blur, `100.0%` abstention on `3%` near-dark, overexposed glare & `22-24 px` swipe blur, `0` wrong doses (`p50 = 3559.9 ms`) |
| **LASA Polypharmacy, Double-Dose & Drug-Class Traps (`10` cases)** | `eval/polypharmacy_confusion_results.json` | **`10/10` (`100.0%`) verdict accuracy** catching `2/2` same-day double doses, `3/3` look-alike/combo strength traps (`10 mg` vs `5 mg`, `850 mg` vs `500 mg`, `500+30 mg`), `2/2` Nordic brand allergy/avoid traps (`Amorion`, `Eliquis`), and `2,5 mg` comma decimals (`p50 = 2978.4 ms`) |
| **6-Language European Packaging (`12` cases)** | `eval/multilingual_labels_results.json` | **`12/12` (`100.0%`) verdict accuracy** across **`fi`, `sv`, `de`, `fr`, `es`, `en`**, `100.0%` allergen recall, `0` false-safe allergens, `100.0%` missing-panel abstention, `0` wrong doses (`p50 = 3249.6 ms`) |
| **Multi-Stage Physical Coaching Trajectories (`4` trajectories, `8` calls)** | `eval/coaching_trajectories.json` | **`4/4` (`100.0%`) pre-coaching abstentions** -> **`4/4` (`100.0%`) sharpest frame selected first** (`FrameRing(8).pick(2)`) -> **`4/4` (`100.0%`) post-coaching verdict accuracy**, `0` wrong doses (`p50 = 3536.5 ms`) |
| **Bystander & Background PII Red-Team (`8` scenes + `8` probes)** | `eval/bystander_privacy_results.json`, `eval/coaching_eval.json` | **`0` bystander or background PII leaks across `8/8` (`100.0%`) red-team scenes** (badges, IBAN screens, mail, SMS lockscreens, bystanders) and **`8/8` (`5.00/5`)** coaching/privacy/Finnish-switch judge pass rate (refusal `2574.8 ms`) |
| **Gemini Live First-Audio & 3-Model Fallback Chains** | `eval/live_models_probe.json`, `eval/model_comparison.json` | **`gemini-3.8-live` `582 ms` first-audio latency** (`706 ms` WS connect; `3/3` Live models reachable, fallback `489 ms`) and **`100.0%` accuracy / `0` wrong doses across all `3` Flash fallback models** (`36` calls, `p50` down to `1310.4 ms`) |
| **Slow-Network Bandwidth & 3-Year Assistive TCO** | `eval/unit_economics.json` | **`84.0%` slow-network video savings** (`724.64 KB -> 116.02 KB` JPEG above `650 ms` RTT), **`EUR 0.00294`/check** (`EUR 0.35/mo`), and **`EUR 341.68` vs `EUR 4,150.00` 3-year TCO = `91.8%` savings** (`12.1x` lower than OrCam midpoint; `85.4%` lower than `EUR 2,340.00` Aira daily plan) |

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

Run the full automated verification gate (`394` unit tests across `54` suites, TypeScript check, production build, DAT bridge verifier, ephemeral HTTP probe, and submission/link/eval hygiene checks), plus the live Gemini smoke test when `GEMINI_API_KEY` is set:

```bash
node scripts/verify-all.mjs
node scripts/verify-submission.mjs
npm -w server run smoke
```

---

## Documentation & Pitch Deck Index

| Artifact | Summary |
|---|---|
| [`deck/index.html`](deck/index.html) | Submission pitch deck (HTML slide deck) |
| [`docs/judge-handout.html`](docs/judge-handout.html) | Self-contained A4 printable judge & mentor quick-start handout with architecture, controls, and verified metrics |
| [`docs/printable-props.html`](docs/printable-props.html) | Printable A4 stage prop medication boxes, food allergen labels, EAN barcodes, and Finnish `holdup://rx` pharmacy QR stickers |
| [`docs/SUBMISSION_CHECKLIST.md`](docs/SUBMISSION_CHECKLIST.md) | Junction 2026 portal submission copy, `BRIEF.md` & 4x25% rubric traceability matrix, and freeze/submit checklist |
| [`docs/PLAN.md`](docs/PLAN.md) | Product thesis, platform decision, system architecture, and 3-minute demo script |
| [`docs/ARCHITECTURE_DEEP_DIVE.md`](docs/ARCHITECTURE_DEEP_DIVE.md) | Protocol sequence diagrams, `FrameRing` & zero-code `/hud-ws` binding internals, and end-to-end resilience state machines |
| [`docs/EVAL.md`](docs/EVAL.md) | Label extraction accuracy, confidence calibration (`ECE = 0.0138`), optical/privacy stress suites, and unit economics report |
| [`docs/HUD_SPEC.md`](docs/HUD_SPEC.md) | Ray-Ban Display 600x600 additive waveguide rules, Neural Band input & zero-code session attach |
| [`docs/HARDWARE_NOTES.md`](docs/HARDWARE_NOTES.md) | Meta Wearables DAT SDK 1.0.1 Android bridge setup, pairing & Display Web App runbook |
| [`docs/IOS_DAT_PARITY.md`](docs/IOS_DAT_PARITY.md) | iOS Swift 6 Meta Wearables DAT SDK 1.0.1 companion wire-contract parity guide (`MWDATCore` & `MWDATCamera`) |
| [`docs/MENTOR_QA.md`](docs/MENTOR_QA.md) | 18 engineering Q&As for Meta booth mentors (Display Web Apps, Android/iOS DAT 1.0.1, safety calibration & EU MDR) |
| [`docs/PILOT_PLAN.md`](docs/PILOT_PLAN.md) | 12-week Helsinki pilot blueprint (`N = 24`) with Nakovammaisten liitto (Iiris Center) and pharmacy counter QR onboarding |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | End-to-end data flow, retention matrix, log redaction, GDPR & EU MDR safety boundary |
| [`docs/ACCESSIBILITY_AUDIT.md`](docs/ACCESSIBILITY_AUDIT.md) | WCAG 2.2 AA/AAA contrast proofs, VoiceOver/TalkBack screen-reader flow, earcons, and keyboard shortcuts |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Vision impairment prevalence, medication error research, 3-year TCO comparison, and Finland adoption context |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Live stage choreography covering glasses coaching, safety catches, and fault recovery |
| [`docs/VIDEO_PRODUCTION.md`](docs/VIDEO_PRODUCTION.md) | 3-pane 1080p60 compositing layout, burned-in WCAG AAA open captions, and backup demo video production guide |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Local HTTPS tunnel, Cloud Run deployment, and environment configuration |
| [`docs/TEAM.md`](docs/TEAM.md) | Team roles, `/live` and `/hud-ws` wire contracts, and shared TypeScript schemas |
