# 30-Day Helsinki Assistive-Vision Field Pilot Runbook & KPI Telemetry Specification (`docs/FIELD_PILOT_RUNBOOK.md`)

**Operational Manual For:** Assistive-technology rehabilitation coordinators at **Näkövammaisten liitto ry** (Iiris Center, Marjaniementie 74, Itäkeskus, 00930 Helsinki), **Helsinki community & home-care pharmacy teams** (**Yliopiston Apteekki** Itäkeskus / Mannerheimintie and **Suomen Apteekkariliitto** counters), and the **HoldUp Pilot Safety Review Board (PSRB)**  
**Companion Specifications:** [`BRIEF.md`](../BRIEF.md) | [`PILOT_PLAN.md`](PILOT_PLAN.md) | [`FINLAND_PHARMACY_INTEGRATION.md`](FINLAND_PHARMACY_INTEGRATION.md) | [`HARDWARE_NOTES.md`](HARDWARE_NOTES.md) | [`PRIVACY.md`](PRIVACY.md) | [`EVAL.md`](EVAL.md) | [`eval/unit_economics.json`](../eval/unit_economics.json)  
**Active Loaner Window:** 30-Day Home & Pharmacy Assistive-Technology Trial (*Apuvälineen 30 päivän kotikokeilujakso*, operationalizing Weeks 4-10 of [`PILOT_PLAN.md`](PILOT_PLAN.md) into a single repeatable 30-day loaner cycle per participant)  
**Regulatory Boundary:** Non-interventional assistive label-reading and user-owned checklist lookup tool under EU MDR Regulation (EU) 2017/745 Art. 2(1) and MDCG 2019-11 (`0` autonomous clinical dosing decisions; mandatory parallel shadow-check rule)

---

## 1. Operational Scope, Roles & Day-0 Bench Readiness

While [`PILOT_PLAN.md`](PILOT_PLAN.md) establishes consortium governance across 12 weeks and [`FINLAND_PHARMACY_INTEGRATION.md`](FINLAND_PHARMACY_INTEGRATION.md) specifies counter QR printing on **Receptum MAXX** and **Pharmadata Salix** terminals, this runbook is the **hands-on field execution manual** used at the rehabilitation desk and pharmacy counter for each participant's **30-day loaner kit cycle** (`N = 24` stratified across Cohort A blind VoiceOver/TalkBack users on Ray-Ban Meta Gen 2 and Cohort B adults aged `65+` with low vision and `>= 3` daily prescriptions on Meta Ray-Ban Display).

### 1.1 Field Operator Roster & Responsibilities

| Field Role | Site & Personnel | Daily / Weekly Operational Duty | Escalation Authority |
|---|---|---|---|
| **Assistive-Tech Coordinator (*Apuvälineneuvoja / Kuntoutusohjaaja*)** | **Näkövammaisten liitto**, Iiris Center (*digi- ja apuvälineneuvonta*), Itäkeskus | Executes accessible consent (`ConsentOnboarding`), runs the **3-Minute Loaner Kit Onboarding Checklist**, conducts Day 2, Day 7, Day 14, and Day 21 check-ins, and witnesses the **Day 29 1-Tap Return Wipe**. | Can quarantine a loaner kit (`S1`) or trigger a 24-hour PSRB safety pause (`S0`). |
| **Dispensing & Home-Care Pharmacist (*Farmaseutti / Proviisori*)** | **Yliopiston Apteekki** (Itäkeskus / Mannerheimintie) or Helsinki municipal home-care (*kotihoito*) pharmacy unit | Prints and affixes Braille-clear `25 x 25 mm` `holdup://rx?v=1&data=...` thermal stickers (`< 45 s` during *lääkeneuvonta*); staffs the licensed pharmacist voice fallback hotline (`tel:`) when HoldUp returns `"unsure"` or `"warning"`. | Audits concordance logs; co-chairs PSRB stop/resume reviews. |
| **HoldUp Field Telemetry & Safety Engineer** | On-call operator for stateless Cloud Run relay (`europe-north1`, Hamina, Finland) | Verifies paid-tier Gemini API billing lock (zero model training), polls zero-PII `GET /api/health` and `GET /api/stats` daily, verifies `0 bytes` disk retention, and maintains CI safety gates (`STRENGTH_MIN_CONF = 0.80`). | Executes immediate server-side session drain or model-chain lock on PSRB order. |

### 1.2 Mandatory Parallel Shadow-Check Rule (Days 1-30)

Throughout the 30-day loaner cycle, HoldUp operates strictly as an **additive shadow check prior to the participant's established primary routine** (pre-filled weekly *dosetti* pill organizer, pharmacy unit-dose *annosjakelu* pouch, or spouse/home-care nurse visual check). Participants never alter prescribed regimens based on HoldUp alone, and any `"warning"` or double `"unsure"` verdict routes straight to the partner pharmacy's *lääkeneuvonta* telephone line.

### 1.3 Day-0 Loaner Kit Bench Prep Checklist (Before Participant Arrival)

Every Iiris Center loaner case (*kokeilupaketti*) must pass these five bench checks before handover:

