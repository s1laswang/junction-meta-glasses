# Cylindrical Vial and Pen Wrap Safety Suite (`glasses_cylindrical_vial_wrap`)

Evaluates HoldUp label reading and deterministic safety checking under first-person Ray-Ban Meta downward-gaze (~35 deg) views of handheld cylindrical prescription pill bottles, ophthalmic eye-drop squeeze bottles, and prefilled insulin pens where wrap-around labels curve and foreshorten across the cylinder limb.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, concurrency `4 <= 6`)
- Coercion and safety check: `toLabelRead` logic (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Temporary image rendering: 3D downward-gaze (~35 deg) cylindrical ray-intersection renders in `/tmp` only (no `.jpg`/`.png` committed)

## Case Categories (12 cases)

- `readable_curved_vial` (`cv_01` to `cv_06`, 6 cases): Front-curved downward-gaze (~35 deg) cylindrical containers with elliptical text arc and foreshortened right-limb strength units that remain legible, covering amber pill bottle Metoprolol `25 mg` (`cv_01` `match`), sterile eye-drop bottle Timolol `0.5%` (`cv_02` `match`), prefilled Lantus insulin glargine `100 IU/mL` pen (`cv_03` `match`), wrong-strength Timolol `0.25%` eye-drop bottle (`cv_04` `warning`), concentrated Toujeo insulin glargine `300 IU/mL` pen vs prescribed `100 IU/mL` (`cv_05` `warning`), and white HDPE Burana ibuprofen `400 mg` NSAID bottle (`cv_06` `warning`).
- `limb_wrapped_strength_clip` (`cv_07` to `cv_12`, 6 cases): Rotated cylindrical containers where critical fields wrap around the curved cylinder horizon, including Metformin `500 mg` pill bottle clipping trailing zeros and `mg` unit around the right limb (`cv_07`), Metoprolol `25 mg` pill bottle wrapping strength and `mg` unit past the right curve (`cv_08`), narrow Timolol `0.5%` eye-dropper wrapping concentration around the squeeze-bottle edge (`cv_09`), narrow Lantus `100 IU/mL` insulin pen clipping trailing zeros and `IU/mL` unit around the barrel (`cv_10`), 180-deg rotated amber vial showing only the back sticker seam and storage text (`cv_11`), and a 2-frame insufficient wrist-roll sequence keeping `25 mg` wrapped past the right limb in both frames (`cv_12`), all requiring `unsure` abstention (`confident_wrong_count == 0`).

## Measured Results (`results.json`)

- `n_cases`: 12 (0 timeouts, `error_count`: 0)
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 limb-wrapped or trailing-zero-clipped cylindrical cases)
- `readable_curved_vial_accuracy`: 1.0 (6/6)
- `limb_wrapped_abstention_rate`: 1.0 (6/6)
- `latency_p50_ms`: 3036.8 ms, `latency_p95_ms`: 4088.8 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/glasses_cylindrical_vial_wrap/run.py --check
TMPDIR=/dev/shm python3 eval/suites/glasses_cylindrical_vial_wrap/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/glasses_cylindrical_vial_wrap/run.py
```
