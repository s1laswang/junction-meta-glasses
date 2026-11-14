# HoldUp: Junction 2026 Submission Dossier & Judge Rubric Traceability

Event: **Junction 2026** | Deadline: **Sunday 15 Nov 2026, 10:00 EET (Helsinki)** | Internal Submit Target: **09:30 EET**
Primary Challenge: **Meta "AI Glasses for Everyone, Everyday"** (`https://hackjunction.app/participate/45/challenges/342`)
Platform Prize Entry: **Google DeepMind "Best Use of Gemini API"**

---

## 1. Ready-to-Paste Junction 2026 Platform Submission Copy

All blocks below contain zero HTML comments, zero em dashes, and only verified architecture facts and measured evaluation metrics from this repository.

### Project Title & Tagline
- **Project Name:** HoldUp
- **Tagline:** Hold it up. Know it is the right one.
- **One-Line Subtitle:** Hands-free medication and allergen label assistant for blind, low-vision, and older adults on Meta AI Glasses, powered by Gemini Live.

### Short Pitch
HoldUp turns Meta AI Glasses into a hands-free medication and food-allergen verification assistant for blind, low-vision, and older adults. Hold a pill box or food carton naturally in both hands: Gemini Live coaches hand rotation, distance, and lighting at ~1 fps until the print is sharp, runs multi-frame schema-locked extraction on Gemini 3.8 Flash with per-field confidence, and checks the label deterministically against your on-device medication schedule, drug-class avoid rules, and allergies. It speaks a calm 2-sentence answer over open-ear audio, projects a high-contrast 4-channel card on Ray-Ban Display, and enforces a hard `0.80` strength-confidence gate so it never guesses a dose.

### Problem
Roughly 2.2 billion people worldwide live with vision impairment (around 80,000 in Finland, over 80% of whom are aged 65+), alongside older adults managing daily polypharmacy with declining sight. Several times every day, nearly identical white pharmacy cartons and fine-print food packages create a high-stakes question: *"Is this my evening Amlodipine 5 mg or Ibuprofen 400 mg? Has it expired? Are hazelnuts or peanut oils listed?"*

Today's smartphone workarounds break down in everyday life:
1. **The three-hand problem:** Rotating a curved bottle, steadying a cane, or holding a pill and a glass of water already takes two hands; holding and blind-aiming a phone camera requires a third.
2. **Single-shot OCR roulette:** Static snapshot apps read unprioritized raw text when the barcode or blank side faces the lens, give zero physical alignment guidance, and have zero awareness of what medications, doses, or allergies belong to the user.
3. **Loss of privacy and independence:** Video-calling a volunteer or asking a family member is slow, not always available at night or in a grocery aisle, and exposes private health routines.

### Solution
HoldUp pairs the chest-level first-person perspective of Meta AI Glasses with real-time multimodal coaching and deterministic personal safety checks:
1. **Ask naturally hands-free:** Trigger a check by voice (*"Is this my evening pill?"*, *"Onko tämä minun iltalääkkeeni?"*, or *"Does this contain nuts?"*), the glasses capture button, Meta Neural Band pinch, or single-key accessible controls.
2. **Active body-relative coaching (`gemini-3.8-live`):** Streaming ~1 fps first-person frames let Gemini Live speak concise physical cues (*"Turn it around"*, *"Tilt it away from the light"*, *"Move closer, hold still"*) while projecting directional glyphs on `/hud` via `show_cue`.
3. **Multi-frame schema-locked read (`gemini-3.8-flash`):** Once readable, `verify_label` selects the sharpest recent frames from a bounded 8-frame RAM ring buffer (`FrameRing`) and extracts structured `LabelRead` fields (`shared/label_schema.json`) with `[0, 1]` confidence per field.
4. **Deterministic personal safety engine (`server/src/safety.ts`):** Extracted fields are checked deterministically against the wearer's on-device `Profile` (`localStorage` only: medications, schedules, allergies, avoid-lists, and `doseLog`), resolving Nordic brand-to-INN mappings, drug classes (NSAIDs, anticoagulants, beta blockers, ACE inhibitors, penicillins, PPIs, antihistamines), EU-14 food allergens across English, Finnish, and Swedish, and expiry dates. If strength is missing or confidence is `< 0.80` (`STRENGTH_MIN_CONF = 0.80`), HoldUp refuses to guess and instructs the user to re-aim or ask a pharmacist.
5. **Multimodal confirmation, dose logging, and pharmacy onboarding:** Wearers hear a `<= 2`-sentence spoken verdict over private open-ear audio, see a `<= 8`-word 4-channel card (`MATCH`, `WARNING`, `UNSURE`, `INFO`) on Ray-Ban Display (`/hud`), log taken doses with double-dose protection, import prescriptions via Finnish pharmacy `holdup://rx` QR codes, and export plain-text caregiver summaries in one tap.

