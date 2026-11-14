# Paired Model Comparison Suite (`model_comparison`)

Evaluates the exact same 12 first-person synthetic medication and food label cases across `gemini-3.8-flash`, `gemini-3.5-flash`, and `gemma-4-31b-it` using HoldUp's shared prompt, JSON schema, TypeScript `toLabelRead` coercion, and deterministic `server/src/safety.ts` `checkLabel` rules.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Models evaluated on identical JPEG bytes (`image_sha256_12` recorded per case):
  - `gemini-3.8-flash` (`thinking_level`: `low`, `responseJsonSchema`)
  - `gemini-3.5-flash` (`thinking_level`: `low`, `responseJsonSchema`)
  - `gemma-4-31b-it` (`thinking_level`: `none` because `thinkingConfig` is unsupported by the endpoint; `responseJsonSchema` with graceful fallback to a JSON-only prompt and markdown code-fence stripping when schema generation fails)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Temporary JPEGs are rendered only to `/dev/shm/holdup_model_comparison` during execution and removed on completion.

## Paired Cases (12 cases)

1. `mc_01` (`med_match`): Sharp Amlodipine 5 mg box matching evening pill on profile (`expected`: `match`)
2. `mc_02` (`med_wrong_strength`): Sharp Amlodipine 10 mg wrong-strength box against 5 mg profile (`expected`: `warning`)
3. `mc_03` (`med_avoid_nsaid`): Sharp Burana ibuprofen 400 mg box triggering NSAID avoid warning (`expected`: `warning`)
4. `mc_04` (`med_mikrog_match`): Sharp Thyroxin 100 mikrog Nordic unit box matching 100 mcg profile (`expected`: `match`)
5. `mc_05` (`med_comma_decimal`): Sharp Bisoprolol 2,5 mg Nordic comma-decimal box matching 2.5 mg profile (`expected`: `match`)
6. `mc_06` (`med_expired`): Sharp Marevan warfarin 3 mg box expired in 2025-04 (`expected`: `warning`)
7. `mc_07` (`med_thumb_occluded`): Amlodipine box with thumb completely occluding the strength badge (`expected`: `unsure`)
8. `mc_08` (`med_motion_blur`): Severely motion-blurred medicine box with illegible text and strength (`expected`: `unsure`)
9. `mc_09` (`med_coplanar_twins`): Co-planar Amlodipine 5 mg and 10 mg boxes held side-by-side equally sharp (`expected`: `unsure`)
10. `mc_10` (`food_allergen_warning`): Sharp Peanut and Hazelnut Bar carton triggering nut allergy warning (`expected`: `warning`)
11. `mc_11` (`food_safe_info`): Sharp Nordic Oat Drink carton with legible nut-free oat ingredient panel (`expected`: `info`)
12. `mc_12` (`food_unreadable_allergens`): Food carton with ingredients and allergen panel occluded by hand and glare (`expected`: `unsure`)

## Measured Per-Model Results (`results.json`, `n = 12` per model)

| Model | Thinking | Schema Mode (Fallbacks) | Verdict Accuracy (Wilson 95% CI) | Confident-Wrong Rate (Wilson 95% CI; 3/n Upper) | False Match | Unsafe Reassurance | Abstain / Unsure | Latency p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | `low` | `responseJsonSchema` (0) | 12/12 = `1.0000` (`[0.7575, 1.0000]`) | 0/12 = `0.0000` (`[0.0000, 0.2425]`; `3/n = 0.2500`) | 0 | 0 | 4/4 | `3191.6` / `9158.3` |
| `gemini-3.5-flash` | `low` | `responseJsonSchema` (0) | 12/12 = `1.0000` (`[0.7575, 1.0000]`) | 0/12 = `0.0000` (`[0.0000, 0.2425]`; `3/n = 0.2500`) | 0 | 0 | 4/4 | `2808.9` / `6107.4` |
| `gemma-4-31b-it` | `none` | `responseJsonSchema+json_prompt_fallback` (1) | 11/12 = `0.9167` (`[0.6461, 0.9851]`) | 1/12 = `0.0833` (`[0.0149, 0.3539]`; `n/a`) | 1 | 0 | 3/4 | `5579.6` / `19033.1` |

Key paired findings:
- On `mc_09` (co-planar Amlodipine 5 mg and 10 mg boxes held side-by-side), both `gemini-3.8-flash` (confidence `0.70`, guidance `"Hold only one box at a time."`) and `gemini-3.5-flash` (confidence `0.75`) lowered confidence below `0.80` per Hard Rule 4 and abstained (`unsure`). `gemma-4-31b-it` violated Hard Rule 4 by merging the two separate boxes into `"5 mg + 10 mg"` at confidence `0.98`, producing a false `match` and confident-wrong read.
- `gemma-4-31b-it` does not support `thinkingConfig`, required `json_prompt_fallback` on `mc_03`, and ran at `5579.6` ms p50 / `19033.1` ms p95 versus `3191.6` ms p50 for `gemini-3.8-flash`.

## Verify and Re-run

Offline verification (re-verifies all 36 `LabelRead` outputs in `results.json` through `eval/safety_bridge.mts` with zero network calls):

```bash
python3 eval/suites/model_comparison/run.py --check
```

Full live paired evaluation across all 3 models:

```bash
python3 eval/suites/model_comparison/run.py
```
