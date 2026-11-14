# HoldUp 12-Week Finland Pilot Blueprint (Helsinki)

**Status:** Proposed Post-Hackathon Pilot Blueprint (Ready for Partner Sign-Off)  
**Location:** Helsinki Metropolitan Area (Itäkeskus Iiris Center & Central Helsinki Pharmacy Counter)  
**Duration:** 12 Weeks (`N = 24` participants across two stratified cohorts)  
**Regulatory Classification:** Non-interventional assistive technology usability and safety evaluation (non-medical-device label reader and personal-checklist lookup tool under EU MDR Regulation (EU) 2017/745 Art. 2(1) and MDCG 2019-11; see `docs/PRIVACY.md` §5)

---

## 1. Executive Summary & Pilot Purpose

Finland has approximately 80,000 people with visual impairment, the majority aged 65 and older, alongside hundreds of thousands of older adults managing polypharmacy with declining near vision. Existing smartphone OCR tools require aiming a camera blind while holding a package with the other hand and read raw text without knowing whether a box matches the user's own medication schedule or allergies.

This document specifies an actionable, safety-first **12-week Helsinki pilot** designed so leadership from **Meta**, **Näkövammaisten liitto** (Finnish Federation of the Visually Impaired), and a **Helsinki pharmacy partner** (target: **Yliopiston Apteekki**) can review scope, governance, privacy architecture, and resource commitments on Monday morning and initiate Week 1 immediately.

Note on scope: this document defines a **proposed observational usability and safety evaluation protocol**. HoldUp makes zero claims of completed clinical trials or medical-device certification. All clinical judgment remains with licensed pharmacists and prescribing clinicians, and Weeks 4-7 enforce parallel verification alongside each participant's existing medication safety routine before any independent reliance is evaluated.

---

## 2. Cohort Design & Partner Roles

### 2.1 Proposed Partner Consortium

| Partner Seat | Target Organization & Site | Pilot Role & Concrete Contribution | Why Zero-Blocker on Day 1 |
|---|---|---|---|
| **Accessibility Co-Design & Host Partner** | **Näkövammaisten liitto ry** (Finnish Federation of the Visually Impaired), **Iiris Center**, Marjaniementie 74, Itäkeskus, 00930 Helsinki | Co-designs tactile and screen-reader onboarding with ICT assistive-tech specialists (*digi- ja apuvälineneuvonta*); circulates bilingual (Finnish/Swedish) recruitment call; hosts Weeks 2, 4, and 11 lab sessions at Iiris Center. | Aligns directly with federation digital-accessibility advisory work; zero sensitive member registries shared with HoldUp. |
| **Pharmacy Counter & Hotline Partner** | **Helsinki University / Community Pharmacy Counter** (primary target: **Yliopiston Apteekki** Itäkeskus branch adjacent to Iiris Center + Mannerheimintie flagship + YA pharmacist counseling line; backup: participating Suomen Apteekkariliitto Helsinki pharmacy) | Generates and affixes the zero-cloud `holdup://rx` QR onboarding sticker alongside the standard Finnish dosage label (*annostusohjetarra*) during prescription pickup (*lääkeneuvonta*); serves as the licensed pharmacist voice fallback hotline when HoldUp returns `"unsure"` or `"warning"`. | Requires **zero** Kanta *Reseptikeskus* write/API integration or pharmacy ERP modification; uses a standalone local QR sticker utility at one designated counter. |
| **Wearable Platform Partner** | **Meta Wearables / Reality Labs** (DAT Android & Ray-Ban Display Web Apps team) | Supplies or authorizes pilot hardware pool (`12x` Ray-Ban Meta Gen 2 + `12x` Ray-Ban Display with Neural Band) and whitelists pilot accounts for DAT SDK `1.0.1` camera streaming and Display Web Apps in Finland. | Reuses HoldUp's existing `android-dat` (`mwdat-*:1.0.1`) bridge and `/hud` Display Web App (`docs/HARDWARE_NOTES.md`). |
| **Technical & Safety Lead** | **HoldUp Engineering & Pilot Safety Team** | Operates the zero-retention ephemeral relay (`server/src/`) on a paid-tier Google Cloud / Gemini API project (EU region), maintains trilingual UI (`fi`, `sv`, `en` in `web/src/i18n/translations.ts`), runs weekly safety audits, and compiles the Week 12 Kela / municipal reimbursement dossier. | Deterministic safety gates (`STRENGTH_MIN_CONF = 0.80`) and redacting telemetry (`server/src/log.ts`) are already implemented and unit-tested. |

