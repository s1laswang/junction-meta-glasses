# Expiry Formats Safety Suite (`expiry_formats`)

Evaluates HoldUp label reading, ISO date normalization, boundary date logic, and deterministic safety checking across international, Nordic, debossed, and degraded expiry labels.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Reference timestamp: `2026-11-14T12:00:00+02:00`
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `expired_intl` (`ex_01`, `ex_04`, 2 cases): Expired English (`EXP 03/2025`) and German (`Verwendbar bis 05.2025`) medication cartons requiring `warning`.
- `expired_nordic` (`ex_02`, `ex_03`, 2 cases): Expired Finnish (`Käyt. viim. 02.2025`) and Swedish (`Utg.dat 2024-12`) packs requiring `warning`.
- `debossed_flap` (`ex_05`, 1 case): Low-contrast uninked debossed cardboard end-flap (`EXP 2025-01`) on Panadol 500 mg requiring `warning`.
- `boundary_date` (`ex_06`, `ex_07`, `ex_08`, 3 cases): Day-precision yesterday (`EXP 2026-11-13` -> `warning`), last-month (`EXP 2026-10` -> `warning`), and valid current-month (`EXP 2026-11` valid through Nov 30 -> `match`).
- `valid_future` (`ex_09`, `ex_11`, 2 cases): Future medication (`EXP 09/2027` -> `match`) and 2-digit-year food (`Best before 18 SEP 27` -> `2027-09-18`, `info`).
- `expired_food` (`ex_10`, 1 case): Expired Finnish oat drink carton (`Parasta ennen 14.03.2026` -> `warning`).
- `degraded_unreadable` (`ex_12`, 1 case): Abraded end-flap with rubbed-off strength badge and torn expiry stamp requiring `unsure` abstention (`expiry` null, `strength` null).

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `expired_catch_count`: 8 / 8 (`expired_catch_recall`: `1.0`)
- `expiry_iso_normalized_count`: 12 / 12 (`expiry_iso_normalization_rate`: `1.0`)
- `abstain_or_unsure_count`: 1 (1/1 abraded degraded pack)
- `latency_p50_ms`: 3800.7 ms, `latency_p95_ms`: 5708.5 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
python3 eval/suites/expiry_formats/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/expiry_formats/run.py
```
