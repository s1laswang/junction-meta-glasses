# HoldUp SIMULATED user studies (`n = 40` SIMULATED personas, WS3)

> **CRITICAL HONESTY DISCLOSURE (`SIMULATED`, NOT REAL USERS):** HoldUp has **zero (`n = 0`) real blind or low-vision human user sessions** in this repository. Every persona (`P01-P40`), task run, confusion point, trust score, and first-person reflection in this document is **100% SIMULATED**. Personas and usability evaluations were designed and scored in-session; automated UI journeys ran in headless Chromium via Playwright (`@axe-core/playwright`, `?mock=1` and `/hud/?mock=1`) and text/frame sessions ran against the real HoldUp server (`gemini-3.8-flash` label reader with `shared/verify_prompt.md`, `shared/label_schema.json`, `server/src/safety.ts`, and `server/src/find.ts`, with `0` direct `gemini-4-carbon` API calls). Never cite these numbers as real human user validation.

## 1. Executive summary (`SIMULATED`, `n = 40` personas, `n = 80` task sessions)

To pressure-test usability across HoldUp's target demographics (Finland's ~55,000 visually impaired people, ~45,000 aged 65+, plus Swedish-speaking Finns, TalkBack/VoiceOver/Braille users, motor/tremor users, and caregivers/pharmacists) without misrepresenting synthetic tests as human trials, we executed `n = 40` scripted **SIMULATED** personas across two tracks:

1. **Track A: Playwright Mock App E2E (`?mock=1` & `/hud/?mock=1`):** Real headless Chromium browser sessions exercising 3-card privacy onboarding, camera/microphone permission recovery, `Check` (`Live`, `Snapshot`, `Offline` barcode/DataMatrix, `Which one?` 3-box scene mode, `Hold up to add` `AddSheet` confirmation, `Escape` dismissal, 45 s auto-stop, glasses wear-detection & low-battery fallback), `Profile` (`MedEditor`, `TagList`, language selector, `Dose log`), `Privacy` (`voice`/`quiet` toggles, consent withdrawal), and `/hud/` (`600x600` Ray-Ban Display spatial navigation), audited live with `@axe-core/playwright` (`WCAG 2.0/2.1/2.2 A+AA`).
2. **Track B: Real HoldUp Server Sessions (`/api/verify` & `findItems`):** Real HTTP/WebSocket label verification sessions on an ephemeral port against the shipped `gemini-3.8-flash` reader (`ThinkingLevel.LOW`, `responseJsonSchema`) and deterministic `server/src/safety.ts` + `server/src/gs1.ts` + `server/src/find.ts` using first-person synthetic and fixture photos (`server/fixtures/*.jpg` and `eval/synthetic/images/*.jpg`).

| Metric (`SIMULATED`, `n = 40` personas) | Pre-fix baseline | Post-fix (this PR) | 95% CI (Wilson / bootstrap) | Notes |
|---|---|---|---|---|
| **Playwright Mock App task success** (`n = 40`) | `33 / 40 = 82.50%` (CI `68.05-91.25%`) | **`40 / 40 = 100.00%`** | Wilson `91.24-100.00%` (rule-of-three miss `<= 7.50%`) | `+17.50 pp` gain after fixing `UX-01..UX-05` in `web/src/` |
| **Real Server (`gemini-3.8-flash` + `safety.ts`) task success** (`n = 40`) | `38 / 40 = 95.00%` (CI `83.50-98.62%`)* | **`40 / 40 = 100.00%`** | Wilson `91.24-100.00%` (rule-of-three miss `<= 7.50%`) | *2 pre-fix scenarios (`med002`, `food008`) were caught as expired as of Nov 2026 (`safety.ts` worked as designed) |
| **Combined task sessions passed** (`n = 80` across both tracks) | `71 / 80 = 88.75%` (CI `79.98-93.97%`) | **`80 / 80 = 100.00%`** | Wilson `95.42-100.00%` (rule-of-three miss `<= 3.75%`) | Every persona completed both UI and server verification |
| **Mock App interaction turns per persona** (`n = 40`) | mean `6.58` (SD `1.57`, median `6.0`) | **mean `6.85`** (SD `1.48`, median `6.0`, p95 `10.0`) | Bootstrap 95% CI `6.40-7.33` turns | Includes 4-turn first-run consent onboarding |
| **Mock App session duration (s)** (`n = 40`) | mean `13.68 s` (median `12.10 s`) | **mean `11.43 s`** (SD `3.67 s`, median `11.76 s`, p95 `15.81 s`) | Bootstrap 95% CI `10.29-12.56 s` | End-to-end Playwright browser wall time |
| **Real Server verification turns per persona** (`n = 40`) | mean `1.02` (median `1.0`) | **mean `1.02`** (SD `0.16`, median `1.0`, p95 `1.0`) | Bootstrap 95% CI `1.00-1.07` turns | `P02` required 2 turns (back of box -> front of box) |
| **Real Server verification latency (s)** (`n = 40`) | mean `3.02 s` (median `2.80 s`) | **mean `3.17 s`** (SD `1.27 s`, median `2.87 s`, p95 `6.61 s`) | Bootstrap 95% CI `2.80-3.58 s` | Real `gemini-3.8-flash` + `safety.ts` / `find.ts` |
| **axe-core WCAG 2.2 A+AA zero-violation screens** (`n = 40`) | `38 / 40 = 95.00%` (CI `83.50-98.62%`) | **`36 / 40 = 90.00%`** | Wilson `76.95-96.04%` | `4 / 40 = 10.00%` (CI `3.96-23.05%`) hit `dlitem` on `<span class='conf'>` in `VerdictCard.tsx:139` (`UX-07`) |
| **SIMULATED persona trust score (1-5 Likert)** (`n = 40`) | mean `4.15` | **mean `4.33 / 5.00`** (SD `0.47`, median `4.0`, range `4-5`) | Bootstrap 95% CI `4.17-4.47` | Held back from `5.0` primarily by English-only UI/verdict text for `fi`/`sv` users (`UX-06`) |

---

## 2. Results by SIMULATED user cohort and language (`n = 40`)

