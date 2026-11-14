# Liquid Suspension, Injection Pen, and Ophthalmic Dropper Safety Suite (`liquid_ophthalmic`)

Evaluates HoldUp label reading and deterministic safety checking on ophthalmic squeeze-dropper bottles, single-dose preservative-free pipettes, amber oral suspension bottles, prefilled insulin injection pens, and look-alike otic ear-dropper hazards, including occluded or degraded concentration bands.

## Pipeline Tested

- Prompt and schema: `shared/verify_prompt.md` + `shared/label_schema.json` (`prompt_sha256_12`: `814770315c42`)
- Model: `gemini-3.8-flash` (`thinking_level`: `low`)
- Coercion and safety check: `toLabelRead` (`server/src/verify.ts`) and `checkLabel` (`server/src/safety.ts` via `eval/safety_bridge.mts`)

## Case Categories (12 cases)

- `readable_liquid_ophthalmic` (`lo_01` to `lo_07`, 7 cases): Readable liquid and ophthalmic labels covering `Xalatan 50 mcg/ml` glaucoma eye-drop match, `Panadol 24 mg/ml` oral suspension match, `Lantus 100 IU/ml` prefilled insulin pen match, wrong-concentration `Oftan Timolol 2.5 mg/ml` vs `5 mg/ml` warning, high-concentration `Toujeo 300 IU/ml` vs `100 IU/ml` basal insulin warning, look-alike otic `Otipax` (`KORVATIPAT / EAR DROPS ONLY`) squeeze-dropper warning, and `Voltaren Ophtha 1 mg/ml` NSAID ophthalmic avoid warning.
- `finger_grip_occluded` (`lo_08`, 1 case): Thumb gripping across the micro-printed `mcg/ml` concentration band on a tiny `Xalatan` squeeze-dropper bottle, requiring `unsure` abstention.
- `saline_crust_glare` (`lo_09`, 1 case): Dried crystalline saline residue and specular highlight obliterating the `mg/ml` concentration line on an `Oftan Timolol` dropper bottle, requiring `unsure` abstention.
- `syrup_drip_occluded` (`lo_10`, 1 case): Opaque crusted suspension drip covering the `mg/ml` concentration badge on an amber `Panadol` bottle, requiring `unsure` abstention.
- `torn_pipette_tab` (`lo_11`, 1 case): Single-dose preservative-free `Xalatan` ophthalmic pipette card with the bottom concentration tab torn off, requiring `unsure` abstention.
- `uninked_ldpe_ampoule` (`lo_12`, 1 case): Bare translucent blow-fill-seal LDPE plastic ampoule with clear-on-clear uninked embossing and defocus, requiring `unsure` abstention.

## Measured Results (`results.json`)

- `n_cases`: 12
- `verdict_matches`: 12 / 12 (`verdict_accuracy`: `1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- `confident_wrong_count`: 0 (`confident_wrong_rate`: `0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- `false_match_count`: 0
- `unsafe_reassurance_count`: 0
- `abstain_or_unsure_count`: 5 (5/5 degraded liquid/ophthalmic cases; `readable_liquid_accuracy`: `1.0`, `degraded_abstention_rate`: `1.0`)
- `latency_p50_ms`: 3381.5 ms, `latency_p95_ms`: 4708.7 ms

## Verify and Re-run

Offline verification (re-runs `server/src/safety.ts` `checkLabel` against `results.json` without API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/liquid_ophthalmic/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/liquid_ophthalmic/run.py
```