### Meta "AI Glasses for Everyone, Everyday" Track Statement
HoldUp is built natively around why smart glasses are a fundamentally better everyday medium than a smartphone, not a phone screen mirrored onto a lens:
- **Proprioceptive hands-free POV:** A head-mounted camera naturally points at what two hands hold at chest height, freeing both hands to rotate packages, open blister packs, or hold a mobility cane.
- **Audio-first and display-first parity:** Blind wearers get a complete eyes-free loop via Bluetooth HFP open-ear audio, synthesized Web Audio earcons, haptics, and VoiceOver/TalkBack screen-reader support (`WCAG 2.2 AA`). Low-vision wearers additionally get an additive waveguide HUD on **Meta Ray-Ban Display** (`/hud`: pure `#000000` transparent canvas, `<= 65%` lit pixel fill budget to prevent waveguide bloom, `<= 8` word headline cap, and 4-channel shape + stroke icon + uppercase badge + high-luma color encoding) controlled by **Meta Neural Band** thumb swipes (`ArrowLeft`/`ArrowRight`) and index pinch (`Enter`) within a `<= 2`-entry browser history budget.
- **Dual Meta Wearables integration (DAT + Web Apps):** Combines the native Android **Meta Wearables Device Access Toolkit (`mwdat-core` & `mwdat-camera` SDK `1.0.1`)** streaming `720x1280` first-person frames and real-time `connected`/`worn`/`battery` state with a zero-code Ray-Ban Display Web App (`/.well-known/meta-wearables-manifest.json` + `/hud-ws` auto-attach and state replay).
- **Credible adoption and EU regulatory path:** Engineered strictly within the **EU MDR Art. 2(1) non-medical assistive reader** boundary (digital reading glasses + user-owned checklist comparison with mandatory pharmacist handoff on ambiguity), enabling immediate community pilots with visual-impairment organizations such as **Nakovammaisten liitto** in Finland and dispensing-box QR/EAN onboarding with Nordic pharmacies.

### Google DeepMind "Best Use of Gemini API" Prize Statement
HoldUp uses the Gemini API both as a **split-brain safety-critical runtime architecture** and as an **offline data and evaluation workforce**:
1. **Real-Time Multimodal Coaching & Grounded Tool Calling (`gemini-3.8-live`):** Streams 16 kHz PCM16 voice input, 24 kHz native audio output, and ~1 fps camera frames over `@google/genai` `v1beta` with barge-in interruption handling, `slidingWindow` context compression, `sessionResumption`, and three tools (`show_cue`, `verify_label`, `log_dose`). Crucially, `server/src/prompts/live.md` forbids the Live model from stating drug names, strengths, expiries, or allergens from its own video stream, eliminating conversational vision hallucinations.
2. **Low-Latency Schema-Constrained Verification (`gemini-3.8-flash`):** `readLabel()` (`server/src/verify.ts`) sends 1-3 sharpest frames with `ThinkingLevel.LOW`, `responseMimeType: "application/json"`, and `responseJsonSchema: LABEL_SCHEMA` (zero `$ref`s after inlining) while withholding the user's `Profile` so model extraction cannot be biased by expected prescriptions. Both Live and Verify paths enforce concurrency gates, `AbortSignal` timeouts, jittered backoff, and 3-model fallback chains (`gemini-3.8-live -> gemini-3.1-flash-live-preview -> gemini-2.5-flash-native-audio-latest`; `gemini-3.8-flash -> gemini-3.5-flash -> gemini-3-flash-preview`), plus `/api/tts` fallback synthesis.
3. **Gemini Offline Workforce (Fixture Generation & Automated Safety Judging):** `server/scripts/generate-demo-fixtures.ts` uses `gemini-3.1-flash-image` to synthesize photorealistic first-person pharmacy and food packages across 7 challenging scenarios (including thumb-occluded dosage digits, blank rear barcode panels, and expired packs). `eval/judge_coaching.py` runs multi-turn multimodal probes and a schema-locked Gemini judge scoring brevity, zero raw-vision hallucination, tool grounding, bystander face refusal, and Finnish language switching. In `eval/coaching_eval.json`, HoldUp achieved **`8 / 8` scenarios passing all 5 safety and accessibility checks (`100%` pass rate, mean score `5 / 5`, `p50` multi-turn tool latency `5118.3 ms`, direct bystander refusal `2574.8 ms`)**. Additional label extraction and confidence-calibration runs are tracked in `eval/*.json` and `docs/EVAL.md`.