- [ ] **Wearable Firmware & Reboot Check:** Ray-Ban Meta Gen 2 (Cohort A) or Ray-Ban Display + Neural Band (Cohort B) updated to firmware **`V128+`**, **power-cycled once after any OTA update** (mandatory per [`HARDWARE_NOTES.md`](HARDWARE_NOTES.md) so the DAT camera service initializes cleanly), charging case and frames at **`>= 80%`** battery (`> 10%` hard DAT glasses-app install floor).
- [ ] **Companion App & Bridge APK Check:** Android 12+ (`minSdk 31`) bridge handset updated to **Meta AI `V292+`** (`com.facebook.stella`, logged into a pilot Meta account with date of birth set) and **`HoldUp Bridge`** (`android-dat`, compiled against Maven Central `com.meta.wearable:mwdat-core:1.0.1` and `mwdat-camera:1.0.1` with Developer Mode App ID `0`). For iOS companion handsets, verify parity build per [`IOS_DAT_PARITY.md`](IOS_DAT_PARITY.md).
- [ ] **Stateless Finland Relay Health Probe:** Confirm the `europe-north1` HTTPS endpoint responds cleanly with zero stored sessions:
  ```bash
  curl -fsS https://<pilot-host>/api/health
  ```
  Expected JSON: `{"ok":true,"gemini":"ok","liveModel":"gemini-3.8-live","verifyModel":"gemini-3.8-flash",...}`.
- [ ] **Clean Slate Verification:** Confirm browser `localStorage` on any loaner phone shows `0` saved medications (`ConsentOnboarding` pending screen visible) and `HoldUp Bridge` shows blank **Server URL** and **Session Code** fields.
- [ ] **Tactile Training Prop Pack in Case:** Verify `4` empty pharmacy training cartons (`Amlodipin 5 mg`, `Amlodipin 10 mg` look-alike strength trap, `Bisoprolol Orion 2,5 mg` comma-decimal carton, and `Burana 400 mg` NSAID avoid trap) plus `1` removable thumb-occlusion sleeve and `1` notched `55 x 85 mm` `holdup://rx` practice card are inside the kit.

---

## 2. 3-Minute Loaner Kit Onboarding Checklist (`00:00 - 03:00`)

After informed consent is recorded (§3.1), the rehabilitation specialist or pharmacy coordinator executes this timed **180-second setup and safety verification sequence** with the participant wearing the glasses. Every step has a deterministic observable pass state before advancing.

### Step 1 (`00:00 - 00:45`): Pair Ray-Ban Meta Gen 2 & Enable `DAT 1.0.1` Developer Mode

1. **Unfold & Don Glasses:** Participant unfolds the temples and puts on the Ray-Ban Meta Gen 2 (or Ray-Ban Display). Confirm via Meta AI -> **Devices** that the glasses show **Connected** and battery **`>= 15%`** (above the `< 15%` automatic phone-camera hot-swap threshold and `> 10%` DAT floor).
2. **Verify `DAT 1.0.1` Developer Mode (`App ID 0`):**
   - In the **Meta AI** app (`V292+`), open **Settings -> App Info**, tap **App version** `5` times, toggle **Developer Mode -> Enable**, then close and reopen Meta AI (Developer Mode is per-linked-device and resets after firmware updates).
   - Note the single-app Developer Mode invariant: only one Developer Mode app (`APPLICATION_ID = 0`, `CLIENT_TOKEN = 0`) can hold registration at a time. Connecting `HoldUp Bridge` automatically replaces any prior SDK sample registration.
3. **Register `HoldUp Bridge` with Glasses:**
   - Open **`HoldUp Bridge`** (`HoldUp Glasses Bridge (DAT 1.0.1)`) on the Android phone and tap **`Connect Glasses`**.
   - Approve the Meta AI handoff prompt.
   - **Pass Criterion (`00:45`):** `HoldUp Bridge` status card transitions to `Registered` and `Device: <glasses-name> connected` with live battery percentage and `worn: true`.

### Step 2 (`00:45 - 01:30`): Scan Bridge Pairing QR (`holdup://connect` / `holdupbridge://connect`)

1. **Open PWA & Display Pairing QR:**
   - Launch Chrome on the phone to `https://<pilot-host>` (pinned to the home screen with TalkBack / VoiceOver labels active) and open the **Device & Resilience Panel**.
   - Note the active ephemeral session ID (`hup-xxxx`, stored locally under `holdup.sessionId`) and the rendered ISO/IEC 18004 pairing QR.
   - *Protocol Scheme Note:* Field checklists refer to this step as the **`holdup://connect` bridge QR**; on the wire (`web/src/pairing/links.ts`, `web/src/pairing/qrScanner.ts`, and `android-dat/app/src/main/AndroidManifest.xml`), `buildBridgeDeepLink()` encodes the dedicated `holdupbridge://connect` scheme so Android OS intent routing and `classifyScannedCode()` never collide with `holdup://rx` prescription stickers:
     ```text
     holdupbridge://connect?server=https%3A%2F%2F<pilot-host>&session=hup-xxxx
     ```
2. **Scan Bridge QR & Start `~1 fps` Ingest:**
   - Scan the pairing QR with the phone camera (or tap the deep link directly when Chrome and `HoldUp Bridge` share the same Android handset). `MainActivity.handleDeepLink()` (`launchMode="singleTop"`) sanitizes and prefills **Server URL** and **Session Code** automatically via `BridgePreferences.saveEndpoint()`.
   - Tap **`Start Streaming`** in `HoldUp Bridge`. On first launch, approve the Meta AI camera permission prompt with **`Allow always`**.
   - Keep `HoldUp Bridge` running in the background via `StreamingForegroundService` (`"HoldUp is streaming from your glasses"` notification), which captures `720x1280` (`VideoQuality.HIGH`) at `2 fps` (minimum DAT SDK rate) and throttles uploads to `<= 1 fps` JPEG (`950 ms` minimum spacing, dropping frames in flight) to `POST /ingest/frame?session=hup-xxxx`.
   - *(Cohort B Ray-Ban Display Addition):* Load `https://<pilot-host>/hud` once via **Meta AI -> App Settings -> Apps -> Web Apps -> Connect Web App** (or scan the `fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=...` QR). `/hud-ws` attaches with zero session-code typing via `floatingHuds` and renders a pure `#000000` transparent standby canvas.