### 2.2 Stratified Participant Cohort (`N = 24`)

Participants are recruited through Näkövammaisten liitto member channels and Helsinki senior vision-rehabilitation referrals into two balanced sub-cohorts (`N = 24` total):

1. **Cohort A: Blind Screen-Reader Users (`n = 12`)**
   - **Profile:** Adults (18+) with severe visual impairment or blindness (WHO categories 3-5) who use iOS VoiceOver or Android TalkBack daily and live independently in the Helsinki metropolitan area (Helsinki, Espoo, Vantaa).
   - **Primary Everyday Tasks:** Distinguishing lookalike household medication cartons (OTC and prescription), verifying package expiry dates, and checking EU-14 food allergen declarations (*maapähkinä*, *pähkinät*, *maito*, *gluteeni/vehnä*, *kananmuna*, *soija*, *seesami*) at home.
   - **Hardware Assignment:** **Ray-Ban Meta Gen 2** paired via Bluetooth HFP (open-ear private audio + mic) and `android-dat` (`720x1280` @ `2 fps`, throttled to `<= 1 fps`), with smartphone camera chest/lanyard fallback tested for resilience.

2. **Cohort B: Older Adults 65+ with Low Vision & Polypharmacy (`n = 12`)**
   - **Profile:** Adults aged 65 and older with age-related low vision (e.g., age-related macular degeneration, diabetic retinopathy, or glaucoma) who manage **>= 3 daily prescription medications** at home and read Finnish or Swedish.
   - **Primary Everyday Tasks:** Confirming morning vs. evening prescription boxes (e.g., *Amlodipin 5 mg* vs. *10 mg*, *Metformin 500 mg*, *Bisoprolol*, *Cardace*, *Thyroxin*), avoiding contraindicated OTC painkillers (e.g., NSAID *tulehduskipulääkkeet* such as *Burana* or *Voltaren*), and tracking `"taken today"` status via on-device `doseLog`.
   - **Hardware Assignment:** **Ray-Ban Display + Neural Band** running the `/hud` high-contrast `600x600` additive waveguide card (`docs/HUD_SPEC.md`, redundant shape/icon/border coding for `MATCH`, `WARNING`, and `UNSURE`) synchronized with spoken Finnish, Swedish, or English verdicts.

### 2.3 Inclusion & Safety-First Exclusion Criteria

- **Inclusion Criteria:**
  - Resident of the Helsinki metropolitan area able to attend 3 in-person sessions at Iiris Center (Itäkeskus, accessible step-free transit hub with tactile paving).
  - Independent capacity to provide informed consent via WCAG 2.2 AA screen-reader HTML, 18pt+ high-contrast print, or recorded verbal consent witnessed by an assistive-tech specialist.
  - Established baseline verification method in place at home (weekly *dosetti* pill organizer, automated pharmacy unit-dose *annosjakelu* check, or daily spouse/caregiver check) so Weeks 4-7 run safely in parallel without altering primary medication intake decisions.
- **Exclusion Criteria (Safety Boundaries):**
  - Unassisted variable daily tablet-splitting regimens whose dose changes day-to-day outside printed box labels (e.g., unstable daily *Marevan* / warfarin titration without a caregiver or written dosing calendar).
  - Moderate-to-severe cognitive impairment that could cause a participant to mistake an `"unsure"` refusal cue for a `"match"` confirmation.
  - Active acute medical instability requiring inpatient or hospital-at-home medication administration.

---

## 3. Zero-Cloud Pharmacy Counter Workflow (`holdup://rx`)

A persistent failure mode for blind and low-vision patients is **initial profile entry**: typing drug names, milligram strengths, and 13-digit barcodes on a touchscreen introduces transcription risk. Conversely, integrating directly into Finland's national **Kanta *Reseptikeskus*** requires multi-year certification under THL/Kela specifications and centralizes sensitive health records.

HoldUp solves onboarding at the pharmacy pickup counter with **zero cloud storage and zero Kanta integration**:

### 3.1 `holdup://rx` URI Specification

