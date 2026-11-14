Nordic Generic Substitution and EU Parallel-Import Safety Suite (`parallel_import_substitution`)
================================================================================================

Evaluates HoldUp end-to-end across 12 Nordic mandatory generic substitution (Kela laakevaihto) and EU parallel-import over-stickered pharmacy scenarios (`fi`, `sv`, `en`) where box brand, colour, and layout change at pharmacy pickup while the patient profile stores familiar brands (`Norvasc 5 mg`, `Glucophage 500 mg`, `Panadol 500 mg`, `Emconcor 2.5 mg`, allergies `peanut` and `tree nuts`, avoid `NSAIDs`). Runs real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped into deterministic `server/src/safety.ts` via `eval/safety_bridge.mts`. Temporary PIL JPEGs render inside `TMPDIR` (`/dev/shm` by default) only; zero image files or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/parallel_import_substitution/run.py --workers 3
```

Offline verification of cached `results.json`, PIL rendering in `/dev/shm`, and `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/parallel_import_substitution/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/parallel_import_substitution/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`, `eval_now_iso = 2026-11-14T20:00:00Z`)
---------------------------------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Languages tested | `fi`, `sv`, `en` | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.693 s`, `p95 = 4.725 s`, `mean = 3.724 s` | - |
| Artifact size (`results.json`) | `11332 B` (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Safe generic & parallel-import matches (4):** `pi_01` Finnish generic substitution `AMLODIPIN KRKA 5 mg` (`amlodipiini` -> `amlodipine`, `EXP 10/2027` -> `2027-10`) matched to saved `Norvasc 5 mg`; `pi_02` EU parallel-import repack with `ORIFARM` Finnish over-sticker `NORVASC 5 mg tabletti - amlodipiini` (`EXP 2027-09`) matched to `Norvasc 5 mg`; `pi_03` Swedish generic substitution `METFORMIN SANDOZ 500 mg` (`metforminhydroklorid`, `Utg.dat. 12.2027` -> `2027-12`) matched to `Glucophage 500 mg`; `pi_04` Finnish comma-decimal generic substitution `BISOPROLOL RATIOPHARM 2,5 mg` (`bisoprololi`, `2,5 mg` -> `2.5 mg`, `Kayt. viim. 11.2027` -> `2027-11`) matched to `Emconcor 2.5 mg`.
- **Dispensing, look-alike, unlisted, & expiry warnings (5):** `pi_05` generic substitution strength mismatch `AMLODIPINE ACCORD 10 mg` vs saved `5 mg` (`strength 10 mg differs from your 5 mg`); `pi_06` parallel-import beta-blocker 2x strength mismatch `BISOPROLOL TEVA 5 mg` vs saved `2.5 mg` (`strength 5 mg differs from your 2.5 mg`); `pi_07` painkiller look-alike box `PRONAXEN 500 mg` (`naprokseeni` -> `naproxen`, NSAID on avoid list); `pi_08` unlisted cardiovascular generic `RAMIPRIL HEXAL 5 mg` (`ramipril`, `not on your medication list`); `pi_09` old pre-substitution `NORVASC 5 mg` box from travel pouch past expiry (`EXP 04/2025` -> `expired 2025-04`).
- **Over-sticker occlusion & tear abstentions (2):** `pi_10` misaligned pharmacy over-sticker covering the strength badge on `AMLODIPIN ORIFARM` (`AMLODIPIN ORIFARM` / `amlodipine` legible at `0.98`, `strength = null` at `0.0` -> `unsure`, `strength not readable`); `pi_11` torn parallel-import over-sticker leaving blank fibrous paper residue over drug name and strength with only `Vnr 52 90 14` and `30 tablettia / Suun kautta` visible (`unsure`, `label not readable`).
- **Pharmacy checkout allergen warning (1):** `pi_12` Finnish pharmacy checkout bar `APTEEKKI PROTEIINIPATUKKA` (`Sisaltaa: maapahkina, kaura` -> `["peanut", "oat"]` at `0.98`) flagged against `peanut` allergy (`warning`, `contains peanut (allergy: peanut)`).
