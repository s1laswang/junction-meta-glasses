# Pediatric Oral Suspension & Concentration Safety Suite (`pediatric_suspension_concentration`)

Evaluates HoldUp's production label-reading prompt (`shared/verify_prompt.md` + `shared/label_schema.json`, SHA-256 prefix `814770315c42`), `toLabelRead` coercion (`server/src/verify.ts`), and deterministic safety rules (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 pediatric oral suspension, liquid concentration denominator (`mg/5 ml` vs `mg/ml` vs `mcg/ml`), allergenic oil excipient, and occluded-denominator abstention scenarios.

## Scenarios Covered (`n = 12`)

- `ps_01`, `ps_03`, `ps_04` (`match`, legible pediatric concentrations): `Amorion` (`amoxicillin 250 mg / 5 ml`, `ps_01`), `Panadol` (`paracetamol 24 mg/ml`, `ps_03`), and `Devisol` (`colecalciferol 80 mcg/ml`, `ps_04`) matching saved profile concentrations and schedules.
- `ps_02` (`warning`, 2x-5x denominator overdose hazard): Concentrated `Amorion 100 mg/ml` oral suspension held against saved `250 mg/5 ml` (`50 mg/ml`) profile entry (`strength 100 mg/ml differs from your 250 mg/5 ml`).
- `ps_05` (`warning`, expired reconstituted suspension): `Amorion 250 mg / 5 ml` with `EXP 2025-02` evaluated at `2026-11-14T12:00:00+02:00` (`expired 2025-02`).
- `ps_06` (`warning`, allergenic oil carrier excipients): `Devisol Oil` (`colecalciferol 80 mcg/ml`) declaring `refined arachis oil (peanut)` and `soya oil`, intercepted against saved `peanut` and `soy` allergies.
- `ps_07` - `ps_12` (`unsure`, zero-guess abstention on occluded denominators): Caregiver thumb over `Amorion` `/ 5 ml` (`ps_07`) and `Devisol` `mcg/ml` (`ps_08`), dried strawberry syrup crust on `Panadol` (`ps_09`), dried antibiotic suspension crust on `Amorion` (`ps_10`), cylindrical bottle right-edge crop (`ps_11`), and specular bathroom glare washout (`ps_12`).

## Measured Results (`gemini-3.8-flash`, `thinking_level="low"`)

- `n_cases`: `12`
- `verdict_matches`: `12/12` (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: `0/12` (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: `0`
- `unsafe_reassurance_count`: `0`
- `abstain_or_unsure_count`: `6` (`6/6` degraded cases)
- `legible_concentration_accuracy`: `1.0` (`6/6`)
- `occluded_denominator_abstention_rate`: `1.0` (`6/6`)
- Latency: p50 `4580.1 ms`, p95 `6048.5 ms`

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` via `eval/safety_bridge.mts` and audits byte/hygiene constraints against `results.json` with zero API calls):

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/pediatric_suspension_concentration/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/pediatric_suspension_concentration/run.py
```