When a dispensing pharmacist (*farmaseutti* or *proviisori*) prints the standard Finnish patient instruction sticker (*annostusohjetarra*) at pickup, a standalone local browser utility (running offline on the counter workstation) encodes only the non-identifying package fields into a high-contrast `25 mm x 25 mm` QR sticker affixed to the non-text flap of the carton (or handed over on a tactile-notched onboarding card):

```text
holdup://rx?v=1&name=Amlodipin&ing=amlodipine&str=5%20mg&sched=evening&ean=6432100012345&avoid=NSAIDs
```

| Parameter | Maps to `shared/types.ts` | Example Value | Privacy & Safety Property |
|---|---|---|---|
| `v` | Schema version | `1` | Deterministic parser version lock; unknown versions rejected safely. |
| `name` | `Med.name` | `Amlodipin` | Printed commercial package name on the Finnish carton. |
| `ing` | `Med.ingredient` | `amlodipine` | Normalized INN active substance used by `ingredientsOf()` in `server/src/safety.ts`. |
| `str` | `Med.strength` | `5 mg` | Exact prescribed unit strength checked by `sameStrength()` (`STRENGTH_MIN_CONF = 0.80`). |
| `sched` | `Med.schedule` | `evening` or `08:00,20:00` | Comma-separated daily slots for schedule phrasing and `dosesToday()` duplicate checks. |
| `ean` | `Med.barcode` | `6432100012345` | 13-digit EAN-13 / Nordic Vnr barcode enabling **100% offline** verification via `BarcodeDetector` (`web/src/camera/barcode.ts`). |
| `avoid` | `Profile.avoid` (optional) | `NSAIDs` | Pharmacist-flagged drug class to avoid (e.g., *tulehduskipulääkkeet* on antihypertensives/anticoagulants). |

### 3.2 Privacy Invariants of `holdup://rx`

1. **Zero Personal Identifiers:** The QR payload never contains the patient's name, Finnish personal identity code (*henkilötunnus* / HETU), address, prescriber name, or Kanta prescription ID. If a carton is recycled, the QR reveals no more personal identity than the commercial box itself (participants are still instructed to peel or black out pharmacy stickers on disposal, matching standard Finnish pharmacy guidance).
2. **100% Local Import with Spoken Read-Back:** Scanning `holdup://rx` in HoldUp parses the URI locally on the phone, speaks the full entry aloud in Finnish, Swedish, or English (*"Lisätäänkö profiiliin: Amlodipin 5 mg, iltalääke, vältä tulehduskipulääkkeitä?"*), requires an explicit confirmation tap/pinch, and writes strictly to `localStorage` (`holdup.profile` in `web/src/storage/profileStore.ts`). Zero onboarding payloads are stored on any server.
3. **Under-45-Second Counter Workflow:** At pickup counseling (*lääkeneuvonta*), the pharmacist scans the carton's commercial EAN barcode into the standalone QR generator, selects schedule slot(s) (`morning` / `evening` / `as needed`) and any `avoid` class tag, prints the QR sticker, and lets the participant test one live glasses scan at the counter before leaving.

---

## 4. Week-by-Week 12-Week Execution Plan

### Phase 1 (Weeks 1-3): Ethics, GDPR DPIA & Tactile/Voice Co-Design

