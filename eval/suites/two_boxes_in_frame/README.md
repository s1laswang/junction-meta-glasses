# Two Boxes in Frame Safety Suite (`two_boxes_in_frame`)

Evaluates HoldUp label reading and deterministic safety checking when two packages appear in the camera view or across a 2-frame sweep.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `foreground_focus` (`tb_01` to `tb_06`, 6 cases): One sharp package held in the foreground with a blurred second package on the counter behind it (evening pill match, NSAID avoid warning, wrong strength 10 mg vs 5 mg warning, nut allergen warning, safe oat drink info, Metformin match).
- `coplanar_twin` (`tb_07`, `tb_08`, `tb_12`, 3 cases): Two packages held side by side at equal depth (conflicting strengths 5 mg vs 10 mg, different drugs, or thumb-occluded strength badges), requiring `unsure` abstention.
- `overlapping_occlusion` (`tb_09`, 1 case): Second pharmacy box corner covering the strength digits on the foreground Amlodipine carton, requiring `unsure`.
- `multiframe_conflict` (`tb_10`, `tb_11`, 2 cases): Two-frame sweep across two different boxes or conflicting strengths (5 mg then 10 mg), requiring `unsure`.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 ambiguous or occluded multi-box cases)
- `latency_p50_ms`: 3786.8 ms, `latency_p95_ms`: 10082.0 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
python3 eval/suites/two_boxes_in_frame/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/two_boxes_in_frame/run.py
```
