# HoldUp: "Hold it up. Know it is the right one."

Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · deadline **Sun 15 Nov 10:00 Helsinki**
Also entered for Google DeepMind "Best Use of Gemini API".

---

## 1. Problem and Audience

**Audience.** Roughly **2.2 billion people worldwide** live with vision impairment (**~80,000 in Finland**, with **>80% aged 65+**). The second core audience is older adults managing daily polypharmacy with declining sight.

**Everyday high-stakes problem.** *"Is this the right one? Did I take my pills today?"* Several times a day, nearly identical white Nordic pharmacy boxes or fine-print food packages create an urgent question: is this Amlodipine 5 mg or Ibuprofen 400 mg? Was my evening tablet already logged? Has this pack expired? Does this snack bar contain hazelnuts or peanut oil? Today the options force unacceptable trade-offs:
- **Ask someone nearby.** Costs independence and privacy, and fails when living alone.
- **Smartphone OCR apps (Seeing AI and similar).** Require **three hands** (two hands to hold and rotate a curved bottle or steady a cane and water glass, plus a third hand to blind-aim a phone). Single snapshots read raw unprioritized text with zero physical guidance when the barcode or blank side faces the lens, and zero awareness of *your* prescriptions or allergies.
- **Video-call a volunteer (Be My Eyes).** Slow, requires another person, and exposes private medication routines.

**Why Meta AI Glasses beat a phone here.**
- **Hands-free first-person framing.** The head-mounted camera already points where proprioception naturally holds an item at chest height, keeping both hands free.
- **Private open-ear audio.** Bluetooth HFP open-ear speakers deliver clear 2-sentence answers privately while keeping ears open to the room.
- **Streaming body-relative coaching.** Continuous ~1 fps frames let Gemini Live coach hand position in real time (*"Turn it left... move closer... hold still"*) and support instant voice barge-in.
- **Synchronized waveguide confirmation.** On **Meta Ray-Ban Display**, a pure-black `#000000` `600x600` additive waveguide card (`MATCH`, `WARNING`, `UNSURE`, `INFO`) pairs geometric shapes, icons, uppercase badges, and high-luminance colors with **Meta Neural Band** spatial gestures (`Arrow*` / `Enter`).

---

## 2. The Product & Shipped UI Surfaces

HoldUp is a hands-free medication and allergen label assistant powered by **Gemini Live** (`gemini-3.8-live`) and **Gemini 3.8 Flash** (`gemini-3.8-flash`).

### End-to-End Interaction Loop
1. **Ask naturally.** *"Is this my evening pill?"*, *"Did I take my pills?"*, or *"Does this contain nuts?"* via the glasses open-ear mic, capture button, keyboard (`Space`), or Meta Neural Band.
2. **Guided capture (`gemini-3.8-live`, streaming).** Watches ~1 fps frames and speaks short body-relative cues (`other_side`, `rotate`, `closer`, `more_light`, `hold_still`) until text is sharp, while `VoiceActivityPill` tracks open-ear mic RMS and supports mid-sentence barge-in.
3. **Multi-frame verified read (`verify_label` -> `gemini-3.8-flash`).** Selects the 1-3 sharpest frames from the bounded 8-slot RAM `FrameRing` (`FrameRing.pick`) and runs schema-constrained extraction (`shared/label_schema.json`) with `[0, 1]` confidence per field and **zero user profile attached** (preventing confirmation bias).
4. **Deterministic personal safety check (`server/src/safety.ts`).** Enforces 6 deterministic guardrails against the user's **on-device** profile behind a hard **`STRENGTH_MIN_CONF = 0.80` never-guess gate**:
   - `MATCH`: *"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."*
   - `WARNING`: *"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."* (Also catches wrong strengths, double doses, expired packs, and EU-14 food allergen synonyms such as `arachis oil` -> `peanut`).
   - `UNSURE`: *"It looks like Amlodipine, but I can't read the strength confidently. Turn the label toward the light or check with a pharmacist."* **HoldUp never guesses a dose.**