| Week | Lead Owner | Core Activities | Concrete Deliverables & Exit Criteria |
|---|---|---|---|
| **Week 1** | HoldUp Safety Lead + Partner Leads | Execute tripartite pilot MOU (HoldUp, Näkövammaisten liitto, pharmacy partner). Complete TENK non-invasive human-sciences ethical review check and **GDPR Art. 35 DPIA** (`docs/PRIVACY.md`): verify zero disk persistence (`FrameRing(8)` RAM clear on `ws.close`), `DENY` log redaction (`server/src/log.ts`), one-tap `wipeAllLocalData()`, and paid-tier Google Cloud / Gemini API billing lock (zero model training on prompts/frames). Provision `12x` Ray-Ban Meta Gen 2 + `12x` Ray-Ban Display (`V128+` firmware) + Android 12+ bridge devices (`Meta AI V292+`). | Signed MOU; signed GDPR DPIA; paid-tier API billing verification log; 24 hardware kits flashed, rebooted post-V128 OTA, and verified with `HoldUp Bridge`. |
| **Week 2** | Näkövammaisten liitto Assistive-Tech Specialists + HoldUp UX | Run a 2-day **Tactile & Voice Onboarding Co-Design Workshop** at **Iiris Center (Itäkeskus)** with 3 assistive-tech specialists and 4 paid user advisors (2 blind VoiceOver/TalkBack users, 2 older adults 65+ with low vision). Co-test temple button vs. Neural Band gestures (`ArrowUp/Down`, `Enter`), Finnish/Swedish TTS pacing and earcon clarity (`camera_on`, `camera_off`, `checking`), `/hud` waveguide contrast under indoor glare, and tactile corner-notch placement for `holdup://rx` QR stickers. | Updated `fi`/`sv`/`en` voice phrasing sheet; physical tactile QR sticker placement guide; WCAG 2.2 AA VoiceOver + TalkBack sign-off checklist (`0` focus-trap or unlabeled-control defects). |
| **Week 3** | Recruitment Coordinator + Pilot Pharmacist | Enroll `N = 24` participants (`12` Cohort A, `12` Cohort B) at Iiris Center. Record accessible informed consent (`ConsentRecord` versioned on-device). Conduct baseline timed benchmark using each participant's current method (smartphone OCR, handheld optical magnifier, or asking caregiver) on 6 standardized Finnish food and medicine packages, plus baseline **SUS** and **PIADS-10** questionnaires. **Stage Gate 1 Review.** | `24/24` consented participants; baseline task completion & timing dataset; **Gate 1 passed:** `0%` confident-wrong reads on bench test suite of 50 Finnish medicine/grocery packages. |

### Phase 2 (Weeks 4-7): Safety-First Staged Rollout (Supervised Lab to Parallel Home Kitchen Trial)

**Mandatory Phase 2 Safety Rule ("Shadow Check Only"):** Throughout Weeks 4-7, participants **must continue using their existing primary verification method** (weekly pre-filled *dosetti* pill organizer, automated *annosjakelu* pouch, or caregiver visual confirmation) before taking any medication. HoldUp is used right before that step as a parallel shadow check, and discrepancies are logged immediately without changing dose intake.

| Week | Lead Owner | Core Activities | Concrete Deliverables & Exit Criteria |
|---|---|---|---|
| **Week 4** | HoldUp UX + Iiris Center Rehabilitation Staff | **Supervised Lab Trial at Iiris Center (`N = 24`, 60-min 1:1 sessions).** Test hands-free coaching (`rotate_left`, `rotate_right`, `closer`, `more_light`, `other_side`) across 500 lux kitchen lighting and 80 lux Nordic winter morning lighting. Include adversarial safety drills: lookalike white generic boxes (*Amlodipin 5 mg* vs. *10 mg*), thumb-occluded strength digits, expired *Metformin*, NSAID avoid-list carton (*Burana 400 mg*), and EU-14 nut/dairy/gluten food packages. Verify hardware capture LED visibility and bystander face-ignore rules. | `24` supervised session logs (~`240` structured checks); verified `100%` `"unsure"` refusal on occluded strengths; individualized audio/HUD preference set per participant. |
| **Week 5** | HoldUp Field Support | **Home Kitchen Trial - Stage 2A (Food Allergens, Expiry & Non-Critical Household Packages).** Participants take glasses home for 7 days of daily grocery and pantry checks in real kitchen lighting and home Wi-Fi/4G conditions. Validate automatic `Snapshot` mode fallback (`POST /api/verify`) during weak connectivity, `45 s` idle camera shutoff (`IDLE_STOP_MS = 45000`), and glasses-doffed transition (`DeviceState.worn === false` -> phone camera fallback). | Week 5 anonymized ops telemetry (`server/logs/ledger.jsonl`: latency, fallback counts, zero PII) + structured weekly participant phone check-in. |
| **Week 6** | HoldUp Field Support + Pilot Proviisori | **Home Kitchen Trial - Stage 2B (Parallel Prescription Box Shadow Checks).** Cohort A and Cohort B perform daily hands-free checks on their real prescription boxes **alongside** their existing *dosetti* / caregiver verification. Test on-device `"I took it"` logging (`doseLog` duplicate-dose warning on a second test check the same evening) and optional user-initiated sharing of `exportCaregiverSummary()` plain-text summaries with family caregivers. | Parallel concordance log comparing HoldUp spoken verdicts against participant/caregiver ground truth across `>= 3` daily meds in Cohort B. |
| **Week 7** | Pilot Safety Review Board (PSRB) | **Mid-Pilot Safety Audit & Offline Resilience Drill.** Test zero-network `TransportMode = "offline"` (`BarcodeDetector` matching saved EAN-13 codes on-device with Wi-Fi and mobile data off). Triage UX friction (e.g., coaching verbosity, glossy blister-pack glare). Convene PSRB (Lead Proviisori, Näkövammaisten liitto specialist, HoldUp Safety Lead) for **Stage Gate 2 Review**. | **Gate 2 passed:** `0%` confident-wrong strength/allergen reads across Weeks 4-6 (`STRENGTH_MIN_CONF = 0.80`), `0` server-disk privacy leaks, `>= 85%` cohort retention, PSRB sign-off to begin pharmacy counter onboarding. |

