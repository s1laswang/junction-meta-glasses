# Metered-Dose Inhaler, Dry-Powder Inhaler, and Nasal Spray Dosage Safety Suite (`inhaler_dpi_dosage`)

Evaluates HoldUp label reading and deterministic safety checking across metered-dose inhalers (MDI), Finnish/Nordic dry-powder inhalers (Orion Easyhaler, Turbuhaler, Diskus), and nasal sprays, focusing on per-actuation microgram strengths (`mikrog/annos`, `mcg/dose`, `mcg/spray`), combination strengths (`160/4.5` vs `320/9`), dose-counter distractors (`200 annosta / 200 doses`), avoid-list/unlisted/expired inhalers, and degraded zero-guess abstentions.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, `MAX_WORKERS`: `3`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Ephemeral image rendering: 768x768 JPEGs written to `/dev/shm/holdup_inhaler_dpi_dosage` only

## Case Categories (12 cases)

- `clean_prescribed_match` (`ih_01` to `ih_03`, 3 cases): Clean prescribed matches across Orion `Buventol Easyhaler 100 mikrog/annos` (`salbutamol`, `100 mcg/dose`), Orion `Bufomix Easyhaler 160/4,5 mikrog/annos` (`budesonide, formoterol`, `160/4.5 mcg/dose`), and `Avamys 27,5 mikrog/suihke` (`fluticasone furoate`, `27.5 mcg/spray`).
- `wrong_per_actuation_strength` (`ih_04`, `ih_05`, 2 cases): Per-actuation strength mismatch warnings on `Buventol Easyhaler 200 mikrog/annos` vs prescribed `100 mcg/dose` and `Bufomix Easyhaler 320/9 mikrog/annos` vs prescribed `160/4.5 mcg/dose`.
- `dose_counter_distractor` (`ih_06`, 1 case): `Ventoline Evohaler` MDI displaying a prominent amber `200 annosta / 200 doses` pack badge while actual per-actuation strength is `100 mikrog/annos` (`salbutamol`), requiring `match` without mistaking the 200-dose count for `200 mcg/dose`.
- `avoid_unlisted_expired_warning` (`ih_07` to `ih_09`, 3 cases): `Atrovent 20 mikrog/annos` MDI (`ipratropium bromide`, avoid-list + unlisted warning), `Serevent Diskus 50 mikrog/annos` (`salmeterol`, `60 annosta / 60 doses`, unlisted DPI warning), and expired `Symbicort Turbuhaler 160/4,5 mikrog/annos` (`Kayt. viim. 04.2025` -> `2025-04` expired warning).
- `degraded_zero_guess` (`ih_10` to `ih_12`, 3 cases): Thumb covering strength digits before `mikrog/annos` on `Buventol Easyhaler` (`ih_10`), brushed-aluminum MDI canister specular glare blowing out strength digits on `Ventoline Evohaler` (`ih_11`), and heavy hand-tremor motion blur across `Avamys` nasal spray (`ih_12`), all requiring `unsure` abstention with zero guessed doses.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper bound `0.25`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 3 (3/3 degraded cases; `degraded_abstention_rate`: `1.0`, `readable_case_accuracy`: `1.0`, `warning_recall`: `1.0`)
- `errors`: 0, `timeouts`: 0
- `latency_p50_ms`: 4293.5 ms, `latency_p95_ms`: 5209.8 ms
- `results.json` size: 12151 B (`<= 15360` B)

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/inhaler_dpi_dosage/run.py --check
TMPDIR=/dev/shm python3 eval/suites/inhaler_dpi_dosage/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/inhaler_dpi_dosage/run.py
```