### Technical Challenges & Resilience
1. **Bridging Meta Wearables hardware boundaries:** Ray-Ban Display Web Apps run in an on-glasses Chromium container without `getUserMedia` camera or raw microphone streams, while first-person camera access requires native Android/iOS DAT SDK `1.0.1`. We unified **one Node/TypeScript backend (`server/src/hub.ts`)** across **three thin clients** (Phone/Laptop React 19 PWA on `/live`, Android DAT bridge on `/ingest/frame` and `/ingest/state`, and Display HUD on `/hud-ws`). Session-less `floatingHuds` auto-bind to the latest active session and deterministically replay `status -> device -> coach -> verdict` so wearers never type pairing codes on glasses.
2. **Preventing confident dose hallucinations:** Single-model vision prompts can guess `5 mg` vs `50 mg` from box colors. We separated conversational coaching (`gemini-3.8-live`), blind schema-locked OCR (`gemini-3.8-flash` with `null` + `confidence <= 0.3` on ambiguous digits), and deterministic TypeScript verification (`STRENGTH_MIN_CONF = 0.80` in `server/src/safety.ts`), verified across `49` dedicated safety unit tests covering unit conversions (`mcg`/`mg`/`g`/`IU`/`KY`), combination drugs (`500 mg + 30 mg`), Nordic brands, and all EU-14 allergens.
3. **End-to-end fault tolerance under real-world mobility:** Tested by `179` automated unit tests (`21` test suites) and inspectable live via the in-app **Device & Resilience Panel** chaos toggles:
   - **Camera or mic permission denied:** Plain-language recovery steps; mic denial shifts cleanly to camera + typed question + TTS; camera denial preserves 7-scenario Demo Prop Mode.
   - **Live WebSocket drop:** Bounded exponential-backoff reconnect (`300 ms` to `8000 ms`) + Gemini `sessionResumption` while immediately routing checks through HTTP **Snapshot Mode** (`POST /api/verify` + HUD fan-out + `/api/tts` or `speechSynthesis`).
   - **Complete offline loss:** Switches automatically to **Offline Mode**, matching EAN/UPC/QR codes locally via `BarcodeDetector` against saved `localStorage` `meds[].barcode` and `doseLog` with zero network calls, while stating clearly that new unsaved labels require connectivity.
   - **Slow venue Wi-Fi:** Continuous 5-second `ping`/`pong` RTT probing scales capture dynamically (`1.0 fps` @ `768 px` JPEG `0.78` under `250 ms` -> `0.75 fps` @ `640 px` JPEG `0.64` -> `0.5 fps` @ `512 px` JPEG `0.50` above `650 ms`).
   - **Glasses doffed, disconnected, or low battery:** Announces the transition aloud and hot-swaps active camera `source` from `"glasses"` to `"phone"` mid-session without losing profile or conversation state.
   - **Privacy by code enforcement:** Capture starts only on explicit user action, plays `camera_on`/`camera_off` earcons, auto-stops after `45 s` idle (`IDLE_STOP_MS = 45000`), clears the 8-frame RAM ring immediately on socket close (`hub.ring.clear()`), scrubs `DENY` keys and `AIza...` tokens in `server/src/log.ts`, keeps hardware LED locked ON via DAT firmware, refuses bystander descriptions (`100%` pass in `eval/coaching_eval.json`), and wipes all `holdup.*` local data in one tap (`wipeAllLocalData()`).

---

## 2. Judge Rubric & `BRIEF.md` Traceability Matrix

Automated verification baseline in this repository: **`21` test suites / `179` unit test cases** (`10` server files = `101` tests via `npm -w server test`; `11` web files = `78` tests via `npm -w web test`), TypeScript strict check (`npm run typecheck`), 9-check live end-to-end smoke script (`server/scripts/smoke.ts`), and 8-scenario Gemini safety/coaching benchmark (`eval/coaching_eval.json`).