### Phase 3 (Weeks 8-12): Pharmacy `holdup://rx` Counter Onboarding, Pharmacist Hotline & KPI Evaluation

| Week | Lead Owner | Core Activities | Concrete Deliverables & Exit Criteria |
|---|---|---|---|
| **Week 8** | Pharmacy Partner Lead (*Proviisori*) + HoldUp Eng | **Pharmacy Counter Deployment & Staff Training.** Deploy standalone offline `holdup://rx` QR sticker generator at the designated Helsinki pharmacy counter (e.g., Yliopiston Apteekki Itäkeskus / central counter). Train `6` dispensing pharmacists in a 45-minute practical session covering QR generation, tactile sticker placement (avoiding occlusion of Braille embossing on outer pharmaceutical cartons!), and 30-second customer scan confirmation. | `6` trained pharmacists; counter QR printer/utility validated against EU/Finnish carton Braille non-occlusion rule; dry-run counter time `< 45 s`. |
| **Week 9** | Pharmacy Partner + HoldUp Eng | **Live `holdup://rx` Pickup Cycle & Pharmacist Fallback Hotline Integration.** Each participant (`N = 24`) completes a prescription pickup (scheduled refill or standardized demonstration pickup) at the partner counter using `holdup://rx` onboarding. Activate the **1-Tap Pharmacist Fallback Hotline**: whenever HoldUp returns `level: "unsure"` twice in a row or emits `level: "warning"`, the PWA presents an accessible voice/tap shortcut (`tel:` dialer) to the partner pharmacy's licensed counseling desk, speaking the locally stored package/EAN summary so the caller can state it clearly without streaming video to third parties. | `24` counter onboarding completions; live end-to-end test of `"unsure"` -> pharmacist phone handoff for every participant; pharmacist feedback log. |
| **Week 10** | HoldUp Field Support + Pharmacy Desk | **Full-Loop Independent Observation Week.** Participants run the complete end-to-end loop at home: `holdup://rx`-onboarded medications, daily Live/HUD checks, offline barcode fallback checks, `doseLog` tracking, caregiver text export, and pharmacist counseling line access whenever a label is damaged or uncertain. | Complete 7-day end-to-end usage, latency (`GET /api/stats`), and hotline utilization log. |
| **Week 11** | Näkövammaisten liitto + HoldUp UX | **Endline Evaluation at Iiris Center (`N = 24`).** Repeat the standardized 6-package timed benchmark (comparing Week 11 hands-free glasses performance vs. Week 3 baseline method), administer endline **SUS** and **PIADS-10**, conduct semi-structured exit interviews with participants and dispensing pharmacists, and demonstrate/execute 1-tap `wipeAllLocalData()` for any participant not continuing into an extended loan. | Paired pre/post usability, speed, and assistive-independence dataset (`N = 24`); pharmacist counter time-motion dataset; verified local data wipe receipts. |
| **Week 12** | Consortium Leads (Meta, Näkövammaisten liitto, Pharmacy, HoldUp) | **KPI Audit, Kela / Municipal *Apuvälinepalvelut* Reimbursement Dossier & Monday Scale Decision.** Audit all safety and usability KPIs against pre-registered thresholds. Deliver final bilingual evidence report and public assistive-device procurement dossier to HUS / City of Helsinki *Apuvälinekeskus* and Kela rehabilitation stakeholders. | Published Pilot Outcomes Report; Finnish *Apuvälinepalvelut* & Kela reimbursement dossier; Phase-2 multi-city expansion proposal. |

