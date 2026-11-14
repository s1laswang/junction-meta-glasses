Hold Up to Add Onboarding and Safety Suite (`hold_up_to_add`)
=============================================================

Evaluates HoldUp's voice-and-camera "Hold up to add" confirmation sheet (`PLAN.md` section 0.2, `web/src/components/AddSheet.tsx`, `web/src/lib/checker.ts`) across 12 real `gemini-3.8-flash` label reads (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`). Synthetic PIL JPEGs render strictly inside `TemporaryDirectory(dir=temp_root())` (`/dev/shm` by default); zero image files or encoded image payloads are written to the repository.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/hold_up_to_add/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity (plain `python3`):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/hold_up_to_add/run.py --check
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/hold_up_to_add/run.py --verify-cached
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Evaluation clock (`eval_now_iso`) | `2026-11-14T20:00:00Z` | - |
| Languages tested | `en`, `fi`, `sv` | - |
| Verdict + add-gate pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Clean add-confirmation ready | `4/4` (`ha_01`..`ha_04`), `8/8` unsafe/unverified blocked | - |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False add-proposal count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `min = 2.698 s`, `p50 = 3.465 s`, `p95 = 5.219 s`, `max = 6.237 s`, `mean = 3.618 s` | - |
| Cached artifact size | `12,573` bytes (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Clean EN/FI/SV prescription cartons ready for add-confirmation + post-add `match` (4):**
  - `ha_01` (`en`, `match`): `AMLODIPINE 5 mg` (`product_conf = 0.99`, `ingredient_conf = 0.99`, `strength_conf = 0.99`), builds evening `AddSheet` proposal and verifies post-add `matches aml`, `taken today: 0/1`.
  - `ha_02` (`fi`, `match`): Finnish `METFORMIN ORION 500 mg` (`Vaikuttava aine: metformiini` -> `metformin`, `product_conf = 0.99`, `ingredient_conf = 0.99`, `strength_conf = 0.99`), builds morning + evening proposal and verifies post-add `matches met`, `taken today: 0/2`.
  - `ha_03` (`fi`, `match`): Finnish comma-decimal `BISOPROLOL ORION 2,5 mg` (`2,5 mg` -> `2.5 mg`, `product_conf = 0.99`, `ingredient_conf = 0.99`, `strength_conf = 0.99`), builds morning proposal and verifies post-add `matches bis`, `taken today: 0/1`.
  - `ha_04` (`sv`, `match`): Swedish `ATORVASTATIN KRKA 20 mg` (`Aktiv substans: atorvastatin`, `Utg.dat. 03/2028` -> `2028-03`, `product_conf = 0.98`, `ingredient_conf = 0.98`, `strength_conf = 0.98`), builds night proposal and verifies post-add `matches ato`, `taken today: 0/1`.
- **Occluded, glared, and rear barcode-only holds blocking unverified dose auto-population (3):**
  - `ha_05` (`unsure`): Thumb-occluded strength on `AMLODIPINE` carton (`strength_read = null`, `strength_conf = 0.0`, `add_ready = false`, `strength not readable`).
  - `ha_06` (`unsure`): Heavy specular glare washing out the `mg` area on `METFORMIN ORION` carton (`strength_read = null`, `strength_conf = 0.0`, `add_ready = false`, `strength not readable`).
  - `ha_07` (`unsure`): Rear barcode-only hold (`6432100091844`, `LOT 2508K`) with no visible drug name or strength (`product_conf = 0.0`, `strength_read = null`, `add_ready = false`, `label not readable`).
- **Avoid-list, drug-allergy, and expired-pack `warning` blocks (3):**
  - `ha_08` (`warning`): `IBUPROFEN ORION 400 mg` against `avoid: ["NSAIDs"]` (`ibuprofen is an NSAID, on your avoid list`, `add_ready = false`).
  - `ha_09` (`warning`): `AMOXICILLIN 500 mg` against `allergies: ["penicillin", "tree nuts"]` (`contains amoxicillin (allergy: penicillin)`, `add_ready = false`).
  - `ha_10` (`warning`): Expired `BISOPROLOL 2.5 mg` pack with `EXP 03/2025` (`expired 2025-03`, `add_ready = false`).
- **Non-medicine grocery packages (`item_kind == "food"`) with safe allergen checks (2):**
  - `ha_11` (`info`): `Nordic Harvest Oat Milk 1 L` (`item_kind = "food"`, `strength_read = null`, `allergens = ["oats", "gluten"]`, `add_ready = false`, `no listed allergen matches your profile`).
  - `ha_12` (`warning`): `Nordic Crunch Hazelnut Bar 45 g` (`item_kind = "food"`, `strength_read = null`, `allergens = ["hazelnut", "gluten"]`, `add_ready = false`, `contains hazelnut (allergy: tree nuts)`).
