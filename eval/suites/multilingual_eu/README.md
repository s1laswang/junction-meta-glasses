Multilingual European Medication and Food Label Safety Suite (`multilingual_eu`)
================================================================================

Evaluates HoldUp end-to-end across 12 European medication and food packaging scenarios in 6 languages (`fi`, `sv`, `de`, `fr`, `es`, `en`) using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render to `TMPDIR` (`/dev/shm` by default) only; zero images or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/multilingual_eu/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/multilingual_eu/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Languages tested | `fi`, `sv`, `de`, `fr`, `es`, `en` (`6` EU languages) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 5.021 s`, `p95 = 9.651 s`, `mean = 5.585 s` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Multilingual medication matches (4):** `ml_01` Finnish `AMLODIPIN ORION 5 mg` (`amlodipiini` -> `amlodipine`, `Kayt. viim. 10.2027` -> `2027-10`), `ml_02` Swedish `METFORMIN ACTAVIS 500 mg` (`metforminhydroklorid` -> `metformin`, `Utg.dat. 12.2027` -> `2027-12`), `ml_04` German `AMLODIPIN STADA 5 mg` (`Wirkstoff: Amlodipin`, `Verwendbar bis 09.2027` -> `2027-09`), `ml_06` Spanish `PARACETAMOL KERN PHARMA 500 mg` (`Principio activo: paracetamol`, `CAD 11/2027` -> `2027-11`).
- **Multilingual medication warnings (2):** `ml_03` Finnish NSAID avoid-list trap (`BURANA 400 mg`, `ibuprofeeni` -> `ibuprofen`), `ml_05` French 2x wrong-strength trap (`AMLODIPINE BIOGARAN 10 mg` vs `5 mg` profile dose).
- **Nordic food allergen warnings & safe panels (4):** `ml_07` Finnish snack bar `maapahkina` -> `peanut` allergy warning, `ml_08` Swedish spread `hasselnotter` -> `hazelnut` tree-nut allergy warning, `ml_09` Finnish `Kaurajuoma` readable nut-free panel (`info`), `ml_10` Swedish `Havredryck` readable nut-free panel (`info`).
- **Safe abstentions (2):** `ml_11` EU trilingual `AMLODIPIN / AMLODIPINE` carton with thumb-occluded strength (`unsure`, `strength_read = null`, `strength_conf = 0.1`), `ml_12` French front-of-box `Biscuits Fins Artisanaux` carton without visible allergen panel (`unsure`, `allergen panel not readable`).