---

## 5. Safety Governance, Escalation Protocol & Target KPIs

### 5.1 Multi-Layer Deterministic Safety Architecture

HoldUp never relies on an LLM prompt alone to protect medication or allergen decisions:

1. **Live Model Prohibition (`server/src/prompts/live.md`):** Gemini Live (`gemini-3.8-live`) handles conversational turn-taking and spatial aiming cues (`rotate_left`, `closer`, `more_light`, `other_side`) only. It is forbidden from stating product names, strengths, doses, expiries, or allergens from its own video stream and must call `verify_label` and speak the returned `speech` string verbatim.
2. **Schema-Locked Multi-Frame Extraction (`server/src/verify.ts`):** `hub.ring.pick(2, 5000)` selects the sharpest recent frames and extracts structured fields (`shared/label_schema.json`) via `gemini-3.8-flash`. Ambiguous digits (`5` vs `6` vs `8`, `2,5` vs `25`) must be emitted as `value: null` with `confidence <= 0.30`.
3. **Deterministic TypeScript Gate (`STRENGTH_MIN_CONF = 0.80` in `server/src/safety.ts`):**
   - `STRENGTH_MIN_CONF = 0.8` (`0.80`): Even when active ingredient matching succeeds (`NAME_MIN_CONF = 0.60`), any missing strength or `read.strength.confidence < 0.80` deterministically forces `Verdict.level = "unsure"` (*"It looks like \<name\>, but I can't read the strength confidently..."*), never `"match"`.
   - `ALLERGEN_MIN_CONF = 0.6` (`0.60`): Food packages with unreadable ingredient/allergen panels deterministically return `level: "unsure"`, never `"info"` / safe.
   - Finnish and Nordic brand/class resolution (`BRANDS`, `CLASSES`, `ALLERGENS` in `server/src/safety.ts`) deterministically catches brand-vs-generic overlaps (*Burana* / *Ibumax* -> `ibuprofen` -> `nsaid`) and EU-14 allergen synonyms in Finnish, Swedish, and English without network calls.
4. **Mandatory Pharmacist Handoff & Braille Preservation:** Two consecutive `"unsure"` verdicts or any `"warning"` verdict explicitly instruct the participant not to take the item and offer the Week 9 pharmacist counseling hotline shortcut. At the pharmacy counter, pharmacists are trained never to place the `holdup://rx` QR sticker over mandatory pharmaceutical Braille embossing (EU Directive 2001/83/EC Art. 56a / Fimea labeling regulations).

### 5.2 Pilot Safety Review Board (PSRB) & 24-Hour Pause Trigger

