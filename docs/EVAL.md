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
No new model calls: the same 1,740 `gemini-3.8-flash` reads (prompt `814770315c42`), the same 4,730 image × profile scenarios, now checked by main's `server/src/safety.ts` at `d404115`. The change that matters is the allergen gate from `667312c`: "none of your allergens" needs allergen confidence ≥ 0.95 and readability ≥ 0.8. The later hedge for a blurry non-medicine (`d404115`) changes none of these 4,730 verdicts; the numbers are identical at `667312c` and `d404115`. Reproduce with `eval/rescore_safety.py`; results are in **`eval/results/v2_safety_rescore.json`**. As a sanity check, the same scorer with v1's `safety.ts` reproduces v1's 49 / 4,730 exactly.

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

### 2. Paired model comparison: gemini-3.8-flash vs gemini-3.5-flash vs gemma-4-31b-it
The same 150 images go to all three models: a fixed, stratified subset of the v1 set (seed 42; 82 medicines, 68 foods; clean, every degradation and severity, back of box). Each model gets the same verify prompt and schema (`814770315c42`), the same scoring, and main's `safety.ts` (`d404115`). The Gemini models use thinking LOW and JSON-schema mode. Gemma on the Gemini API has neither, so it gets the prompt and schema in the user turn and its code fences are stripped. **All 450 calls returned parseable JSON** (Gemma's 10 quota 429s were retried and succeeded). All calls were interactive, at most 12 concurrent. Results are in **`eval/results/v2_model_compare.json`**; reproduce with `eval/compare_models.py`. Chart: `docs/img/eval_model_compare.png`.

![Model comparison](img/eval_model_compare.png)

| n = 150 images | gemini-3.8-flash (shipped) | gemini-3.5-flash | gemma-4-31b-it |
|---|---|---|---|
| Strength correct, readable (n = 59) | 46 = 78.0% (65.9–86.7%) | 42 = 71.2% (58.6–81.2%) | 46 = 78.0% (65.9–86.7%) |
| **Confident-wrong strength** (conf ≥ 0.8, n = 82) | **0** (≤ 3.7%, rule of three) | **0** (≤ 3.7%) | **0** (≤ 3.7%) |
| Confident-wrong, any field (n = 528) | 19 = 3.6% (2.3–5.6%) | 20 = 3.8% (2.5–5.8%) | **38 = 7.2% (5.3–9.7%)** |
| of which allergens | 8 | 9 | 21 |
| **Silent unsafe reassurance** (n = 377 verdicts) | **0** (≤ 0.8%) | **0** (≤ 0.8%) | 2 = 0.53% (0.15–1.91%) |
| Verdict equals the true-label verdict | 214 = 56.8% (51.7–61.7%) | 207 = 54.9% (49.9–59.9%) | 219 = 58.1% (53.1–63.0%) |
| "Not sure" | 158 = 41.9% (37.0–47.0%) | 164 = 43.5% (38.6–48.6%) | 147 = 39.0% (34.2–44.0%) |
| Verify latency p50 / p95 | 3.2 s (3.0–3.4) / 6.1 s | **2.0 s (1.9–2.3)** / 4.5 s | 27.8 s (26.9–29.9) / 48.5 s |

**Paired differences vs gemini-3.8-flash.** 95% CIs come from a paired bootstrap over images. p is the exact McNemar test on discordant pairs.
- **gemini-3.5-flash:** strength −6.8 pp (−15.1 to 0.0; 5 vs 1 discordant, p = 0.22), any-field confident-wrong +0.2 pp (−1.3 to +1.5), unsafe 0 vs 0. **1.2 s faster** (median paired difference −1.17 s, −1.34 to −0.94; slower on only 23/150 images). No accuracy or safety difference is detectable at this n. The strength point estimate is lower, but the CI includes 0.
- **gemma-4-31b-it:** strength 0.0 pp (−8.3 to +8.1). **Any-field confident-wrong +3.6 pp (+1.7 to +5.5)**, the only significant accuracy difference, and mostly allergens. Unsafe +0.5 pp (0.0 to +1.3; 2 vs 0, p = 0.5). **24.3 s slower** (23.3–26.1), slower on 150/150 images.
- One of Gemma's two unsafe verdicts is the worst kind. On `food036__crop_2` it listed only sesame at allergen confidence 0.95 (readability 0.9) and missed a "may contain peanut" trace, so a peanut-allergic user hears "none of your allergens". That passes the 0.95/0.8 gate; the gate needs a calibrated reader. The other (`food018__crop_1`) is an expired food with the date cropped out.

**Test-retest of the shipped model.** v1's `gemini-3.8-flash` reads of the same 150 images, scored the same way, differ from tonight's fresh reads on no metric. Strength is 46/59 both times (2 vs 2 discordant), unsafe is 0 vs 0, and verdict-correct differs by +1.1 pp (−1.4 to +3.7). Under the previous `safety.ts` (`667312c`), the fresh run had 2 unsafe verdicts, both from one blurred milk carton read as a non-food "Recovery Gel". That gap is fixed in `d404115`, which is why the table shows 0.

