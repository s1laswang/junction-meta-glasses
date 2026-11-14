# HoldUp eval (v1)

_Generated 2026-11-14 19:47 by `eval/make_report.py` from `eval/out/results.json`._

Model under test: `gemini-3.8-flash` (thinking `low`), prompt + schema from `shared` (hash `814770315c42`). Confident = confidence ≥ 0.8. Safety rules: server/src/safety.ts via npx tsx (STRENGTH_MIN_CONF from the module).

## Headline (synthetic set)

- **160 images** from 22 Gemini-generated label specs (28 renders kept, 0 dropped as garbled).
- Strength: **83.7% accurate when readable**, **0 confident-wrong reads out of 125** (0.0%); abstains on 91.7% of strengths that are not visible.
- End-to-end safety verdict (server rules): **6 unsafe reassurances in 445 verdicts** (1.3%); correct 60.4%, unsure 38.2%.
- Latency per verify call: p50 3.15 s, p95 5.44 s.

### Dataset

| Condition | Images |
|---|---|
| back_of_box | 6 |
| clean | 22 |
| crop | 27 |
| defocus | 9 |
| glare | 21 |
| low_light | 24 |
| motion_blur | 30 |
| rotation | 21 |

### Per-field accuracy (all conditions)

| Field | n | Accuracy (readable) | Abstain (readable) | Wrong (readable) | Abstain (not visible) | Confident-wrong (≥0.8) |
|---|---|---|---|---|---|---|
| product | 160 | 79.7% | 15.3% | 5.1% | 91.3% | **6** (3.8%) |
| ingredient | 125 | 91.1% | 8.9% | 0.0% | 87.5% | **0** (0.0%) |
| strength | 125 | 83.7% | 16.3% | 0.0% | 91.7% | **0** (0.0%) |
| dosing | 125 | – | – | – | 100.0% | **0** (0.0%) |
| expiry | 160 | 80.0% | 20.0% | 0.0% | 100.0% | **0** (0.0%) |
| allergens | 35 | 81.0% | 14.3% | 4.8% | 25.0% | **4** (11.4%) |
| barcode | 159 | 100.0% | 0.0% | 0.0% | 100.0% | **0** (0.0%) |

_Readable_ = the field is legible in the image per the render check and the degradation model. _Not visible_ = cropped, under glare, too blurred, or on the back of the box; the honest answer is null.

### Strength by degradation and severity

| Condition | sev | n | Accuracy (readable) | Abstain (partial/hidden) | Wrong | Confident-wrong |
|---|---|---|---|---|---|---|
| clean | 0 | 17 | 100.0% | – (n=0) | 0.0% | 0 |
| rotation | 1 | 6 | 100.0% | – (n=0) | 0.0% | 0 |
| rotation | 2 | 6 | 83.3% | – (n=0) | 0.0% | 0 |
| rotation | 3 | 6 | 100.0% | – (n=0) | 0.0% | 0 |
| defocus | 1 | 3 | 100.0% | – (n=0) | 0.0% | 0 |
| defocus | 2 | 3 | 66.7% | – (n=0) | 0.0% | 0 |
| defocus | 3 | 3 | 0.0% | 100.0% (n=1) | 0.0% | 0 |
| motion_blur | 1 | 8 | 100.0% | – (n=0) | 0.0% | 0 |
| motion_blur | 2 | 8 | 50.0% | – (n=0) | 0.0% | 0 |
| motion_blur | 3 | 8 | 0.0% | 100.0% (n=5) | 0.0% | 0 |
| low_light | 1 | 4 | 100.0% | – (n=0) | 0.0% | 0 |
| low_light | 2 | 4 | 100.0% | – (n=0) | 0.0% | 0 |
| low_light | 3 | 4 | 0.0% | 100.0% (n=1) | 0.0% | 0 |
| glare | 1 | 6 | 100.0% | – (n=0) | 0.0% | 0 |
| glare | 2 | 6 | – | 83.3% (n=6) | 0.0% | 0 |
| glare | 3 | 6 | – | 83.3% (n=6) | 0.0% | 0 |
| crop | 1 | 7 | 100.0% | 75.0% (n=4) | 0.0% | 0 |
| crop | 2 | 7 | 100.0% | 100.0% (n=6) | 0.0% | 0 |
| crop | 3 | 7 | 100.0% | 100.0% (n=4) | 0.0% | 0 |
| back_of_box | 0 | 6 | – | 100.0% (n=6) | 0.0% | 0 |

### Allergens by degradation and severity