| Cohort (`SIMULATED`) | `n` | Languages | Mock App Success (`k/n`, Wilson 95% CI) | Real Server Success (`k/n`, Wilson 95% CI) | Mean Mock Turns (95% CI) | Mean Server Latency s (95% CI) | Mean Simulated Trust /5 (95% CI) |
|---|---:|---|---|---|---|---|---|
| **A · Older Adults (65-88) with Low Vision & Polypharmacy** (`P01-P10`) | `10` | `7 fi, 3 sv` | `10/10 = 100.0%` (`72.25-100.00%`) | `10/10 = 100.0%` (`72.25-100.00%`) | `6.00` (`5.40-6.50`) | `3.59 s` (`2.67-4.74 s`) | `4.10 / 5` (`4.00-4.30`) |
| **B · Blind Screen-Reader Power Users (TalkBack/VoiceOver)** (`P11-P18`) | `8` | `5 fi, 2 sv, 1 en` | `8/8 = 100.0%` (`67.56-100.00%`) | `8/8 = 100.0%` (`67.56-100.00%`) | `7.88` (`6.88-8.88`) | `2.78 s` (`2.16-3.61 s`) | `4.50 / 5` (`4.12-4.88`) |
| **C · Deaf-Blind (Braille), Hearing-Impaired & Non-Verbal** (`P19-P24`) | `6` | `4 fi, 1 sv, 1 en` | `6/6 = 100.0%` (`60.97-100.00%`) | `6/6 = 100.0%` (`60.97-100.00%`) | `5.67` (`5.00-6.00`) | `3.06 s` (`2.32-3.96 s`) | `4.33 / 5` (`4.00-4.67`) |
| **D · Motor, Tremor, Switch-Control & Hands-Busy** (`P25-P30`) | `6` | `4 fi, 1 sv, 1 en` | `6/6 = 100.0%` (`60.97-100.00%`) | `6/6 = 100.0%` (`60.97-100.00%`) | `7.50` (`6.33-8.83`) | `2.83 s` (`2.04-3.79 s`) | `4.17 / 5` (`4.00-4.50`) |
| **E · Caregivers, Home-Care Nurses, Pharmacists & LASA** (`P31-P40`) | `10` | `6 fi, 2 sv, 2 en` | `10/10 = 100.0%` (`72.25-100.00%`) | `10/10 = 100.0%` (`72.25-100.00%`) | `7.20` (`6.50-8.00`) | `3.31 s` (`2.55-4.38 s`) | `4.50 / 5` (`4.20-4.80`) |
| **All SIMULATED Personas (`P01-P40`)** | **`40`** | **`26 fi, 9 sv, 5 en`** | **`40/40 = 100.0%` (`91.24-100.00%`)** | **`40/40 = 100.0%` (`91.24-100.00%`)** | **`6.85` (`6.40-7.33`)** | **`3.17 s` (`2.80-3.58 s`)** | **`4.33 / 5` (`4.17-4.47`)** |

**Breakdown by persona language (`n = 40`):**
- **Finnish (`fi`, `n = 26`, `65.00%`, Wilson 95% CI `49.51-77.87%`):** Mock `26/26 = 100.0%` (CI `87.13-100.00%`), Server `26/26 = 100.0%` (CI `87.13-100.00%`), mean simulated trust `4.19 / 5` (bootstrap 95% CI `4.04-4.35`).
- **Swedish (`sv`, `n = 9`, `22.50%`, Wilson 95% CI `12.32-37.50%`):** Mock `9/9 = 100.0%` (CI `70.09-100.00%`), Server `9/9 = 100.0%` (CI `70.09-100.00%`), mean simulated trust `4.33 / 5` (bootstrap 95% CI `4.00-4.67`).
- **English (`en`, `n = 5`, `12.50%`, Wilson 95% CI `5.46-26.11%`):** Mock `5/5 = 100.0%` (CI `56.55-100.00%`), Server `5/5 = 100.0%` (CI `56.55-100.00%`), mean simulated trust `5.00 / 5` (bootstrap 95% CI `5.00-5.00`).

---

## 3. Concrete UX defects discovered and fixes shipped in `web/` (`n = 10`)

