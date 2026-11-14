Thermal Fade and Carton Wear Safety Suite (`thermal_fade_wear`)
===============================================================

Evaluates HoldUp end-to-end across 12 worn pharmacy and pantry packaging scenarios (6 moderate wear cases and 6 severe dosage/allergen damage cases) using real `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`) piped through `to_label_read` (`server/src/verify.ts` port) and deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary 768x768 PIL JPEGs render to `TMPDIR` / `/dev/shm` only; zero images or base64 strings are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/thermal_fade_wear/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/thermal_fade_wear/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/thermal_fade_wear/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.591 s`, `p95 = 5.268 s`, `mean = 3.813 s` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Moderate thermal fade & carton wear (`tw_01` .. `tw_06`, 6 cases):** scuffed corners, diagonal creases, surface water droplets, and 56-64% faded thermal stickers while preserving legible critical fields: `tw_01` evening pill match (`Amlodipin 5 mg` -> `match`), `tw_02` NSAID avoid hit (`Burana 400 mg` ibuprofen -> `warning`), `tw_03` expired medication (`Metformin 500 mg`, `EXP 2025-01` -> `warning`), `tw_04` tree-nut allergen hit (`Hazelnut Praline Wafers` -> `warning`), `tw_05` safe pantry food (`Plain Oat Drink` -> `info`), and `tw_06` wrong strength (`Amlodipin 10 mg` vs `5 mg` -> `warning`).
- **Severe localized damage abstention (`tw_07` .. `tw_12`, 6 cases -> `unsure`):** destroyed strength or allergen regions requiring safe abstention (`strength_read = null`, `strength_conf <= 0.1`): `tw_07` 95% UV/thermal bleach over `Amlodipin` strength, `tw_08` wet ink smear across `Amlodipin` strength digits, `tw_09` torn pharmacy sticker ripping off `Metformin` strength, `tw_10` pocket key abrasion and deep crease across `Panadol` strength, `tw_11` heat-blackened thermal patch over `Bisoprolol` strength, and `tw_12` abraded torn allergen/ingredients panel on `Crispy Cereal Bar`.
