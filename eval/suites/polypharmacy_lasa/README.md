Polypharmacy and LASA Medication Safety Suite (`polypharmacy_lasa`)
===================================================================

Evaluates HoldUp end-to-end across 12 Nordic polypharmacy and look-alike/sound-alike (LASA) medication scenarios using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render to `/tmp` only; zero images or base64 strings are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/polypharmacy_lasa/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/polypharmacy_lasa/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.81 s`, `p95 = 5.75 s`, `mean = 4.15 s` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Safe matches (3):** `lasa_01` brand-to-INN evening match (`Norvasc 5 mg` -> `amlodipine`), `lasa_02` Nordic comma decimal match (`Bisoprolol Orion 2,5 mg` -> `2.5 mg`), `lasa_03` BID second dose allowed (`Metformin Orion 500 mg` at `1/2` daily doses).
- **Double-dose & strength LASA warnings (5):** `lasa_04` once-daily double-dose trap (`Amlodipin Orion 5 mg` at `1/1`), `lasa_05` BID quota-exhausted trap (`Glucophage 500 mg` at `2/2`), `lasa_06` same-house 2x strength trap (`Amlodipin Orion 10 mg` vs `5 mg`), `lasa_07` decimal-vs-integer trap (`Bisoprolol Orion 5 mg` vs `2.5 mg`), `lasa_08` Nordic `100 mikrog` vs `25 mcg` thyroid trap (`Thyroxin`).
- **Stem, combo & allergy warnings (3):** `lasa_09` `-olol` stem house-pack cousin (`Metoprolol Orion 25 mg` vs `Bisoprolol Orion`), `lasa_10` opioid co-formulation (`Panacod 500 mg + 30 mg` codeine avoid hit vs plain paracetamol), `lasa_11` Finnish brand penicillin-class allergy (`Amorion 500 mg` amoxicillin).
- **Safe abstention (1):** `lasa_12` thumb-occluded strength on `Amlodipin Orion` (`unsure`, `strength_read = null`, `strength_conf = 0.0`).
