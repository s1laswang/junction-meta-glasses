Caregiver, Nurse, and Household Handoff Safety Suite (`caregiver_handoff`)
==========================================================================

Evaluates HoldUp end-to-end across 12 caregiving, home-care nurse, and shared-household medication and meal handoff scenarios for blind and low-vision older adults using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Synthetic PIL JPEGs render only inside `TemporaryDirectory(dir=temp_root())` (`/dev/shm` by default); zero image files or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/caregiver_handoff/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity (plain `python3`, no `google-genai` needed):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/caregiver_handoff/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/caregiver_handoff/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Evaluation clock (`eval_now_iso`) | `2026-11-14T19:30:00+02:00` (morning nurse dose at `08:30+02:00`) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.631 s`, `p95 = 6.045 s`, `mean = 4.074 s` | - |
| Cached artifact size | `10,102` bytes (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Caregiver dose-log handoff (3):**
  - `ch_01` (`match`): Evening `AMLODIPINE 5 mg` (`EXP 2027-11`) with `0` doses logged today (`matches aml`, `taken today: 0/1`).
  - `ch_02` (`warning`): Once-daily morning `RAMIPRIL 5 mg` already logged by morning nurse at `2026-11-14T08:30:00+02:00` (`matches ram`, `taken today: 1/1`, `already taken today`).
  - `ch_03` (`match`): Twice-daily `METFORMIN 500 mg` (`schedule: ["morning", "evening"]`) with 1 morning nurse dose logged at `08:30` (`matches met`, `taken today: 1/2`, evening dose still due).
- **Spouse, visitor, and drawer household traps (4):**
  - `ch_04` (`warning`): Spouse's look-alike `AMLODIPINE 10 mg` (`FOR SPOUSE` tag) on shared table against user's `5 mg` prescription (`strength 10 mg differs from your 5 mg`).
  - `ch_05` (`warning`): Spouse's `MAREVAN 3 mg` (`warfarin sodium`) box on shared counter (`not on your medication list`).
  - `ch_06` (`warning`): Visitor-left OTC `BURANA 400 mg` (`ibuprofen`) against `NSAIDs` avoid list (`ibuprofen is an NSAID, on your avoid list`, `not on your medication list`).
  - `ch_07` (`warning`): Old drawer backup `PARACETAMOL 500 mg` with past expiry `EXP 05/2025` (`expired 2025-05`).
- **Caregiver note occlusion and torn pharmacy vial abstentions (2):**
  - `ch_08` (`unsure`): Caregiver yellow sticky note (`EVENING PILL`) pasted directly over the strength box on `AMLODIPINE` carton (`strength_read = null`, `strength_conf = 0.0`, `strength not readable`).
  - `ch_09` (`unsure`): Turned-away torn amber pharmacy vial showing only `Keep in a dry place` and `Lot 48219` with no drug name, ingredient, or strength (`label not readable`).
- **Family and caregiver meal handoff allergen checks (3):**
  - `ch_10` (`warning`): Visitor bakery gift box (`Contains: hazelnuts, wheat, milk`) against `tree nuts` allergy (`contains hazelnut (allergy: tree nuts)`).
  - `ch_11` (`info`): Caregiver-brought `Wholegrain Oat Porridge` carton with readable nut-free panel (`Contains: oat, gluten`) against `peanut` + `tree nuts` allergies (`no listed allergen matches your profile`).
  - `ch_12` (`unsure`): Home-cooked meal container lid with caregiver sticky note (`Homemade Lasagna - heat 3 min`) and no visible ingredient or allergen panel (`kind = "food"`, `allergens = null`, `allergen panel not readable`).
