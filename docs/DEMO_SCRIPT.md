# HoldUp Live Stage Choreography, Pre-Flight & Contingency Playbook (`docs/DEMO_SCRIPT.md`)

Operational stage runbook for the **3-minute Junction 2026 live demo** (`Meta: AI Glasses for Everyone, Everyday` + `Google DeepMind: Best Use of Gemini API`). Designed for **Silas** (presenter), **Momin010** (glasses & DAT bridge operator), **ivarakerholm-wq** (physical props & accessibility check), and **Chintufp** (projection, timer & backup video).

---

## 1. Five-Minute Pre-Stage Flight Check (`T-05:00` to `T-00:00`)

Complete every item in order before walking onto stage or inviting booth judges to begin:

### 1.1 Server, HTTPS Tunnel & Health (`T-05:00`)
- [ ] Start the single-origin production build and HTTPS tunnel in two persistent terminal tabs (or verify the stable Cloud Run `europe-north1` URL from `docs/DEPLOY.md`) and **do not restart `cloudflared`** once `/hud` is registered:
  ```bash
  npm start
  npm run tunnel
  ```
- [ ] Run health and manifest checks against `$HOST`:
  ```bash
  curl -fsS "$HOST/api/health"
  curl -fsS "$HOST/.well-known/meta-wearables-manifest.json"
  ```
  Confirm `"ok": true` and `"gemini": "ok"`.
- [ ] Enable a **dedicated 5 GHz phone hotspot** as primary or standby Wi-Fi so congested hackathon venue Wi-Fi cannot stall WebSocket frames.

### 1.2 Battery, Firmware & Bluetooth HFP (`T-04:00`)
- [ ] Verify battery **> 30%** (target `> 80%`; DAT glasses app install fails below `10%`) across:
  1. **Ray-Ban Meta Gen 2** (`firmware V128+`, rebooted after any OTA update)
  2. **Meta Ray-Ban Display + Meta Neural Band** (`firmware V128+` / `v125+`)
  3. **Android 12+ (`minSdk 31`) bridge phone** running **Meta AI `V292+`** with **Developer Mode ON** (`0`/`0` credentials) and account DOB set (`docs/HARDWARE_NOTES.md`)
- [ ] Confirm **Bluetooth HFP** audio routing: open `$HOST` in Chrome on the paired phone, unmute audio, and confirm synthesized earcons (`web/src/audio/earcons.ts`) and spoken voice play through the glasses open-ear speakers.
- [ ] Keep glasses unfolded on the table **un-streaming** until `T-00:30` so thermal level stays cool (`Stream` pauses if temple touch is accidentally tapped or thermal guard trips).

### 1.3 Android HoldUp Bridge & Ray-Ban Display `/hud` (`T-03:00`)
- [ ] In **HoldUp Bridge (`android-dat/`)**, scan `holdupbridge://connect?server=<HTTPS_HOST>` from the PWA `DeviceResiliencePanel` (`web/src/components/DeviceResiliencePanel.tsx`), tap **Connect glasses** (`Status: Registered`), test **Start streaming** for 3 seconds (`POST /ingest/frame` + `POST /ingest/state` -> `HTTP 204`, front hardware capture LED illuminates, PWA eye badge flips to **`Glasses DAT`**), then tap **Stop streaming** until cue `0:40`.
- [ ] On **Meta Ray-Ban Display**, open the pinned **HoldUp** Web App (`https://<host>/hud` added via `Meta AI -> Apps -> Web Apps -> Connect Web App` or `fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=...`). Confirm pure `#000000` transparent standby, zero scrollbars, **`HUD Connected`** status on the phone PWA, and **Neural Band** thumb-swipe (`ArrowLeft`/`ArrowRight`) + index-pinch (`Enter`) focus movement (`docs/HUD_SPEC.md`).

### 1.4 Physical Stage Props & Clean Profile Reset (`T-01:30`)
- [ ] Stage the **4 physical wrapped cartons** printed at `100%` actual scale from [`docs/printable-props.html`](printable-props.html) left-to-right on a matte non-glare tray (with duplicate backup wraps underneath):
  1. **Prop 1 (Evening Match + Rear Coaching + Offline Barcode):** *Amlodipin 5 mg* (`amlodipine`, `EXP 08/2027`, rear Code-128 / EAN-13 barcode `6432100012345`) placed **barcode-side facing the presenter** so initial pickup faces backwards.
  2. **Prop 2 (NSAID Contraindication Catch):** *Burana 400 mg* (`ibuprofeeni / ibuprofen`, `EXP 11/2027`, barcode `6412345000400`).
  3. **Prop 3 (Expired Medication Trap, Q&A / Bonus Beat):** *Metformin 500 mg* (`metformin hydrochloride`, **`EXP 04/2025`**, barcode `6432100054321`).
  4. **Prop 4 (Hidden Allergen Catch):** *Nordic Oat & Hazelnut Bar* (`roasted hazelnuts 12%, arachis oil`, `14.09.2027`, barcode `7310100555111`).
