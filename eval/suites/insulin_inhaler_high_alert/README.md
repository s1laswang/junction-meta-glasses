# High-Alert Insulin Pens and Metered Inhalers Suite (`insulin_inhaler_high_alert`)

Evaluates HoldUp label reading and deterministic safety checking across high-alert insulin pens, Nordic `KY/ml` vs `IU/ml` concentration equivalence, concentrated U-300 insulin pens, rapid-acting vs basal look-alike pens, dry-powder and metered-dose inhalers (`mikrog` vs `mcg`), expired pen cartons, already-taken evening basal insulin, and thumb/glare/motion-blur abstentions.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, concurrency `3`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Ephemeral rendering: 12 first-person images rendered only in `/dev/shm/holdup_insulin_inhaler` and removed in `finally`
- Profile medications: Lantus (`glargine`, `100 IU/ml`, evening), Pulmicort (`budesonide`, `200 mcg`, morning and evening), Ventoline (`salbutamol`, `100 mcg`, morning)

## Case Categories (12 cases)

- `matching_basal_pen_iu` (`ih_01`, 1 case): Sharp `Lantus SoloStar` (`insulin glargine 100 IU/ml`) pre-filled pen matched against `100 IU/ml` evening profile (`match`).
- `nordic_ky_iu_equivalence` (`ih_02`, 1 case): Sharp Finnish `Abasaglar KwikPen` (`insuliiniglargiini / insulin glargine 100 KY/ml`) carton matched as unit-equivalent to `100 IU/ml` (`match`).
- `concentrated_u300_pen` (`ih_03`, 1 case): Concentrated `Toujeo SoloStar` (`insulin glargine 300 IU/ml`, U-300) pen flagged for wrong strength against `100 IU/ml` profile (`warning`).
- `rapid_vs_basal_lookalike` (`ih_04`, 1 case): Rapid-acting `NovoRapid FlexPen` (`insulin aspart 100 IU/ml`) held up instead of basal glargine flagged as not on medication list (`warning`).
- `matching_dpi_mikrog_mcg` (`ih_05`, 1 case): Sharp `Pulmicort Turbuhaler` (`budesonide 200 mikrog`) dry-powder inhaler matched against `200 mcg` profile (`match`).
- `matching_mdi_salbutamol` (`ih_06`, 1 case): Sharp `Ventoline Evohaler` (`salbutamol 100 mikrog`) metered-dose inhaler matched against `100 mcg` profile (`match`).
- `wrong_strength_inhaler` (`ih_07`, 1 case): `Pulmicort Turbuhaler` (`budesonide 400 mikrog`) flagged for wrong strength against `200 mcg` profile (`warning`).
- `expired_insulin_carton` (`ih_08`, 1 case): Expired `Lantus SoloStar` carton (`EXP 2025-05` evaluated at `2026-11-14`) flagged as expired (`warning`).
- `already_taken_basal_insulin` (`ih_09`, 1 case): Valid `Lantus SoloStar 100 IU/ml` carton checked when today's evening basal insulin dose is already logged (`warning`).
- `thumb_occluded_pen_concentration` (`ih_10`, 1 case): Pen barrel with thumb covering the concentration digits before `IU/ml`, abstaining without guessing dose (`unsure`).
- `glare_inhaler_microgram_badge` (`ih_11`, 1 case): Dry-powder inhaler with specular glare washing out the microgram badge, abstaining (`unsure`).
- `heavy_motion_blur` (`ih_12`, 1 case): Handheld metered inhaler under heavy directional motion blur, abstaining (`unsure`).

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 3 (3 / 3 occluded, glare-washed, or motion-blurred cases)
- `api_error_count`: 0
- `timeout_count`: 0
- `latency_p50_ms`: 4098.4 ms, `latency_p95_ms`: 5694.6 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` in under 2 seconds without API calls):

```bash
python3 eval/suites/insulin_inhaler_high_alert/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/insulin_inhaler_high_alert/run.py
```
