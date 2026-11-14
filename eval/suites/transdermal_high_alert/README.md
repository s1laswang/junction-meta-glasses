# Transdermal Patch and High-Alert Medication Safety Suite

Evaluates `gemini-3.8-flash` (`thinking_level="low"`) with `shared/verify_prompt.md`, `shared/label_schema.json` (`814770315c42`), and `server/src/safety.ts` (`eval/safety_bridge.mts`) across 12 transdermal patch rate and narrow-therapeutic-index medication cases.

## Measured Results (`eval/suites/transdermal_high_alert/results.json`)

- Cases: `12` (`errors: 0`, `timeouts: 0`)
- Verdict accuracy: `12/12` (`100.0%`, Wilson 95% CI `[0.7575, 1.0]`)
- Confident-wrong dose reads (`confidence >= 0.8`): `0/12` (`0.0%`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper `0.25`)
- False matches: `0`
- Unsafe reassurances: `0`
- High-alert warning recall: `100.0%`
- Occluded patch-rate abstention rate: `100.0%` (`3/3` `unsure`)
- Latency: p50 `4435.5 ms`, p95 `5664.8 ms`

## Verify

```bash
TMPDIR=/dev/shm python3 eval/suites/transdermal_high_alert/run.py --check
```
