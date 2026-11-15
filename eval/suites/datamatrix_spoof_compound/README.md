# GS1 DataMatrix Spoofing Matrix and Nordic Multi-Allergen Compound Suite (`datamatrix_spoof_compound`)

Evaluates HoldUp label reading (`gemini-3.8-flash`) and deterministic safety cross-checking (`server/src/safety.ts` via `eval/safety_bridge.mts`) across EU FMD GS1 DataMatrix spoofing, conflict, and expiry-rescue scenarios plus bilingual Finnish/Swedish multi-allergen compound food labels.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`, concurrency `<= 4`)
- Coercion, GS1 parsing, and safety check: `toLabelRead` (`server/src/verify.ts`), `parseGs1` (`server/src/gs1.ts`), and `checkLabel(read, profile, now, code)` (`server/src/safety.ts` via `eval/safety_bridge.mts`)
- Ephemeral rendering: temporary JPEGs rendered only in `/dev/shm/holdup_dm_spoof_compound` and removed in `finally:`

## Case Matrix (12 cases)

- `ds_01` (`dm_verified_match`): Intact Amlodipin 5 mg carton with matching `]d2` EU FMD GS1 DataMatrix GTIN and `2028-06` expiry (`match`, `crosscheck_agrees=true`).
- `ds_02` (`dm_sleeve_swap_spoof`): Sleeve-swap spoof with printed Amlodipin 5 mg carton paired with saved Atorvastatin GS1 DataMatrix GTIN (`unsure`, `crosscheck_agrees=false`).
- `ds_03` (`dm_unlisted_print_spoof`): Unlisted Burana ibuprofen 400 mg carton paired with spoofed saved Amlodipin GS1 DataMatrix GTIN (`unsure`, `crosscheck_agrees=false`).
- `ds_04` (`dm_expiry_month_mismatch`): Printed `EXP 2028-06` on Metformin 500 mg conflicting with GS1 DataMatrix expiry `2027-11` (`unsure`, `crosscheck_agrees=false`).
- `ds_05` (`dm_expired_code_rescue`): Atorvastatin 20 mg with rubbed-off printed expiry caught as expired `2025-04` via GS1 DataMatrix (`warning`, `crosscheck_agrees=true`).
- `ds_06` (`dm_valid_code_expiry_rescue`): Amlodipin 5 mg with abraded printed expiry rescued to verified `match` via valid GS1 DataMatrix expiry `2028-06-30` (`match`, `crosscheck_agrees=true`).
- `ds_07` (`dm_thumb_occluded_strength`): Thumb-occluded strength on Amlodipin remains `unsure` despite matching GS1 DataMatrix GTIN and expiry (zero-guess `< 0.8` dose gate never bypassed by barcode).
- `ds_08` (`nordic_compound_allergen_warning`): Bilingual Finnish/Swedish nut-seed snack bar declaring `hasselpahkina/hasselnot`, `manteli/mandel`, `hera/mjolk`, `seesami` plus `voi sisaltaa maapahkinaa / kan innehalla jordnot` (`warning`).
- `ds_09` (`nordic_compound_allergen_warning`): Bilingual Finnish/Swedish Skagen soup declaring `katkarapu`, `selleri`, `sinappi/senap`, `rikkidioksidi` plus `voi sisaltaa lupiinia / kan innehalla lupin` (`warning`).
- `ds_10` (`nordic_may_contain_warning`): Bilingual Finnish/Swedish oat cookies declaring `voi sisaltaa / kan innehalla` traces of peanut, hazelnut, and sesame (`warning`).
- `ds_11` (`nordic_safe_food_info`): Sharp Finnish/Swedish rye-oat crispbread with complete gluten-only allergen panel passing `>= 0.95` confidence and `>= 0.80` readability gate (`info`).
- `ds_12` (`nordic_occluded_allergen_unsure`): Nordic oat snack pouch with torn sticker and thumb occluding the ingredients and allergen panel (`unsure`).

## Measured Results (`results.json`)

- `n_cases`: 12 (`errors`: 0, `timeouts`: 0)
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 5
- `datamatrix_spoof_matrix_accuracy`: `1.0` (7 / 7)
- `nordic_compound_allergen_accuracy`: `1.0` (5 / 5)
- `latency_p50_ms`: 3338.9 ms, `latency_p95_ms`: 4970.0 ms

## Verify and Re-run

Keyless offline replay through `eval/safety_bridge.mts`:

```bash
NODE_PATH=/tmp/fleet-root/wt/node_modules env -u GEMINI_API_KEY /tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/datamatrix_spoof_compound/run.py --check
```

Live evaluation against `gemini-3.8-flash`:

```bash
NODE_PATH=/tmp/fleet-root/wt/node_modules /tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/datamatrix_spoof_compound/run.py
```