| Condition | sev | n | Accuracy (readable) | Abstain (partial/hidden) | Wrong | Confident-wrong |
|---|---|---|---|---|---|---|
| clean | 0 | 5 | 100.0% | – (n=0) | 0.0% | 0 |
| rotation | 1 | 1 | 100.0% | – (n=0) | 0.0% | 0 |
| rotation | 2 | 1 | 100.0% | – (n=0) | 0.0% | 0 |
| rotation | 3 | 1 | 100.0% | – (n=0) | 0.0% | 0 |
| motion_blur | 1 | 2 | 100.0% | – (n=0) | 0.0% | 0 |
| motion_blur | 2 | 2 | 0.0% | 100.0% (n=1) | 0.0% | 0 |
| motion_blur | 3 | 2 | – | 100.0% (n=2) | 0.0% | 0 |
| low_light | 1 | 4 | 100.0% | – (n=0) | 0.0% | 0 |
| low_light | 2 | 4 | 50.0% | – (n=0) | 25.0% | 1 |
| low_light | 3 | 4 | 0.0% | 100.0% (n=3) | 0.0% | 0 |
| glare | 1 | 1 | 100.0% | – (n=0) | 0.0% | 0 |
| glare | 2 | 1 | – | 0.0% (n=1) | 100.0% | 0 |
| glare | 3 | 1 | – | 0.0% (n=1) | 0.0% | 0 |
| crop | 1 | 2 | – | 0.0% (n=2) | 50.0% | 1 |
| crop | 2 | 2 | – | 0.0% (n=2) | 0.0% | 0 |
| crop | 3 | 2 | – | 0.0% (n=2) | 100.0% | 2 |

### Calibration: strength

| Confidence bin | n | Mean confidence | Accuracy |
|---|---|---|---|
| [0.70,0.80) | 2 | 0.725 | 100.0% |
| [0.80,0.90) | 1 | 0.8 | 100.0% |
| [0.90,0.95) | 5 | 0.9 | 100.0% |
| [0.95,1.00] | 67 | 0.97 | 100.0% |

Expected calibration error (ECE): **0.043**

### Calibration: all fields

| Confidence bin | n | Mean confidence | Accuracy |
|---|---|---|---|
| [0.50,0.60) | 2 | 0.5 | 100.0% |
| [0.60,0.70) | 1 | 0.6 | 100.0% |
| [0.70,0.80) | 12 | 0.712 | 91.7% |
| [0.80,0.90) | 23 | 0.837 | 82.6% |
| [0.90,0.95) | 26 | 0.901 | 92.3% |
| [0.95,1.00] | 343 | 0.965 | 98.8% |

Expected calibration error (ECE): **0.031**

### Choosing the 'unsure' threshold for strength

| Trust threshold t | Readable strengths accepted (coverage) | Trusted reads | Trusted but wrong | Wrong rate among trusted |
|---|---|---|---|---|
| 0.5 | 83.7% | 75 | 0 | 0.0% |
| 0.6 | 83.7% | 75 | 0 | 0.0% |
| 0.7 | 83.7% | 75 | 0 | 0.0% |
| 0.8 | 81.4% | 73 | 0 | 0.0% |
| 0.85 | 80.2% | 72 | 0 | 0.0% |
| 0.9 | 80.2% | 72 | 0 | 0.0% |
| 0.95 | 76.7% | 67 | 0 | 0.0% |

### End-to-end safety verdict

Each image is checked against 2–3 profiles: the item on the list at the same strength, on the list at a different strength, not on the list (medicines); allergic to an allergen it contains, or to one it doesn't (food). _Unsafe reassurance_ = the true verdict is a warning (wrong strength, not your med, allergen, expired) but the system says match/no-allergen.

| Safety rules | Verdicts | Correct vs truth | Unsure | **Unsafe reassurance** | False match |
|---|---|---|---|---|---|
| server safety.ts (as shipped) | 445 | 60.4% | 38.2% | **6** (1.3%) | 4 |
| python port, all thresholds = 0.6 | 445 | 62.2% | 34.8% | **10** (2.2%) | 6 |
| python port, all thresholds = 0.7 | 445 | 62.2% | 34.8% | **10** (2.2%) | 6 |
| python port, all thresholds = 0.8 | 445 | 60.7% | 36.0% | **11** (2.5%) | 7 |
| python port, all thresholds = 0.9 | 445 | 54.8% | 43.1% | **6** (1.3%) | 4 |

Per scenario (server rules):

| Scenario | n | Correct | Unsure | Unsafe |
|---|---|---|---|---|
| allergic_to_absent | 35 | 65.7% | 28.6% | 2 |
| allergic_to_contained | 35 | 71.4% | 28.6% | 0 |
| not_on_list | 125 | 68.0% | 32.0% | 0 |
| on_list_other_strength | 125 | 56.0% | 44.0% | 0 |
| on_list_same_strength | 125 | 52.8% | 44.0% | 4 |

By condition (server rules):

| Condition | Verdicts | Correct vs truth | Unsure | Unsafe reassurance | Agrees with ideal reader |
|---|---|---|---|---|---|
| clean | 61 | 100.0% | 0.0% | 0 | 100.0% |
| rotation | 60 | 95.0% | 5.0% | 0 | 95.0% |
| defocus | 27 | 44.4% | 51.9% | 1 | 55.6% |
| motion_blur | 84 | 42.9% | 56.0% | 1 | 64.3% |
| low_light | 60 | 55.0% | 45.0% | 0 | 61.7% |
| glare | 60 | 61.7% | 38.3% | 0 | 91.7% |
| crop | 75 | 44.0% | 50.7% | 4 | 74.7% |
| back_of_box | 18 | 0.0% | 100.0% | 0 | 100.0% |

