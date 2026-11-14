Nordic Pharmacy Dispensing Sticker vs Manufacturer Carton Suite (`pharmacy_sticker_conflict`)
=============================================================================================

Evaluates HoldUp end-to-end across 12 Finnish, Swedish, and bilingual (`fi`, `sv`) pharmacy dispensing sticker (`apteekin annostustarra` / `apotekets doseringsetikett`) vs manufacturer carton scenarios where pharmacy-applied thermal labels interact or conflict with printed carton fields. The patient profile saves familiar brand names (`Norvasc 5 mg` evening, `Cardace 5 mg` morning already logged at `10:00`, `Glucophage 500 mg` morning + evening with `1 of 2` logged at `10:00`, `Panadol 500 mg` as needed), allergies (`peanut`, `tree nuts`), and avoid list (`NSAIDs`). Runs real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped into deterministic `server/src/safety.ts` via `eval/safety_bridge.mts`. Temporary PIL JPEGs render inside `TMPDIR` (`/dev/shm` by default) only; zero image files or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pharmacy_sticker_conflict/run.py --workers 3
```

Offline verification of cached `results.json`, PIL rendering in `/dev/shm`, and `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pharmacy_sticker_conflict/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/pharmacy_sticker_conflict/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`, `eval_now_iso = 2026-11-14T19:30:00+02:00`)
--------------------------------------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Languages tested | `fi`, `sv` (including bilingual `FI/SV` and `SV/FI`) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.31 s`, `p95 = 4.565 s`, `mean = 3.567 s` | - |
| Artifact size (`results.json`) | `12052 B` (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Generic substitution & twice-daily schedule matches (2):** `ps_01` Finnish generic substitution `AMLODIPIN ORION 5 mg` (`amlodipiini` -> `amlodipine`, sticker `vaihtokelpoinen: Norvasc`, `EXP 11/2027` -> `2027-11`) matched to `Norvasc 5 mg` (`taken today: 0/1`); `ps_11` bilingual `SV/FI` `METFORMIN ACTAVIS 500 mg` (`1 tablett morgon och kvall / 1 tabletti aamulla ja illalla`) matched to `Glucophage 500 mg` with morning dose logged (`taken today: 1/2`).
- **Strength, spouse-med, NSAID, expiry, & duplicate-dose warnings (5):** `ps_03` Swedish wrong-strength generic pack `AMLODIPIN SANDOZ 10 mg` vs saved `5 mg` (`strength 10 mg differs from your 5 mg`); `ps_04` household spouse sticker on `METOPROLOL HEXAL 50 mg` (`Patient: Erik Lindholm`) when user takes `Amlodipine` (`not on your medication list`); `ps_05` Finnish prescription-stickered `BURANA 400 mg` (`ibuprofeeni`, sticker referencing `Ibumax 400 mg`) flagged by `avoid: ["NSAIDs"]` (`ibuprofen is an NSAID, on your avoid list`); `ps_06` matching `NORVASC 5 mg` pack with past carton expiry `EXP 04/2025` (`expired 2025-04`); `ps_07` `RAMIPRIL ORION 5 mg` (`vaihtokelpoinen: Cardace`) flagged because today's morning dose is already logged (`matches cardace`, `taken today: 1/1`).
- **Bilingual FI/SV allergenic excipient conflicts (2):** `ps_09` bilingual `FI/SV` softgel `KOLEKALSIFEROLI ORION 50 mikrog` declaring `puhdistettu maapahkinaoljy (arachis oil) / raffinerad jordnotsolja` (`contains arachis oil (allergy: peanut)`); `ps_10` bilingual `SV/FI` substituted `PARACETAMOL ACTAVIS 500 mg` softgel (`Utbytbar / Vaihtokelpoinen: PANADOL 500 mg`) where the carton excipient `raffinerad jordnotsolja / puhdistettu maapahkinaoljy (arachis oil, peanut)` overrides a `Panadol 500 mg` drug+strength match (`contains peanut (allergy: peanut)`).
- **Sticker occlusion, thermal fade/tear, & blur/glare abstentions (3):** `ps_02` misaligned Finnish pharmacy sticker covering the strength digits on `AMLODIPIN KRKA` so only `mg` peeks out (`strength = null`, `conf = 0.1` -> `unsure`, `strength not readable`); `ps_08` heat-faded torn Swedish thermal sticker plus ripped paperboard over the strength badge on `RAMIPRIL HEXAL` (`strength = null`, `conf = 0.1` -> `unsure`, `strength not readable`); `ps_12` out-of-focus + specular-glared bilingual `FI/SV` sticker and carton (`kind = unreadable`, `readability = 0.0` -> `unsure`, `label not readable`).
