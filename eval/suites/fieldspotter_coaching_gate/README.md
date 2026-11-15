FieldSpotter ONNX Spatial Coach and Zero-Guess Gate Suite (`fieldspotter_coaching_gate`)
========================================================================================

Evaluates HoldUp's 2-tier safety architecture across both held-out dataset metrics and 12 glasses-POV synthetic and degraded medicine cartons:

1. Tier 1 local spatial coach: CPU-only `web/public/models/fieldspotter.onnx` (`CPUExecutionProvider`, `[1, 3, 640, 640]` float32 RGB normalized `0..1` -> `[1, 8, 8400]`, gating `"strength_visible"` at `conf >= 0.40`).
2. Tier 2 zero-guess reader and deterministic safety gate: `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`, `prompt_sha256_12` `814770315c42`) scored by `server/src/safety.ts` via `eval/safety_bridge.mts` (`STRENGTH_MIN_CONF = 0.80`).

Temporary PIL frames render only inside `/dev/shm/holdup_fs_gate` and are deleted in `finally:`. Zero images, comments, or base64 blobs are committed.

Held-Out 2-Tier Gate Audit (`held_out_gate_audit`)
--------------------------------------------------

Derived deterministically from `eval/results/fieldspotter.json` (`n = 348` held-out validation images) and `eval/results/v1_results.json` (`1,740` scored images):

- Tier 1 (`fieldspotter.onnx` CPU at `conf >= 0.40`, `n = 348`): `tp = 122`, `fp = 4`, `fn = 64`, `tn = 158`; `"strength visible"` precision `96.8%` (Wilson 95% CI `[92.1%, 98.8%]`), recall `65.6%` (`[58.5%, 72.0%]`), hidden-strength specificity `97.5%` (`158 / 162` hidden-strength frames intercepted locally; `2.47%` false-pass rate), ONNX CPU latency `p50 = 34.5 ms` / `p95 = 35.3 ms` (`29.0 fps`).
- Tier 2 (`gemini-3.8-flash` + `server/src/safety.ts` at `conf >= 0.80`): `0 / 754` confident-wrong strength reads (rule-of-three 95% upper bound `0.004`), `98.4%` (`187 / 190`) hidden-strength abstention with `0` hidden-strength wrong reads, cloud verify latency `p50 = 3430.0 ms` / `p95 = 5550.0 ms`.
- Combined 2-tier gate: `97.5%` of hidden-strength frames receive an immediate local spatial coaching cue `99.4x` faster than a full cloud verify (`34.5 ms` vs `3430.0 ms` p50), with `0` joint confident-wrong strength reads (joint 95% upper bound `0.000098`).

Live End-to-End Cases (`n_cases = 12`)
--------------------------------------

- `clean_front` (`fsg_01` .. `fsg_04`, 4 cases): Clean front glasses-POV medicine cartons (`Amlodipine Orion 5 mg`, `Metformin Orion 500 mg`, `Atorvastatin Krka 20 mg`, and `Burana Ibuprofen 400 mg` NSAID avoid) -> FieldSpotter `strength_box_conf` `0.6613` to `0.7715` (`ready_to_verify`), `gemini-3.8-flash` + `safety.ts` returns `match` x3 and `warning` x1.
- `thumb_occlusion` (`fsg_05` .. `fsg_08`, 4 cases): Skin-toned thumb/finger occluding `5 mg`, `500 mg`, `20 mg`, and a `10 mg` wrong-strength trap while the product name stays clear (`product_box_conf` `0.6975` to `0.7879`) -> FieldSpotter `strength_box_conf` `0.0005` to `0.0006` (`< 0.40`) triggers `slide_thumb_off_strength`, and `gemini-3.8-flash` + `safety.ts` returns `unsure` (`0` confident-wrong doses, `0` `< 0.8` dose leaks).
- `crop_or_back` (`fsg_09` .. `fsg_10`, 2 cases): Bottom-edge crop cutting off `5 mg` strength (`strength_box_conf = 0.1183`) and back-of-box EAN-13 barcode-only view (`strength_box_conf = 0.0003`) -> FieldSpotter triggers `center_or_turn_box`, and `gemini-3.8-flash` + `safety.ts` returns `unsure`.
- `blur_or_glare` (`fsg_11` .. `fsg_12`, 2 cases): Heavy glasses-POV motion blur (`strength_box_conf = 0.0005`) and specular ceiling-lamp glare hotspot over `20 mg` (`strength_box_conf = 0.0017`) -> FieldSpotter triggers `hold_steady_or_tilt_glare`, and `gemini-3.8-flash` + `safety.ts` returns `unsure`.

Measured Suite Summary (`results.json`)
---------------------------------------

- `verdict_matches`: `12 / 12` (`verdict_accuracy = 1.0`, Wilson 95% CI `[0.7575, 1.0]`), `0` errors, `0` timeouts
- `fieldspotter_gate_matches`: `12 / 12` (`1.0`), `coach_cue_matches`: `12 / 12`
- `confident_wrong_count`: `0` (`0.0`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper `0.25`)
- `false_match_count`: `0`, `unsafe_reassurance_count`: `0`, `low_conf_dose_leak_count`: `0`
- `abstain_or_unsure_count`: `8 / 8` degraded frames (`100%` abstention)
- Suite CPU ONNX latency (under concurrent fleet load): `p50 = 113.9 ms`, `p95 = 159.3 ms`
- Suite `gemini-3.8-flash` verify latency: `p50 = 3801.8 ms`, `p95 = 5712.8 ms`

Verification Commands
---------------------

```bash
/tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/fieldspotter_coaching_gate/run.py
NODE_PATH=/tmp/fleet-root/wt/node_modules env -u GEMINI_API_KEY /tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/fieldspotter_coaching_gate/run.py --check
NODE_PATH=/tmp/fleet-root/wt/node_modules /tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python -c "import pathlib, eval.test_suites as t; t.validate_suite_dir(pathlib.Path('eval/suites/fieldspotter_coaching_gate')); print('PASS')"
/tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/compile_suites.py
```
