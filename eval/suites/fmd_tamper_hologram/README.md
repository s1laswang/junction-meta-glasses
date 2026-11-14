# EU FMD Anti-Tamper Hologram, VOID Residue, and Perforation Safety Suite (`fmd_tamper_hologram`)

Evaluates HoldUp label reading and deterministic safety checking on European Falsified Medicines Directive (EU FMD 2016/161) serialized packs featuring rainbow hologram anti-tamper seals, 2D GS1 DataMatrix blocks, post-opening VOID adhesive residue, and partially torn perforations.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `intact_fmd_pack` (`fh_01` to `fh_06`, 6 cases): Intact readable EU FMD cartons with rainbow hologram, translucent, or silver security seals on the tuck-flap plus 2D GS1 DataMatrix blocks (`PC`/`SN`/`EXP`/`LOT`) in the safe zone (evening pill 5 mg match, wrong strength 10 mg vs 5 mg warning, Burana 400 mg NSAID avoid warning, expired `EXP 2025-01` DataMatrix pack warning, tree-nut allergen warning, and nut-free oat crackers info).
- `hologram_specular_rainbow` (`fh_07`, `fh_08`, 2 cases): EU FMD rainbow hologram seal pasted directly over the strength badge or hit by direct LED rainbow diffraction flare across strength digits, requiring `unsure` abstention.
- `void_adhesive_residue` (`fh_09`, `fh_10`, 2 cases): Peeled EU FMD anti-tamper tape leaving blue checkerboard `VOID OPENED` adhesive residue and fiber tear across strength digits after opening, requiring `unsure` abstention.
- `torn_perforation_tamper` (`fh_11`, `fh_12`, 2 cases): Partially torn perforation and silver security seal ripping across or covering the strength, GS1 DataMatrix, expiry, or allergen panel, requiring `unsure` abstention.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 6 (6/6 tamper-occluded cases; `tamper_occluded_abstention_rate`: `1.0`, `intact_fmd_pack_accuracy`: `1.0`)
- `latency_p50_ms`: 3696.7 ms, `latency_p95_ms`: 5745.7 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/fmd_tamper_hologram/run.py --check
TMPDIR=/dev/shm python3 eval/suites/fmd_tamper_hologram/run.py --verify-cached
```

Full live evaluation against `gemini-3.8-flash`:

```bash
python3 eval/suites/fmd_tamper_hologram/run.py
```