5. **Confirm, log, and alert family.** Speaks a concise 2-sentence verdict, updates `/hud` on Ray-Ban Display, logs taken doses into on-device `localStorage` by voice (*"I took it"*) or Neural Band pinch, updates the daily adherence checklist, and formats 1-tap SMS/email/clipboard caregiver summaries (`CaregiverAlertCard`).

### Shipped Client & Booth Surfaces
- **`JudgeDemoTour` (`web/src/components/JudgeDemoTour.tsx`)**: Docked 60-second interactive judge walkthrough at the top of the PWA running all 5 core safety and resilience beats (`1. Right Evening Pill`, `2. NSAID Safety Catch`, `3. Covered Dose (Zero Guess)`, `4. Hidden Nut Allergen`, `5. Wi-Fi Off Barcode Fallback`) in one click without requiring physical props.
- **`ScheduleChecklistCard` (`web/src/components/ScheduleChecklistCard.tsx`, *"Did I Take My Pills?"*)**: Real-time daily adherence checklist grouping saved medications by local dose window (`morning`, `noon`, `evening`, `bedtime`, `as_needed`), showing `takenToday / requiredToday` counts, `HH:MM` timestamps, and `>= 48 px` `Check Label` / `Log Taken` buttons across `en`, `fi`, and `sv`.
- **`ConfidenceBreakdownCard` (`web/src/components/ConfidenceBreakdownCard.tsx`)**: Per-field `[0, 100%]` confidence inspector rendered directly beneath `VerdictCard`, displaying a visual **`80%` `STRENGTH_MIN_CONF = 0.80` threshold bar** (`80% Dose Gate: PASSED >= 80%` vs `BLOCKED < 80%`), overall readability badge, and the deterministic safety audit trail.
- **`SafetyRuleExplainerCard` (`web/src/components/SafetyRuleExplainerCard.tsx`)**: Personalized inspection of all 6 active deterministic guardrails (`80% Never-Guess Dose Gate`, `Prescription Ingredient & Strength Match`, `Drug-Class & Avoid Rules`, `Allergen & Excipient Synonym Catch`, `Expiry Month & Date Guard`, `Same-Day Double-Dose Prevention`) plus the EU MDR Art. 2(1) non-medical assistive-reader boundary.
- **`VoiceActivityPill` (`web/src/components/VoiceActivityPill.tsx`)**: Open-ear voice status bar resolving 6 deterministic states (`MIC LISTENING`, `HOLDUP SPEAKING`, `SNAPSHOT AUDIO`, `OFFLINE LOCAL`, `AUDIO MUTED`, `MIC STANDBY`) with a 5-bar RMS meter and `>= 48 px` `Interrupt Speech` barge-in button.
- **`PharmacyImportModal` (`web/src/components/PharmacyImportModal.tsx`)**: Zero-cloud `holdup://rx` counter QR onboarding supporting **live environment-camera QR scanning** (`Scan QR with Camera` via `getUserMedia` + `BarcodeDetector`, stopping camera tracks immediately on capture), smart guidance if a DAT bridge QR or retail EAN barcode is scanned instead, 1-click Finnish *Yliopiston Apteekki* sample loading, and idempotent local profile merge.
- **`ViewfinderStage`, `DeviceResiliencePanel`, `EvalProofCard`, `HudPreviewFrame`, `DoseTimelineCard` & `CaregiverAlertCard`**: Explicit `CAMERA OFF` / `CAMERA ON` + 45s auto-stop indicator, 3-source switcher (`Phone Camera`, `Glasses DAT`, `7 Demo Props`), live RTT/DAT telemetry + 4 chaos fault simulators + SVG QR pairing codes, live `/api/stats` ledger card, interactive `600x600` `#000000` Ray-Ban Display simulator, 7-day dose timeline, and caregiver alert links.
- **Single-Origin Pitch & Booth Artifacts (`:8787`)**:
  - `/deck` ([`deck/index.html`](../deck/index.html)): Self-contained 12-slide 16:9 HTML pitch deck with presenter notes, slide overview grid, and live `/api/eval-summary` hydration.
  - `/judge-handout.html` ([`docs/judge-handout.html`](judge-handout.html)): Printable A4 portrait judge and mentor quick-start handout with inline SVG waveguide diagrams, controls, and verified metrics.
  - `/printable-props.html` ([`docs/printable-props.html`](printable-props.html)): Printable A4 stage prop wraps (*Amlodipin 5 mg*, *Burana 400 mg*, expired *Metformin 500 mg*, *Nordic Oat & Hazelnut Bar*) with scannable GS1 EAN-13 / Code-128 barcodes and a zero-PII Finnish `holdup://rx` pharmacy QR counter sticker.

