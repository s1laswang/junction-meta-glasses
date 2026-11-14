# Finnish and Nordic Annosjakelu / ApoDos Sachet Safety Suite (`annosjakelu_sachets`)

Evaluates HoldUp label reading and deterministic safety checking on automated multi-dose pharmacy cellophane pouches (`koneellinen annosjakelu` / `ApoDos`), covering Finnish and bilingual Nordic thermal dose-roll sachets as well as torn perforations, specular cellophane glare, thermal printhead dropout, thumb-grip occlusion, and severely defocused crumpled pouches.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `sachet_readable` (`aj_01` to `aj_07`, 7 cases): Readable Finnish and Nordic multi-dose sachets covering `ILTA 20:00` `Amlodipin 5 mg` match, bilingual `AAMU / MORGON 08:00` `Bisoprolol 2,5 mg` comma-decimal match, `AAMU 08:00` `Thyroxin 50 mikrog` microgram match, wrong-dose `Amlodipin 10 mg` vs `5 mg` warning, `TARVITTAESSA` `Burana 400 mg` NSAID avoid warning, `Amorion 500 mg` penicillin allergy warning, and expired `Metformin 500 mg` (`EXP 2025-03`) warning.
- `perforation_tear_degraded` (`aj_08`, 1 case): Perforation seam tear ripping away the strength field on an `Amlodipin` sachet, requiring `unsure` abstention.
- `cellophane_glare_degraded` (`aj_09`, 1 case): Specular cellophane film glare obliterating the strength digits on a `Metformin` sachet, requiring `unsure` abstention.
- `thermal_dropout_degraded` (`aj_10`, 1 case): Thermal printhead dropout leaving the strength band blank on a `Bisoprolol` `ApoDos` pouch, requiring `unsure` abstention.
- `thumb_occlusion_degraded` (`aj_11`, 1 case): Thumb gripping directly over the strength badge on a `Thyroxin` sachet, requiring `unsure` abstention.
- `crumpled_blur_degraded` (`aj_12`, 1 case): Severely defocused crumpled cellophane sachet with smeared thermal print, requiring `unsure` abstention.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 5 (5/5 degraded sachets; `readable_sachet_accuracy`: `1.0`, `degraded_abstention_rate`: `1.0`)
- `latency_p50_ms`: 3672.7 ms, `latency_p95_ms`: 5089.9 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/annosjakelu_sachets/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/annosjakelu_sachets/run.py
```
