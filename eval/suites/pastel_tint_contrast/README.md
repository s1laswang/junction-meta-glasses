# Pastel, Warm Tungsten, and Low-Vision Filter Contrast Suite (`pastel_tint_contrast`)

Evaluates HoldUp label reading and deterministic safety checking on pastel low-contrast Nordic and generic cartons viewed under warm 2700K tungsten indoor lighting, yellow (450 nm) and amber (511 nm) low-vision contrast filter lenses, photochromic tints, and washed-out grey-on-silver foil strength digits.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `pastel_moderate` (`pt_01` to `pt_06`, 6 cases): Low-contrast pastel mint, blush, cream, lavender, peach, and sage Nordic/generic cartons under 2700K tungsten cast and yellow/amber/photochromic lenses (mean target-region WCAG contrast `4.1787:1`; covers evening pill match, NSAID avoid warning, expired pack warning, wrong strength 10 mg vs 5 mg warning, tree-nut allergen warning, and safe oat drink info).
- `grey_on_silver_washout` (`pt_07`, `pt_08`, `pt_12`, 3 cases): Washed-out pale grey-on-silver metallic foil strength strips on Amlodipin and Metformin cartons under warm tungsten cast, brown photochromic tint, and yellow 450 nm filter lens, requiring `unsure` abstention.
- `yellow_amber_filter_washout` (`pt_09`, `pt_10`, 2 cases): Pale yellow-on-cream and pale amber-on-ivory strength digits on Panadol and Atorvastatin cartons collapsed by yellow 450 nm and amber 511 nm low-vision filter lenses, requiring `unsure` abstention.
- `tungsten_tint_washout` (`pt_11`, 1 case): Pastel lilac Amlodipin carton under unrecovered dark grey photochromic tint and warm 2700K lamp glare over the strength badge, requiring `unsure` abstention.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 washout cases; `washout_abstention_rate`: `1.0`, mean washout WCAG contrast `1.05:1`)
- `latency_p50_ms`: 4100.1 ms, `latency_p95_ms`: 6994.1 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
python3 eval/suites/pastel_tint_contrast/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/pastel_tint_contrast/run.py
```