- [ ] In the PWA `ConsentOnboarding` drawer (`P` key), click **`Load Demo Profile (3 Meds + Nut Allergy)`** (`web/src/components/ConsentOnboarding.tsx`) so `localStorage` holds the clean demo profile (`Amlodipine 5 mg` evening + barcode `6432100012345`, `Metformin 500 mg`, avoid `NSAIDs`, `peanut`/`tree nut` allergy, and **`0` doses logged today**), then leave the Consent screen visible for the `0:20` beat.

---

## 2. Second-by-Second `3:00` Live Stage Choreography

Project the phone/laptop PWA (showing live transcript, `VerdictCard` per-field confidence bars, `HudPreviewFrame` `600x600` waveguide mirror, and `DeviceResiliencePanel`) onto the stage screen while Silas wears the Meta glasses at the prop table.

| Time Window | Stage Action & Hardware State | Exact Presenter & System Dialogue | Judge Takeaway |
|---|---|---|---|
| **`0:00 - 0:20`** *(20 s)* **1. The Hook** | Silas stands behind three nearly identical white Nordic pharmacy boxes (`Prop 1`, `Prop 2`, `Prop 3`) while holding a glass of water in one hand. | **Silas:** *"2.2 billion people worldwide live with vision impairment, including roughly 80,000 in Finland, over 80% aged 65+. Every evening, three identical white pharmacy boxes create a high-stakes question: which one is my blood-pressure pill? Phone OCR apps need three hands: two to hold and turn the bottle, and a third to blind-aim a phone. With Meta AI Glasses, the camera already points where your hands naturally hold the box."* | Clear audience, everyday frequency, and physical proof why head-mounted POV beats smartphone OCR. |
| **`0:20 - 0:40`** *(20 s)* **2. Consent & Local-Only Profile** | Screen shows `ConsentOnboarding` (`v2026-11`). Silas taps **`I Understand, Continue to HoldUp`**. Points briefly to on-device profile (`3` meds, `avoid: NSAIDs`, `nut` allergy). | **Silas:** *"HoldUp starts with explicit consent. The camera runs only during an active check and auto-stops after 45 seconds. Frames stay in an 8-frame RAM ring buffer and are never written to disk. My prescriptions, NSAID avoid rule, and nut allergy live strictly in on-device localStorage, never on a server, with a two-tap full wipe."* | `BRIEF.md` consent, GDPR data minimization, and bystander/LED trust established up front. |
| **`0:40 - 1:40`** *(60 s)* **3. Guided Capture -> Match -> Dose Log** | Momin010/Silas starts active check (`Space` or glasses voice). `camera_on` ascending earcon (`440 -> 659 Hz`) plays; glasses front capture LED turns ON; eye shows **`Glasses DAT`**. Silas picks up **Prop 1 (*Amlodipin 5 mg*) backwards** (rear barcode `6432100012345` facing lens), rotates on cue, gets `MATCH`, and logs the dose via voice or Neural Band index pinch (`Enter`). | **Silas:** *"Is this my evening pill?"*<br>**HoldUp (`gemini-3.8-live` + `/hud` `TURN PACKAGE OVER`):** *"Turn it around, the label is on the other side."*<br>*(Silas flips Prop 1 to front label; `verify_label` sends sharpest frames to `gemini-3.8-flash` -> `safety.ts`)*<br>**HoldUp (`MATCH` green check-shield card on `/hud`):** *"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."*<br>**Silas:** *"I took it, please log it."* (or pinches Neural Band on `Log Dose`)<br>**HoldUp:** *"Logged your Amlodipine dose."* (`VerdictCard` flips to `Taken today` + double-dose lock). | Streaming 2-way body-relative coaching (impossible with single-shot OCR), multimodal open-ear + `/hud` confirmation, and duplicate-dose protection. |
| **`1:40 - 2:10`** *(30 s)* **4. Three High-Stakes Safety Catches** | **Beat 4a (10 s):** Hold up **Prop 2 (*Burana 400 mg*)**.<br>**Beat 4b (10 s):** Hold up **Prop 1** again with **thumb covering `"5 mg"`**.<br>**Beat 4c (10 s):** Hold up **Prop 4 (*Nordic Oat & Hazelnut Bar*)**. | **Silas (Prop 2):** *"Can I take this for a headache?"* -> **HoldUp (`WARNING` triangle + square earcon):** *"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."* (Finnish brand `Burana` mapped to `ibuprofen` -> `nsaid`).<br>**Silas (Thumb over `5 mg`):** *"What about this box?"* -> **HoldUp (`UNSURE` diamond + `< 80%` badge):** *"It looks like Amlodipine, but I can't read the strength confidently. Turn the label toward the light or check with a pharmacist."* (**Never guesses a dose**).<br>**Silas (Prop 4):** *"Does this snack have nuts?"* -> **HoldUp (`WARNING`):** Catches `hazelnuts` and `arachis oil` (`peanut` synonym). | Proves Nordic brand/drug-class resolution, the hard `STRENGTH_MIN_CONF = 0.80` zero-guess gate, and hidden food allergen synonym detection (`arachis oil` = peanut). |
| **`2:10 - 2:35`** *(25 s)* **5. Live Fault & Hardware Resilience** | In `DeviceResiliencePanel`, toggle **`Simulate Live WS Drop`** -> **`Simulate Complete Offline`** (scan Prop 1 rear barcode `6432100012345` with `B`) -> clear toggles -> physically **take glasses off** (or click **`Simulate Glasses Taken Off`**). | **Silas:** *"Real-world assistive tech cannot fail when Wi-Fi or hardware drops. Drop the Live WebSocket: HoldUp switches immediately to HTTP Snapshot + TTS mode. Kill network completely: on-device BarcodeDetector still matches my saved Amlodipine EAN barcode offline with zero bytes sent and warns I already took it today. Take the glasses off: DAT state switches my active eye to the phone camera mid-session without losing state."* | Directly satisfies `BRIEF.md` resilience mandate live on stage (WS drop, complete offline, device state doff/low-battery hot-swap). |
| **`2:35 - 3:00`** *(25 s)* **6. Measured Proof & Pilot Close** | Display summary slide / `VerdictCard` confidence breakdown while Silas holds the glasses. | **Silas:** *"Across our calibration and coaching benchmarks, HoldUp recorded zero confident-wrong dose reads at the 0.80 gate, 100% abstention on occluded doses, and 8 out of 8 passes on coaching and bystander face refusal. At EUR 341.68 over 3 years versus EUR 4,150 for specialized OCR cameras, a 91.8% savings, we stay cleanly inside the EU MDR non-medical assistive boundary and are ready for a 12-week Helsinki pilot with Nakovammaisten liitto and pharmacy QR onboarding. Hold it up. Know it is the right one."* | Closes with verified numbers (`eval/*.json`), 91.8% TCO advantage, regulatory clarity, and concrete Finnish pilot path. |