### 2.1 `BRIEF.md` Mandatory Deliverables Traceability

| `BRIEF.md` Deliverable | HoldUp Implementation Summary | Exact Repository Files | Automated Tests & Verification |
|---|---|---|---|
| **1. Functional prototype and pitch deck** | Unified Node/TS Express + `ws` backend serving React 19 PWA (`/`), Ray-Ban Display waveguide preview & `/hud` protocol, DAT `/ingest/*` endpoints, 7-fixture Demo Prop Mode, Cloud Run `Dockerfile`, and slide deck / docs index. | `server/src/index.ts`, `server/src/live.ts`, `server/src/verify.ts`, `server/src/safety.ts`, `server/src/hub.ts`, `web/src/App.tsx`, `web/src/hud/HudPreviewFrame.tsx`, `web/public/fixtures/*.jpg`, `Dockerfile`, `README.md`, `docs/PLAN.md` | `server/test/http-ws.test.ts` (7 tests), `server/test/snapshot-hud.test.ts` (3 tests), `web/test/fixtureLoader.test.ts` (5 tests), `server/scripts/smoke.ts` (`npm -w server run smoke`) |
| **2. Clear problem and audience** | Grounded everyday polypharmacy & food-allergen problem for blind, low-vision (~2.2B globally, ~80k in Finland), and older adults; clear physical & privacy rationale why head-worn glasses beat 3-hand smartphone OCR. | `README.md`, `BRIEF.md`, `docs/PLAN.md`, `shared/types.ts`, `web/src/camera/demoScenarios.ts` | `web/test/barcode.test.ts` (`DEMO_SCENARIOS` 7-scenario coverage), `eval/coaching_eval.json` (8 realistic user scenarios) |
| **3. Plausible path to adoption or pilot** | EU MDR Art. 2(1) non-medical assistive reader boundary + mandatory pharmacist handoff; Finnish pharmacy `holdup://rx` QR onboarding (`SAMPLE_FINNISH_PHARMACY_QR`), 1-tap caregiver plain-text summary export, EN/FI/SV UI & EU-14 allergen/Nordic INN tables for pilots with Nakovammaisten liitto and pharmacies. | `web/src/pairing/pharmacyQr.ts`, `web/src/storage/profileStore.ts`, `web/src/i18n/translations.ts`, `server/src/safety.ts`, `docs/PRIVACY.md`, `docs/DEPLOY.md` | `web/test/pharmacyQr.test.ts` (6 tests), `web/test/profileStore.test.ts` (`exportCaregiverSummary` test), `web/test/i18n.test.ts` (5 tests), `server/test/safety-extended.test.ts` (34 Nordic INN & EU-14 tests) |
| **4. Permissions, errors, performance trade-offs, connectivity, and device state changes** | `probePermissions` + `classifyMediaError` recovery; 3-model Gemini retry/fallback chains + semaphore + `AbortSignal`; 5s WS `ping`/`pong` RTT-adaptive FPS & JPEG scaling; Live -> Snapshot (`POST /api/verify` + TTS) -> Offline (`BarcodeDetector`) transitions; DAT `connected`/`worn`/`battery` hot-swap to phone camera; interactive chaos panel. | `web/src/camera/cameraStream.ts`, `web/src/camera/adaptive.ts`, `web/src/camera/barcode.ts`, `web/src/session/sessionManager.ts`, `web/src/components/DeviceResiliencePanel.tsx`, `server/src/gemini.ts`, `server/src/verify.ts`, `web/src/audio/tts.ts` | `web/test/camera.test.ts` (6 tests), `web/test/sessionManager.test.ts` (7 tests), `web/test/barcode.test.ts` (7 tests), `web/test/earcons.test.ts` (TTS fallback tests), `server/test/gemini.test.ts` (6 tests), `server/test/verify-unit.test.ts` (16 tests), `web/test/components-a11y.test.ts` (chaos & telemetry tests) |
| **5. Consent and safe data practices** | Screen-reader-first `ConsentOnboarding` (`CONSENT_VERSION = "2026-11"`) before capture; explicit user start + `~1 fps` cap (`>= 900 ms`) + `45 s` idle auto-stop; zero disk frame/audio storage (`FrameRing(8)` cleared on close); `localStorage`-only profile + 1-tap `wipeAllLocalData()`; `DENY` key log redactor + `48`-char cap + `AIza...` scrubber; bystander face-ignore prompt & schema lock; hardware capture LED via DAT. | `web/src/components/ConsentOnboarding.tsx`, `web/src/storage/profileStore.ts`, `server/src/log.ts`, `server/src/live.ts`, `server/src/hub.ts`, `server/src/env.ts`, `server/src/prompts/live.md`, `shared/verify_prompt.md`, `docs/PRIVACY.md` | `server/test/log-verify.test.ts` (6 redaction, key-scrub, `FrameRing.clear`, & hostile-input tests), `web/test/profileStore.test.ts` (`loadConsent`, `wipeAllLocalData`), `web/test/sessionManager.test.ts` (`45s` auto-stop & frame clear), `web/test/components-a11y.test.ts` (`ConsentOnboarding` EN/FI), `eval/coaching_eval.json` (`bystander_face_privacy` = `5/5`) |

