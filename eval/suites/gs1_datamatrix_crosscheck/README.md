# EU FMD GS1 DataMatrix Cross-Check Suite (`gs1_datamatrix_crosscheck`)

Evaluates HoldUp structured label extraction (`gemini-3.8-flash`), deterministic medication safety rules (`server/src/safety.ts`), and EU Falsified Medicines Directive (FMD) GS1 DataMatrix `(01)` GTIN + `(17)` YYMMDD cross-checking (`web/src/lib/gs1.ts` and server cross-check rules) across 12 EU prescription cartons rendered in `/dev/shm`.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, concurrency `<= 4`)
- Reference timestamp: `2026-11-14T12:00:00+02:00`
- Coercion, GS1 parser, and safety check: `toLabelRead` (`server/src/verify.ts`), `parseGs1` + `sameGtin` (`web/src/lib/gs1.ts`), and `checkLabel` (`server/src/safety.ts`)
- Profile medications with saved GTIN-14s:
  - Amlodipine `5 mg` (`evening`, `gtin`: `06416542001056`)
  - Metformin `500 mg` (`morning`, `evening`, `gtin`: `06416542005009`)
  - Atorvastatin `20 mg` (`evening`, `gtin`: `06416542002008`)
  - Allergies: `penicillin`; Avoid list: `NSAIDs`

## Case Categories (12 cases)

- `agreeing_pack` (`dm_01`, `dm_02`, `dm_03`, 3 cases): Sharp Amlodipine `5 mg`, Metformin `500 mg`, and Atorvastatin `20 mg` cartons paired with `]d201...1727080010...21...` (`DD=00` month-end `2027-08` matching printed `EXP 2027-08` and saved `gtin`) -> `agrees: true`, double-checked `match`.
- `gtin_conflict` (`dm_04`, `dm_05`, 2 cases): Relabeled or wrong-sleeve cartons printing `AMLODIPINE ORION 5 mg` while the scanned GS1 DataMatrix `(01)` GTIN belongs to `Amlodipine 10 mg` (`06416542001100`) or `Atorvastatin 20 mg` (`06416542002008`) -> `agrees: false`, downgraded from text-only `match` to `unsure`.
- `expiry_conflict` (`dm_06`, `dm_07`, 2 cases): Cartons printing `EXP 2027-08` while the scanned GS1 DataMatrix encodes `(17)261200` (`2026-12`) in raw `]d2` FNC1 and parenthesized `(01)...(17)...` formats -> `agrees: false`, downgraded to `unsure` ("ask a pharmacist").
- `expired_pack_code` (`dm_08`, 1 case): Amlodipine `5 mg` carton with worn/scratched-off printed expiry (`expiry: null` from Gemini) caught as expired by GS1 DataMatrix `(17)240500` (`2024-05`) -> `warning`.
- `worn_expiry_rescued` (`dm_09`, 1 case): Metformin `500 mg` carton with worn/scratched-off printed expiry (`expiry: null` from Gemini) rescued by valid in-date GS1 DataMatrix `(17)271031` (`2027-10-31`) + matching GTIN -> `match` with code-verified expiry.
- `occluded_strength_gtin_present` (`dm_10`, 1 case): Amlodipine carton with `5 mg` covered by a thumb paired with a matching GS1 DataMatrix GTIN -> remains `unsure` (`strength` confidence `< 0.8` is never bypassed by barcode or GTIN).
- `end_flap_gtin_only` (`dm_11`, 1 case): Narrow carton end-flap showing only the 2D DataMatrix without front name or strength -> remains `unsure` (`agrees: null`) online.
- `nsaid_avoid_with_gs1` (`dm_12`, 1 case): Burana (`ibuprofen` `400 mg`) carton with valid in-date GS1 DataMatrix (`2027-11`) -> `warning` (NSAID avoid-list warning preserved).

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `crosscheck_agrees_matches`: 12 / 12 (`crosscheck_agrees_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `conflict_caught_count`: 4 / 4 (`conflict_catch_rate`: `1.0`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6
- `api_error_count`: 0, `timeout_count`: 0
- `latency_p50_ms`: 3138.0 ms, `latency_p95_ms`: 4716.1 ms
- `results.json` size: 14560 bytes (`< 15 KB`)

## Verify and Re-run

Offline verification in under 2 seconds (re-runs `parseGs1` + `checkLabel` + GS1 cross-check against `results.json` without API calls):

```bash
python3 eval/suites/gs1_datamatrix_crosscheck/run.py --check
```

Full live evaluation against `gemini-3.8-flash` (renders temp JPEGs in `/dev/shm` and cleans up in `finally`):

```bash
python3 eval/suites/gs1_datamatrix_crosscheck/run.py
```
