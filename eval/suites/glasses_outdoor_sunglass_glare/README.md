# Outdoor Sunglass and Window Glare Safety Suite (`glasses_outdoor_sunglass_glare`)

Evaluates HoldUp label reading and deterministic safety checking under first-person Ray-Ban Meta outdoor pharmacy pickup, window-glare, wearer-head shadow, and dim evening tungsten lighting conditions.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `readable_glare_and_shadow` (`sg_01` to `sg_06`, 6 cases): Off-strength specular sun glint on laminated carton (`sg_01` Amlodipine 5 mg `match`), sharp diagonal wearer-head shadow splitting the box (`sg_02` Burana ibuprofen 400 mg NSAID `warning`), dim evening kitchen tungsten light plus CMOS sensor grain (`sg_03` wrong-strength Amlodipine 10 mg `warning`, `sg_06` safe Nordic Oat Drink `info`), window-mullion diagonal shadow plus off-strength laminate glint (`sg_04` Metformin 500 mg `match`), and outdoor sun glint plus wearer shadow on food (`sg_05` Peanut and Hazelnut Bar `warning`).
- `blown_highlight_occlusion` (`sg_07` to `sg_12`, 6 cases): Saturated white window-sun reflection directly over the Amlodipine strength badge obliterating `5 mg` (`sg_07`), silhouetted backlit carton held up against a bright window with unreadable front text (`sg_08`), solar lens-flare streak and aperture ghost obliterating Metformin active ingredient and strength (`sg_09`), broad midday UV-varnish sun sheet reflection obliterating Atorvastatin `20 mg` strength (`sg_10`), outdoor sun reflection obliterating snack wrapper ingredients and allergens (`sg_11`), and a 2-frame outdoor head-turn glare sweep obliterating strength in both frames (`sg_12`), all requiring `unsure` abstention (`confident_wrong_count == 0`).

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 blown-highlight, backlit-silhouette, or lens-flare occluded cases)
- `readable_glare_and_shadow_accuracy`: 1.0 (6/6)
- `blown_highlight_abstention_rate`: 1.0 (6/6)
- `latency_p50_ms`: 4245.9 ms, `latency_p95_ms`: 5800.3 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/glasses_outdoor_sunglass_glare/run.py --check
TMPDIR=/dev/shm python3 eval/suites/glasses_outdoor_sunglass_glare/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/glasses_outdoor_sunglass_glare/run.py
```