### 2.2 Meta 4 x 25% Judging Pillars Traceability

| Judging Pillar (Weight) | How HoldUp Excels Beyond Phone Mirroring | Exact Repository Files | Automated Tests & Measured Proof |
|---|---|---|---|
| **1. Creativity and use case (25%)** | Transforms passive single-shot OCR into an active 2-way physical coaching loop where streaming chest-height glasses video guides the wearer's hands (`show_cue`) until `FrameRing` locks sharp frames for `verify_label`, unifying medication safety, duplicate-dose prevention, and food allergen checks in one hands-free companion. | `server/src/live.ts`, `server/src/prompts/live.md`, `server/src/verify.ts`, `shared/label_schema.json`, `web/src/camera/sharpness.ts`, `web/src/camera/demoScenarios.ts`, `server/scripts/generate-demo-fixtures.ts` | `server/test/live-events.test.ts` (4 tool, barge-in & `log_dose` tests), `server/test/log-verify.test.ts` (`FrameRing.pick` sharpness window test), `web/test/camera.test.ts` (`computeSharpness` monotonic & `< 5 ms` benchmark), `eval/coaching_eval.json` (`8/8` scenarios passed, `tool_use_correct = 1.0`) |
| **2. Technical execution (25%)** | Clean split between streaming voice/coaching (`gemini-3.8-live`), blind multi-frame JSON extraction (`gemini-3.8-flash`), and deterministic verification (`safety.ts`); zero-code multi-client session hub (`floatingHuds` + ordered late-join replay); 3-tier Live/Snapshot/Offline state machine; proxy-aware concurrency-gated Gemini client with token/latency ledger; non-root multi-stage Cloud Run build. | `server/src/hub.ts`, `server/src/gemini.ts`, `server/src/verify.ts`, `server/src/safety.ts`, `server/src/ledger.ts`, `server/src/index.ts`, `web/src/session/sessionManager.ts`, `web/src/camera/fixtureLoader.ts`, `Dockerfile`, `eval/judge_coaching.py` | `179` unit tests across `21` files: `server/test/hub.test.ts` (5), `server/test/http-ws.test.ts` (7), `server/test/snapshot-hud.test.ts` (3), `server/test/verify-unit.test.ts` (16), `server/test/gemini.test.ts` (6), `server/test/ledger.test.ts` (5), `web/test/sessionManager.test.ts` (7), `web/test/fixtureLoader.test.ts` (5) |
| **3. Real-world value and feasibility (25%)** | Solves high-frequency daily risk with zero clinical overreach (`STRENGTH_MIN_CONF = 0.80` never-guess gate); handles comma decimals (`2,5 mg`), liquid concentrations (`500 mg/5 ml`), combination tablets, microgram/IU/KY conversions, Nordic brands (Burana, Marevan, Eliquis, Losec, Somac, Heinix, Ventoline, Amorion), all EU-14 allergens in EN/FI/SV, offline barcodes, and Finnish pharmacy QR import. | `server/src/safety.ts`, `web/src/pairing/pharmacyQr.ts`, `web/src/camera/barcode.ts`, `web/src/storage/profileStore.ts`, `docs/HARDWARE_NOTES.md`, `docs/DEPLOY.md`, `eval/real/labels.csv` | `server/test/safety.test.ts` (15 tests), `server/test/safety-extended.test.ts` (34 tests), `web/test/barcode.test.ts` (7 tests), `web/test/pharmacyQr.test.ts` (6 tests), `web/test/profileStore.test.ts` (9 tests), `eval/coaching_eval.json` (`no_raw_vision_hallucination = 1.0`, `finnish_switch = 5/5`, `medical_interaction_boundary = 5/5`) |
| **4. UX: input, accessibility and trust (25%)** | Built screen-reader-first: dual-slot sequence-alternating ARIA live announcer (ensures repeated coaching cues are spoken by VoiceOver/TalkBack), 8 distinct acoustic + haptic earcons, 7 single-key shortcuts (`Space`, `S`, `B`, `L`, `R`, `T`, `P`) + spoken orientation in EN/FI/SV, `dark`/`light`/`high-contrast` themes (`>= 56 px` targets), Ray-Ban Display `#000000` 4-channel waveguide UI + Neural Band focus strip, explicit `< 80%` confidence badge & double-dose lock. | `web/src/a11y/announcer.tsx`, `web/src/a11y/shortcuts.ts`, `web/src/audio/earcons.ts`, `web/src/components/VerdictCard.tsx`, `web/src/components/ShortcutsModal.tsx`, `web/src/components/ConsentOnboarding.tsx`, `web/src/hud/HudPreviewFrame.tsx`, `web/src/styles/tokens.css`, `web/public/.well-known/meta-wearables-manifest.json`, `docs/HUD_SPEC.md` | `web/test/a11y.test.ts` (5 announcer & shortcut tests), `web/test/components-a11y.test.ts` (15 SSR ARIA, `< 80%` threshold, 4-SVG shape, double-dose lock, & zero-em-dash tests), `web/test/earcons.test.ts` (8 acoustic/haptic & TTS tests), `web/test/shortcutsModal.test.ts` (5 Neural Band & spoken orientation tests), `web/test/i18n.test.ts` (5 EN/FI/SV localization tests) |