### Trust, Privacy, and Graceful Degradation Principles
- **No silent guessing**: `STRENGTH_MIN_CONF = 0.80` blocks any uncertain medication dose and routes to a coaching cue or pharmacist handoff.
- **Active check only + 45s auto-stop**: Capture starts only on explicit user action, plays `camera_on`/`camera_off` earcons, throttles live frames to `<= 1 fps` (`>= 900 ms`), and auto-stops after `45 s` (`IDLE_STOP_MS = 45000`).
- **Zero server retention**: Frames stay in an 8-slot RAM `FrameRing` cleared on WebSocket close (`hub.ring.clear()`); audio streams in RAM only; `server/src/log.ts` redacts `DENY` keys and scrubs `AIza...` secrets; health profiles and `doseLog` stay strictly in phone `localStorage` (`holdup.*`, 1-tap `wipeAllLocalData()`); `/hud` writes zero browser storage.
- **Hardware LED + Bystander Face-Ignore**: Meta DAT SDK `1.0.1` + firmware `V128+` lock the front capture LED ON during streaming, while prompts and JSON schema forbid describing people or faces.

| Failure / Constraint | Runtime Detection | Automatic HoldUp Behavior |
|---|---|---|
| **Permission Denied** (Camera or Mic) | `PermissionStateSummary` (`denied`) | Plain-language Chrome/Safari recovery banner; mic denial runs camera-only **Snapshot Mode** (`POST /api/verify` + typed input + `/api/tts`); camera denial unlocks **Demo Prop Mode**. |
| **Live WebSocket Drop** | `/live` WS `close`/`error` or `degraded` | Exponential-backoff reconnect (`300 ms` to `8000 ms`) + Gemini `sessionResumption` handle; seamlessly switches to **Snapshot Mode** (`POST /api/verify` + `/api/tts` or `speechSynthesis`). |
| **Complete Offline** | `navigator.onLine === false` | **Offline Mode**: local `BarcodeDetector` matches EAN/UPC barcodes against saved `localStorage` `meds[].barcode` and `doseLog` at `0 B` network traffic, stating clearly that unsaved labels cannot be read offline. |
| **Slow Venue Wi-Fi** | 5s WebSocket `ping` / `pong` RTT probe | Dynamically adapts capture from `1.0 fps` `768 px` (`<= 250 ms` RTT) down to `0.75 fps` `640 px` (`<= 650 ms`) and `0.5 fps` `512 px` JPEG `0.50` (`> 650 ms`), cutting video bandwidth by `84.0%`. |
| **Glasses Doffed / Low Battery** | DAT `/ingest/state` (`!connected`, `!worn`, `battery < 15%`) | Announces transition aloud and hot-swaps active eye from `"glasses"` to `"phone"` mid-session without losing transcripts or profile state. |
| **Gemini Error or Quota (`429`/`5xx`)** | Retry + 3-model fallback chains | Live (`gemini-3.8-live` -> `gemini-3.1-flash-live-preview` -> `gemini-2.5-flash-native-audio-latest`) and Verify (`gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3-flash-preview`). |

---

## 3. Platform Decision: One Backend, Three Thin Clients