| Defect ID | Frequency (`k/40`, Wilson 95% CI) | Exact `file:line` | UX / Accessibility Defect Found in SIMULATED Study | Status / Fix in this PR (`web/test/simUserUxFixes.test.ts`) |
|---|---|---|---|---|
| **UX-01** | `13 / 40 = 32.50%` (`20.08-47.98%`) | `web/src/lib/mock.ts:155,173,224,314`; `web/src/lib/checker.ts:679` | **1.6 s auto-scenario lock & Snapshot question ignored in `?mock=1`:** Clicking `Start check` in `?mock=1` auto-starts Scenario 0 (`Amlodipine`) after `1.6 s` and sets `this.running = true` for `11.8 s`. Any user (`P01, P05, P08, P12, P18, P20, P21, P26, P30, P34, P35, P38, P39`) who takes `> 1.6 s` to type a question in `#ask` has their question silently dropped (`if (this.running) return;`) and receives an Amlodipine match when asking about ibuprofen or nuts. Also `pickScenario` ignored FI/SV words (`Burana`, `pähkinä`, `mikä näistä`, `nötter`, `vilken`), `mockFetch('/api/verify')` ignored `body.question`, and `checker.snapshot()` rejected in `?mock=1` when no camera was present. | **FIXED in PR** (`web/src/lib/mock.ts`, `web/src/lib/checker.ts`): added `clearScenario()` so typed questions preempt any auto-started scenario; added EN/FI/SV keyword routing in `pickScenario()`; wired `body.question` in `mockFetch('/api/verify')`; and allowed `IS_MOCK` in `checker.snapshot()`. |
| **UX-02** | `4 / 40 = 10.00%` (`3.96-23.05%`) | `web/src/lib/checker.ts:88,944-953` | **Abrupt 45 s auto-stop cutoff with zero warning:** Older personas with tremor, arthritis, or cognitive slowing (`P04` Pentti, `P07` Ritva, `P09` Sylvi, `P28` Leena) fumbling with blister packs are cut off at `45 s` with no warning because the countdown (`autoStopAt`) is hidden inside the collapsed developer `DevicePanel`. | **FIXED in PR** (`web/src/lib/checker.ts`): added `AUTO_STOP_WARN_MS = 35_000` (`autoStopWarnTimer`) emitting a polite announcement 10 s before cutoff (`"Still watching. Camera turns off in 10 seconds if no label is seen."`). |
| **UX-03** | `6 / 40 = 15.00%` (`7.06-29.07%`) | `web/src/screens/Live.tsx:46-58` | **No `Escape` shortcut to dismiss `VerdictCard` on the phone `Check` screen:** Unlike `/hud/` (`Hud.tsx:261`), pressing `Escape` on the phone `Check` screen did not dismiss an active `VerdictCard`, forcing keyboard, switch-control, and Braille users (`P10, P11, P14, P19, P25, P27`) to tab past `<details>` and action buttons to reach `Dismiss`. | **FIXED in PR** (`web/src/screens/Live.tsx`): `onKey` now handles `e.key === "Escape"` when `s.verdict && !s.addProposal && !isTypingTarget(e.target)` by calling `checker.dismissVerdict()`. |
| **UX-04** | `4 / 40 = 10.00%` (`3.96-23.05%`) | `web/src/screens/Profile.tsx:194-198` | **Silent input wipe when adding a duplicate allergy or avoid tag:** In `Profile` (`TagList`), submitting an allergy or avoid term that is already on the list (e.g. `"peanut"` or `"NSAIDs"` for `P05, P14, P33, P35`) cleared the input box with zero `aria-live` announcement, leaving blind screen-reader users unsure if their input succeeded. | **FIXED in PR** (`web/src/screens/Profile.tsx`): `TagList` now announces `"${t} is already in ${title}."` when a duplicate tag is submitted. |
| **UX-05** | `3 / 40 = 7.50%` (`2.58-19.86%`) | `web/src/lib/checker.ts:550,736,753`; `web/src/lib/mock.ts:177`; `web/src/lib/audio.ts:71,114` | **Early DataMatrix scan dropped during `/live` connect + `AudioContext.resume()` hang:** Scanning or injecting a GS1 DataMatrix code while `/live` is still connecting (`0-250 ms` after `Start check`, `P31, P32`) was dropped by `if (dm && this.live?.isOpen)` and locked out for `8 s` by `lastBarcodeAt`; and `await this.ctx.resume()` in `audio.ts:71,114` hung `checker.start()` on devices without an audio output sink (`P20`). | **FIXED in PR** (`web/src/lib/checker.ts`, `web/src/lib/mock.ts`, `web/src/lib/audio.ts`): added `pendingDm` queue flushed in `onConn("open")`, live cross-check update on `this.lastVerdict` in `MockSocket`, and non-blocking `void this.ctx.resume().catch(() => {})` in `audio.ts`. |
| **UX-06** | `34 / 40 = 85.00%` (`70.93-92.94%`) | `web/src/screens/Profile.tsx:86`; `server/src/safety.ts:436-545`; `web/src/lib/feedback.ts:87,107` | **English-only UI screens and English `safety.ts` verdict templates for `fi`/`sv` users:** `Profile.tsx:86` notes *"The screens are in English for now"*, so all `26` Finnish and `9` Swedish personas encounter English onboarding, buttons, and `VerdictCard` headlines/reasons. | **Documented defect** (mitigated on `main` `06edb36` + `9eeb913`; full audited FI/SV UI string table provided in `docs/LANG_QA.md`). |
| **UX-07** | `4 / 40 = 10.00%` (`3.96-23.05%`) | `web/src/components/VerdictCard.tsx:139-141` | **axe-core `dlitem` violation inside `VerdictCard` `<details>`:** Expanding *"What I read, and how sure I am"* (`P12` Sanna, `P22` Astrid) or rendering `VerdictCard` with field rows (`P20, P29`) flagged `<span class="conf">` inside `<dl class="fields">`. | **Caught by Playwright axe-core** (fixed on `main` in commit `f523d8c` by changing `<span class="conf">` to `<dd class="conf">`). |
| **UX-08** | `1 / 40 = 2.50%` (`0.44-12.88%`) | `server/src/live.ts:406`; `web/src/components/AddSheet.tsx:71` | **`Hold up to add` (`add_medication`) requires touching the phone screen:** `P06` (Kauko, post-stroke one-handed user) noted that confirming `AddSheet` requires tapping `Add` on the phone rather than voice confirmation. | **Intentional safety gate** (prevents voice-hallucinated profile writes; double-tap anywhere on `AddSheet` is supported). |
| **UX-09** | `2 / 40 = 5.00%` (`1.38-16.50%`) | `web/src/screens/Hud.tsx:27,101` | **HUD labels warnings `CHECK` (`#FFCA28`) vs phone `Warning` (`#ff9b52`):** `P03` (Margareta) and `P24` (Meeri) noted the terminology difference between the waveguide HUD and spoken/phone warnings. | **Documented cross-modal note** (HUD speech language synced to `holdup.profile` on `main` `9a05762`). |
| **UX-10** | `2 / 40 = 5.00%` (`1.38-16.50%`) | `server/src/safety.ts:498-509` | **Unreadable expiry on a matched medicine still returns green `level: "match"`:** When printed expiry is off-frame or blurred (`P15, P27`), `safety.ts` returns `match` and appends *", and I couldn't read the expiry date"* to sentence 2 (`47/4,730 = 0.99%` in eval v2). | **Documented clinical trade-off** (mitigated when EU FMD DataMatrix expiry decodes via `server/src/gs1.ts`). |

---

## 4. Per-persona SIMULATED study ledger (`P01-P40`, `n = 40`)

All 40 rows below are **SIMULATED** (not real human participants). Every row records the measured Playwright mock run (`?mock=1` / `/hud/?mock=1`) and the measured real server run (`gemini-3.8-flash` + `server/src/safety.ts` / `server/src/find.ts`).

