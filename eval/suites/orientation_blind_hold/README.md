Orientation and Blind-Hold Safety Suite (`orientation_blind_hold`)
==================================================================

Evaluates HoldUp end-to-end across 12 blind-hold package orientation scenarios (`180` deg upside-down, `90` deg and `270` deg sideways, `32` deg and `152` deg 3D perspective tilt, thumb-occluded strength, rear barcode-only carton, and edge-clipped framing) using real `gemini-3.8-flash` (`thinking_level="low"`, `shared/verify_prompt.md` + `shared/label_schema.json`, `prompt_sha256_12` `814770315c42`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Temporary PIL JPEGs render into `tempfile.TemporaryDirectory()` (`TMPDIR=/dev/shm`) and auto-clean; zero images or base64 strings are committed.

Reproduce and Verify
--------------------

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm python3 eval/suites/orientation_blind_hold/run.py --verify-cached
TMPDIR=/dev/shm python3 eval/suites/orientation_blind_hold/run.py --check
```

Full live evaluation against `gemini-3.8-flash` (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm python3 eval/suites/orientation_blind_hold/run.py --workers 3
```

Measured Results (`results.json`, `gemini-3.8-flash`)
-----------------------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False match / unsafe reassurance | `0/12` / `0/12` | - |
| Safe abstentions (`unsure`) | `3/12` (`3/3` incomplete blind-hold views) | - |
| Latency (`latency_ms`) | `p50 = 3494.2 ms`, `p95 = 5888.3 ms` | - |

Scenarios Covered (12 Cases)
----------------------------

- **Rotated and oblique matches (4):** `or_01` upside-down (`180` deg) `Amlodipin 5 mg`, `or_02` sideways (`90` deg CW) `Amlodipin 5 mg`, `or_03` sideways (`270` deg CW) `Amlodipin 5 mg`, `or_11` oblique upside-down (`152` deg + perspective) `Atorvastatin 20 mg`.
- **Rotated and perspective safety warnings (4):** `or_04` upside-down (`180` deg) `Burana 400 mg` ibuprofen NSAID avoid warning, `or_05` sideways (`90` deg CW) expired `2025-03` `Metformin 500 mg` warning, `or_06` upside-down (`180` deg) hazelnut and peanut snack bar allergy warning, `or_08` tilted (`32` deg + perspective) `Amlodipin 10 mg` vs `5 mg` wrong-strength warning.
- **Rotated safe food info (1):** `or_07` sideways (`270` deg CW) nut-free `Nordic Oat Drink` (`info`).
- **Blind-hold abstentions to `unsure` (3):** `or_09` upside-down (`180` deg) `Amlodipin` with thumb occluding strength (`strength` null), `or_10` upside-down (`180` deg) blank rear carton with unknown EAN-13 barcode `6432100099111` only, `or_12` sideways (`90` deg) edge-clipped blind hold missing strength.