---

## 3. Three-Tier Hardware Contingency Playbook

HoldUp's one-backend, three-thin-client architecture (`server/src/hub.ts`) guarantees the team never loses the stage narrative regardless of venue RF interference, loaner firmware state, or battery conditions. Switch tiers cleanly in under **10 seconds** without restarting the server:

### Tier A (Primary): Full Dual-Glasses Meta Wearables Stack
- **Configuration:** **Ray-Ban Meta Gen 2** streams `720x1280` first-person frames via `android-dat/` (`mwdat-core` & `mwdat-camera` `1.0.1`) to `POST /ingest/frame` + state to `POST /ingest/state`; open-ear mic and speaker run over **Bluetooth HFP**; **Meta Ray-Ban Display** renders `/hud` via `/hud-ws` (`floatingHuds` zero-code attach) with **Meta Neural Band** input (`Arrow*` / `Enter`).
- **When to run:** Default whenever `DeviceResiliencePanel` shows `Eye: Glasses DAT`, `HUD: Connected`, and RTT `< 650 ms`.

### Tier B (Fallback 1): Glasses Bluetooth HFP Audio + Phone Chest/Stand Camera + Live `/hud` Mirror
- **Trigger:** DAT camera registration is blocked (`CAPABILITY_DENIED`, post-OTA camera lock, or venue P2P drop), or only one pair of glasses is available on stage.
- **Immediate switch (< 5 s):** Tap **Stop streaming** in `android-dat/` (or leave unplugged). Keep **Ray-Ban Meta glasses paired via Bluetooth HFP** so Silas still speaks into the glasses temple mic and hears open-ear coaching hands-free. Place the phone in a chest lanyard / tabletop stand aimed at chest height (`Eye: Phone Camera` via `getUserMedia`), and show the live `600x600` Ray-Ban Display waveguide UI via `HudPreviewFrame` (`web/src/hud/HudPreviewFrame.tsx`) + `/hud` in a second browser window.
- **What stays 100% live:** Real `gemini-3.8-live` voice coaching, real `gemini-3.8-flash` multi-frame extraction, real `safety.ts` checks on the 4 physical props, real `/hud-ws` WebSocket fan-out, and real offline `BarcodeDetector`.

