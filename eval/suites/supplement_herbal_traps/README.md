Dietary Supplements, Nordic KY/IU Units, and Herbal Interaction Traps Suite (`supplement_herbal_traps`)
=======================================================================================================

Evaluates HoldUp end-to-end across 12 dietary supplement, Nordic `KY` vs `IU` Vitamin D3 strength, `1000 mcg` vs `1 mg` B12 conversion, herbal interaction avoid-list (`hypericum`, `ginkgo`), crustacean excipient allergen, look-alike bottle, expired bottle, and occluded/back-panel abstention scenarios using real `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`, `prompt_sha256_12` `814770315c42`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render only inside `tempfile.TemporaryDirectory(dir=temp_root())` (`/dev/shm`) and auto-clean; zero image files or base64 strings are committed.

Reproduce and Verify
--------------------

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/supplement_herbal_traps/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/supplement_herbal_traps/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash` (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/supplement_herbal_traps/run.py --workers 3
```

Measured Results (`results.json`, `gemini-3.8-flash`)
-----------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False match / unsafe reassurance | `0/12` / `0/12` | - |
| Safe abstentions (`unsure`) | `2/12` (`2/2` occluded bottle strength and front-only wellness pouch) | - |
| Latency (`latency_ms`) | `p50 = 3202.9 ms`, `p95 = 3459.1 ms` | - |
| Cached artifact size | `14301` bytes (`< 15 KB`, zero images/base64) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Daily supplement and Nordic unit-conversion matches (4):** `sh_01` `Devisol` (`colecalciferol`) `1000 IU` (`EXP 11/2027`) morning match (`match`), `sh_02` Finnish `DEVISOL 1000 KY` (`kolekalsiferoli / colecalciferol`) matching saved `1000 IU` (`match`), `sh_03` evening `MAGNESIUM CITRATE 250 mg` bottle (`EXP 09/2027`) (`match`), `sh_04` Finnish `BETOLVEX` (`syanokobalamiini / cyanocobalamin`) `1000 mcg` normalised to `1 mg` by `safety.ts` (`match`).
- **Mega-dose strength trap (1):** `sh_05` high-strength `COLECALCIFEROL 5000 IU` bottle vs saved `1000 IU` (`warning`, `strength 5000 IU differs from your 1000 IU`).
- **Herbal interaction avoid-list traps (2):** `sh_06` St. John's Wort `HYPERICUM ST JOHNS WORT 300 mg` vs `avoid=["hypericum"]` (`warning`), `sh_07` `GINKGO BILOBA EXTRACT 120 mg` vs `avoid=["ginkgo"]` (`warning`).
- **Supplement allergen excipient trap (1):** `sh_08` `GLUCOSAMINE 500 mg` joint supplement declaring `crustacean shellfish (shrimp)` against `shellfish` allergy (`warning`).
- **Unlisted look-alike and expired supplement bottles (2):** `sh_09` unlisted `MELATONIN ORION 3 mg` sleep supplement bottle (`warning`, `not on your medication list`), `sh_10` expired `MAGNESIUM CITRATE 250 mg` bottle (`EXP 02/2025` vs `2026-11-14T20:00:00Z`, `warning`, `expired 2025-02`).
- **Safe abstentions to `unsure` (2):** `sh_11` cylindrical `DEVISOL` (`colecalciferol`) bottle with thumb covering `IU` strength digits (`unsure`, `strength not readable`), `sh_12` `Nordic Berry Wellness Shake` front-of-pouch view stating `See reverse for ingredients and allergens` with `kind="food"` and `allergens=null` (`unsure`, `allergen panel not readable`).