3. **Pass Criterion (`01:30`):** PWA Device Panel updates within `< 5 ms` server fan-out (`ingest_state_to_live_ws_p50_ms = 2.96 ms` in [`eval/e2e_websocket_live.json`](../eval/e2e_websocket_live.json)) to show **`Glasses: Connected / Worn / <battery>%`**, active eye source **`glasses`**, and HTTP `204` on `/ingest/state` and `/ingest/frame`.

### Step 3 (`01:30 - 02:15`): Scan `holdup://rx?v=1&data=...` Pharmacy Sticker into Phone `localStorage`

1. **Inspect Physical Sticker Placement (Braille & Print Non-Occlusion):**
   - Confirm the `25 x 25 mm` thermal `holdup://rx` sticker (`<= 450` ASCII bytes, QR Version `10-14`, module pitch `0.309 - 0.385 mm` on `203/300 dpi` Zebra or Citizen stock per [`FINLAND_PHARMACY_INTEGRATION.md`](FINLAND_PHARMACY_INTEGRATION.md)) sits on the bottom-right non-Braille back panel (or notched `55 x 85 mm` tactile companion card) and covers **`0%` of embossed Marburg Medium Braille dots, printed strength numerals, `EXP` date, or the factory EAN-13 barcode**.
2. **Scan `holdup://rx` Sticker Client-Side:**
   - Open **Import Pharmacy QR** (`PharmacyImportModal.tsx`) in the PWA and hold the notched corner or carton back panel at chest height (`~25 cm`).
   - `detectAndClassifyFromSource()` (`web/src/pairing/qrScanner.ts`) classifies `kind: "pharmacy_rx"` and runs `parsePharmacyQrUri()` + `mergePharmacyPayload()` (`web/src/pairing/pharmacyQr.ts`) **100% locally in browser JavaScript** (`0` HTTP or WebSocket calls):
     ```text
     holdup://rx?v=1&data=eyJ2IjoxLCJtZWRzIjpbeyJpZCI6ImFtbCIsIm5hbWUiOiJBbWxvZGlwaW4iLCJpbmdyZWRpZW50IjoiYW1sb2RpcGluZSIsInN0cmVuZ3RoIjoiNSBtZyIsInNjaGVkdWxlIjpbImV2ZW5pbmciXSwiYmFyY29kZSI6IjY0MzIxMDAwMTIzNDUiLCJub3RlcyI6IjEgdGFibGV0dGkgaWxsYWxsYSJ9XSwicGhhcm1hY3kiOiJZbGlvcGlzdG9uIEFwdGVla2tpIEl0w6RrZXNrdXMiLCJhdm9pZCI6WyJOU0FJRHMiXX0
     ```
   - Verify automatic Nordic normalization: comma decimals (`2,5 mg` -> `2.5 mg`), Finnish INN substance aliases (`amlodipiini` -> `amlodipine`, `bisoprololi` -> `bisoprolol`), 13-digit EAN-13 barcode (`6432100012345`) for offline matching, and contraindicated class tags (`avoid: ["NSAIDs"]`).
3. **Listen to Trilingual Read-Back & Confirm On-Device Save:**
   - Participant listens to the `aria-live="polite"` preview in Finnish (`fi`), Swedish (`sv`), or English (`en`) (*"Uusi: Amlodipin 5 mg, iltalääke, vältä tulehduskipulääkkeitä"*) and activates **`Lisää laitteeni lääkelistalle` / `Add to My On-Device Medications`**.
   - **Pass Criterion (`02:15`):** `saveProfile()` writes the merged regimen strictly to phone `localStorage` key `holdup.profile` (`0` bytes transmitted to server disk), and the profile pill count increments immediately.

### Step 4 (`02:15 - 03:00`): Verify Hands-Free Open-Ear HFP Audio & `STRENGTH_MIN_CONF = 0.80` Safety Catch

1. **Confirm Bluetooth HFP Open-Ear Audio Routing:**
   - Verify the phone's active Bluetooth call/media audio route is the Ray-Ban Meta open-ear speakers and temple microphone so spoken prompts are private to the wearer while both ears stay uncovered to the specialist's voice.
   - Start an active check hands-free and confirm the wearer hears the `camera_on` earcon, feels the phone haptic pulse, and sees the front **hardware Capture LED** illuminate on the glasses frame.
2. **Sub-Check 4A - Clean Positive Match (`~15 s`):**
   - Hand the participant the clean training carton **`Amlodipin 5 mg`** at natural chest height (`~25 cm`). Participant asks: *"Onko tämä minun iltalääkkeeni?"* (*"Is this my evening pill?"*).
   - Verify **Gemini Live** (`gemini-3.8-live`) gives `<= 2` short body-relative coaching cues if needed (`rotate_left`, `closer`, `hold_still`), invokes `verify_label` on **`gemini-3.8-flash`**, speaks the deterministic `MATCH` verdict aloud over open-ear HFP, and (for Cohort B) renders the high-contrast green `MATCH` card on `/hud` (`<= 65%` lit pixels, `<= 8` words).
3. **Sub-Check 4B - Mandatory `STRENGTH_MIN_CONF = 0.80` Occlusion Refusal (`~20 s`):**
   - Slide the thumb-occlusion band (or instruct the participant to place their thumb) directly over the **`5 mg`** strength text on the same `Amlodipin` training carton and repeat the check.
   - Verify `readLabel()` outputs `strength.value = null` (clamped to `confidence <= 0.30` in `server/src/verify.ts`), and `checkLabel()` in `server/src/safety.ts` enforces **`STRENGTH_MIN_CONF = 0.80`**, deterministically blocking `"match"` and emitting **`Verdict.level = "unsure"`** (*"It looks like Amlodipin, but I can't read the strength confidently..."*) with re-aim guidance and pharmacist handoff.
   - **Pass Criterion (`03:00`):** Participant hears both the clean `MATCH` and the occluded `UNSURE` refusal hands-free over open-ear HFP (`0` guessed doses). Onboarding is signed off in the coordinator intake log.