### Tier C (Fallback 2): Laptop `JudgeDemoTour` + 7-Fixture Prop Mode + Backup Hardware Recording
- **Trigger:** Complete venue internet blackout, browser mic/camera hardware lock on a shared podium machine, or 60-second booth walkthrough without physical props.
- **Immediate switch (< 3 s):** Expand the **`60-Second Interactive Judge Walkthrough` (`JudgeDemoTour.tsx`)** at the top of the PWA and run all 5 one-click beats (`1. Right Evening Pill`, `2. NSAID Safety Catch`, `3. Covered Dose (Zero Guess)`, `4. Hidden Nut Allergen`, `5. Wi-Fi Off Barcode Fallback`) backed by the `7` first-person fixtures in `web/public/fixtures/`, paired with the pre-recorded Sunday morning hardware POV clip (`docs/VIDEO_PRODUCTION.md`).

---

## 4. Top 10 Judge Q&A (Grounded in Code & Measured Data)

1. **"Why shouldn't this just be a smartphone app like Seeing AI or Be My Eyes?"**
   - Physical ergonomics, active streaming guidance, and privacy: rotating a curved bottle or holding a cane + water glass already uses **both hands**, leaving no third hand to blind-aim a phone. Glasses point naturally at chest height, stream ~1 fps cues (*"Turn it around"*) over private open-ear audio, project a 4-channel confirmation card on Ray-Ban Display, and never expose private prescriptions to `1,440` live video strangers per year (`docs/RESEARCH.md`).

2. **"What stops Gemini from hallucinating `5 mg` when the box actually says `50 mg` or is blurry?"**
   - A three-layer split architecture: (a) `gemini-3.8-live` (`server/src/prompts/live.md`) is strictly forbidden from reading drug names or doses from raw video and must call `verify_label`; (b) `readLabel()` (`server/src/verify.ts`) sends 1-3 sharpest frames to `gemini-3.8-flash` with `LABEL_SCHEMA` and **zero user profile attached** (preventing confirmation bias), clamping null/ambiguous fields to `confidence <= 0.30`; (c) `checkLabel()` (`server/src/safety.ts`) enforces a hard deterministic **`STRENGTH_MIN_CONF = 0.80`** gate (`0` confident-wrong doses and `100.0%` unreadable abstention across our 16-read `eval/calibration_curve.json` sweep, `ECE = 0.0138`).

3. **"Doesn't giving medication verdicts make HoldUp a regulated Class IIa medical device under EU MDR?"**
   - No. HoldUp is engineered strictly inside the **EU MDR Regulation (EU) 2017/745 Art. 2(1) and MDCG 2019-11** assistive-reader boundary (`docs/PRIVACY.md` Section 5): it optically reads manufacturer-printed packaging text and performs a deterministic literal match against the user's own self-entered or pharmacy-QR-imported list. It never diagnoses, alters dosing, or interprets clinical symptoms (`medical_interaction_boundary` scored `5/5` in `eval/coaching_eval.json`), and hands off any uncertainty to a pharmacist.

4. **"Where is sensitive health data stored, and what about bystanders in the room?"**
   - Medications, allergies, and `doseLog` live **exclusively in phone `localStorage` (`holdup.*`)**, never on server disk or loaner Display glasses (`/hud` writes zero storage), with 1-tap `wipeAllLocalData()`. Server frames live in an 8-slot RAM `FrameRing` cleared immediately on socket close (`hub.ring.clear()`), `server/src/log.ts` redacts `DENY` keys and scrubs `AIza...` secrets, DAT firmware locks the front capture LED ON while streaming, and prompts forbid describing people or faces (`bystander_face_privacy` scored `5/5`, `2574.8 ms` refusal in `eval/coaching_eval.json`).

