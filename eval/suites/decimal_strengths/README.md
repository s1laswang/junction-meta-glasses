# Decimal and Microgram Look-Alike Strength Suite (`decimal_strengths`)

Evaluates HoldUp label reading and deterministic safety checking across decimal separator conventions, tenfold look-alike overdose strengths, microgram vs milligram unit hazards, unit-equivalent strengths, and occluded or cropped decimal/unit regions.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Profile medications: Bisoprolol `2.5 mg` (morning), Clonazepam `0.5 mg` (evening), Zopiclone `7.5 mg` (bedtime), Levothyroxine `100 mikrog` (morning), Warfarin `3 mg` (evening)

## Case Categories (12 cases)

- `comma_decimal` (`ds_01`, `ds_05`, 2 cases): Sharp Finnish comma-decimal cartons (`Bisoprolol Orion 2,5 mg`, `Zopinox 7,5 mg`) normalized to dot decimals and matched against `2.5 mg` and `7.5 mg` profile entries.
- `leading_zero_decimal` (`ds_03`, 1 case): Sharp `Clonazepam 0.5 mg` carton matched against `0.5 mg` evening profile.
- `tenfold_overdose` (`ds_02`, `ds_04`, 2 cases): Sharp 10x look-alike cartons (`Bisoprolol 25 mg` vs `2.5 mg`, `Clonazepam 5 mg` vs `0.5 mg`) caught as `warning`.
- `microgram_unit` (`ds_06`, 1 case): Sharp `Thyroxin 100 mikrog` carton matched against `Levothyroxine 100 mikrog`.
- `unit_hazard_1000x` (`ds_07`, 1 case): Sharp `Levothyroxine 100 mg` carton (1000x overdose vs `100 mikrog`) caught as `warning`.
- `unit_equivalence` (`ds_08`, 1 case): Sharp `Levothyroxine 0.1 mg` carton matched as unit-equivalent to `100 mikrog` via `sameStrength`.
- `decimal_occlusion` (`ds_09`, 1 case): Thumb and smudge covering the decimal region between `2` and `5` on `Bisoprolol`, requiring `unsure`.
- `leading_zero_glare` (`ds_10`, 1 case): Specular glare obscuring the leading `0.` before `5 mg` on `Clonazepam`, requiring `unsure`.
- `strength_motion_blur` (`ds_11`, 1 case): Heavy directional motion blur across the `Zopinox` strength badge, requiring `unsure`.
- `unit_cropped` (`ds_12`, 1 case): `Thyroxin` carton cropped at the right frame border so `100` is visible while the unit (`mikrog` or `mg`) is cut off, requiring `unsure`.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 4 (4/4 occluded, glare-washed, blurred, or unit-cropped cases)
- `latency_p50_ms`: 3852.9 ms, `latency_p95_ms`: 5983.6 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
python3 eval/suites/decimal_strengths/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/decimal_strengths/run.py
```
