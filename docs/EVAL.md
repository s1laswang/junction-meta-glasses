# HoldUp evaluation, v1 (synthetic, Sat 14 Nov 2026) + v2 (re-score and model comparison, Sat night)

**v2 in one line:** re-scoring the same 1,740 v1 predictions with main's `safety.ts` (allergen gate, commit `667312c`) cuts silent unsafe reassurance from **49 / 4,730 (1.04%)** to **3 / 4,730 = 0.06% (Wilson 95% 0.02–0.19%)**, at the cost of fewer "none of your allergens" answers on safe foods. See [v2](#v2-sat-night) below. The v1 section is unchanged except where marked as a correction.

**What's tested:** the shipped product path. That is `gemini-3.8-flash` (thinking LOW) with `shared/verify_prompt.md` and `shared/label_schema.json` (prompt hash `814770315c42`), then the deterministic `server/src/safety.ts`, run through `npx tsx`.

**Dataset:**
- Gemini wrote 172 label specs (127 medicines, many Finnish/Swedish packs, look-alike strengths; 45+ foods with allergen synonyms and "may contain" traces).
- `gemini-3.1-flash-image` rendered 210 first-person photos. A separate Flash check dropped 6 renders with garbled text.
- PIL produced degradations at 3 severities: crop, defocus, glare, low light, motion blur, rotation, back of box.
- Ground truth per field is marked visible, partial or hidden.