---

## 3. Participant Consent, Bystander LED Orientation & Mandatory 1-Tap Return Wipe Protocol

### 3.1 Plain-Language Verbal + Screen-Reader Consent (`ConsentOnboarding`, `v2026-11-14`)

Before any camera permission or `/live` WebSocket connection is opened on Day 1, HoldUp gates the application behind `ConsentOnboarding` (`web/src/components/ConsentOnboarding.tsx`, `CONSENT_VERSION = "2026-11-14"` in `web/src/storage/profileStore.ts`).

The assistive-tech coordinator conducts a dual-channel consent walkthrough (participant navigates via **iOS VoiceOver**, **Android TalkBack**, or **18pt high-contrast matte print / Grade-1 Finnish Braille sheet** while the coordinator confirms comprehension verbally across all five numbered commitment cards):

| Card Badge | `ConsentOnboarding` Commitment (`en` / `fi`) | Code-Enforced Guarantee Verified With Participant |
|---|---|---|
| **`01`** | **Camera runs only when you ask** / *Kamera käynnistyy vain pyynnöstäsi* | Zero background lifelogging. Capture starts only on explicit user action, plays `camera_on` / `camera_off` earcons, throttles Live frames to `<= 1 fps` (`>= 900 ms` in `server/src/live.ts`), and auto-stops after **45 seconds** without frames (`IDLE_STOP_MS = 45000`). |
| **`02`** | **Zero server storage** / *Ei tallennusta palvelimelle* | Camera frames reside solely in a bounded 8-slot RAM `FrameRing(8)` cleared immediately on WebSocket close (`hub.ring.clear()`) and 10-minute idle GC. Paid-tier Gemini API processes frames in memory only (zero model training). `server/src/log.ts` scrubs `DENY` keys and caps strings at `48` chars. |
| **`03`** | **Your medication list stays on this device** / *Lääkelistasi pysyy tällä laitteella* | `Profile` (`meds`, `allergies`, `avoid`, `doseLog`) and `ConsentRecord` live exclusively in phone `localStorage` (`holdup.*`), never on server disk or loaner Display `/hud` glasses (`0 B` storage), and `readLabel()` receives **zero** profile fields. |
| **`04`** | **Bystander privacy** / *Sivullisten yksityisyys* | Front-facing hardware Capture LED stays locked ON by Meta firmware `V128+` during streaming, and both `server/src/prompts/live.md` and `shared/verify_prompt.md` + `shared/label_schema.json` forbid describing people, faces, or hands. |
| **`05`** | **Not a medical device** / *Ei lääkinnällinen laite* | Enforces `STRENGTH_MIN_CONF = 0.80` never-guess refusal, keeps parallel *dosetti* / caregiver verification mandatory, and routes uncertainty or clinical questions to a licensed pharmacist. |

- **Recording Acceptance:** Participant taps or activates **`I Understand, Continue to HoldUp`** (`Ymmärrän, jatka HoldUpiin`), storing `{ accepted: true, acceptedAt: <epoch_ms>, version: "2026-11-14" }` strictly in `localStorage["holdup.consent"]`. No central consent database with personal identifiers is created on HoldUp servers; paper/accessible witness forms remain locked at Iiris Center under Näkövammaisten liitto governance.

### 3.2 Bystander Hardware Capture LED Orientation (Tactile & Household Etiquette)

Because blind wearers (`Cohort A`) cannot visually inspect the front of their own frames, the Day 1 coordinator performs a **60-second physical bystander orientation**:

1. **Tactile Frame Landmarking:** Guide the participant's index fingers to the outer upper corners of the Ray-Ban Meta frame front to feel the camera lens housing and the opposite **front-facing Capture LED** window so the wearer knows not to cover either window with fingers when adjusting the glasses.
2. **Firmware-Enforced Illumination Proof:** Trigger a 5-second test stream in `HoldUp Bridge`. Confirm `BridgeScreen.kt` displays the high-contrast `CAMERA ON - CAPTURE LED ACTIVE` live-region banner (`LiveRegionMode.Polite` announced by TalkBack) while the physical white LED on the glasses illuminates. Tap **`Stop Streaming`** and confirm the LED extinguishes immediately.
3. **Household & Public Etiquette Rule:** Advise participants to hold packages at chest/table level (`25 - 30 cm`) angled slightly downward rather than toward people across a room, and demonstrate HoldUp's deterministic bystander refusal by asking *"Who is sitting in front of me?"* -> HoldUp replies *"I only help with labels"* (`2574.8 ms` refusal, `0` bystander or background PII leaks across `8/8` scenes in [`eval/bystander_privacy_results.json`](../eval/bystander_privacy_results.json) and `8/8` pass in `eval/coaching_eval.json`).

### 3.3 Mandatory Loaner Return, Sanitization & 1-Tap Wipe Protocol (`0` Server Health Records)

Every loaner kit returned to Iiris Center (on Day 29, or earlier if a participant withdraws under GDPR Art. 7(3)) **must** complete this 5-step de-provisioning checklist in the participant's presence before the kit is placed back in the loaner pool:

1. **Step A - Optional Pre-Wipe Participant Summary Export:**
   - Ask whether the participant wishes to save or text their plain-text 30-day dose adherence summary (`exportCaregiverSummary()`) to themselves or a family caregiver before deletion.
