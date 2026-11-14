Pediatric, Veterinary, and Household Cabinet Mix-Up Suite (`pediatric_vet_household`)
=====================================================================================

Evaluates HoldUp end-to-end across 12 multi-generational household cabinet scenarios for blind and low-vision older adults sharing shelves with grandchildren, a spouse, or pets, using real `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`) piped through `to_label_read` (`server/src/verify.ts` port) and deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary 768x768 PIL JPEGs render to `TMPDIR` / `/dev/shm` only; zero images or base64 strings are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pediatric_vet_household/run.py --workers 3
```

Offline verification of cached `results.json` (`13,007` bytes, `< 15 KB`) + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pediatric_vet_household/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pediatric_vet_household/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.864 s`, `p95 = 5.63 s`, `mean = 4.139 s` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Own adult medications (`hh_01`, `hh_06` -> `match`):** `hh_01` adult `Paracetamol 500 mg` film-coated tablet carton (`match`), and `hh_06` evening `Amlodipin 5 mg` tablet carton (`match`).
- **Pediatric & double-strength paracetamol/NSAID cabinet mix-ups (`hh_02`, `hh_03`, `hh_08` -> `warning`):** `hh_02` grandchild's `Panadol Junior 24 mg/ml` oral suspension bottle vs adult `500 mg` profile (`warning`: strength mismatch), `hh_03` adult `Panadol Forte 1 g` double-strength carton vs `500 mg` profile (`warning`: strength mismatch), and `hh_08` grandchild's `Burana 100 mg` ibuprofen suppository carton vs `NSAIDs` avoid list (`warning`: NSAID avoid + not on med list).
- **Veterinary & spouse cabinet mix-ups (`hh_04`, `hh_05`, `hh_07` -> `warning`):** `hh_04` veterinary `Rimadyl 50 mg` (`carprofen` chewable bottle for dogs) in kitchen cabinet (`warning`: not on human medication list), `hh_05` veterinary `Synulox Vet 250 mg` (`amoxicillin, clavulanic acid`) vs `penicillin` allergy (`warning`: penicillin drug-class allergy hit on `amoxicillin`), and `hh_07` spouse's `Atorvastatin 20 mg` cholesterol carton (`warning`: not on user's medication list).
- **Shared household pantry snacks (`hh_09` -> `info`, `hh_10` -> `warning`):** `hh_09` safe `Crunchy Oat Biscuits` with oats/wheat only (`info`), and `hh_10` grandchild's `Peanut Butter Puffs` vs `peanut` allergy (`warning`).
- **Ambiguous / unreadable household bottles (`hh_11`, `hh_12` -> `unsure`):** `hh_11` thumb-occluded strength badge on a `Panadol` bottle (`strength_read = null`, `unsure`), and `hh_12` out-of-focus turned-away amber medicine bottle (`kind = "unreadable"`, `unsure`).
