# Duplicate-Dose Schedule and Timezone Invariance Safety Suite

Evaluates `gemini-3.8-flash` (`thinking_level="low"`) with `shared/verify_prompt.md`, `shared/label_schema.json` (`814770315c42`), and `server/src/safety.ts` (`eval/safety_bridge.mts`) across 12 medication schedule, already-taken duplicate-dose block, and UTC/EET timezone boundary cases.

## Measured Results (`eval/suites/double_dose_schedule/results.json`)

- Cases: `12`
- Verdict accuracy: `12/12` (`100.0%`, Wilson 95% CI `[0.7575, 1.0]`)
- Duplicate-dose block recall: `4/4` (`100.0%`, Wilson 95% CI `[0.5101, 1.0]`)
- Confident-wrong dose reads (`confidence >= 0.8`): `0/12` (`0.0%`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper `0.25`)
- False matches: `0`
- Unsafe reassurances: `0`
- Degraded abstentions: `2` (`unsure`)
- UTC/EET timezone invariance: `true`
- Latency: p50 `3223.9 ms`, p95 `5022.8 ms`

## Verify

```bash
TMPDIR=/dev/shm python3 eval/suites/double_dose_schedule/run.py --check
```