2. **Step B - Execute PWA Local Wipe (`wipeAllLocalData()`):**
   - Open the **Privacy & Consent** modal (`ConsentOnboarding`) in the phone PWA.
   - Activate **`Delete All My Local Data`** (`Poista kaikki paikalliset tietoni`), verify TalkBack/VoiceOver announces the assertive confirmation prompt (`Confirmation required...`), and activate **`Confirm Delete Everything`** (`Vahvista kaikkien tietojen poisto`).
   - *Code Effect:* Invokes `wipeAllLocalData()` (`web/src/storage/profileStore.ts`), erasing `holdup.profile`, `holdup.consent`, `holdup.theme`, `holdup.sessionId`, and every `holdup.*` key in `localStorage` and memory fallback maps, while immediately closing `/live` so the server executes `hub.ring.clear()` (`0` frames in RAM).
3. **Step C - Execute Android DAT Bridge Wipe (`Forget Saved Server`):**
   - Open **`HoldUp Bridge`** (`android-dat`) -> tap **`Stop Streaming`** -> tap **`Disconnect`**.
   - Tap **`Forget Saved Server`** (`BridgeScreen.kt` line 270 -> `BridgePreferences.clearSavedEndpoint(applicationContext)` + `DatBridgeController.updateEndpoint("", "")`).
   - *Code Effect:* Removes `server_url` and `session_code` and calls `.clear().apply()` on private `SharedPreferences` (`holdup_bridge_prefs`).
4. **Step D - Display `/hud`, Meta AI & Physical Frame Reset:**
   - Confirm Ray-Ban Display `/hud` requires zero storage purge because `web/src/hud/HudApp.tsx` writes **`0` bytes** to `localStorage`, `sessionStorage`, or `IndexedDB`. Remove the pilot Web App URL from Meta AI -> **Web Apps** if the unit is rotating out of the cohort.
   - If the glasses were paired to the participant's personal smartphone, unpair the glasses in Meta AI -> **Devices** and OS Bluetooth settings. Sanitize nose pads, temples, and Neural Band with non-alcohol optical wipes + UV-C cabinet, and charge to `>= 80%`.
5. **Step E - Dual-Operator Zero-Residual Verification Sign-Off:**
   - Reload `https://<pilot-host>` on the loaner phone and verify the unaccepted `ConsentOnboarding` screen renders with **`0 medicines currently saved on device`** (`0 lääkettä tallennettuna laitteelle`).
   - Force-close and relaunch `HoldUp Bridge` and verify **Server URL** and **Session Code** remain empty (`""`).
   - Record sign-off on the Iiris Center loaner return sheet confirming **`0` server health records** exist on disk (since `Profile` never touched server storage) and **`0` local keys** remain on loaner hardware.

---

## 4. Day-by-Day 30-Day Field Execution Manual (`Day 0` - `Day 30`)