Unsafe reassurance cases (server rules):

| Image | Scenario | Truth | System said | Reasons |
|---|---|---|---|---|
| med004__defocus_2 | on_list_same_strength | warning | match | expiry not readable; matches m1; taken today: 0/1 |
| med010__crop_1 | on_list_same_strength | warning | match | expiry not readable; matches m1; taken today: 0/1 |
| med015__motion_blur_1 | on_list_same_strength | warning | match | expiry not readable; matches m1; taken today: 0/1 |
| med012__crop_2 | on_list_same_strength | warning | match | expiry not readable; matches m1; taken today: 0/1 |
| food001__crop_1 | allergic_to_absent | warning | info | no listed allergen matches your profile |
| food003__crop_2 | allergic_to_absent | warning | info | no listed allergen matches your profile |

### Confident-wrong examples

| Image | Field | GT status | Truth | Read | Conf |
|---|---|---|---|---|---|
| med011__clean_0 | product | visible | Pamol 24 mg/ml | Pamol | 0.99 |
| med011__low_light_1 | product | visible | Pamol 24 mg/ml | Pamol | 0.95 |
| med011__low_light_2 | product | visible | Pamol 24 mg/ml | Pamol | 0.85 |
| med011__glare_1 | product | visible | Pamol 24 mg/ml | Pamol | 0.98 |
| food001__crop_1 | allergens | partial | ['gluten', 'milk', 'soy', 'tree_nuts'] | ['milk', 'soy', 'may contain: nut', 'may contain: gluten'] | 0.8 |
| food001__crop_3 | allergens | hidden | ['gluten', 'milk', 'soy', 'tree_nuts'] | ['may contain: almond', 'may contain: gluten'] | 0.85 |
| food003__crop_3 | allergens | hidden | ['egg', 'gluten', 'milk', 'soy', 'tree_nuts'] | ['may contain: egg', 'may contain: soy', 'may contain: hazelnut'] | 0.95 |
| food002__motion_blur_2 | product | visible | Laku Mix Salmiakki & Vadelma | Laku Mix | 0.9 |
| food005__low_light_2 | product | visible | Eila Paahdettu Maapähkinä-Kinuski Rahkamousse | Valio | 0.9 |
| food005__low_light_2 | allergens | visible | ['milk', 'peanut', 'tree_nuts'] | ['milk', 'peanut'] | 0.85 |

## Real photos

_Pending: photos land in `eval/real/` with `labels.csv` (v2)._

## Gemini as a workforce: calls and tokens

| Workforce step | Model | Calls (ok) | Input tokens | Output tokens | Thinking tokens |
|---|---|---|---|---|---|
| eval.verify_label | gemini-3.8-flash | 187 (187) | 479,102 | 23,948 | 10,081 |
| gen_images.check | gemini-3.8-flash | 31 (29) | 42,852 | 12,512 | 89,600 |
| gen_images.render | gemini-3-pro-image | 1 (1) | 272 | 1,460 | 299 |
| gen_images.render | gemini-3.1-flash-image | 30 (30) | 5,844 | 43,813 | 0 |
| gen_specs | gemini-3.8-flash | 4 (4) | 1,079 | 8,579 | 0 |
| **total** | | **253** | **529,149** | **90,312** | **99,980** |

## Method

1. `eval/gen_specs.py`: gemini-3.8-flash writes ground-truth label specs (medicine boxes and bottles incl. Finnish/Swedish packs; food packs with allergen synonyms and trace statements).
2. `eval/gen_images.py`: gemini-3.1-flash-image renders a first-person photo of a hand holding each item (fallback gemini-3-pro-image, nano-banana-pro-preview); a separate check call (gemini-3.8-flash, thinking high, given the spec) marks each field legible/matching and returns its bounding box. Renders with garbled key fields are re-rendered once, then dropped; mismatched minor fields are excluded from scoring. A subset gets a back-of-box render.
3. `eval/degrade.py` (Slurm, CPU): motion blur, defocus, rotation, partial crop, glare, low light at 3 severities; each field's ground-truth status (readable / partial / not visible) is updated from its bounding box.
4. `eval/run_eval.py`: runs the product's verify prompt and schema on each 768 px frame (one frame per call), scores fields with normalisation (units, dates, allergen synonyms), and runs the safety rules.

Caveats: the render check uses the same model family as the model under test (gemini-3.1-pro-preview is not available on our key), so 'readable' labels lean on Gemini's own reading of the clean render; a bias toward easier ground truth is possible. Degradation visibility is a heuristic from text height and box overlap. Real photos (v2) are the check on both.
