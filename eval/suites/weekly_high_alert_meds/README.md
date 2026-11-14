Weekly and Narrow-Therapeutic-Index High-Alert Medication Suite (`weekly_high_alert_meds`)
==========================================================================================

Evaluates HoldUp end-to-end across 12 EMA/Fimea high-alert weekly and narrow-therapeutic-index oral medication scenarios in look-alike white HDPE bottles and cartons using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render to `TMPDIR` (`/dev/shm` by default) only; zero images or encoded image payloads are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/weekly_high_alert_meds/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/weekly_high_alert_meds/run.py --check
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.553 s`, `p95 = 4.924 s`, `mean = 3.741 s` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Methotrexate / Trexan `2.5 mg` vs `10 mg` strength swap (3):** `wh_01` Orion white bottle `TREXAN 2,5 mg` normalized to `2.5 mg` (`match`, `taken today: 0/1`), `wh_02` look-alike Orion white bottle `TREXAN 10 mg` 4x cytotoxic swap (`warning`, `strength 10 mg differs from your 2.5 mg`), `wh_03` EU oral carton `METHOTREXATE ACCORD 10 mg` vs scheduled `2.5 mg` (`warning`, `strength 10 mg differs from your 2.5 mg`).
- **Folic acid `1 mg` vs Methotrexate `2.5 mg` Orion white bottle confusion (1):** `wh_04` look-alike Orion white bottle `FOLVITE 1 mg` (`folic acid`) checked against a profile listing `Trexan 2.5 mg` (`warning`, `not on your medication list`).
- **Alendronate `70 mg` weekly tablet schedule check (2):** `wh_05` `ALENDRONATE ORION 70 mg` (`alendronic acid`) before dosing (`match`, `taken today: 0/1`), `wh_06` `ALENDRONATE SANDOZ 70 mg` after a morning dose is already logged (`warning`, `taken today: 1/1`).
- **Warfarin / Marevan `3 mg` vs `5 mg` white bottle strength check (2):** `wh_07` Orion white bottle `MAREVAN 3 mg` (`match`, `taken today: 0/1`), `wh_08` look-alike Orion white bottle `MAREVAN 5 mg` (`warning`, `strength 5 mg differs from your 3 mg`).
- **Obscured strength and specular glare on white cylindrical bottles (2):** `wh_09` thumb occluding strength on white `TREXAN` bottle (`unsure`, `strength_read = null`, `strength not readable`), `wh_10` specular overhead light glare washing out strength on white `MAREVAN` bottle (`unsure`, `strength_read = null`, `0` confident-wrong dose reads).
- **Expired high-alert bottle (1):** `wh_11` backup white bottle `TREXAN 2.5 mg` with `EXP 01/2025` (`warning`, `expired 2025-01`).
- **Rear warning-text-only bottle view (1):** `wh_12` rotated white pill bottle showing only rear safety instructions without drug name or strength (`unsure`, `medicine name not confident`).
