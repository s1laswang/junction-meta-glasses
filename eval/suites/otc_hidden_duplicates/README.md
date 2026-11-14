OTC Cold/Flu Sachets and Hidden Active-Ingredient Duplicates Suite (`otc_hidden_duplicates`)
============================================================================================

Evaluates HoldUp end-to-end across 12 Nordic over-the-counter (OTC) cold/flu sachet, generic painkiller, allergy, throat pastille, and occluded/degraded package scenarios using real `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`, `prompt_sha256_12` `814770315c42`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render into `tempfile.TemporaryDirectory()` (`TMPDIR=/dev/shm`) and auto-clean; zero images or base64 strings are committed.

Reproduce and Verify
--------------------

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/otc_hidden_duplicates/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/otc_hidden_duplicates/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash` (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/otc_hidden_duplicates/run.py --workers 3
```

Measured Results (`results.json`, `gemini-3.8-flash`)
-----------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False match / unsafe reassurance | `0/12` / `0/12` | - |
| Safe abstentions (`unsure`) | `3/12` (`3/3` torn, occluded, or steam-blurred packs) | - |
| Latency (`latency_ms`) | `p50 = 3351.1 ms`, `p95 = 4854.3 ms` | - |
| Cached artifact size | `14421` bytes (`< 15 KB`, zero images/base64) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Scheduled OTC matches (2):** `otc_01` plain `Paracetamol Orion 500 mg` tablet with `0/2` doses logged (`match`), `otc_07` `Heinix` (`cetirizine`) `10 mg` evening allergy tablet with `0/1` doses logged (`match`).
- **Hidden active-ingredient duplication and strength traps (2):** `otc_02` `Panadol Hot 500 mg` warm-drink paracetamol sachet when the daily paracetamol quota (`2/2` doses in `doseLog`) is already exhausted (`warning`), `otc_06` `Panadol Forte 1000 mg` (`1 g`) double-strength OTC tablet vs `500 mg` profile (`warning`).
- **Hidden and generic NSAID avoid traps (3):** `otc_03` `Finrexin` (`acetylsalicylic acid + caffeine`, `500 mg + 30 mg`) cold sachet vs `avoid=["NSAIDs"]` (`warning`), `otc_04` `Ibumax 400 mg` (`ibuprofen`) generic pain pack vs `avoid=["NSAIDs"]` (`warning`), `otc_05` `Ketorin 25 mg` (`ketoprofen`) OTC pack vs `avoid=["NSAIDs"]` (`warning`).
- **Expired OTC sachet (1):** `otc_08` expired `Panadol Hot 500 mg` sachet (`EXP 2025-02`) past expiry (`warning`).
- **Safe throat pastille food pack (1):** `otc_09` caffeine-free `Honey & Lemon Pastilles` with vitamin C and zero profile allergens (`info`).
- **Safe abstentions to `unsure` (3):** `otc_10` torn cold-sachet corner missing paracetamol `mg` strength (`unsure`), `otc_11` thumb-occluded active ingredient and strength on `Para-Tabs` OTC pain relief box (`unsure`), `otc_12` steam-blurred kettle-side `Panadol Hot` sachet with illegible strength (`unsure`).