**1,740 images, 0 API errors.** The 210 kept renders are 170 fronts and 40 back-of-box views; with the clean images and the degradations at up to 3 severities, that makes 1,740 scored images. The full results are committed at **`eval/results/v1_results.json`** (a copy of the run's `eval/out/results.json`, produced by `eval/run_eval.py`). 95% CIs: Wilson for rates, the rule of three for zero events, bootstrap for ECE and latency.

## Headline
| Metric | Result |
|---|---|
| **Confident-wrong strength reads** (conf ≥ 0.8) | **0 / 754** (95% upper bound 0.4%) |
| Strength when visible (n = 926) | 83.2% correct, 16.8% abstained, **0.0% wrong** |
| Strength when hidden | abstains 98.4% |
| All fields when visible (n = 4,776) | 82.4% correct, 15.9% abstained, 1.7% wrong |
| **Confident-wrong product names** (conf ≥ 0.8) | **42 / 1,173 = 3.6%**. Mostly the name read without the strength suffix (e.g. "Pamol" vs "Pamol 24 mg/ml"). Strength is a separate field, gated at 0.8 |
| **Weak fields, confident-wrong** (conf ≥ 0.8) | All fields 158 / 4,151 = 3.8%. **Allergens 66 / 304 = 21.7%** (22 confident misses). **Dosing 16 / 101 = 15.8%**. Allergen reads are the weakest field. That's why "none of your allergens" now needs conf ≥ 0.95 and readability ≥ 0.8 (v2 below), and why the safety verdict never uses the dosing field |
| Calibration ECE, all answered fields (n = 4,406) | 0.022 (0.018–0.028) |
| **Unsafe reassurance, end to end** (n = 4,730 image × profile verdicts) | **49 = 1.0% (0.78–1.37%)** with the v1 `safety.ts`; **3 = 0.06% (0.02–0.19%)** re-scored with main's `safety.ts` (v2) |
| Unsafe for "not on my list" and "wrong strength" scenarios (n = 2,560) | **0** |
| Verify latency per call | p50 3.43 s (3.41–3.46), p95 5.55 s (5.42–5.83) |

## Where the 49 unsafe reassurances came from, and the fixes
1. **32 in the "expiry" bucket.** *Correction (v2):* only **2** of these were medicines (a matched pack whose expiry year was misread). The other **30** were expired *foods* where the app said "none of your allergens" and so never reached the date. **Mitigation for medicines, only when the pack's DataMatrix decodes:** the EU FMD DataMatrix cross-check (`server/src/gs1.ts`, `safety.ts`) reads the exact expiry from the pack's own code. An expired code is a warning, and a code/print conflict is unsure.
2. **17 missed food allergens** (mostly cropped panels where a nut was off-frame). **Fix** (commit `667312c`): "none of your allergens" now needs allergen confidence ≥ 0.95 and readability ≥ 0.8. Otherwise the answer is "not sure, show the whole panel". Replayed on the eval's own predictions, the risky answered food reads drop from **43 to 2 of 334**, and the app still answers on 117. Warnings for a found allergen are unchanged.

The v1 total was therefore **47 food reads + 2 medicines**. v2 re-scores this with the allergen fix (below). The DataMatrix fix isn't exercised by the synthetic set, because no decoded code is passed to the check. Without a decoded code, an unreadable expiry still produces a match that says "I couldn't read the expiry date".

**Scope of the claim:** the product states a strength only when its confidence is ≥ 0.8. Below that it says "I'm not sure". That isn't the same as "never wrong", and the numbers above are synthetic.

A separate, smaller fleet run (160 images, branch `fleet/jr1-eval-and-slide10`, not merged) showed 6 confident-wrong product names, the same failure mode as above.

## v2 (Sat night)

### 1. Safety re-score of the v1 predictions with main's `safety.ts`
No new model calls: the same 1,740 `gemini-3.8-flash` reads (prompt `814770315c42`), the same 4,730 image × profile scenarios, now checked by main's `server/src/safety.ts` (last changed in `667312c`, the allergen gate: "none of your allergens" needs allergen confidence ≥ 0.95 and readability ≥ 0.8). Reproduce with `eval/rescore_safety.py`; results are in **`eval/results/v2_safety_rescore.json`**. As a sanity check, the same scorer with v1's `safety.ts` reproduces v1's 49 / 4,730 exactly.

| End to end (n = 4,730 verdicts) | v1 `safety.ts` | main `safety.ts` (v2) |
|---|---|---|
| **Silent unsafe reassurance** | 49 = 1.04% (0.78–1.37%) | **3 = 0.06% (0.02–0.19%)** |
| of which: food **contains** the allergen, app said "none of your allergens" | 17 | **0** |
| of which: food past its date, app said "none of your allergens" | 30 | 1 (date cropped out of frame) |
| of which: medicine matched, expiry year misread | 2 | 2 |
| Expired box matched, but says "I couldn't read the expiry date" (disclosed, not counted above) | 47 (0.75–1.32%) | 47 (0.75–1.32%) |
| Verdict equals the true-label verdict | 2,885 = 61.0% (59.6–62.4%) | 2,843 = 60.1% (58.7–61.5%) |
| "Not sure" | 1,738 = 36.7% (35.4–38.1%) | 1,810 = 38.3% (36.9–39.7%) |
| Safe food correctly told "none of your allergens" (n = 130 truly safe) | 88 = 67.7% (59.3–75.1%) | **44 = 33.8% (26.3–42.3%)** |

**What changed:** every one of the 46 removed cases is a food read that the gate now answers "not sure, show the whole panel". No verdict became unsafe. **The cost:** on foods that really are free of the user's allergen, the app now says so half as often (88 → 44 of 130); the rest become "not sure". That's the trade we chose: a missed nut is worse than a re-scan.

**The 3 that remain:**
- `med012__motion_blur_1` and `med120__low_light_2`: the model read the expiry year wrong (printed 09.2025 → read 2028-09; 06-2026 → 2028-06) at confidence 0.85, readability 0.7. `safety.ts` trusts a printed expiry at ≥ 0.7. Raising that bar to 0.9 isn't a fix: other year misreads at ≥ 0.9 take their place (still 3), and 44 correct verdicts are lost. The real mitigation is the DataMatrix cross-check, which the synthetic set doesn't exercise.
- `food002__crop_2`: the best-before date is cropped out of frame, the allergen panel is fully readable, and the product is past its date. The app correctly says "none of your allergens" but can't know the date.

### 2. Paired model comparison

(running)

## Gemini as the workforce
These calls built the eval set:
- 26 spec calls (`gemini-3.8-flash`);
- about 260 render calls (`gemini-3.1-flash-image`, falling back to `gemini-3-pro-image`);
- about 270 legibility-check calls;
- 1,740 scoring calls.

All were interactive calls, with no Batch API. The ledger with per-call tokens and latency is in `eval/out/ledger.jsonl`.

## Regression probes (FR8 fleet, `eval/suites/*`)
There are 49 small targeted suites (prompt injection, insulin and inhalers, Nordic dose pouches, comma decimals, DataMatrix, sunglass glare and others), each with n = 12 cases, run against the same prompt and `safety.ts`. They all pass. Treat them as **regression probes** that guard known failure modes, **not as evidence of accuracy**: they were written alongside the code they test. The evidence is the 1,740-image eval above.

`eval/suites/model_comparison` is a **small** paired comparison (n = 12 cases per model):
- `gemini-3.8-flash` and `gemini-3.5-flash`: 12/12 correct verdicts, 0 confident-wrong;
- `gemma-4-31b-it`: 11/12, 1 false match, p50 5.6 s vs 3.2 s.

That comparison is directional only; it isn't a headline.

## Caveats
- The legibility check uses the same model family as the reader, which may make synthetic ground truth easier. That's why the headline is the confident-wrong rate and unsafe reassurance, not raw accuracy.
- Real photos (`eval/real/`) aren't scored yet.