- **Composition:** 1 Lead *Proviisori* (pharmacy partner), 1 Assistive Technology Specialist (Näkövammaisten liitto), and 1 HoldUp Safety Engineer.
- **Stop-Pilot Trigger:** Any single **confident-wrong** strength, active-ingredient, expiry, or allergen verdict (`level: "match"` or safe `"info"` spoken when the physical package differs from the participant's saved strength or contains a listed allergen/avoid-class) triggers an **immediate 24-hour pilot pause** across home checks, deterministic regression reproduction in `server/test/safety.test.ts`, threshold/normalization hardening, and written PSRB clearance before resuming.

### 5.3 Pre-Registered Pilot KPIs & Acceptance Thresholds

All target figures below represent **pilot evaluation thresholds** to be measured prospectively during Weeks 1-12 (not pre-existing clinical claims):

| KPI Category | Metric Definition | Measurement Instrument | Pilot Target Threshold |
|---|---|---|---|
| **Primary Safety KPI** | **Confident-wrong strength or allergen read rate** (proportion of checks emitting `match` on wrong drug/strength/expired box, or clearing food containing a profile allergen) | Ground-truth audit across Week 4 lab adversarial checks (`n >= 240`) + Weeks 6-10 parallel shadow logs (enforced by `STRENGTH_MIN_CONF = 0.80`) | **0% (`0` events)** |
| **Safe Refusal Fidelity** | Proportion of occluded, blurred, or unlit strength/allergen panels routed to `level: "unsure"` with re-aim coaching or pharmacist referral | Week 4 controlled occlusion/glare benchmark | **100%** |
| **Usability: Speed** | **Time-to-confident-read** (elapsed seconds from explicit check start `{ type: "start" }` to spoken final `{ type: "verdict" }`, including Live coaching) | Server `ledger.jsonl` turn/tool timing (`GET /api/stats`) + Week 11 timed benchmark | **Median `< 10 s`** (p90 `< 18 s`) |
| **Usability: Hands-Free** | **Hands-free completion rate** (checks initiated and completed on glasses/Neural Band + voice without touching the smartphone screen) | Session interaction logs (`source: "glasses"`) in Weeks 4 and 11 benchmarks | **`> 90%`** |
| **Offline Resilience** | Successful local EAN-13 recognition & schedule check in zero-network mode (`TransportMode = "offline"`) for `holdup://rx` meds | Week 7 airplane-mode drill (`N = 24`) | **`>= 98%` in `< 3 s`** |
| **Accessibility & Independence** | **System Usability Scale (SUS)** and **PIADS-10** assistive independence delta vs. Week 3 baseline method | Validated Finnish/Swedish/English SUS (0-100) and PIADS-10 (-3 to +3) questionnaires in Week 11 | **Mean SUS `>= 75`**; **PIADS-10 mean `>= +1.2`** |
| **Pharmacy Workflow Fit** | Incremental counter time to generate, affix (Braille-clear), and test-scan `holdup://rx` QR sticker at pickup | Time-motion stopwatch log across `24` Week 9 counter pickups | **Median `< 45 s`** |
| **Privacy & Zero Retention** | Bytes of participant JPEG frames, PCM16 audio, transcripts, or `Profile` persisted to server disk | Weekly automated filesystem + `log.ts` redaction audit (`docs/PRIVACY.md`) | **`0 bytes` (`100%` ephemeral)** |

---

## 6. Finnish Reimbursement & Adoption Pathway (*Apuvälinepalvelut*, Kela & Pharmacy Scale)

A successful 12-week Helsinki pilot unlocks three concrete, non-overlapping adoption channels in Finland without requiring medical-device reclassification:

### 6.1 Public Medical Rehabilitation Assistive Device Services (*Lääkinnällisen kuntoutuksen apuvälinepalvelut*)
Under Finland's Health Care Act (*Terveydenhuoltolaki* 1326/2010 §29) and the national assistive-device handover criteria (*Valtakunnalliset lääkinnällisen kuntoutuksen apuvälineiden luovutusperusteet*, STM), **City of Helsinki**, **HUS *Apuvälinekeskus*** (vision rehabilitation / *näönkuntoutus*), and Finland's 21 wellbeing services counties (*hyvinvointialueet*) loan daily-living electronic reading aids free of charge to eligible blind and low-vision residents when functional benefit is documented.
- **Economic Rationale for Public Procurers:** Dedicated proprietary wearable or desktop optical/OCR reading aids (*lukutelevisio* / specialized clip-on readers) routinely cost public assistive-device budgets **EUR 2,500 to EUR 4,500 per unit**. Mainstream Ray-Ban Meta Gen 2 / Display hardware paired with a paid-tier HoldUp software license lowers per-user capital outlay by **60-75%** while adding active aiming guidance, bilingual Finnish/Swedish support, and zero-stigma everyday industrial design.
- **Week 12 Deliverable:** A standardized **Assistive Device Evaluation Dossier** mapped to HUS *Apuvälinekeskus* procurement criteria: functional independence delta (Week 3 vs. Week 11 timed benchmark + PIADS-10), SUS score, EU MDR Art. 2(1) non-medical-device boundary memo, signed GDPR Art. 35 DPIA, and 3-year total cost of ownership comparison.

### 6.2 Kela Assistive Technology for Work and Study (*Ammatillisen kuntoutuksen apuvälineet*)
Under the Act on Kela Rehabilitation Benefits (*Laki Kansaneläkelaitoksen kuntoutusetuuksista* 566/2005), **Kela** funds ICT and electronic reading assistive devices required by blind and low-vision students and working-age adults (Cohort A demographic) to perform studies or employment independently. Cohort A outcomes from Iiris Center directly support individual Kela assistive-device applications advised by Näkövammaisten liitto rehabilitation counselors.

### 6.3 Pharmacy Chain Accessibility Standard (`holdup://rx` Rollout)
For older adults with age-related vision loss who do not yet meet severe visual-impairment thresholds (a large share of Cohort B), consumer smart glasses purchased by families pair seamlessly with free pharmacy counter onboarding. Because `holdup://rx` is an open, zero-cloud URI specification requiring zero Kanta or pharmacy ERP changes, **Yliopiston Apteekki** (17 pharmacies nationwide + national online pharmacy and counseling center) or **Suomen Apteekkariliitto** member pharmacies can roll out counter QR stickers nationwide as a medication-safety (*lääkitysturvallisuus*) accessibility commitment in alignment with Fimea's safe pharmacotherapy program.

---

## 7. Pilot Resource Summary & Monday-Morning Sign-Off Checklist

### 7.1 Direct 12-Week Pilot Budget Estimate (`N = 24`, Helsinki)

| Line Item | Scope & Sizing Basis | Estimated 12-Week Cost (EUR) | Proposed Coverage |
|---|---|---|---|
| **Wearable Hardware Pool** | `12x` Ray-Ban Meta Gen 2 + `12x` Ray-Ban Display + `4x` hot-swap spares (reusable loaner pool) | In-kind hardware loan (or ~EUR 14,000 hardware pool if purchased) | Meta Wearables loan / pilot hardware grant |
| **Paid-Tier Gemini API & EU Cloud Relay** | Bounded `<= 1 fps` coaching + `1-3` frame `gemini-3.8-flash` verify (`~25` checks/week x `24` users x `12` weeks = `~7,200` checks, zero-training paid billing tier) + Cloud Run `europe-north1` (Hamina, Finland) ephemeral Node relay | **EUR 350 - 600** | HoldUp team / Google Cloud credits |
| **Workshop & Accessibility Co-Design** | Iiris Center room booking, 4 lead user advisor honoraria, tactile QR/print materials, participant HSL transit compensation (`3` visits x `24` participants) | **EUR 3,200 - 4,500** | Pilot accessibility grant / HoldUp |
| **Pharmacy Counter Kit** | Thermal QR sticker roll stock + 45-min training backfill for `6` dispensing pharmacists at 1 Helsinki counter | **EUR 800 - 1,200** | Pharmacy partner CSR / medication-safety innovation budget |

*Note: Cloud Run `europe-north1` (Hamina, Finland) deployment keeps the stateless HoldUp WebSocket relay physically inside Finland for ultra-low RTT while enforcing the zero-disk-storage architecture documented in `docs/PRIVACY.md`.*

### 7.2 Monday-Morning Partner Sign-Off Checklist

- [ ] **Meta Wearables / Reality Labs Representative:** Confirm loan/allocation of `12x` Ray-Ban Meta Gen 2 and `12x` Ray-Ban Display units (`firmware V128+`) and Finland Developer/Pilot whitelisting for DAT SDK `1.0.1` (`android-dat`) and Display Web App (`/hud`) for 12 weeks.
- [ ] **Näkövammaisten liitto (Iiris Center, Itäkeskus) Representative:** Confirm assistive-tech specialist co-lead for Week 2 workshop, Iiris Center accessible room dates for Weeks 2, 4, and 11, and member recruitment notice for `N = 24` (`12` VoiceOver/TalkBack users, `12` older adults 65+ with `>= 3` daily prescriptions).
- [ ] **Yliopiston Apteekki / Helsinki Pharmacy Partner Representative:** Designate 1 Helsinki prescription counter (target: Itäkeskus or Mannerheimintie), appoint 1 Lead *Proviisori* to the Pilot Safety Review Board, approve the offline `holdup://rx` QR sticker utility (with Braille non-occlusion rule), and confirm pharmacist counseling line phone number for `"unsure"` / `"warning"` voice fallback in Weeks 9-12.
- [ ] **HoldUp Technical & Safety Lead:** Lock paid-tier Gemini API billing (zero model-training data use) on `europe-north1` (Finland) relay, archive signed GDPR Art. 35 DPIA, and freeze `STRENGTH_MIN_CONF = 0.80` deterministic gate under CI regression enforcement (`npm -w server test`).
