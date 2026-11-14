High-Alert Insulin and GLP-1 Injectable Pen Safety Suite (`insulin_glp1_pens`)
==============================================================================

Evaluates HoldUp end-to-end across 12 high-alert injectable pen look-alike scenarios for blind and low-vision adults managing diabetes and GLP-1 therapy. Runs real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped into deterministic `server/src/safety.ts` via `eval/safety_bridge.mts`. Synthetic PIL pre-filled pen cartons and cylindrical pen barrels render inside `TMPDIR` (`/dev/shm` by default) only and are cleaned up on exit; zero image files or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/insulin_glp1_pens/run.py --workers 3
```

Offline verification of cached `results.json`, PIL rendering in `/dev/shm`, and `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/insulin_glp1_pens/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/insulin_glp1_pens/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`, `eval_now_iso = 2026-11-14T20:30:00+02:00`)
--------------------------------------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.025 s`, `p95 = 5.052 s`, `mean = 3.279 s` | - |
| Artifact size (`results.json`) | `10299 B` (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Concentrated vs standard insulin pens (4):**
  - `ig_01` (`match`): Standard `LANTUS SoloStar 100 IU/ml` (`insulin glargine`, `EXP 2027-11`) pre-filled pen carton matched to prescribed bedtime `Lantus 100 IU/ml` (`matches lantus`, `taken today: 0/1`).
  - `ig_02` (`warning`): Concentrated 3x `TOUJEO SoloStar 300 IU/ml` (`insulin glargine`, `EXP 2027-10`) look-alike carton caught against prescribed `Lantus 100 IU/ml` (`strength 300 IU/ml differs from your 100 IU/ml`).
  - `ig_03` (`warning`): Concentrated 2x `HUMALOG KwikPen 200 IU/ml` (`insulin lispro`, `EXP 2027-09`) mealtime pen carton caught against prescribed `Humalog 100 IU/ml` (`strength 200 IU/ml differs from your 100 IU/ml`).
  - `ig_04` (`warning`): Concentrated 2x `TRESIBA FlexTouch 200 IU/ml` (`insulin degludec`, `EXP 2027-12`) cylindrical pen barrel caught against prescribed `Tresiba 100 IU/ml` (`strength 200 IU/ml differs from your 100 IU/ml`).
- **GLP-1 pen dose-escalation steps (3):**
  - `ig_05` (`warning`): Leftover starter-step `OZEMPIC 0.25 mg` (`semaglutide`, `EXP 2027-08`) pen carton in refrigerator door flagged against prescribed `Ozempic 0.5 mg` maintenance dose (`strength 0.25 mg differs from your 0.5 mg`).
  - `ig_06` (`match`): Prescribed weekly maintenance `OZEMPIC 0.5 mg` (`semaglutide`, `EXP 2027-11`) pen carton matched cleanly (`matches ozempic`, `taken today: 0/1`).
  - `ig_07` (`warning`): Look-alike teal escalation `OZEMPIC 1 mg` (`semaglutide`, `EXP 2027-10`) cylindrical pen barrel caught against prescribed `Ozempic 0.5 mg` (`strength 1 mg differs from your 0.5 mg`).
- **Thumb grip and specular glare dose-window abstentions (2):**
  - `ig_08` (`unsure`): Thumb gripping `HUMALOG KwikPen` (`insulin lispro`) barrel directly over the `100` vs `200 IU/ml` concentration window (`strength_read = null`, `strength_conf = 0.0`, `strength not readable`, coaching guidance to move thumb).
  - `ig_09` (`unsure`): Overhead kitchen lamp specular glare washing out the mg dose window on `OZEMPIC` (`semaglutide`) barrel (`strength_read = null`, `strength_conf = 0.0`, `strength not readable`, coaching guidance to tilt away from light).
- **Expired carton, duplicate daily basal dose, and basal/bolus swap traps (3):**
  - `ig_10` (`warning`): Worn fridge-back backup `LANTUS SoloStar 100 IU/ml` carton past expiry `EXP 04/2025` (`expired 2025-04`).
  - `ig_11` (`warning`): Bedtime basal `LANTUS SoloStar 100 IU/ml` pen barrel picked up again after `2026-11-14T19:15:00+02:00` dose was already logged today (`matches lantus`, `taken today: 1/1`).
  - `ig_12` (`warning`): Rapid-acting bolus `NOVORAPID FlexPen 100 IU/ml` (`insulin aspart`) carton held up when only basal insulin (`Lantus 100 IU/ml`) and `Ozempic 0.5 mg` are on the medication list (`not on your medication list`).
