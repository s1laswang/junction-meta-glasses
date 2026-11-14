# Nordic Food Allergen Synonyms & Occlusion Safety Suite (`nordic_food_allergen_synonyms`)

Evaluates HoldUp's production label-reading prompt (`shared/verify_prompt.md` + `shared/label_schema.json`, SHA-256 prefix `814770315c42`), `toLabelRead` coercion (`server/src/verify.ts`), and deterministic safety rules (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 synthetic and degraded Finnish, Swedish, and English food allergen panels against a 6-allergen profile (`milk`, `peanut`, `tree nuts`, `sesame`, `gluten`, `egg`).

## Scenarios Covered (`n = 12`)

- `nf_01` (`warning`, dairy protein synonyms): Dark cocoa protein bar declaring `heraproteiini (hera / vassle)` and `natriumkaseinaatti (kaseiini / kasein)` caught under `milk` (`contains whey (allergy: milk)`).
- `nf_02` (`warning`, peanut oil synonyms): Ginger wok sauce pouch declaring `arachis oil (maapahkinaoljy / jordnotsolja)` caught under `peanut` (`contains peanut (allergy: peanut)`).
- `nf_03` (`warning`, sesame paste synonyms): Chickpea spread tub declaring `tahini (seesaminsiementahna / sesampasta)` caught under `sesame` (`contains sesame (allergy: sesame)`).
- `nf_04` (`warning`, Nordic cereal gluten synonyms): Archipelago crispbread declaring `taysjyvaruis (ruis / rag)`, `spelttijauho (speltti / dinkel)`, `ohramallasuute (ohra / korn)`, and `mannasuurimo (durumvehna / vete)` caught under `gluten` (`contains rye (allergy: gluten)`).
- `nf_05` (`warning`, egg white protein synonyms): Blueberry meringue box declaring `kananmunanvalkuaisjauhe (kananmunanvalkuainen / aggvita / albumen)` caught under `egg` (`contains egg (allergy: egg)`).
- `nf_06` (`warning`, Nordic tree nut synonyms): Dark nougat bar declaring `hasselpahkina / hasselnot` and `manteli / mandel` caught under `tree nuts` (`contains hazelnut (allergy: tree nuts)`).
- `nf_07` (`warning`, precautionary trace wording): Berry rice cakes with `Saattaa sisaltaa pienia maaria maapahkinaa / Kan innehalla spar av jordnotter` caught as `may contain peanut (allergy: peanut)`.
- `nf_08` (`info`, verified allergen-free control): Certified gluten-free and dairy-free `Kaurajuoma / Havredryck` (`Parasta ennen: 14.08.2027`) with visible allergen-free ingredient panel returning `info` (`no listed allergen matches your profile`).
- `nf_09` (`warning`, expired `Parasta ennen` best-before date): Allergen-free `Kaurajuoma / Havredryck` with `Parasta ennen: 15.03.2025` flagged as `warning` (`expired 2025-03-15`) as of `2026-11-14T20:00:00+02:00`.
- `nf_10`, `nf_11`, `nf_12` (`unsure`, occluded ingredient panels with active allergies): Folded foil pouch crimp seam (`nf_10`), thumb holding carton over `AINESOSAT / INGREDIENSER` (`nf_11`), and thick crystalline freezer frost over frozen pastry ingredients (`nf_12`), verifying mandatory `unsure` abstention (`allergen panel not readable`) and `0` false-safe `info` verdicts.

## Measured Results (`gemini-3.8-flash`, `thinking_level="low"`, `MAX_WORKERS=3`)

- Verdict accuracy: `12/12` (`1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- Confident-wrong count: `0/12` (`0.0`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper bound `0.25`)
- False-safe `info` count: `0`
- False match count: `0`
- Unsafe reassurance count: `0`
- Errors / timeouts: `0` errors, `0` timeouts
- Allergen synonym & trace warning recall: `7/7` (`1.0`)
- Occluded allergen panel abstention rate: `3/3` (`1.0`)
- Latency: p50 `4958.4 ms`, p95 `6247.4 ms`
- Output artifact size: `11768` bytes (`<= 15360` B cap)

## Verify and Re-run

Offline cached verification (re-runs `server/src/verify.ts` `toLabelRead` and `server/src/safety.ts` `checkLabel` against `results.json` with `TMPDIR=/dev/shm` and zero API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/nordic_food_allergen_synonyms/run.py --check
TMPDIR=/dev/shm python3 eval/suites/nordic_food_allergen_synonyms/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/nordic_food_allergen_synonyms/run.py
```