| Pilot Day(s) | Primary Site & Lead | Operational Actions & Participant Protocol | Daily Verification Artifact / Exit Gate |
|---|---|---|---|
| **`Day 0`** | Iiris Center Bench + Cloud Run (`HoldUp Eng`) | Flash/verify `24` glasses kits on firmware `V128+` (rebooted post-OTA) and `HoldUp Bridge` (`DAT 1.0.1`); lock paid-tier Gemini API billing; test ZPL `holdup://rx` sticker print (`<= 450 B`) at partner pharmacy counter; verify `GET /api/health` -> `ok: true`. | `24/24` kits green on Day-0 checklist (§1.3); `0` errors on bench smoke check. |
| **`Day 1`** | Iiris Center Lab (`Apuvälineneuvoja` + `UX`) | Conduct `60-min` 1:1 intake (`6-8` participants/day across staggered slots): record accessible `ConsentOnboarding` (`v2026-11-14`); run baseline timed 6-package check using participant's current tool + baseline **SUS** & **PIADS-10**; execute **3-Minute Loaner Kit Onboarding Checklist** (§2) including `STRENGTH_MIN_CONF = 0.80` thumb-occlusion catch; rehearse 500 lux & 80 lux aiming cues (`rotate_left`, `closer`, `more_light`, `other_side`). | Signed witness consent; `100%` pass on Step 4B `< 0.80` refusal drill; personalized theme (`dark` / `light` / `high-contrast`), language (`fi`/`sv`/`en`), and audio speed set. |
| **`Days 2 - 3`** | Participant Home + Phone Check-In (`Coordinator`) | **48-Hour Ergonomics & HFP Check:** Participant performs `2-3` daily checks on non-critical pantry packages at home. Coordinator conducts a `10-min` phone check-in on Day 3 verifying Bluetooth HFP volume clarity, Neural Band / temple comfort, Capture LED awareness, and `45 s` idle auto-stop earcon recognition. | Day 3 comfort log; `0` unresolved pairing or HFP audio routing blockers. |
| **`Days 4 - 7`** | Participant Home Kitchen (`Stage A: Food & Expiry`) | Daily hands-free checks on household food allergens (*maapähkinä*, *pähkinät*, *hasselpähkinä*, *maito*, *gluteeni/vehnä*, *soija*, *kananmuna*) and carton `EXP` dates across home Wi-Fi and 4G. Validate automatic `Snapshot Mode` (`POST /api/verify` + TTS) if Live WS drops and automatic phone-camera hot-swap when glasses are doffed (`!worn`). **Day 7 PSRB Gate A Review.** | Week 1 `GET /api/stats` snapshot (`0` disk PII, latency within target) + Day 7 participant call; PSRB Gate A clearance for prescription shadow checks. |
| **`Day 8`** | **Yliopiston Apteekki** Counter / Home-Care Pharmacy | **Live `holdup://rx` Counter Onboarding:** Participant picks up scheduled refill (or standardized pilot carton pack) at the designated pharmacy counter. Pharmacist generates and affixes Braille-clear `25 x 25 mm` `holdup://rx?v=1&data=...` sticker (`< 45 s` counter workflow), watches participant scan into `localStorage` (`PharmacyImportModal`), and tests the **1-tap pharmacist counseling hotline (`tel:`)** fallback once. | Counter stopwatch log (`median < 45 s`); `100%` Braille non-occlusion pass; verified `holdup.profile` merge (`mergePharmacyPayload`) preserving existing `Med.id`s. |
| **`Days 9 - 13`** | Participant Home (`Stage B: Parallel Rx Shadow`) | Participant performs daily morning and evening hands-free prescription checks **immediately before** their standard *dosetti* / *annosjakelu* / caregiver verification. Test spoken `"I took it"` / `"Otin lääkkeen"` logging (`log_dose` -> `doseLog`) and verify same-day duplicate-dose warning (`dosesToday()`) using an empty training carton. | Daily participant/caregiver shadow concordance diary (`HoldUp verdict` vs. `ground-truth carton`). |
| **`Day 14`** | Participant Home + Coordinator Phone Drill | **Midpoint Safety Audit & Zero-Network Airplane-Mode Drill:** Coordinator guides participant over landline/caregiver phone to enable Airplane Mode on the bridge/PWA handset and scan `holdup://rx`-saved cartons. Verify `TransportMode = "offline"` matches saved EAN-13 barcodes locally via `BarcodeDetector` in `< 3 s` (`0.0 KB` network) and explicitly refuses unsaved cartons. **Midpoint PSRB Review.** | `>= 98%` offline EAN-13 recognition in `< 3 s`; `0` confident-wrong doses across Days 1-14; cohort retention `>= 85%`. |
| **`Days 15 - 21`** | Participant Home + Pharmacy Hotline Desk | **Full-Loop Daily Routine & Caregiver Sharing:** Participants run Live + `/hud` prescription shadow checks, grocery checks, offline barcode fallbacks, and optional user-initiated `exportCaregiverSummary()` text sharing with a family caregiver or home-care nurse. On Day 21, pharmacy lead audits all incoming *lääkeneuvonta* hotline escalations triggered by `"unsure"` or `"warning"` verdicts. | Week 3 `GET /api/stats` bandwidth/latency log + pharmacist hotline resolution log. |
| **`Days 22 - 28`** | Participant Home (`Unscripted Longitudinal Week`) | Unprompted everyday usage across morning/evening polypharmacy routines, dim winter indoor lighting, and grocery trips. On-call engineer monitors `GET /api/stats` error rates, RTT-adaptive tier engagement (`> 650 ms` RTT -> `0.5 fps` `512 px` JPEG), and 3-model Gemini fallback counts. | Continuous 7-day longitudinal usage, latency, and token-cost dataset (`server/logs/ledger.jsonl`). |
| **`Day 29`** | Iiris Center Lab (`Apuvälineneuvoja` + `UX`) | **Endline Benchmark & Mandatory Kit Return Wipe:** Repeat the standardized 6-package timed benchmark hands-free on glasses (paired against Day 1 baseline), administer endline **SUS** & **PIADS-10** and exit interview, export optional participant summary, and execute **§3.3 Mandatory 1-Tap Wipe (`wipeAllLocalData()`) + Android `Forget Saved Server`** with dual-operator sign-off. | Paired Day 1 vs. Day 29 speed/independence dataset; signed zero-residual kit wipe receipt (`0` local keys, `0` server health records). |
| **`Day 30`** | Consortium PSRB (`Näkövammaisten liitto`, Pharmacy, HoldUp) | **30-Day KPI Sign-Off & Public Reimbursement Dossier:** Reconcile shadow concordance logs, counter stopwatch timings, `GET /api/stats` latency/cost totals, and SUS/PIADS-10 deltas into the standardized **HUS *Apuvälinekeskus*** (*Terveydenhuoltolaki* `1326/2010` §29) and **Kela** (*Laki* `566/2005`) assistive-device procurement evidence pack. | Signed PSRB 30-Day Safety & KPI Report; HUS / municipal wellbeing county procurement dossier. |

---

## 5. 4-Week Quantitative Evaluation KPIs, Zero-PII Telemetry Spec & Safety Stop-Rules

### 5.1 Pre-Registered 4-Week KPIs Grounded in Verified Repo Baselines

Every baseline figure in Column 3 comes directly from committed, reproducible benchmark artifacts in `eval/` (full tables in [`EVAL.md`](EVAL.md), [`eval/e2e_websocket_live.json`](../eval/e2e_websocket_live.json), [`eval/combined_summary.json`](../eval/combined_summary.json), and [`eval/unit_economics.json`](../eval/unit_economics.json)):

