# Crushed Carton Crease and Handheld Magnifier Distortion Safety Suite (`crushed_magnifier`)

Evaluates HoldUp label reading and deterministic safety checking on pocket-crushed pharmacy cartons (crumpled corners, diagonal margin creases, and deep white paper-fiber delamination folds across decimal strength digits) and handheld reading magnifier optics (2x barrel curvature, opaque bezel/handle occlusion, and peripheral spherical aberration blur).

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `readable_distorted` (`cm_01` to `cm_06`, 6 cases): Readable cartons viewed through moderate barrel-distorted handheld reading magnifiers or with pocket-crumpled corners and margin creases away from critical fields (Amlodipin 5 mg evening match, Cardace 2.5 mg decimal match, Metformin 1000 mg vs 500 mg wrong-strength warning, Burana 400 mg NSAID avoid warning, Hazelnut Dark Bar tree-nut allergen warning, and Nordic Oat Crisps nut-free info).
- `crease_fold_decimal_obliteration` (`cm_07`, `cm_08`, 2 cases): Deep white paper-fiber delamination crease across `2.5 mg` on Emconcor (`bisoprolol`) and compound horizontal crush fold across strength digits on Metformin, requiring `unsure` abstention with zero `25 mg` or guessed-dose reads.
- `magnifier_bezel_occlusion` (`cm_09`, `cm_10`, 2 cases): Thick opaque magnifier bezel rim (`cm_09`) or handle (`cm_10`) crossing directly over the numerical strength badge on Amlodipin and Cardace, requiring `unsure` abstention.
- `peripheral_spherical_aberration` (`cm_11`, `cm_12`, 2 cases): High-power reading magnifier centered on product title while severe peripheral spherical blur renders the strength badge (`cm_11`) or food allergen panel (`cm_12`) illegible, requiring `unsure` abstention.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 severely distorted/occluded cases; `severe_distortion_abstention_rate`: `1.0`, `readable_distorted_accuracy`: `1.0`)
- `latency_p50_ms`: 3312.4 ms, `latency_p95_ms`: 6350.2 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/crushed_magnifier/run.py --check
TMPDIR=/dev/shm python3 eval/suites/crushed_magnifier/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/crushed_magnifier/run.py
```