**What this supports:** keep `gemini-3.8-flash`. `gemini-3.5-flash` is a credible faster fallback, with nothing measurably worse at n = 150, but this test can't rule out a strength gap of up to ~15 pp. Gemma reads strength as well, but it is twice as often confidently wrong (mostly allergens), it is the only model here with an unsafe reassurance, and it is about 9× slower.

**Limits:**
- n = 150 is small. Strength accuracy rests on 59 readable strengths, so differences under ~15 pp aren't resolvable.
- Gemma runs under a 16k input-token/min quota on our key. Its latency was about 27 s both in a 12-worker pass and in the 3-worker pass that finished it, so concurrency isn't the cause. The earlier 12-case fleet suite measured 5.6 s for Gemma on a different day, so Gemma latency depends on the endpoint.
- Synthetic images only.

## Red-team v1: 32 attack families (Sun night, `eval/results/redteam_v1.json`, `eval/redteam/`)
**Who built it:** a separate Gemini session.
- `gemini-4-carbon` designed 32 clinical and packaging attack families: look-alike drug names (LASA), 2.5 vs 25 mg, mg vs mcg, combination products, pharmacy stickers over the print, prompt injection printed on packs, two boxes in frame, a thumb over a digit, odd expiry formats, hidden "may contain" traces, E-number sulphites, and more.
- `gemini-4-hydrogen` wrote 2,048 specs, and `gemini-3.1-flash-image` rendered 566 verified images, which became 2,264 test images.
- The **shipped reader** (`gemini-3.8-flash`, prompt `814770315c42`) read every image, and `server/src/safety.ts` judged it.

| Silent unsafe reassurance (n = 2,264) | Before (`safety.ts` at `1d395b3`) | After (main) |
|---|---|---|
| All families | 199 = 8.79% (7.69–10.03%) | **13 = 0.57% (0.34–0.98%)** |
| Wrong drug or wrong strength called a match | 0 | 0 |
| Families with 0 unsafe | | 29 of 32 |
| Safe controls still reassured (n = 2,120) | 1,338 = 63.1% | 1,340 = 63.2% (no extra over-caution) |

**What remains:** 12 missed allergens or excipients (food or medicine), and 1 expired pack.

**Caveat (in-sample):** the `safety.ts` guards were written by looking at these same 199 failures (a broader Finnish/Nordic brand map, the anticoagulant and sulfonamide classes, molluscs, marzipan/praline as tree nuts, E220–E228 sulphites, per-gram concentrations). So "after" is a **training-set number, not a held-out one**. Every failing case is pinned as a regression test (`server/test/safety-redteam-ws1.test.ts`, 199 fixtures).

**No regression on the held-out v2 set:** re-scoring the 4,730 v2 verdicts with the merged rules still gives 3/4,730 = 0.06%.

## Gemini as the workforce
These calls built the eval set:
- 26 spec calls (`gemini-3.8-flash`);
- about 260 render calls (`gemini-3.1-flash-image`, falling back to `gemini-3-pro-image`);
- about 270 legibility-check calls;
- 1,740 scoring calls.

All were interactive calls, with no Batch API. The ledger with per-call tokens and latency is in `eval/out/ledger.jsonl`.

## Regression probes (FR8 fleet, `eval/suites/*`)
There are 49 small targeted suites (prompt injection, insulin and inhalers, Nordic dose pouches, comma decimals, DataMatrix, sunglass glare and others), each with n = 12 cases, run against the same prompt and `safety.ts`. They all pass. Treat them as **regression probes** that guard known failure modes, **not as evidence of accuracy**: they were written alongside the code they test. The evidence is the 1,740-image eval above.

`eval/suites/model_comparison` is a **small** paired comparison (n = 12 cases per model; superseded by the n = 150 comparison in v2 above):
- `gemini-3.8-flash` and `gemini-3.5-flash`: 12/12 correct verdicts, 0 confident-wrong;
- `gemma-4-31b-it`: 11/12, 1 false match, p50 5.6 s vs 3.2 s.

That comparison is directional only; it isn't a headline.

## Caveats
- **Recomputable:** the per-image predictions (`eval/results/v1/preds_synthetic.jsonl`, 1,740 rows) and ground truth (`eval/results/v1/ground_truth.jsonl`) are committed. Every number above can be recomputed with `eval/run_eval.py score` and `eval/rescore_safety.py` without new model calls.
- **One ground-truth override** (`eval/gt_overrides.json`): med113's strength is "30 mg + 70 mg", because the render prints "30 mg Fe + 70 mg Vit. C"; the spec said "30 mg". It was checked by eye against the clean render, and it affects 1 of 172 labels.
- **Self-graded and synthetic:** Gemini wrote the specs, rendered the images and filtered legibility, and the allergen gate (≥ 0.95 / 0.8) was tuned on this same set. Treat v1/v2 as in-sample; real photos are not yet scored.
- The legibility check uses the same model family as the reader, which may make synthetic ground truth easier. That's why the headline is the confident-wrong rate and unsafe reassurance, not raw accuracy.
- Real photos (`eval/real/`) aren't scored yet: as of Sat 23:30, `origin/main` has only the template `labels.csv` (one `example.jpg` row) and no JPGs. `eval/run_eval.py predict --set real` and `score` handle them and report them separately once they land.
