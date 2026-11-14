Nordic Grocery Food Allergen and Precautionary Cross-Contact Safety Suite (`food_may_contain_nordic`)
=====================================================================================================

Evaluates HoldUp's second demo scenario (Nordic grocery food packages in Finnish, Swedish, and English: `fi`, `sv`, `en`) across 12 cases on real `gemini-3.8-flash` (`shared/verify_prompt.md` + `shared/label_schema.json`) piped through deterministic `server/src/safety.ts` (`eval/safety_bridge.mts`) against profile `allergies: ["peanut", "tree nuts", "milk", "egg", "soy", "sesame"]` at `eval_now_iso = "2026-11-14T20:00:00Z"`. Temporary PIL JPEGs render inside `TMPDIR` (`/dev/shm` by default) only; zero images or encoded image bytes are committed.

Reproduce
---------

Live evaluation (requires `GEMINI_API_KEY`, capped at `<= 3` concurrent workers):

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" /tmp/fleet-silas/canary-venv/bin/python eval/suites/food_may_contain_nordic/run.py --workers 3
```

Offline verification of cached `results.json` + PIL rendering + `server/src/safety.ts` parity:

```bash
TMPDIR=/dev/shm PATH="/home/silas/tools/node/bin:$PATH" python3 eval/suites/food_may_contain_nordic/run.py --check
```

Results Summary (`gemini-3.8-flash`)
------------------------------------

| Metric | Value | 95% Interval / Bound |
|---|---|---|
| Cases (`n`) | `12` (`0` errors, `0` timeouts) | - |
| Profile allergies | `peanut`, `tree nuts`, `milk`, `egg`, `soy`, `sesame` | - |
| Languages tested | `fi`, `sv`, `en` | - |
| Verdict pass rate | `12/12` (`1.0`) | Wilson 95% CI `[0.7575, 1.0]` |
| Confident-wrong dose (`conf >= 0.8`) | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| False-safe allergen count | `0/12` (`0.0`) | Wilson 95% CI `[0.0, 0.2425]`, rule-of-three upper `0.25` |
| Latency (`latency_s`) | `p50 = 3.12 s`, `p95 = 5.631 s`, `mean = 3.567 s` | - |
| Artifact size (`results.json`) | `10,808 B` (`< 15 KB`) | - |

Scenarios Covered (12 Cases)
----------------------------

- **Precautionary cross-contact warnings in FI / SV / EN (4):**
  - `nf_01` (`warning`, `fi`): `"Puolukka & Kaura Mysli"` with precautionary `"Saattaa sisaltaa maapahkinaa"` -> `may contain peanut (allergy: peanut)`.
  - `nf_02` (`warning`, `sv`): `"Kardemummaskorpor"` with `"Kan innehalla spar av hasselnotter"` -> `may contain hazelnut (allergy: tree nuts)`.
  - `nf_03` (`warning`, `en`): `"Flax & Pumpkin Rye Thins"` with `"May contain traces of sesame"` -> `may contain sesame (allergy: sesame)`.
  - `nf_04` (`warning`, `en`): `"Wild Bilberry Oat Clusters"` with `"May contain traces of tree nuts (almonds, walnuts)"` -> `may contain tree nuts (allergy: tree nuts)`.
- **Nordic hidden dairy, egg, and soy ingredient terms (3):**
  - `nf_05` (`warning`, `fi`): Bilingual `"Saaristolais Yrttisipsit"` listing hidden whey powder `HERAJAUHE` / `VASSLEPULVER` -> `contains milk (allergy: milk)`.
  - `nf_06` (`warning`, `sv`): Dairy-free labeled `"Krispiga Havrevafflor"` listing hidden egg terms `AGGVITA` / `KANANMUNAJAUHE` -> `contains egg (allergy: egg)`.
  - `nf_07` (`warning`, `fi`): Plant-based `"Tumma Kaakao-Kaurapala"` listing hidden soy emulsifier `emulgointiaine (SOIJALESITIINI)` -> `contains soy (allergy: soy)`.
- **Genuinely safe, clearly legible allergen-free Nordic grocery packages (2):**
  - `nf_08` (`info`, `fi`): `"Taytelainen Kaurajuoma"` (water, wholegrain oats, rapeseed oil, sea salt; `sisaltaa kauraa / innehaller havre`) -> `no listed allergen matches your profile` (`0` false warnings on clean safe food).
  - `nf_09` (`info`, `sv`): `"Nordiskt Ragknackebrod"` (wholegrain rye flour, water, yeast, salt; `innehaller rag / sisaltaa ruista (gluten)`) -> `no listed allergen matches your profile` (`0` false warnings on clean safe food).
- **Expired Nordic grocery package (1):**
  - `nf_10` (`warning`, `fi`): Allergen-free `"Perinteinen Puolukkahillo"` past its best-before date (`Parasta ennen 02/2025` vs `2026-11-14`) -> `expired 2025-02`.
- **Occluded and condensation-blurred `Ainesosat / Ingredienser` abstentions (2):**
  - `nf_11` (`unsure`, `fi`): Thumb gripping directly over the `"Ainesosat / Ingredienser"` panel on `"Pohjolan Valipalapatukka"` (`allergens = null`, guidance `"Move your finger away from the ingredients list."`) -> `allergen panel not readable`.
  - `nf_12` (`unsure`, `sv`): Cold-case moisture fog and droplets blurring the `"Ingredienser / Ainesosat"` panel on `"Nordisk Rodbetssallad"` (`allergens = null`, guidance `"The ingredient panel is obscured, show a clear view."`) -> `allergen panel not readable`.
