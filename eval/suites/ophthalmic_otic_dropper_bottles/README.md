# Ophthalmic vs Otic Dropper Bottles Micro-Label Suite (`ophthalmic_otic_dropper_bottles`)

Evaluates HoldUp label reading and deterministic safety checking on tiny 5 to 15 ml glaucoma eye-drop bottles, single-dose ophthalmic pipettes, and look-alike ear-drop or oral dropper bottles held in first-person view.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, `concurrency`: `3`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Ephemeral image rendering: 12 first-person JPEG frames rendered only in `/dev/shm/holdup_eyedrops` and deleted in `finally`
- Profile medications and allergies: Timolol `0.5 %` (morning, evening), Latanoprost `50 mcg` (evening), Dorzolamide `2 %` (morning, evening); allergy `penicillin`; avoid `NSAIDs`

## Case Categories (12 cases)

- `ophthalmic_carton_match` (`eo_01`, 1 case): Sharp Finnish `TIMOLOL ORION 0,5 %` glaucoma eye-drop carton normalized to `0.5 %` and matched against `0.5 %` profile (`match`).
- `ophthalmic_bottle_match` (`eo_02`, 1 case): Sharp 5 ml `OFTAN TIMOLOL 0.5 %` LDPE dropper bottle matched against `0.5 %` profile (`match`).
- `single_dose_pipette_match` (`eo_03`, 1 case): Sharp `MONOPROST` (`latanoprost`) `50 mikrog` preservative-free single-dose pipette strip matched as unit-equivalent to `50 mcg` evening profile (`match`).
- `wrong_strength_glaucoma_bottle` (`eo_04`, 1 case): Sharp `OFTAN TIMOLOL 0.25 %` 5 ml glaucoma bottle caught as wrong strength against `0.5 %` profile (`warning`).
- `otic_lookalike_otipax` (`eo_05`, 1 case): Look-alike 10 ml `OTIPAX` (`phenazone, lidocaine` `40 mg/g + 10 mg/g`) ear-drop bottle caught as not on medication list (`warning`).
- `otic_lookalike_ciprofloxacin` (`eo_06`, 1 case): Look-alike 10 ml `CIPROFLOXACIN 0.3 %` antibiotic ear-drop bottle caught as not on medication list (`warning`).
- `penicillin_allergy_dropper_bottle` (`eo_07`, 1 case): `AMOXICILLIN 100 mg/ml` 15 ml oral dropper bottle caught against `penicillin` drug allergy (`warning`).
- `expired_ophthalmic_bottle` (`eo_08`, 1 case): `OFTAN TIMOLOL 0.5 %` eye-drop bottle with `EXP 2025-06` caught as expired despite matching dose (`warning`).
- `cylindrical_wrap_clipped_strength` (`eo_09`, 1 case): Curved 5 ml cylindrical `OFTAN TIMOLOL` dropper bottle clipping the strength badge around the right cylinder edge (`unsure`).
- `wet_tear_smudged_strength` (`eo_10`, 1 case): `LATANOPROST` eye-dropper bottle with wet tear droplets and smeared ink across the strength badge (`unsure`).
- `thumb_occluding_concentration` (`eo_11`, 1 case): Pinch-gripped 5 ml `OFTAN TIMOLOL` dropper bottle with thumb covering the concentration badge (`unsure`).
- `out_of_focus_closeup_bottle` (`eo_12`, 1 case): Extreme close-up 5 ml dropper bottle held inside focus distance with severe optical defocus (`unsure`).

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 4 (4/4 degraded micro-label cases abstained with 0 confident-wrong)
- `api_error_count`: 0, `timeout_count`: 0
- `latency_p50_ms`: 2751.9 ms, `latency_p95_ms`: 4484.7 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` in under 2 seconds without API calls):

```bash
python3 eval/suites/ophthalmic_otic_dropper_bottles/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/ophthalmic_otic_dropper_bottles/run.py
```