---

## 3. Sunday 15 Nov Freeze (06:00) & Submission (09:30) Sign-Off Checklist

### 3.1 Automated Pre-Freeze Gate (Run on `fr8/meta/main` at 05:45 EET)

Before declaring the **Sunday 06:00 EET freeze**, confirm every command below exits `0` on the clean main branch:

```bash
git status --short
npm run typecheck
npm -w server test
npm -w web test
npm run build
```

When verifying with a live `GEMINI_API_KEY` on the demo host or Cloud Run revision, also run the 9-check live end-to-end smoke test and health/manifest checks:

```bash
npm -w server run smoke
curl -fsS "$HOST/api/health"
curl -fsS "$HOST/.well-known/meta-wearables-manifest.json"
```

Verify repository hygiene before final push:
- [ ] `.env`, `server/logs/`, and any local `local.properties` files are untracked (`git status --ignored` shows zero staged secrets or API keys).
- [ ] Zero em dashes (Unicode U+2014) and zero HTML comment tags appear in submission copy, `README.md`, `docs/SUBMISSION_CHECKLIST.md`, or rendered UI strings.
- [ ] Every quantitative claim in slides and portal answers matches committed outputs in `eval/coaching_eval.json` (`8/8` scenarios passed, `5/5` mean score), `eval/*.json` / `docs/EVAL.md`, and verified `node:test` suites (`179` unit tests across `21` files).

---

### 3.2 Teammate Sign-Off Checklists (06:00 Freeze -> 09:30 Submit)

