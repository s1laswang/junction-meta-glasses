# Nordic Pharmacy Unit-Dose Sachet and Dosett Suite (`nordic_apodos_pouches`)

Evaluates HoldUp label reading and deterministic safety checking on Finnish (`Anja` annosjakelupussi) and Swedish (`Apodos` dospase) automated pharmacy unit-dose dispensing sachets and unlabeled weekly Dosett pill compartments, directly supporting HoldUp's Finnish NKL and older-adult home-care adoption scenario.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, concurrency `3`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Ephemeral rendering: 12 first-person `768x768` frames rendered exclusively in `/dev/shm/holdup_apodos` (fine black thermal dot-matrix print on translucent heat-sealed sachet film, plus a weekly plastic pill organizer) and deleted in `finally`
- Profile medications: Amlodipine `5 mg` (evening), Bisoprolol `2.5 mg` (morning), Levothyroxine `100 mikrog` (morning), Atorvastatin `20 mg` (evening); allergies: `penicillin`; avoid: `NSAIDs`

## Case Categories (12 cases)

- `sharp_anja_match` (`ap_01`, 1 case): Sharp Finnish Anja sachet `Amlodipiini 5 mg` (`EXP 2027-09`) matched to `Amlodipine 5 mg` evening profile (`match`).
- `sharp_apodos_comma_match` (`ap_02`, 1 case): Sharp Swedish Apodos sachet `Bisoprolol 2,5 mg` (`EXP 2027-10`) normalized from comma decimal and matched to `Bisoprolol 2.5 mg` morning profile (`match`).
- `sharp_anja_microgram_match` (`ap_03`, 1 case): Sharp Finnish Anja sachet `Levothyroxine 100 mikrog` (`EXP 2027-11`) matched to `Levothyroxine 100 mikrog` morning profile (`match`).
- `sharp_apodos_match` (`ap_04`, 1 case): Sharp Swedish Apodos sachet `Atorvastatin 20 mg` (`EXP 2027-11`) with off-text film crinkles matched to `Atorvastatin 20 mg` evening profile (`match`).
- `wrong_strength_sachet` (`ap_05`, 1 case): Wrong-strength Anja sachet `Amlodipiini 10 mg` vs `5 mg` profile caught as `warning`.
- `unlisted_nsaid_sachet` (`ap_06`, 1 case): Unlisted PRN pain sachet `Ibuprofeeni 400 mg` caught by both the medication list check and `avoid: ["NSAIDs"]` (`warning`).
- `expired_sachet` (`ap_07`, 1 case): Expired Anja sachet `Bisoprolol 2,5 mg` printed `EXP 2025-03` (evaluated at `2026-11-14T14:00:00+02:00`) caught as `warning`.
- `already_logged_today` (`ap_08`, 1 case): Sharp Anja sachet `Amlodipiini 5 mg` evaluated when today's `amlodipine` evening dose is already recorded in `doseLog` (`warning`).
- `crinkled_glare_strength` (`ap_09`, 1 case): Crinkled cellophane specular reflection washing out the strength field on `Amlodipiini`, abstaining to `unsure`.
- `faded_thermal_strength` (`ap_10`, 1 case): Thermal printhead dropout and pocket wear erasing the strength field on `Bisoprolol`, abstaining to `unsure`.
- `thumb_occluded_name` (`ap_11`, 1 case): Wearer thumb pinching the top half of the sachet over the medicine name while `5 mg` remains legible, abstaining to `unsure`.
- `unlabeled_dosett_compartment` (`ap_12`, 1 case): Unlabeled translucent weekly Dosett plastic compartment holding loose white tablets with no drug name or strength printed, abstaining to `unsure` without guessing loose pills.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 4 (4 / 4 degraded or unlabeled cases)
- `api_error_count`: 0, `timeout_count`: 0
- `latency_p50_ms`: 3598.1 ms, `latency_p95_ms`: 4685.1 ms
- `sharp_sachet_verdict_accuracy`: 1.0 (8 / 8)
- `degraded_or_unlabeled_abstention_rate`: 1.0 (4 / 4)

## Verify and Re-run

Offline verification (`< 2 s`, re-runs `server/src/safety.ts` `checkLabel` via `eval/safety_bridge.mts` against `results.json` without API calls):

```bash
python3 eval/suites/nordic_apodos_pouches/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/nordic_apodos_pouches/run.py
```
