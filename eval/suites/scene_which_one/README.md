# Multi-Box Spatial Scene Mode Suite (`scene_which_one`)

Evaluates HoldUp's `"Which one?"` multi-package spatial scene mode end to end across 12 synthetic and degraded tabletop scenes (35 total packages across 2-pack and 3-pack layouts), testing `shared/find_prompt.md`, `shared/verify_prompt.md`, `shared/scene_schema.json`, `shared/label_schema.json`, and `server/src/find.ts` (`toRawItems`, `assignPositions`, and `buildSceneVerdict`).

## Pipeline Tested

- System prompt: `shared/find_prompt.md` + `"\n\n"` + `shared/verify_prompt.md` (`prompt_sha256_12`: `c1627b3a5d5c`)
- Response JSON schema: `shared/scene_schema.json` with `read` inlined from `shared/label_schema.json`
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion, spatial ranking, and safety check: `toRawItems`, `assignPositions`, and `buildSceneVerdict` (`server/src/find.ts` + `server/src/safety.ts`)
- Profile: Amlodipine `5 mg` (evening), Panadol / paracetamol `500 mg` (as needed), Metformin `500 mg` (morning); allergies `peanut`, `tree nuts`; avoid `NSAIDs`

## Case Categories (12 cases)

- `clean_lineup` (`sw_01` to `sw_03`, 3 cases): Clean 3-box lineups (`"Which one is my evening pill?"`) rotating Amlodipine `5 mg` across `right`, `left`, and `center` alongside Panadol `500 mg` and Burana `400 mg` -> `match` with exact `ScenePosition`.
- `degraded_strength_occlusion` (`sw_04`, 1 case): Thumb occluding the `5 mg` badge on the right Amlodipine carton while neighbour cartons stay sharp -> `unsure` (0 `< 0.8` dose leaks, 0 confident-wrong doses).
- `degraded_blur_and_unreadable` (`sw_05`, 1 case): Motion-blurred strength badge on the left Amlodipine carton, sharp Panadol `500 mg` in `center`, and heavily blurred unreadable carton on `right` -> `unsure` (`left: Amlodipine: unclear`, `right: a package I can't read: unclear`).
- `wrong_strength_trap` (`sw_06`, 1 case): Look-alike Amlodipine `10 mg` carton in `center` against the profile's `5 mg` evening dose -> `warning` (`Middle box: wrong strength`).
- `duplicate_boxes_taken_today` (`sw_07`, 1 case): Duplicate Amlodipine `5 mg` cartons at `center` and `right` alongside Metformin `500 mg` at `left` when today's evening dose is already recorded in `doseLog` -> `warning` (`Middle box: already taken today`).
- `nsaid_avoid_unlisted` (`sw_08`, 1 case): Unlisted OTC NSAID lineup (`Burana 400 mg`, `Pronaxen 250 mg`, `Aspirin 500 mg`) for `"Can I take Burana 400 mg for pain?"` -> `warning`.
- `food_allergen_table` (`sw_09`, 1 case): 3 food cartons (`Hazelnut Oat Bar` left, `Peanut Crunch Mix` center, nut-free `Nordic Oat Biscuits` right) for `"Which pack has no nuts?"` -> `info` (`Right one: none of your allergens`) with `warning` on both nut packs.
- `food_cropped_panel` (`sw_10`, 1 case): 2 food cartons with bottom-cropped and back-panel-only missing allergen panels for `"Which pack has no nuts?"` -> `unsure` (`None clearly free of your allergens`).
- `expired_target_med` (`sw_11`, 1 case): Expired target Amlodipine `5 mg` carton (`EXP 2024-09`) in `center` -> `warning` (`Middle box: expired`).
- `no_target_overview` (`sw_12`, 1 case): No-target tabletop overview (`target=""`) of Metformin `500 mg`, Burana `400 mg`, and Amlodipine `5 mg` -> `info` (`3 packages seen`) with accurate `left`, `center`, and `right` items.

## Measured Results (`results.json`)

- `n_cases`: 12 (`errors`: 0, `timeouts`: 0)
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `spatial_position_matches`: 7 / 7 (`spatial_position_accuracy`: `1.0`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `position_swap_false_match_count`: 0
- `low_conf_dose_leak_count`: 0
- `abstain_or_unsure_count`: 3 (`degraded_abstention_rate`: `1.0`, 3 / 3 degraded strength, unreadable, or cropped allergen panel cases)
- `latency_p50_ms`: 6235.1 ms, `latency_p95_ms`: 6999.6 ms

## Verify and Re-run

Offline replay and deterministic invariant check (`toRawItems` + `assignPositions` + `buildSceneVerdict` via `server/src/find.ts` covering position swaps, duplicate boxes, unreadable labels, NSAID avoid, and `< 0.8` strength dose-leak blocking with zero network calls):

```bash
/tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/scene_which_one/run.py --check
```

Live evaluation against `gemini-3.8-flash`:

```bash
/tmp/fleet-root/shared/junction-meta-glasses-venv/bin/python eval/suites/scene_which_one/run.py
```