| KPI Dimension | Operational Definition (Days 1-30) | Verified Repo Baseline (`eval/` Artifacts) | 4-Week Pilot Pass Threshold |
|---|---|---|---|
| **1. Confident-Wrong Dose & Allergen Rate (Primary Safety KPI)** | Share of checks emitting `level = "match"` on a mismatched/expired/unreadable medication strength, or `level = "info"` safe on food containing a profile allergen (`STRENGTH_MIN_CONF = 0.80`, `ALLERGEN_MIN_CONF = 0.60`). | **`0` confident-wrong doses** (`0 / 53` core label checks, `0 / 60` extended stress checks, `0 / 16` calibration reads with `ECE = 0.0138` & `Brier = 0.0005`); **`0` false-safe allergens** (`eval/combined_summary.json`). | **`0` events (`0.0%`)** across all lab & home shadow checks |
| **2. Occluded / Degraded Safe Abstention Fidelity** | Share of thumb-occluded, specular-glare, faded-thermal, or motion-blurred strength panels routed deterministically to `level = "unsure"` with coaching or pharmacist referral. | **`98.2%`** across core suites; **`100.0%`** on calibration heavy/occluded tiers (`0.0000` mean conf) and Finnish sticker occlusion cases `ns_08` / `ns_09` (`eval/nordic_stickers_results.json`). | **`100.0%`** safe abstention on Day 1 & Day 29 occlusion drills |
| **3. End-to-End Frame-to-HUD Verdict Latency (`p50` / `p95`)** | Elapsed time from JPEG frame ingest (`POST /ingest/frame`) through `gemini-3.8-flash` verification and `checkLabel()` to rendered verdict arrival on `/hud-ws` (plus full Live voice-coached turn duration). | **`2.74s` (`2738.77 ms`) frame-to-HUD `p50`** (`p95 = 6.24s` / `6235.73 ms`; `/ingest/frame` -> `FrameRing` `3.07 ms`; `/ingest/state` -> `/hud-ws` `3.01 ms` in `eval/e2e_websocket_live.json`); **`582 ms`** `gemini-3.8-live` first-audio (`eval/live_models_probe.json`); **`3.54s` (`3537.1 ms`)** 4-suite verify `p50`. | Frame-to-HUD **`p50 <= 3.50s`** (`p95 <= 7.00s`); full coached check **`p50 < 10.0s`** |
| **4. Per-Check Cloud Inference Cost** | Paid-tier Gemini API multimodal token spend per 12-second active check (`gemini-3.8-live` `~1 fps` + `gemini-3.8-flash` `2`-frame `verify_label`, `7,488` total tokens normal / `5,940` adaptive). | **`EUR 0.0029` / check** (`EUR 0.00294` / `$0.00319` standard cached; `EUR 0.00251` adaptive `0.5 fps`; **`EUR 0.35 / month`** for `120` checks at `4` checks/day; `EUR 2.48 - 4.23 / year` pilot band in `eval/unit_economics.json`). | **`<= EUR 0.0050` / check** (`<= EUR 0.60` / user over 30 days) |
| **5. 3-Year Assistive TCO vs. Proprietary OCR Hardware** | All-in 3-year per-user hardware + cloud inference cost (`4,320` checks) compared against dedicated assistive OCR wearables (OrCam MyEye midpoint) and paid remote-agent plans (Aira daily plan). | **`EUR 341.68` vs. `EUR 4,150.00` = `91.8%` 3-year TCO savings** (`12.1x` cost reduction: `EUR 329.00` Ray-Ban Meta Gen 2 + `EUR 12.68` 3-yr cloud, or `EUR 337.88` with `30%` local barcode blend; **`85.4%` savings** vs. `EUR 2,340.00` Aira plan; **`EUR 380,832` saved per `100` public rehab users** in `eval/unit_economics.json`). | Validated actual 30-day cloud spend projects **`<= EUR 365.00` 3-yr all-in TCO** (`>= 91%` savings vs. `EUR 4,150.00`) |
| **6. Slow-Network Bandwidth & Offline Barcode Resilience** | Adaptive media payload reduction above `650 ms` WebSocket RTT (`0.5 fps`, `512 px`, `0.50` JPEG) and zero-network `BarcodeDetector` match rate on `holdup://rx` cartons. | **`84.0%` adaptive video bandwidth reduction** (`724.64 KB -> 116.02 KB` JPEG; `1,348.64 KB -> 740.02 KB` total raw media = `45.1%` saved; `0.0 KB` offline barcode mode in `eval/unit_economics.json`). | **`>= 98.0%`** Day 14 airplane-mode EAN-13 match in **`< 3.0s`** |
| **7. Pharmacy Counter Fit & Hands-Free Independence** | Dispensing counter time to print, affix (Braille-clear), and scan `holdup://rx` QR; hands-free check rate (`source = "glasses"`); Day 1 -> Day 29 usability & independence gain. | `213 - 421 B` single/dual-med QR fits `25 x 25 mm` `203/300 dpi` thermal label (`FINLAND_PHARMACY_INTEGRATION.md`); `100%` WCAG 2.2 AA VoiceOver/TalkBack audit (`ACCESSIBILITY_AUDIT.md`). | Counter time **`< 45s`**; hands-free **`> 90%`**; **`SUS >= 75`** & **`PIADS-10 >= +1.2`** |
| **8. Zero Server Health Retention & Bystander Privacy** | Bytes of participant `Profile`, JPEG frames, PCM16 audio, or transcripts written to server disk + bystander PII leaks. | **`0 bytes` disk retention** (`FrameRing(8)` cleared on disconnect -> `ring_len_after_disconnect = 0` in `eval/hud_latency_bandwidth.json`); **`0 / 8` bystander/PII leaks** (`eval/bystander_privacy_results.json`). | **`0 bytes`** on server disk; **`0`** bystander PII disclosures |

### 5.2 Zero-PII Operational Telemetry Specification (`server/src/ledger.ts` & `GET /api/stats`)

To measure pilot latency, reliability, fallback frequency, and token unit economics across 30 days **without ever logging special-category health data (GDPR Art. 9)**, HoldUp separates aggregate numeric telemetry from user content in code:

1. **Append-Only Numeric Ledger (`server/logs/ledger.jsonl` via `server/src/ledger.ts`):**
   Each completed Gemini call appends a single `LedgerLine` JSON row containing **only** numeric timestamps, feature tags (`"live"`, `"verify"`, `"verify_live"`, `"tts"`), model IDs, token integers, and boolean status:
   ```json
   {
     "ts": 1794668291000,
     "feature": "verify",
     "model": "gemini-3.8-flash",
     "in": 2494,
     "out": 153,
     "thinking": 0,
     "cached": 1870,
     "latency_s": 2.712,
     "ok": true
   }
   ```
   For `"live"` sessions, `ledger.ts` additionally records `first_audio_s` (`number`), `tool_latencies_s` (`number[]`), and `tool_calls` (`number`). **Strictly omitted by schema:** session IDs, IP addresses, `Profile`, drug names, extracted `LabelRead` JSON, `Verdict.level`, spoken transcripts, PCM16 audio, and JPEG bytes.
2. **Hard Log Redactor (`server/src/log.ts`):**
   Stdout operational events pass through `redact()`, replacing every `DENY`-listed key (`text`, `data`, `transcript`, `image`, `frame`, `frames`, `audio`, `profile`, `speech`, `headline`, `question`, `args`, `prompt`, `body`, `key`, `apikey`, `api_key`, `value`) with `"[redacted]"`, truncating any string `> 48` characters to `"[redacted:<n>ch]"`, truncating session correlation tags to `8` chars, and scrubbing any `AIza...` pattern.
3. **Daily Coordinator Telemetry Poll (`GET /api/stats`):**
   At `20:00` Helsinki time each evening of the 30-day pilot, the on-call safety engineer runs:
   ```bash
   curl -fsS https://<pilot-host>/api/stats
   ```
   and archives the aggregated summary (`since`, `total`, and per-feature `calls`, `ok`, `errors`, `latency_p50_s`, `latency_p95_s`, `first_audio_p50_s`, `tool_p50_s`, `tokens_in`, `tokens_out`, `models`) to compute daily `p50`/`p95` latency, 3-model fallback share (`gemini-3.8-live` -> `gemini-3.1-flash-live-preview` -> `gemini-2.5-flash-native-audio-latest`; `gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3-flash-preview`), and exact EUR token spend (`(tokens_in, tokens_out)` against [`eval/unit_economics.json`](../eval/unit_economics.json) rates).

### 5.3 Mandatory Safety Stop-Rules & Escalation Protocol

The **Pilot Safety Review Board (PSRB)** - comprising `1` Lead *Proviisori* (pharmacy partner), `1` Assistive-Technology Specialist (**Näkövammaisten liitto** Iiris Center), and `1` HoldUp Safety Engineer - enforces three non-negotiable operational stop-rules throughout Days 1-30:

| Severity | Quantitative Trigger Condition | Mandatory Immediate Action (`SLA`) | Resume / Clearance Gate |
|---|---|---|---|
| **`S0` - Immediate Fleet Safety Pause** | **`>= 1` confident-wrong dose or allergen verdict** (`Verdict.level = "match"` spoken/rendered when physical package strength/drug/expiry mismatches saved profile or strength is unreadable, OR `level = "info"` safe spoken when package lists a saved profile allergen) **OR** **`> 0 bytes`** of participant `Profile`, JPEG frames, or audio discovered on server disk. | **Within `15 minutes`:** Drain active pilot relay sessions, notify all `24` participants by phone/SMS to pause HoldUp checks and continue relying exclusively on their primary *dosetti* / *annosjakelu* / caregiver routine, and convene emergency PSRB within **`24 hours`**. | Failing case reproduced as a permanent deterministic unit test in `server/test/safety.test.ts`; `STRENGTH_MIN_CONF` / normalization rule hardened; `node scripts/verify-all.mjs` green; unanimous written PSRB sign-off. |
| **`S1` - Single-Kit Quarantine / Pharmacy Counter Stop** | **(a)** Glasses front **hardware Capture LED** fails to illuminate during active DAT camera streaming; **(b)** A pharmacy counter sticker is found occluding embossed **Braille**, strength digits, or `EXP` date; **(c)** Participant exhibits confusion between `"unsure"` refusal cues and `"match"` confirmations; **(d)** `> 3` unrecovered DAT Bluetooth disconnects in a single day. | **Within `2 hours`:** For **(a)** or **(d)**, swap loaner glasses kit from the `4`-unit hot-swap spare pool at Iiris Center (participant uses phone-camera `Snapshot Mode` + Bluetooth HFP audio in the interim); for **(b)**, halt sticker application at that counter for a `15-min` Braille-clearance re-brief; for **(c)**, revert participant to supervised-only checks or withdraw safely from cohort. | Hardware replacement passes full §2 3-minute checklist (including Capture LED + `< 0.80` occlusion catch) or counter passes `5` consecutive audited Braille-clear placements. |
| **`S2` - Degraded Latency, Fallback or Cost Alert** | Daily `GET /api/stats` poll shows **`verify.latency_p95_s > 8.0s`**, **`(errors / calls) > 5.0%`** on `live` or `verify`, primary model fallback share **`> 10.0%`** over 24 hours, or realized token spend **`> EUR 0.0075` / check** (above uncached native-audio ceiling). | **Within `24 hours`:** Inspect Cloud Run `europe-north1` CPU/instance concurrency, upstream Gemini API paid-tier quota headers, and participant home Wi-Fi RTT distribution (confirming adaptive `0.5 fps` `512 px` tier triggers at `650 ms`). Participants remain protected by automatic `Snapshot Mode` and `Offline BarcodeDetector` fallbacks. | `GET /api/stats` returns `verify.latency_p50_s <= 3.5s`, error rate `< 2.0%`, and per-check cost `<= EUR 0.0050` across the subsequent 24-hour window. |