#### Silas (Founder, Stage Presenter & Platform Submitter)
- [ ] **06:00 Freeze Lock:** Confirm `main` is frozen (post-06:00 fixes merge via PR + passing unit/smoke check only); confirm hosting choice (`cloudflared` quick tunnel vs Google Cloud Run `europe-north1` in `docs/DEPLOY.md`) and confirm whether `.env` / Secret Manager uses a paid-tier Gemini billing key (`docs/PLAN.md` Q2-Q3) so privacy wording matches exact billing tier.
- [ ] **06:30 - 08:30 Stage Rehearsal (3 Full Runs):** Rehearse the 3-minute live flow (`docs/PLAN.md` Section 5) under a strict stopwatch:
  - `0:00 - 0:20` Hook: three look-alike white pharmacy boxes on the counter.
  - `0:20 - 0:40` Consent onboarding: show active-check-only capture, Google Gemini API disclosure, and on-device `localStorage` profile (`3` meds + nut allergy).
  - `0:40 - 1:40` Live glasses coaching -> match -> log: pick up Amlodipine 5 mg *backwards*, follow Gemini Live cue (*"Turn it around..."*), receive spoken + `/hud` `MATCH` verdict, say *"I took it"* or pinch Neural Band to log dose.
  - `1:40 - 2:10` Safety catches: hold up Ibuprofen/Burana 400 mg (`WARNING` avoid NSAIDs) and occluded/blurry strength box (`UNSURE` `< 80%` strength refusal; never guesses).
  - `2:10 - 2:35` Live resilience: toggle Wi-Fi / WS drop -> Snapshot Mode -> Offline `BarcodeDetector` match -> auto-recovery; take glasses off -> automatic switch to phone camera.
  - `2:35 - 3:00` Proof & pilot path: cite `0` confident-wrong strength gates (`STRENGTH_MIN_CONF = 0.80`), `8/8` coaching/privacy eval pass rate, EU MDR assistive boundary, and Nakovammaisten liitto + Finnish pharmacy QR pilot path.
- [ ] **09:15 Pre-Submit Audit:** Open public GitHub repository URL, deployed HTTPS demo URL (if public), pitch deck, and demo video link in an **incognito browser window** with zero local auth cookies.
- [ ] **09:30 Junction Platform Submit:** Paste finalized copy from **Section 1**, attach repository URL, deck, and video URL, select **Meta "AI Glasses for Everyone, Everyday"** + **Google DeepMind "Best Use of Gemini API"**, submit by **09:30 EET** (30-minute safety buffer before the **10:00 EET** hard cutoff), and screenshot confirmation.

#### Momin010 (Hardware & Meta Wearables Lead)
- [ ] **06:00 Hardware & Battery Readiness:** Confirm **Ray-Ban Meta Gen 2**, **Meta Ray-Ban Display**, **Meta Neural Band**, and the paired Android 12+ (`minSdk 31`) demo phone are charged `> 80%` (DAT glasses app registration fails below `10%`), running **Meta AI `V292+`** and **glasses firmware `V128+`** (rebooted after any OTA update), with **Developer Mode ON** (`0`/`0` dev credentials) and account DOB set (`docs/HARDWARE_NOTES.md`).
- [ ] **06:15 Bridge & Display Provisioning:**
  - Confirm `HOST` HTTPS tunnel or Cloud Run URL is live and unchanged for the entire morning (`curl -fsS "$HOST/api/health"` -> `"ok": true`).
  - Pair `android-dat/` HoldUp Bridge via `holdupbridge://connect?server=...` QR from the PWA Device Resilience Panel; verify `POST /ingest/frame` and `POST /ingest/state` return HTTP `204` and PWA switches eye to **Glasses DAT** with front hardware capture LED illuminated while streaming.
  - Register `https://<host>/hud` in **Meta AI -> Apps -> Web Apps -> Connect Web App** (or `fb-viewapp://web_app_deep_link` QR), pin **HoldUp** on Ray-Ban Display, verify `#000000` zero-bloom transparency, Neural Band `ArrowLeft`/`ArrowRight`/`Enter` focus ring, and `HUD Connected` badge on the phone PWA.
- [ ] **06:30 - 08:30 Hardware Rehearsal & Thermal/Hotspot Guard:** Run 3 end-to-end hardware passes with Silas and Chintufp; verify mobile hotspot backup in case venue Wi-Fi drops; keep glasses resting un-streaming between runs so thermal state stays nominal.
- [ ] **Post-Judging Booth Return (~10:30+ EET):** Stop streaming, unpair/clean test session per Amanda Le's booth instructions, and return all loaned Meta hardware (`Ray-Ban Meta Gen 2`, `Ray-Ban Display`, `Neural Band`).