Meta Ray-Ban Display Web Apps run inside an on-glasses Chromium container with **no camera or raw microphone API** (`getUserMedia` is unavailable on-lens), whereas first-person camera access runs through the native **Meta Wearables Device Access Toolkit (DAT) SDK `1.0.1`** ([`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md), [`docs/IOS_DAT_PARITY.md`](IOS_DAT_PARITY.md)). HoldUp unifies **one Node.js TypeScript backend** with **three thin clients**:

1. **Phone / Laptop PWA (`web/`, P0 core)**: Screen-reader-first React 19 + Vite 6 client (WCAG 2.2 AA/AAA across `dark`, `light`, and `high-contrast` themes), 16 kHz / 24 kHz PCM16 Web Audio streaming, `getUserMedia` phone-camera fallback, 7-fixture Demo Prop Mode, and offline `BarcodeDetector`. Paired Ray-Ban Meta glasses act immediately as a hands-free Bluetooth HFP mic and open-ear speaker.
2. **Android DAT Camera Bridge (`android-dat/`, P1 hardware eye)**: Thin Kotlin app built on `com.meta.wearable:mwdat-core:1.0.1` and `mwdat-camera:1.0.1` (Developer Mode app ID `0`), streaming `720x1280` frames throttled to ~1 fps JPEG (`POST /ingest/frame`) plus `connected` / `worn` / `battery` / `streaming` telemetry (`POST /ingest/state`), paired in one scan via `holdupbridge://connect`.
3. **Meta Ray-Ban Display Web App (`/hud`, P1 waveguide lens)**: Pure `#000000` `600x600` additive waveguide HUD (`<= 65%` lit pixel fill budget, `<= 8` word headline cap, 4-channel redundant encoding) with Neural Band `Arrow*` / `Enter` focus and zero-code session attach over `WSS /hud-ws`.

---

## 4. System Architecture & Single-Origin Endpoints

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
|    (android-dat/, Kotlin)        |  |  - ScheduleChecklistCard & Tour  |  |
|  - mwdat-core & mwdat-camera     |  |  - ConfidenceBreakdownCard (80%) |  |
|  - Throttles <= ~1 fps JPEG      |  |  - VoiceActivityPill (barge-in)  |  |
|  - Reports worn/battery state    |  |  - PharmacyImportModal (cam QR)  |  |
+-----------------+----------------+  +-----------------+----------------+  |
                  | POST /ingest/frame                  | WSS /live         | WSS /hud-ws
                  | POST /ingest/state                  | POST /api/verify  | (zero-code
                  v                                     v                   |  floatingHuds
+------------------------------------------------------------------------+  |  attach +
| SINGLE-ORIGIN NODE/TS SERVER (:8787 local / :8080 Cloud Run, Express 5)|--+  1.78ms p50
|  - Static & Booth: /, /hud, /deck (12 slides), /judge-handout.html,    |     replay)
|    /printable-props.html, /.well-known/meta-wearables-manifest.json    |
|  - Hub & FrameRing(8): RAM-only sharpness-ranked frame ring + fan-out  |
|  - LiveProxy (gemini-3.8-live): 2-way voice coaching, barge-in & tools |
|  - verify_label (gemini-3.8-flash): 1-3 sharpest frames -> JSON schema |
|  - Safety Engine (server/src/safety.ts): 6 deterministic guardrails    |
|  - HTTP APIs (no-store): /api/health, /api/stats, /api/eval-summary,   |
|    /api/verify, /api/tts (24 kHz WAV via gemini-3.8-flash-tts)         |
+------------------------------------------------------------------------+
```

- **Server (`server/`)**: Node `>= 20` (`22`/`24`), TypeScript (`tsx`), Express 5, `ws`, `@google/genai`. `GEMINI_API_KEY` stays strictly in server RAM (`server/src/env.ts`).
- **Frontend Bundle (`web/`)**: Vite 6 splits `node_modules` into `vendor-<hash>.js` (`~223 kB`) and app code into `index-<hash>.js` (`~430 kB`), keeping every chunk under `500 kB` ([`docs/DEPLOY.md`](DEPLOY.md)).
- **Run & Deploy**: `npm install && npm run dev` starts `:8787` + `:5173`; `npm start` + `npm run tunnel` (or `Dockerfile` on Cloud Run `europe-north1`) serves the entire stack from a single HTTPS origin.

---

## 5. Measured Benchmarks & Automated Verification

All metrics below come from committed real-model and loopback benchmark artifacts in `eval/*.json` (`27` JSON files; full methodology in [`docs/EVAL.md`](EVAL.md)) and automated test suites:

| Benchmark / Gate | Source Artifact / Suite | Measured Result |
|---|---|---|
| **Never-Guess Dose Safety Invariant (`STRENGTH_MIN_CONF = 0.80`)** | All `19` label-reading suites (`228` real-model reads across `27` `eval/*.json` files) | **`0` confident-wrong dose reads** and **`0` false-safe allergen verdicts** across clean, thumb-occluded, curved-bottle, blister-glare, low-light, motion-blurred, partial-view, upside-down/sideways, thermal-faded/worn, debossed-expiry, prompt-injected, bystander-PII, LASA, and 6-language labels |
| **Live End-to-End Glass-to-HUD Verdict Latency** | `eval/e2e_websocket_live.json`, `eval/live_models_probe.json` | **`2738.8 ms` live frame-to-HUD verdict `p50`** (`3/3` verdict accuracy across `amlodipine.jpg`, `ibuprofen.jpg`, `blurry_amlodipine.jpg`), **`431.6 ms` `/live` startup-to-ready**, **`1175.3 ms` first coaching event**, **`582 ms` `gemini-3.8-live` first-audio latency** |
| **DAT Frame Ingest, `/hud-ws` Replay & Concurrency** | `eval/hud_latency_bandwidth.json`, `eval/concurrent_sessions_results.json` | **`1.17 ms` `POST /ingest/frame` `p50`** (`100` frames, `8`-slot bounded `FrameRing` cleared to `0` on disconnect), **`1.78 ms` `/hud-ws` late-join replay `p50`** (`50` joins, `674 B` verdict wire), **`0` cross-session leaks across `25` concurrent sessions (`50` WebSockets)** |
| **Core 4-Suite Accuracy & Calibration (`53` + `16` reads)** | `eval/combined_summary.json`, `eval/calibration_curve.json` | **`98.1%` (`52/53`) overall verdict accuracy**, **`100.0%` clean field accuracy**, **`98.2%` occluded abstention** (`p50 = 3537.1 ms`); **`ECE = 0.0138`**, **`Brier = 0.0005`** (`100.0%` clean recall & `100.0%` unreadable abstention at `0.80`) |
| **Multi-Frame Recovery, Adversarial Allergens & Expiry** | `eval/multiframe_recovery_results.json`, `eval/allergen_adversarial_results.json`, `eval/expiry_formats_results.json` | **`6/6` (`100.0%`) single-frame partial-view abstentions -> `6/6` (`100.0%`) paired-frame `FrameRing.pick(2)` recovery** (`p50 = 3519.0 ms`); **`10/10` (`100.0%`) botanical/Nordic allergen catches** (`p50 = 3545.8 ms`); **`10/10` (`100.0%`) Nordic/debossed expiry normalization & `8/8` expired catches** (`p50 = 3367.2 ms`) |
| **Optical Stress, Prompt-Injection, Privacy & `/api/tts`** | `eval/curved_blister_results.json`, `eval/lighting_motion_results.json`, `eval/orientation_robustness_results.json`, `eval/thermal_fade_wear_results.json`, `eval/prompt_injection_labels_results.json`, `eval/bystander_privacy_results.json`, `eval/tts_multilingual_audio.json` | **`100.0%` verdict accuracy** on curved/blister (`10/10`), lighting/tremor (`12/12`), rotated `90/180/270 deg` (`10/10`), thermal-faded/worn (`10/10`), and visual prompt-injection (`8/8`, `0` hijacks) packs; **`0` bystander/PII leaks (`8/8` scenes)**; **`6/6` (`100.0%`) valid `24 kHz` WAVs on `/api/tts`** (`en`/`fi`/`sv`, `p50 = 3910.9 ms`) |
| **Bandwidth Savings & 3-Year Assistive TCO** | `eval/unit_economics.json` | **`84.0%` slow-network video savings** (`724.64 KB -> 116.02 KB` above `650 ms` RTT), **`EUR 0.00294`/check** (`EUR 0.35/mo`), **`EUR 341.68` vs `EUR 4,150.00` 3-year TCO = `91.8%` savings** (`12.1x` lower than OrCam midpoint) |
| **Automated Test & Production Smoke Gate** | `scripts/verify-all.mjs`, `scripts/verify-submission.mjs`, `scripts/smoke-production.mjs` | **`510/510` automated tests passing across `74` suites** (`190` server tests in `24` suites + `320` web tests in `50` suites), **`19` live single-origin production routes verified**, `0` broken relative links across `20` docs, `0` leaked keys, `0` em dashes |

---

## 6. Three-Minute Live Stage Demo Summary

Full second-by-second runbook, pre-flight checklist, and 3-tier hardware contingency plan in [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md):

1. **`0:00 - 0:20` (20 s) Hook**: Three nearly identical white Nordic pharmacy boxes + water glass in hand; why smartphone OCR demands three hands while first-person Meta AI Glasses keep both hands free.
2. **`0:20 - 0:40` (20 s) Consent & Live Pharmacy QR Scan**: Accept `ConsentOnboarding`, open `PharmacyImportModal`, tap **`Scan QR with Camera`**, and scan the zero-PII Finnish *Yliopiston Apteekki* `holdup://rx` QR slip from [`docs/printable-props.html`](printable-props.html) into local-only `ScheduleChecklistCard` (*"Did I Take My Pills?"*).
3. **`0:40 - 1:40` (60 s) Guided Capture, Barge-In, Match & Dose Log**: Pick up *Amlodipin 5 mg* backwards; `gemini-3.8-live` coaches rotation while `VoiceActivityPill` demonstrates live barge-in (`Interrupt Speech`); `MATCH` appears on Ray-Ban Display `/hud` with `ConfidenceBreakdownCard` `80% Dose Gate: PASSED`; voice or Neural Band logs the dose into `ScheduleChecklistCard`.
4. **`1:40 - 2:10` (30 s) Three Safety Catches**: *Burana 400 mg* triggers NSAID `WARNING`; thumb-covered *Amlodipin* triggers `UNSURE` with `ConfidenceBreakdownCard` `BLOCKED < 80%` threshold bar (**never guesses a dose**); *Nordic Oat & Hazelnut Bar* catches `hazelnuts` + `arachis oil` (`peanut`).
5. **`2:10 - 2:35` (25 s) Live Fault & Hardware Resilience**: Trigger WS drop (`Snapshot Mode`), complete offline (`BarcodeDetector` matches `6432100012345` on-device and flags `Taken today`), and glasses doff (`Glasses DAT` -> `Phone Camera`), plus highlight the 5-step `JudgeDemoTour`.
6. **`2:35 - 3:00` (25 s) Measured Proof & Pilot Close**: Present `0` confident-wrong doses across `228` reads, `2738.8 ms` live glass-to-HUD `p50`, `EUR 341.68` 3-year TCO (`91.8%` savings), `/deck` 12-slide deck, `/judge-handout.html`, and the 12-week Helsinki pilot with **Nakovammaisten liitto** ([`docs/PILOT_PLAN.md`](PILOT_PLAN.md)).

---

## 7. Hardware Plan & Booth Runbook

Complete pairing, firmware, and troubleshooting details in [`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md) and [`docs/MENTOR_QA.md`](MENTOR_QA.md):

| Window (Helsinki) | Owners | Action |
|---|---|---|
| **Sat 15:30** | Momin010 (backup: Chintufp) | Borrow **Ray-Ban Meta Gen 2** (DAT camera + BT HFP) and **Meta Ray-Ban Display + Neural Band** at the Meta booth; pair to Android 12+ (`minSdk 31`) demo phone in Meta AI `V292+` with Developer Mode ON (`0`/`0` credentials) and account DOB set. |
| **Sat 16:00 - 20:30** | Momin010 + ivarakerholm-wq | Install `android-dat/` bridge, verify `POST /ingest/frame` (`1.17 ms` `p50`) + `POST /ingest/state`, register `https://<host>/hud` via `Meta AI -> Apps -> Web Apps -> Connect Web App`, and confirm zero-code `/hud-ws` session binding. |
| **Sun 06:30 - 08:30** | Momin010, Chintufp, Silas | Print [`docs/printable-props.html`](printable-props.html) and [`docs/judge-handout.html`](judge-handout.html) at `100%` A4 scale, run 3 full hardware rehearsals, and capture the 3-pane backup video ([`docs/VIDEO_PRODUCTION.md`](VIDEO_PRODUCTION.md)). |
| **Sun 09:30** | Full team | Final submission check (`node scripts/verify-all.mjs && node scripts/verify-submission.mjs && node scripts/smoke-production.mjs`) ahead of the **Sun 15 Nov 10:00** deadline; return loaned hardware after judging. |

---

## 8. Milestones & Delivery Status

| Milestone | Scope | Status |
|---|---|---|
| **M0: Architecture & Contracts** | Shared TypeScript wire contracts (`shared/types.ts`, `shared/label_schema.json`), privacy & HUD specs | Completed |
| **M1: End-to-End Vertical Slice** | Consent -> `/live` `gemini-3.8-live` coaching -> `verify_label` `gemini-3.8-flash` -> `safety.ts` -> spoken verdict | Completed |
| **M2: Hardware & Resilience** | `android-dat/` DAT `1.0.1` bridge, `/hud` Ray-Ban Display waveguide Web App, Snapshot/Offline modes, `DeviceResiliencePanel` | Completed |
| **M3: Inclusive UX & Booth Polish** | WCAG 2.2 AA/AAA (`dark`/`light`/`high-contrast`), `ScheduleChecklistCard`, `ConfidenceBreakdownCard`, `SafetyRuleExplainerCard`, `VoiceActivityPill`, `PharmacyImportModal` camera QR, `JudgeDemoTour` | Completed |
| **M4: Benchmarks, Deck & Freeze** | `27` `eval/*.json` artifacts (`0` confident-wrong doses), 12-slide `/deck`, `/judge-handout.html`, `/printable-props.html`, `510/510` automated tests | Completed |

---

## 9. Gemini API & Workforce Usage (Google DeepMind Prize)

- **In the live runtime**:
  - **Gemini Live (`gemini-3.8-live`)**: Bidirectional 16 kHz / 24 kHz PCM16 voice + ~1 fps video coaching, native barge-in (`interrupted`), sliding-window context compression, `sessionResumption`, and tool calling (`show_cue`, `verify_label`, `log_dose`) with 3-model live fallback (`gemini-3.8-live` -> `gemini-3.1-flash-live-preview` -> `gemini-2.5-flash-native-audio-latest`).
  - **Gemini 3.8 Flash (`gemini-3.8-flash`)**: Multi-frame schema-constrained packaging extraction (`ThinkingLevel.LOW`, `shared/label_schema.json`) with per-field `[0, 1]` confidence and 3-model verify fallback (`gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3-flash-preview`).
  - **Gemini Flash TTS (`gemini-3.8-flash-tts`)**: Multilingual (`en`/`fi`/`sv`) `24 kHz` WAV synthesis on `POST /api/tts` (`Kore` voice, fallback `gemini-2.5-flash-preview-tts` -> browser `speechSynthesis`).
- **Offline evaluation & fixture workforce**:
  - Generates realistic clean and degraded packaging test suites (`server/scripts/generate-demo-fixtures.ts`, `eval/generate_synthetic.py`, `eval/eval_*.py`) across blur, glare, thumb occlusion, curved bottles, rotations, thermal fade, and 6 European languages.
  - Scores multi-turn coaching brevity, tool discipline, Finnish switching, medical-boundary handoff, and bystander face/PII refusal via an automated LLM-as-judge rubric (`eval/judge_coaching.py`, `8/8` scenarios passed at `5.00/5`).