| ID | SIMULATED Persona (Age, City, Lang) | Condition & Assistive Tech | Mock App (`?mock=1`) Result, Turns, Time, axe | Real Server (`gemini-3.8-flash`) Verdict, Turns, Latency | Trust (/5) | Confusion Codes |
|---|---|---|---|---|---:|---|
| **P01** | **Aino** (78, Helsinki, `fi`) | Dry age-related macular degeneration (central scotoma, 20/200), 6 chronic meds + warfarin/NSAID avoid · *200% browser zoom + spoken answers (fi)* | **PASS** · `7` turns · `15.63 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.14 s` | **4/5** | `UX-01`, `UX-06` |
| **P02** | **Esko** (82, Tampere, `fi`) | Diabetic retinopathy + peripheral neuropathy (numb fingertips, cannot read Braille), 8 meds · *Ray-Ban Meta Bluetooth audio + large phone buttons* | **PASS** · `6` turns · `14.83 s` · axe `0` | **PASS** (`match`: *Yes: Metformin 1000 mg, your morning pill*) · `2` t · `6.61 s` | **5/5** | `UX-06` |
| **P03** | **Margareta** (76, Vaasa, `sv`) | Open-angle glaucoma (tunnel vision, severe photophobia & low-light loss), 5 meds · *Ray-Ban Display HUD (600x600) + Finland-Swedish voice* | **PASS** · `4` turns · `5.65 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `3.43 s` | **4/5** | `UX-06`, `UX-09` |
| **P04** | **Pentti** (84, Oulu, `fi`) | Bilateral cataracts + 6 Hz essential hand tremor, 6 meds + NSAID avoid · *Hands-free 'Which one?' scene mode + spoken answers* | **PASS** · `6` turns · `14.66 s` · axe `0` | **PASS** (`match`: *Evening pill: box on the right*) · `1` t · `6.34 s` | **4/5** | `UX-02`, `UX-06` |
| **P05** | **Ingrid** (79, Porvoo, `sv`) | Wet AMD (eccentric viewing) + mild hearing loss (hearing aids), tree nut & peanut allergy · *Large type + haptics + earcons + Swedish voice* | **PASS** · `6` turns · `15.70 s` · axe `0` | **PASS** (`warning`: *Warning: may contain nuts*) · `1` t · `3.79 s` | **4/5** | `UX-01`, `UX-04`, `UX-06` |
| **P06** | **Kauko** (71, Jyväskylä, `fi`) | Post-stroke left homonymous hemianopia (20/100, one-handed right thumb operation), 7 cardiac meds · *One-handed big button + Hold up to add (addmed)* | **PASS** · `6` turns · `15.81 s` · axe `0` | **PASS** (`warning`: *Simvastatin 40 mg: not on your list*) · `1` t · `2.98 s` | **4/5** | `UX-06`, `UX-08` |
| **P07** | **Ritva** (86, Kuopio, `fi`) | Severe macular degeneration + severe hand osteoarthritis, lives alone with home-care visits · *Spoken answers + dose log double-dose protection* | **PASS** · `6` turns · `9.37 s` · axe `0` | **PASS** (`warning`: *Amlodipine 5 mg: already taken today*) · `1` t · `2.07 s` | **4/5** | `UX-02`, `UX-06` |
| **P08** | **Henrik** (74, Mariehamn, `sv`) | Retinitis pigmentosa (10 deg tunnel field, night blindness) + celiac disease · *High contrast + Swedish speech + food allergen check* | **PASS** · `6` turns · `11.08 s` · axe `0` | **PASS** (`warning`: *Warning: contains rye*) · `1` t · `3.15 s` | **4/5** | `UX-01`, `UX-06` |
| **P09** | **Sylvi** (88, Lahti, `fi`) | Advanced cataract + mild cognitive slowing, on 9 medicines (Fimea excessive polypharmacy cohort) · *Big Start/Stop button + 10s pre-auto-stop warning* | **PASS** · `6` turns · `12.03 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.27 s` | **4/5** | `UX-02`, `UX-06` |
| **P10** | **Olavi** (75, Turku, `fi`) | Corneal opacity + Parkinsonian resting tremor, on 6 meds · *Bluetooth headset Play/Pause tap (Space/MediaPlayPause)* | **PASS** · `7` turns · `10.62 s` · axe `0` | **PASS** (`warning`: *Ramipril 5 mg: expired November 2024*) · `1` t · `3.12 s` | **4/5** | `UX-03`, `UX-06` |
| **P11** | **Mikko** (34, Espoo, `fi`) | Congenitally blind software engineer, daily Ray-Ban Meta + TalkBack (300 WPM) user · *Android TalkBack + keyboard shortcuts (Space, Escape) + skip link* | **PASS** · `7` turns · `9.89 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.82 s` | **4/5** | `UX-03`, `UX-06` |
| **P12** | **Sanna** (29, Helsinki, `fi`) | Totally blind (optic nerve atrophy), iOS VoiceOver + Braille Screen Input, peanut & sesame anaphylaxis · *iOS VoiceOver + per-field confidence details table* | **PASS** · `6` turns · `9.56 s` · axe `1` | **PASS** (`warning`: *Warning: contains sesame*) · `1` t · `2.71 s` | **4/5** | `UX-01`, `UX-06`, `UX-07` |
| **P13** | **Lukas** (41, Stockholm/Helsinki, `sv`) | Totally blind (Leber congenital amaurosis), frequent ferry commuter with spotty connectivity · *TalkBack (sv-SE) + offline barcode & GS1 DataMatrix mode* | **PASS** · `9` turns · `7.73 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `3.39 s` | **5/5** | `UX-06` |
| **P14** | **Noora** (24, Tampere, `fi`) | Blind university student (retinopathy of prematurity), milk & soy allergy · *Keyboard-only navigation + Profile TagList management* | **PASS** · `9` turns · `21.70 s` · axe `0` | **PASS** (`warning`: *Warning: contains milk*) · `1` t · `3.46 s` | **4/5** | `UX-03`, `UX-04`, `UX-06` |
| **P15** | **David** (52, London/Helsinki, `en`) | Totally blind since age 20, dose recently reduced from Amlodipine 10 mg to 5 mg (old 10 mg box in drawer) · *VoiceOver (en-GB) + Ray-Ban Meta headset* | **PASS** · `7` turns · `15.81 s` · axe `0` | **PASS** (`warning`: *Amlodipine 10 mg: wrong strength*) · `1` t · `3.23 s` | **5/5** | `UX-10` |
| **P16** | **Riikka** (46, Vantaa, `fi`) | Blind rehabilitation specialist at NKL (Iiris centre), works in open-plan office with voice muted · *TalkBack + Quiet mode + Spoken answers OFF (live-region cues only)* | **PASS** · `9` turns · `14.74 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.39 s` | **5/5** | `UX-06` |
| **P17** | **Emil** (38, Jakobstad, `sv`) | Totally blind violinist, streams from Ray-Ban Meta glasses camera with phone in jacket pocket · *Glasses camera via DAT bridge + wear-detection fallback* | **PASS** · `10` turns · `14.35 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.22 s` | **5/5** | `UX-06` |
| **P18** | **Hanna** (61, Joensuu, `fi`) | Late-blinded (diabetic retinopathy at 55), uses compact Bluetooth keyboard in noisy clinics · *TalkBack + typed #ask input in Snapshot mode* | **PASS** · `6` turns · `13.90 s` · axe `0` | **PASS** (`match`: *Yes: Paracetamol 500 mg, your morning pill*) · `1` t · `2.01 s` | **4/5** | `UX-01`, `UX-06` |
| **P19** | **Tuomas** (49, Helsinki, `fi`) | Usher syndrome Type 2 (RP tunnel vision + severe bilateral sensorineural hearing loss) · *40-cell refreshable Braille display (aria-live) + haptics* | **PASS** · `6` turns · `14.55 s` · axe `0` | **PASS** (`warning`: *Warning: contains peanut*) · `1` t · `2.80 s` | **4/5** | `UX-03`, `UX-06` |
| **P20** | **Claire** (36, Brussels/Helsinki, `en`) | Usher syndrome Type 1 (profoundly deaf + low vision 20/160), denies mic permission by default · *High contrast (prefers-contrast: more) + mic-denied text mode* | **PASS** · `6` turns · `12.79 s` · axe `1` | **PASS** (`warning`: *Ibuprofen 400 mg: not on your list*) · `1` t · `3.96 s` | **5/5** | `UX-01`, `UX-05` |
| **P21** | **Jari** (58, Kotka, `fi`) | Post-laryngectomy aphonia (cannot speak aloud) + glaucoma low vision · *Typed #ask input + spoken answers ON* | **PASS** · `6` turns · `10.58 s` · axe `0` | **PASS** (`warning`: *Ibuprofen 400 mg: not on your list*) · `1` t · `3.31 s` | **4/5** | `UX-01`, `UX-06` |
| **P22** | **Astrid** (67, Ekenäs, `sv`) | Bilateral cochlear implants + diabetic macular edema (relies on visual confidence breakdown) · *High-contrast VerdictCard + per-field confidence table* | **PASS** · `6` turns · `12.17 s` · axe `1` | **PASS** (`unsure`: *Can't read the label yet*) · `1` t · `2.70 s` | **4/5** | `UX-06`, `UX-07` |
| **P23** | **Sami** (31, Rovaniemi, `fi`) | Vestibular migraine + optic neuritis (severe motion sickness from spinners/pulsing) + shellfish allergy · *prefers-reduced-motion: reduce + screen magnification* | **PASS** · `6` turns · `11.78 s` · axe `0` | **PASS** (`warning`: *Warning: contains shrimp*) · `1` t · `3.38 s` | **5/5** | `UX-06` |
| **P24** | **Meeri** (73, Pori, `fi`) | Presbycusis + nuclear cataract, uses Ray-Ban Display HUD with Neural Band gestures · *Ray-Ban Display 600x600 Web App + Neural Band Arrow/Enter keys* | **PASS** · `4` turns · `10.13 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.24 s` | **4/5** | `UX-06`, `UX-09` |
| **P25** | **Ville** (44, Tampere, `fi`) | C6 tetraplegia (uses 2-button Bluetooth switch mapped to Tab / Space / Enter / Escape) + cataract · *Switch control (Tab, Space, Enter, Escape)* | **PASS** · `7` turns · `12.03 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.45 s` | **4/5** | `UX-03`, `UX-06` |
| **P26** | **Kirsti** (69, Lappeenranta, `fi`) | Severe rheumatoid arthritis (ulnar deviation, painful finger joints) + low vision, avoids NSAIDs · *Large >=56px AAA touch targets + voice* | **PASS** · `6` turns · `11.74 s` · axe `0` | **PASS** (`warning`: *Ibuprofen 400 mg: not on your list*) · `1` t · `3.01 s` | **4/5** | `UX-01`, `UX-06` |
| **P27** | **Marcus** (37, Helsinki, `en`) | Blind parent holding a crying toddler in one arm and a paracetamol pack in the other (zero free hands) · *Bluetooth glasses MediaPlayPause / MediaStop tap + voice* | **PASS** · `7` turns · `11.51 s` · axe `0` | **PASS** (`match`: *Yes: Paracetamol 500 mg, your morning pill*) · `1` t · `1.95 s` | **5/5** | `UX-03`, `UX-10` |
| **P28** | **Leena** (63, Hämeenlinna, `fi`) | Multiple sclerosis (intention tremor + diplopia + fatigue), on 5 meds · *Modal dialog focus restoration + large buttons* | **PASS** · `9` turns · `11.86 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `1.79 s` | **4/5** | `UX-02`, `UX-06` |
| **P29** | **Johan** (55, Korsholm, `sv`) | Diabetic retinopathy + unilateral upper-limb prosthesis, browser camera blocked by policy · *Camera-denied PermissionRecovery + 'Take a photo instead' upload* | **PASS** · `6` turns · `13.37 s` · axe `1` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `3.09 s` | **4/5** | `UX-07` |
| **P30** | **Anni** (27, Oulu, `fi`) | Stargardt juvenile macular degeneration (20/200), checking meds on congested 3G train connection · *Adaptive RTT frame policy + Snapshot fallback + reconnect* | **PASS** · `10` turns · `5.30 s` · axe `0` | **PASS** (`info`: *Rainbow Luomu Tomaattimurska Yrteillä: none of your allergens*) · `1` t · `4.71 s` | **4/5** | `UX-01`, `UX-06` |
| **P31** | **Sari** (42, Espoo, `fi`) | Home-care nurse (kotisairaanhoito) verifying an 81-year-old client's prescription pack with GS1 DataMatrix · *Profile pack-code scanner + DataMatrix 'Double-checked' badge* | **PASS** · `7` turns · `13.43 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `7.64 s` | **4/5** | `UX-05`, `UX-06` |
| **P32** | **Priya** (33, Helsinki, `en`) | Community pharmacist testing HoldUp's EU FMD DataMatrix conflict guard when a box flap code disagrees with print · *CrossCheck disagreement alert + DevicePanel* | **PASS** · `7` turns · `13.37 s` · axe `0` | **PASS** (`unsure`: *Label and pack code disagree*) · `1` t · `3.68 s` | **5/5** | `UX-05` |
| **P33** | **Karl-Erik** (68, Loviisa, `sv`) | Swedish-speaking caregiver husband checking his blind wife's morning vs evening boxes · *Profile Dose log + Swedish voice* | **PASS** · `9` turns · `8.68 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.12 s` | **4/5** | `UX-04`, `UX-06` |
| **P34** | **Maija** (77, Seinäjoki, `fi`) | Low-vision retiree on warfarin (Marevan) + NSAID/aspirin avoid list holding Finnish Disperin 500 mg · *Large type + spoken warnings* | **PASS** · `6` turns · `6.66 s` · axe `0` | **PASS** (`warning`: *Acetylsalicylic acid 500 mg: not on your list*) · `1` t · `2.81 s` | **4/5** | `UX-01`, `UX-06` |
| **P35** | **Hassan** (51, Turku, `en`) | Low-vision kitchen worker with mustard, egg, and sulphite allergies checking bilingual FI/SV sauce labels · *Phone camera + allergen breakdown* | **PASS** · `6` turns · `8.21 s` · axe `0` | **PASS** (`warning`: *Warning: contains mustard*) · `1` t · `2.72 s` | **5/5** | `UX-01`, `UX-04` |
| **P36** | **Elina** (64, Kouvola, `fi`) | Privacy-conscious low-vision retired civil servant auditing consent withdrawal and one-button data wipe · *Privacy tab controls + screen-reader announcements* | **PASS** · `8` turns · `9.81 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.05 s` | **5/5** | `UX-06` |
| **P37** | **Viktor** (60, Mariehamn, `sv`) | Low-vision user taking Exforge (amlodipine + valsartan combo) checking plain single-ingredient Amlodipine · *Swedish voice + VerdictCard reasons list* | **PASS** · `7` turns · `9.94 s` · axe `0` | **PASS** (`warning`: *Amlodipine 5 mg: not on your list*) · `1` t · `2.26 s` | **5/5** | `UX-06` |
| **P38** | **Taina** (72, Mikkeli, `fi`) | Low-vision patient with look-alike Atarax 25 mg (hydroxyzine) vs Hydralazine 25 mg and Bisoprolol 2.5 mg · *200% zoom + per-field confidence table* | **PASS** · `6` turns · `8.71 s` · axe `0` | **PASS** (`warning`: *Hydroxyzine 25 mg: not on your list*) · `1` t · `2.58 s` | **4/5** | `UX-01`, `UX-06` |
| **P39** | **Otso** (19, Tampere, `fi`) | Blind vocational student learning assistive apps with his O&M instructor using DevicePanel simulation controls · *TalkBack + DevicePanel mode transitions (Live -> Snapshot -> Offline -> Live)* | **PASS** · `10` turns · `2.36 s` · axe `0` | **PASS** (`match`: *Yes: Amlodipine 5 mg, your evening pill*) · `1` t · `2.91 s` | **4/5** | `UX-01`, `UX-06` |
| **P40** | **Helena** (83, Helsinki, `fi`) | Visually impaired NKL peer-support volunteer running the 4-step USER_TEST_KIT protocol · *Spoken answers + 3-box scene mode + thumb-over-strength abstention check* | **PASS** · `6` turns · `5.10 s` · axe `0` | **PASS** (`match`: *Evening pill: box on the right*) · `1` t · `4.35 s` | **5/5** | `UX-06` |

---

## 5. SIMULATED persona task transcripts and reflections (`P01-P40`)

> **Reminder:** The quotes below are **SIMULATED first-person reflections** generated to summarize each persona's scripted run and surface concrete UX friction. They are **not** quotes from real human testers.

- **`P01` Aino (`78`, `Helsinki`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Onko tämä iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tämä minun iltalääkkeeni Amlodipin 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.14 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Kun pidän Amlodipin-pakkausta kädessäni, iso keltainen painike ja selkeä tuomio auttavat, mutta englanninkielinen teksti ruudulla hämmentää."*
- **`P02` Esko (`82`, `Tampere`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Mikä on tämän metformin vahvuus?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Entä nyt kun käänsin pakkauksen?"` -> `MATCH` (*"Yes, Metformin 1000 mg, your morning pill. You haven't taken it today."* in `6.61 s`, `2` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"Kun pakkaus oli väärinpäin, ohje kääntää sitä oli rauhallinen eikä sovellus arvannut vahvuutta ennen kuin teksti näkyi."*
- **`P03` Margareta (`76`, `Vaasa`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* HUD rendered 600x600 verdict card, activated Repeat via Enter, and dismissed cleanly on Escape.
  - *Real server check:* Asked `"Är det här min kvällstablett Amlodipin 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `3.43 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-06, UX-09`):* *"På glasögonens skärm syns kortet tydligt trots min ljuskänslighet, men 'CHECK' i stället för 'VARNING' fick mig att tveka."*
- **`P04` Pentti (`84`, `Oulu`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Mikä näistä kolmesta on iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Mikä näistä kolmesta pöydällä olevasta rasiasta on iltalääkkeeni?"` -> `MATCH` (*"Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list."* in `6.34 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-02, UX-06`):* *"Kolmen valkoisen rasian tarkistus pöydältä kerralla ('oikeanpuoleinen') säästää minua vapisevin käsin kääntelemästä jokaista."*
- **`P05` Ingrid (`79`, `Porvoo`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Innehåller kakan nötter eller mandel?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Innehåller den här chokladen nötter eller spår av nötter?"` -> `WARNING` (*"Warning: Karl Fazer Maitosuklaa may contain nuts. Your profile lists an allergy to tree nuts."* in `3.79 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-04, UX-06`):* *"Varningen för hasselnöt och mandel kom direkt med tydlig ljudsignal och vibration, och dubblettvarningen i profilen hördes nu."*
- **`P06` Kauko (`71`, `Jyväskylä`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Triggered hold-up-to-add via voice/text setup, confirmed Lisinopril 10 mg in AddSheet modal.
  - *Real server check:* Asked `"Mikä lääke tämä on ja onko se listallani?"` -> `WARNING` (*"This is Simvastatin 40 mg. It isn't on your medication list."* in `2.98 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-06, UX-08`):* *"Lääkkeen lisääminen äänen avulla onnistui yhdellä kädellä, vaikka puhelimen näytöltä täytyikin vielä painaa vahvistusta."*
- **`P07` Ritva (`86`, `Kuopio`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Onko tämä iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Olinko jo ottanut tämän iltalääkkeen tänään?"` -> `WARNING` (*"This is Amlodipine 5 mg, your evening pill. You already took it today."* in `2.07 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-02, UX-06`):* *"Sovellus muisti heti, että olin jo ottanut iltalääkkeeni puoli tuntia sitten, mikä estää vaarallisen tupla-annoksen."*
- **`P08` Henrik (`74`, `Mariehamn`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Kan jag ta smärtstillande ibuprofen?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Innehåller det här brödet gluten eller råg?"` -> `WARNING` (*"Warning: Oululainen Jälkiuunipala Täysjyväruis contains rye. Your profile lists an allergy to gluten and wheat."* in `3.15 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Den hittade råg och gluten på rågbrödspåsen direkt, men jag önskar att hela skärmen var på svenska."*
- **`P09` Sylvi (`88`, `Lahti`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Onko tämä iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tämä oikea iltalääkkeeni?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.27 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-02, UX-06`):* *"45 sekunnin aikakatkaisu tuntui aiemmin äkilliseltä läpipainopakkausten kanssa, mutta 10 sekunnin ennakkoilmoitus auttaa."*
- **`P10` Olavi (`75`, `Turku`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Started check via Space shortcut, received verdict, dismissed VerdictCard with Escape key (UX-3), and stopped check.
  - *Real server check:* Asked `"Onko tämä Ramipril-pakkaus vielä voimassa vai vanhentunut?"` -> `WARNING` (*"This is Ramipril 5 mg, your medicine. This box expired in November 2024, so ask a pharmacist for a new one."* in `3.12 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-03, UX-06`):* *"Vanhentunut Ramipril-pakkaus jäi heti kiinni varoituksella, ja Bluetooth-napautus toimii ilman ruudun tähtäämistä."*
- **`P11` Mikko (`34`, `Espoo`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Started check via Space shortcut, received verdict, dismissed VerdictCard with Escape key (UX-3), and stopped check.
  - *Real server check:* Asked `"Onko tämä iltalääkkeeni?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.82 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-03, UX-06`):* *"TalkBack-navigaatio ja uusi Escape-pikanäppäin tuomiokortin sulkemiseen tekevät tarkistuksesta nopean näppäimistöllä."*
- **`P12` Sanna (`29`, `Helsinki`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Asked "Sisältääkö tämä pähkinää?", expanded "What I read, and how sure I am" (<details>), and inspected 3 field confidences.
  - *Real server check:* Asked `"Sisältääkö tämä tahini seesamia tai maapähkinän jäämiä?"` -> `WARNING` (*"Warning: Luomu Tahini Vaalea contains sesame. Your profile lists an allergy to peanut, sesame and tree nuts."* in `2.71 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06, UX-07`):* *"Kenttäkohtainen luottamusprosentti paljasti seesamin ja maapähkinäjäämät, vaikka dl-listan span-elementti antoikin axe-huomautuksen."*
- **`P13` Lukas (`41`, `Stockholm/Helsinki`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Switched to offline mode, matched saved medicine via GS1 pack code, and recovered online.
  - *Real server check:* Asked `"Är det här min kvällsmedicin Amlodipine 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill, double-checked with the pack's code. You haven't taken it today."* in `3.39 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"När nätet försvann på färjan kände offline-läget ändå igen min Amlodipin via GS1-koden och återanslöt själv."*
- **`P14` Noora (`24`, `Tampere`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Tested duplicate allergy tag announcement in Profile (UX-4), added new tag, and completed Check verdict.
  - *Real server check:* Asked `"Onko tässä Dumle-pussissa maitoa tai soijaa?"` -> `WARNING` (*"Warning: Fazer Dumle Original Toffee Caramel contains milk and soy. Your profile lists an allergy to milk and soy."* in `3.46 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-03, UX-04, UX-06`):* *"Allergialistan muokkaus näppäimistöllä oli sujuvaa, ja nyt ruudunlukija ilmoittaa selkeästi, jos allergia on jo listalla."*
- **`P15` David (`52`, `London/Helsinki`, `en`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Is this my evening pill?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Is this my 5 mg Amlodipine evening pill?"` -> `WARNING` (*"This is Amlodipine 10 mg, but your list says 5 mg. Don't take it before checking with a pharmacist."* in `3.23 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-10`):* *"Holding up my old 10 mg Amlodipine box triggered an immediate wrong-strength warning against my 5 mg prescription."*
- **`P16` Riikka (`46`, `Vantaa`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Toggled Spoken answers OFF and Quiet mode ON in Privacy, then completed check via live-region announcements.
  - *Real server check:* Asked `"Tarkista onko tämä Amlodipin 5 mg."` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.39 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"Äänettömässä tilassa pelkät ruudunlukijan live-ilmoitukset ja värinä riittivät viemään tarkistuksen läpi avokonttorissa."*
- **`P17` Emil (`38`, `Jakobstad`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Streamed from glasses camera, triggered 12% low-battery alert and glasses-doffed auto-fallback to phone camera.
  - *Real server check:* Asked `"Är det här min Amlodipin 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.22 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"När jag tog av mig glasögonen växlade appen direkt till telefonens kamera och varnade även vid 12 procent batteri."*
- **`P18` Hanna (`61`, `Joensuu`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Voinko ottaa Burana särkylääkkeen?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tämä minun Panadol 500 mg särkylääkkeeni?"` -> `MATCH` (*"Yes, Paracetamol 500 mg, your morning pill. You haven't taken it today."* in `2.01 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Kysymyksen kirjoittaminen tekstikenttään meluisassa odotustilassa toimi luotettavasti myös valokuvatilassa."*
- **`P19` Tuomas (`49`, `Helsinki`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Onko tämä iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tässä pussissa maapähkinää?"` -> `WARNING` (*"Warning: Pirkka Paahdetut ja Suolatut Maapähkinät contains peanut. Your profile lists an allergy to peanut."* in `2.80 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-03, UX-06`):* *"Pistekirjoitusnäytöllä luettavat aria-live-viestit ja erottuvat värinäkuviot kertoivat heti maapähkinävaroituksen ilman ääntä."*
- **`P20` Claire (`36`, `Brussels/Helsinki`, `en`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Can I take this ibuprofen?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Can I take this Burana 400 mg painkiller?"` -> `WARNING` (*"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."* in `3.96 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-01, UX-05`):* *"After denying microphone access, the recovery screen let me continue without a mic, though rapid startup before camera init can race."*
- **`P21` Jari (`58`, `Kotka`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Voinko ottaa Burana?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Mikä lääke tämä on, sopiiko se minulle?"` -> `WARNING` (*"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."* in `3.31 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Ilman puheääntä pystyin kirjoittamaan kysymyksen Buranasta, ja sovellus varoitti heti tulehduskipulääkkeestä."*
- **`P22` Astrid (`67`, `Ekenäs`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Asked "Vilken styrka har metformin?", expanded "What I read, and how sure I am" (<details>), and inspected 3 field confidences.
  - *Real server check:* Asked `"Kan du läsa styrkan på den här förpackningen?"` -> `UNSURE` (*"I can't read the label yet. Turn the box around to show the front panel."* in `2.70 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-06, UX-07`):* *"Tabellen 'What I read, and how sure I am' gav mig kontroll när baksidan av Metformin-asken inte gick att läsa."*
- **`P23` Sami (`31`, `Rovaniemi`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Does this have nuts?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tässä pastassa katkarapua tai äyriäisiä?"` -> `WARNING` (*"Warning: Katkarapupasta / Räkpasta contains shrimp. Your profile lists an allergy to shellfish."* in `3.38 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"Reduced-motion-tila poisti pyörivät animaatiot, ja katkarapupastan äyriäisvaroitus tuli nopeasti."*
- **`P24` Meeri (`73`, `Pori`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* HUD rendered 600x600 verdict card, activated Repeat via Enter, and dismissed cleanly on Escape.
  - *Real server check:* Asked `"Onko tämä minun iltalääkkeeni?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.24 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-06, UX-09`):* *"Lasien näytöllä nuolinäppäimet, Enter ja Escape toimivat loogisesti ilman turhia valikoita."*
- **`P25` Ville (`44`, `Tampere`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Started check via Space shortcut, received verdict, dismissed VerdictCard with Escape key (UX-3), and stopped check.
  - *Real server check:* Asked `"Onko tämä iltalääkkeeni Amlodipin 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.45 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-03, UX-06`):* *"Kahden kytkimen ohjauksella (Tab, Space, Escape) pystyin käynnistämään tarkistuksen ja sulkemaan tuloksen ilman kosketusnäyttöä."*
- **`P26` Kirsti (`69`, `Lappeenranta`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Voinko ottaa Burana särkylääkkeen?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Voinko ottaa tämän Burana 400 mg tablettini nivelkipuun?"` -> `WARNING` (*"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."* in `3.01 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Isot 56–104 pikselin painikkeet osuivat kipeillä sormilla kerralla kohdalleen, ja Burana-varoitus oli selkeä."*
- **`P27` Marcus (`37`, `Helsinki`, `en`, `SIMULATED`):**
  - *Mock UI flow:* Started check via Space shortcut, received verdict, dismissed VerdictCard with Escape key (UX-3), and stopped check.
  - *Real server check:* Asked `"Is this Paracetamol 500 mg?"` -> `MATCH` (*"Yes, Paracetamol 500 mg, your morning pill. You haven't taken it today."* in `1.95 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-03, UX-10`):* *"With a toddler in one arm and the bottle in the other, tapping the headset button to check Pamol 500 mg was a lifesaver."*
- **`P28` Leena (`63`, `Hämeenlinna`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Added Bisoprolol 2.5 mg in MedEditor modal and completed live check.
  - *Real server check:* Asked `"Onko tämä Amlodipin 5 mg iltalääkkeeni?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `1.79 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-02, UX-06`):* *"Lääkkeen muokkausikkunan sulkeminen palautti kohdistuksen takaisin oikeaan painikkeeseen eikä kadottanut paikkaa."*
- **`P29` Johan (`55`, `Korsholm`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Är det här min kvällsmedicin?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Är det här min kvällsmedicin Amlodipine 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `3.09 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-07`):* *"När kameran var blockerad kunde jag ändå gå vidare via återställningsskärmen och kontrollera min kvällsmedicin."*
- **`P30` Anni (`27`, `Oulu`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Tested slow network RTT adaptation, forced Snapshot mode check with typed question (UX-1b), and returned to Live.
  - *Real server check:* Asked `"Onko tässä tomaattimurskassa pähkinää?"` -> `INFO` (*"Rainbow Luomu Tomaattimurska Yrteillä: no tree nuts listed. Best before 31 August 2027."* in `4.71 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Hitaalla junayhteydellä kuvanlaatu mukautui automaattisesti, ja tomaattimurska todettiin pähkinättömäksi."*
- **`P31` Sari (`42`, `Espoo`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Simulated GS1 DataMatrix scan on active verdict and verified .xcheck.ok Double-checked badge.
  - *Real server check:* Asked `"Varmista onko tämä asiakkaan Amlodipin Orion 5 mg iltalääke."` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill, double-checked with the pack's code. You haven't taken it today."* in `7.64 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-05, UX-06`):* *"Kotihoidon käynnillä GS1 DataMatrix -koodi varmisti sekä Amlodipin Orionin vahvuuden että viimeisen käyttöpäivän."*
- **`P32` Priya (`33`, `Helsinki`, `en`, `SIMULATED`):**
  - *Mock UI flow:* Simulated GS1 DataMatrix scan on conflicting product and verified .xcheck.bad disagreement warning.
  - *Real server check:* Asked `"Does the printed label match the pack DataMatrix code here?"` -> `UNSURE` (*"The printed label and the pack's code disagree. Please ask a pharmacist."* in `3.68 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-05`):* *"When the scanned DataMatrix GTIN belonged to Atorvastatin on an Amlodipine box, HoldUp rightly refused and said to ask a pharmacist."*
- **`P33` Karl-Erik (`68`, `Loviisa`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Tested duplicate allergy tag announcement in Profile (UX-4), added new tag, and completed Check verdict.
  - *Real server check:* Asked `"Är det här min frus kvällstablett kl 20:00?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.12 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-04, UX-06`):* *"Som anhörigvårdare kunde jag snabbt se i dosloggen och höra att kvällstabletten kl. 20 var rätt Amlodipin 5 mg."*
- **`P34` Maija (`77`, `Seinäjoki`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Voinko ottaa tämän Disperin särkylääkkeen?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Voinko ottaa tämän Disperin 500 mg poretabletin kun käytän Marevania?"` -> `WARNING` (*"This is Acetylsalicylic acid 500 mg. It isn't on your medication list and your list says to avoid NSAIDs."* in `2.81 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Marevanin käyttäjänä sain välittömän varoituksen, että suomalainen Disperin 500 mg on tulehduskipulääke (asetyylisalisyylihappo)."*
- **`P35` Hassan (`51`, `Turku`, `en`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Does this food bar have nuts or allergens?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Does this sauce contain mustard, egg, or sulphites?"` -> `WARNING` (*"Warning: mustard sauce contains mustard, egg and sulfite. Your profile lists an allergy to mustard, egg and sulphites."* in `2.72 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-01, UX-04`):* *"It caught mustard, egg, and sulphites on a bilingual Finnish/Swedish sauce bottle in one read."*
- **`P36` Elina (`64`, `Kouvola`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check, withdrew consent in Privacy, and verified Check screen locks camera behind #needconsent gate.
  - *Real server check:* Asked `"Onko tämä Amlodipin 5 mg?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.05 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"Suostumuksen peruuttaminen lukitsi kameran välittömästi, ja tietojen poistopainike tyhjensi kaiken puhelimesta."*
- **`P37` Viktor (`60`, `Mariehamn`, `sv`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Är det här min kvällsmedicin?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Är det här min kombinationsmedicin Exforge?"` -> `WARNING` (*"This is Amlodipine 5 mg. It isn't on your medication list."* in `2.26 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"Den blandade inte ihop enkel Amlodipin 5 mg med min kombinationsmedicin Exforge, vilket är avgörande för säkerheten."*
- **`P38` Taina (`72`, `Mikkeli`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Voinko ottaa Burana?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Onko tämä minun verenpainelääkkeeni Hydralazine 25 mg?"` -> `WARNING` (*"This is Hydroxyzine 25 mg. It isn't on your medication list."* in `2.58 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Samannäköinen Atarax 25 mg -purkki ei mennyt läpi Hydralazine 25 mg -verenpainelääkkeenä, vaan antoi selkeän varoituksen."*
- **`P39` Otso (`19`, `Tampere`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Tested slow network RTT adaptation, forced Snapshot mode check with typed question (UX-1b), and returned to Live.
  - *Real server check:* Asked `"Onko tämä minun Amlodipin 5 mg iltalääkkeeni?"` -> `MATCH` (*"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."* in `2.91 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 4/5`, confusions: `UX-01, UX-06`):* *"Oppitunnilla pystyin testaamaan yhteyden katkeamisen, varavalokuvatilan ja paluun live-tilaan yhdellä napilla."*
- **`P40` Helena (`83`, `Helsinki`, `fi`, `SIMULATED`):**
  - *Mock UI flow:* Completed check via "Mikä näistä kolmesta on iltalääkkeeni?" (preempting auto-demo via UX-1) and verified VerdictCard.
  - *Real server check:* Asked `"Mikä näistä kolmesta pakkauksesta on minun iltalääkkeeni?"` -> `MATCH` (*"Your evening pill is the box on the right. The middle one is Ibuprofen 400 mg, not on your list."* in `4.35 s`, `1` turn(s)).
  - *Simulated reflection (`trust = 5/5`, confusions: `UX-06`):* *"NKL:n vertaistukijana pidän tärkeimpänä sitä, että peukalon peittäessä vahvuuden sovellus kieltäytyy arvaamasta annosta."*