5. **"Why did you build both an Android DAT app and a Web App instead of putting everything inside the Ray-Ban Display Web App?"**
   - Because **Ray-Ban Display Web Apps have no camera or raw microphone API** (`getUserMedia` is unavailable inside the on-glasses Chromium container), whereas camera access is exposed only through the native **Meta Wearables DAT SDK `1.0.1`** (`docs/HARDWARE_NOTES.md`). Our session hub (`server/src/hub.ts`) bridges `android-dat/` (`/ingest/*`), the phone PWA (`/live`), and the Display Web App (`/hud-ws`) with zero-code `floatingHuds` auto-binding and ordered state replay.

6. **"What happens when internet connectivity is slow or drops completely in an older adult's apartment?"**
   - Three automatic tiers (`web/src/session/sessionManager.ts`): (1) 5-second WS `ping`/`pong` RTT probing scales capture from `1.0 fps` `768 px` down to `0.5 fps` `512 px` JPEG `0.50` above `650 ms` RTT, cutting video bandwidth by **`84.0%`** (`eval/unit_economics.json`); (2) if `/live` drops, HoldUp switches to **Snapshot Mode** (`POST /api/verify` = `38.67 KB` + TTS) while reconnecting with backoff + `sessionResumption`; (3) if completely offline, local **`BarcodeDetector`** matches saved medication EAN barcodes on-device at **`0 KB`** network usage.

7. **"How does an older blind user enter their medications without making typos on a touchscreen?"**
   - Via our **zero-cloud pharmacy QR specification (`holdup://rx` in `web/src/pairing/pharmacyQr.ts`)**. At prescription pickup (*laakeneuvonta*), an offline counter utility prints a `25 mm` QR sticker containing only package metadata + schedule + EAN barcode (**zero patient name or HETU**), placed clear of carton Braille. Scanning merges locally into `localStorage` with trilingual spoken read-back in under 45 seconds (`docs/PILOT_PLAN.md` Section 3).

8. **"Does it handle Finnish generic substitution and multilingual Nordic labels?"**
   - Yes. `server/src/safety.ts` normalizes comma decimals (`2,5 mg` -> `2.5 mg`), microgram/IU/KY units, **49 Nordic/INN drug aliases** (`Norvasc` = `Amlodipin` = `amlodipiini`; `Burana` = `Ibumax` = `ibuprofeeni` -> `nsaid`; `Marevan` -> `warfarin` -> `anticoagulant`), and **all EU-14 food allergens** across English, Finnish, and Swedish (`arachis oil` / `maapahkina` / `jordnot` -> `peanut`; `hasselpahkina` / `hasselnotter` -> `tree nut`), backed by `49` dedicated safety unit tests and live Finnish voice switching (`finnish_switch` = `5/5` in `eval/coaching_eval.json`).

9. **"Is continuous multimodal Gemini inference affordable for public assistive-device reimbursement?"**
   - Highly affordable (`eval/unit_economics.json`): a 12-second guided check + 2-frame Flash verify uses `7,488` tokens (`$0.00319` / **`EUR 0.00294`** at standard cached Flash rates), or **`EUR 0.35/month` (`EUR 4.23/year`)** at 4 checks/day (with an uncached native-audio ceiling of `EUR 10.79/year`). Combined with EUR 329 Ray-Ban Meta Gen 2 hardware, **3-year TCO is `EUR 341.68` versus `EUR 4,150.00` for OrCam-class cameras (`91.8%` savings, `12.1x` cost reduction)**, letting HUS *Apuvalinekeskus* equip `1,214` residents on the budget of `100` legacy devices.

10. **"What would a real pilot look like starting Monday morning?"**
    - [`docs/PILOT_PLAN.md`](PILOT_PLAN.md) specifies a ready-to-sign **12-week Helsinki pilot (`N = 24`: `12` blind VoiceOver/TalkBack users + `12` older adults 65+ with `>= 3` daily meds)** hosted at **Nakovammaisten liitto's Iiris Center (Itakeskus)** alongside a Helsinki pharmacy counter (**Yliopiston Apteekki**), enforcing parallel "shadow check" safety in Weeks 4-7, a Pilot Safety Review Board with a 24-hour pause rule on any confident-wrong read, and a Week 12 HUS / Kela reimbursement dossier.
