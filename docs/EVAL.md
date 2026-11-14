# HoldUp evaluation, v1 (synthetic, Sat 14 Nov 2026)

**What's tested:** the shipped product path. That is `gemini-3.8-flash` (thinking LOW) with `shared/verify_prompt.md` and `shared/label_schema.json` (prompt hash `814770315c42`), then the deterministic `server/src/safety.ts`, run through `npx tsx`.

**Dataset:**
- Gemini wrote 172 label specs (127 medicines, many Finnish/Swedish packs, look-alike strengths; 45+ foods with allergen synonyms and "may contain" traces).
- `gemini-3.1-flash-image` rendered 210 first-person photos. A separate Flash check dropped 6 renders with garbled text.
- PIL produced degradations at 3 severities: crop, defocus, glare, low light, motion blur, rotation, back of box.
- Ground truth per field is marked visible, partial or hidden.

**1,740 images, 0 API errors.** Results come from `eval/out/results.json` via `eval/run_eval.py`. 95% CIs: Wilson for rates, the rule of three for zero events, bootstrap for ECE and latency.

## Headline
| Metric | Result |
|---|---|
| **Confident-wrong strength reads** (conf ≥ 0.8) | **0 / 754** (95% upper bound 0.4%) |
| Strength when visible (n = 926) | 83.2% correct, 16.8% abstained, **0.0% wrong** |
| Strength when hidden | abstains 98.4% |
| All fields when visible (n = 4,776) | 82.4% correct, 15.9% abstained, 1.7% wrong |
| Calibration ECE, all answered fields (n = 4,406) | 0.022 (0.018–0.028) |
| **Unsafe reassurance, end to end** (n = 4,730 image × profile verdicts) | **49 = 1.0% (0.78–1.37%)** before the Sat-evening fixes |
| Unsafe for "not on my list" and "wrong strength" scenarios (n = 2,560) | **0** |
| Verify latency per call | p50 3.43 s (3.41–3.46), p95 5.55 s (5.42–5.83) |

## Where the 49 unsafe reassurances came from, and the fixes
1. **32 expiry misread or not seen** on a matched medicine. **Fix:** the EU FMD DataMatrix cross-check (`server/src/gs1.ts`, `safety.ts`) reads the exact expiry from the pack's own code. An expired code is a warning, and a code/print conflict is unsure.
2. **17 missed food allergens** (mostly cropped panels where a nut was off-frame). **Fix** (commit `667312c`): "none of your allergens" now needs allergen confidence ≥ 0.95 and readability ≥ 0.8. Otherwise the answer is "not sure, show the whole panel". Replayed on the eval's own predictions, the risky answered food reads drop from **43 to 2 of 334**, and the app still answers on 117. Warnings for a found allergen are unchanged.

A full re-run with both fixes is pending.

## Gemini as the workforce
These calls built the eval set:
- 26 spec calls (`gemini-3.8-flash`);
- about 260 render calls (`gemini-3.1-flash-image`, falling back to `gemini-3-pro-image`);
- about 270 legibility-check calls;
- 1,740 scoring calls.

All were interactive calls, with no Batch API. The ledger with per-call tokens and latency is in `eval/out/ledger.jsonl`.

## Extra suites (FR8 fleet, `eval/suites/*`)
About 25 targeted suites (prompt injection, insulin and inhalers, Nordic dose pouches, comma decimals, DataMatrix, sunglass glare and others) run against the same prompt and `safety.ts`. Each has its own README and `results.json`.

`eval/suites/model_comparison` is a **small** paired comparison (n = 12 cases per model):
- `gemini-3.8-flash` and `gemini-3.5-flash`: 12/12 correct verdicts, 0 confident-wrong;
- `gemma-4-31b-it`: 11/12, 1 false match, p50 5.6 s vs 3.2 s.

That comparison is directional only; it isn't a headline.

## Caveats
- The legibility check uses the same model family as the reader, which may make synthetic ground truth easier. That's why the headline is the confident-wrong rate and unsafe reassurance, not raw accuracy.
- Real photos (`eval/real/`) aren't scored yet.
