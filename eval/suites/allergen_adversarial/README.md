Food and Beverage Packaging Adversarial Allergen Safety Suite (`allergen_adversarial`)
======================================================================================

Evaluates HoldUp end-to-end across 12 food and beverage packaging adversarial allergen scenarios in English, Finnish, and Swedish (`en`, `fi`, `sv`) using real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`) against profile `allergies: ["peanut", "tree nuts", "milk", "sesame"]` at `eval_now_iso = "2026-11-14T20:00:00Z"`. Temporary PIL JPEGs render inside `TMPDIR` (`/dev/shm` by default) only; zero images or encoded image bytes are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/allergen_adversarial/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/allergen_adversarial/run.py --check
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Profile allergies | `peanut`, `tree nuts`, `milk`, `sesame` | - |
| Languages tested | `en`, `fi`, `sv` | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.397 s`, `p95 = 4.848 s`, `mean = 3.679 s` | - |
| Artifact size (`results.json`) | `10,967 B` (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Hidden & synonym food allergens (4):**
  - `aa_01` (`warning`): Misleading green `"100% PLANT PROTEIN BAR"` carton listing `roasted cashew paste (14%), cocoa mass, almonds (6%)` -> `contains cashew (allergy: tree nuts)`.
  - `aa_02` (`warning`): Gourmet `"Savoury Satay & Salad Dressing"` listing hidden synonym `arachis oil (groundnut), soy sauce, lime` -> `contains peanut (allergy: peanut)`.
  - `aa_03` (`warning`): `"Coffee Creamer Classic"` instant whitener listing `glucose syrup, whey powder (milk), sodium caseinate` -> `contains milk (allergy: milk)`.
  - `aa_04` (`warning`): `"Chickpea Mezze Dip"` carton listing `chickpeas (68%), tahini (sesame seed paste) 16%, lemon, garlic` -> `contains sesame (allergy: sesame)`.
- **Nordic precautionary `"may contain"` trace declarations (2):**
  - `aa_05` (`warning`): Finnish bakery oat cookie pack (`"Kaurakeksi Perinteinen"`) with `"Voi sisaltaa maapahkinaa ja mantelia"` -> `may contain peanut (allergy: peanut)`, `may contain almond (allergy: tree nuts)`.
  - `aa_06` (`warning`): Swedish dark cocoa bar (`"Mork Choklad 70%"`) with `"Kan innehalla spar av hasselnotter och mjolk"` -> `may contain hazelnut (allergy: tree nuts)`, `may contain milk (allergy: milk)`.
- **False-positive traps & expired safe-allergen drink (3):**
  - `aa_07` (`info`): `"Roasted Sunflower & Pumpkin Seed Granola"` (`wholegrain oats, sunflower seeds, pumpkin seeds, maple syrup`, `Allergens: Contains oats (gluten)`) -> `no listed allergen matches your profile`.
  - `aa_08` (`info`): Dairy-lookalike Finnish oat cooking cream (`"POHJAN KAURAKERMA"`, `vesi, taysjyvakaura (12%), rypsioljy, merisuola`, `Allergeenit: sisaltaa kauraa (gluteeni)`) -> `no listed allergen matches your profile`.
  - `aa_09` (`warning`): Nut-free `"Nordic Oat Barista"` (`Allergens: Contains oats (gluten)`) past its date (`Best before 03/2025` vs `2026-11-14`) -> `expired 2025-03`.
- **Occluded, front-only, and glare-washed abstentions (3):**
  - `aa_10` (`unsure`): Bright orange `"ALENNUS -30%"` supermarket discount sticker pasted directly over the ingredients and allergens box on `"Kanelikierre"` pastry carton (`allergens = null`) -> `allergen panel not readable`.
  - `aa_11` (`unsure`): Front-of-pack `"Artisanal Spiced Tea Biscuits"` tin (`"See base of tin for full ingredients and allergen information"`, no allergen panel visible) -> `allergen panel not readable`.
  - `aa_12` (`unsure`): Specular glare-washed and blurred micro-print back panel on `"Berry & Seed Flapjack Bar"` (`allergens = null`) -> `allergen panel not readable`.