#### ivarakerholm-wq (Accessibility, Real-Label Data & Demo Props Lead)
- [ ] **06:00 Real-Label & Privacy Hygiene Check:** Confirm every real package photo in `eval/real/` and row in `eval/real/labels.csv` contains zero bystander faces and has any patient name on pharmacy dispensing stickers blurred or cropped (`docs/PRIVACY.md` Section 3).
- [ ] **06:15 Screen-Reader & Accessible UX Sign-Off:** Verify full check flow with VoiceOver or TalkBack + keyboard shortcuts (`Space` start/stop, `S` snapshot, `B` offline barcode, `L` log dose, `R` repeat, `T` theme cycle `dark`/`light`/`high-contrast`, `P` consent/privacy, `?` shortcuts modal + `Play Spoken Orientation`) and confirm earcons (`camera_on`, `checking`, `match`, `warning`, `unsure`, `camera_off`) are audible and distinct; ensure attendee/screen-reader feedback notes (`docs/USER_FEEDBACK.md`, if collected) are committed.
- [ ] **06:30 Stage Physical Props Ready & Ordered:** Stage physical props in presentation order on a clean tray with backup duplicates:
  1. Look-alike white pharmacy box #1: **Amlodipine 5 mg** (with matching EAN barcode `6432100012345` saved in demo profile for offline barcode proof).
  2. Look-alike white/red pharmacy box #2: **Ibuprofen / Burana 400 mg** (triggers `WARNING` not on list + avoid NSAIDs).
  3. Ambiguous/occluded strength prop #3: medicine box with strength covered or blurred (triggers `UNSURE` `< 80%` confidence refusal).
  4. Food allergen prop #4 + safe prop #5: **hazelnut/peanut snack bar** (`WARNING` allergen hit) and **oat drink carton** (`INFO` safe + best-before date), plus printed **Finnish pharmacy QR** (`SAMPLE_FINNISH_PHARMACY_QR`) if shown during Q&A.

#### Chintufp (Story, Pitch Deck & Demo Video Lead)
- [ ] **06:00 Deck & Citation Audit:** Verify final slide deck (`deck/index.html` / PDF export) aligns 1:1 with `README.md` and **Section 1** above: zero fabricated numbers, exact `STRENGTH_MIN_CONF = 0.80` threshold, `8/8` coaching/privacy eval results from `eval/coaching_eval.json` (plus any finalized label accuracy table from `eval/*.json` / `docs/EVAL.md`), accurate paid-vs-free Gemini tier privacy wording, and zero em dashes.
- [ ] **06:30 - 08:30 Backup Demo Video Shoot & Export (<= 3:00, 1080p MP4 + Public Link):** Capture synchronized first-person glasses POV, Ray-Ban Display HUD (`Meta AI -> Devices -> Record Display` or `/hud` capture), open-ear spoken audio, and the phone PWA `DeviceResiliencePanel` showing:
  1. Consent onboarding & local-only profile.
  2. Back-of-box body-relative coaching -> Amlodipine 5 mg `MATCH` -> voice/pinch dose log.
  3. Burana 400 mg NSAID `WARNING` + covered-strength `< 80%` `UNSURE` refusal.
  4. Live fault recovery: WS drop -> Snapshot Mode -> Offline `BarcodeDetector` match -> Glasses doffed to Phone Camera hot-swap.
- [ ] **09:00 Video & Deck Link Delivery:** Upload final video (YouTube Unlisted or public direct link with permissions verified in an incognito window) and final deck PDF/link, and hand verified URLs to Silas by **09:00 EET**.

---

### 3.3 Final 09:30 EET Submission Sign-Off Table

| Checkpoint | Owner | Target Time (Sun 15 Nov EET) | Verification Rule | Status |
|---|---|---|---|---|
| Main branch freeze & `179` unit tests green | Silas | `06:00` | `npm run typecheck && npm -w server test && npm -w web test` exit `0`; zero `.env` / keys tracked | `[ ]` |
| Glasses DAT bridge + `/hud` Web App live on stable HTTPS | Momin010 | `06:30` | `/api/health` `200 OK`; `/ingest/frame` `204`; `/hud` zero-code replay active | `[ ]` |
| Physical demo props, PII audit & screen-reader pass complete | ivarakerholm-wq | `06:30` | All 5 props staged; `eval/real/` PII-free; VoiceOver/TalkBack + `high-contrast` verified | `[ ]` |
| 3x hardware stage rehearsals + backup video uploaded | Chintufp + All | `08:30` | Video `<= 3:00` plays with audio in incognito browser; deck exported | `[ ]` |
| Junction 2026 portal submitted (Meta + Google DeepMind) | Silas | `09:30` (hard deadline `10:00`) | Repo, deck, video, and Section 1 copy submitted; confirmation screenshot saved | `[ ]` |
