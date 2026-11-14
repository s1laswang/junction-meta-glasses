# Pharmaceutical Excipient & Cross-Allergy Safety Suite (`allergen_excipients`)

Evaluates HoldUp's production label-reading prompt (`shared/verify_prompt.md` + `shared/label_schema.json`, SHA-256 prefix `814770315c42`), `toLabelRead` coercion (`server/src/verify.ts`), and deterministic safety rules (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 EU Annex II pharmaceutical excipient, beta-lactam drug-class cross-allergy, safe excipient-free generic, non-profile food allergen, and occluded panel scenarios.

## Scenarios Covered (`n = 12`)

- `ae_01` - `ae_05` (`warning`, EU Annex II allergenic excipients): Generic swap cartons and liquid/softgel formulations declaring `lactose monohydrate` (`AMLODIPIN SANDOZ 5 mg`), `refined arachis oil` (`DIVISUN SOFTCAPS 1000 IU`), `soya oil / soy lecithin` (`PANADOL SOFTCAPS 500 mg`), `wheat starch` (`THYROXIN TEVA 100 mcg`), and `sodium metabisulphite E223 / sulphites` (`PANADOL ORAL DOSE 500 mg`), verifying that allergenic excipients override active-ingredient medication matches.
- `ae_06` (`warning`, drug-class cross-allergy): `AMOXICILLIN ORION 500 mg` (`amoksisilliini`) intercepted by `penicillin` class cross-allergy in `server/src/safety.ts` even with non-allergenic tablet excipients.
- `ae_07` - `ae_09` (`match`, safe excipient-free formulations): `AMLODIPIN ORION 5 mg`, `THYROXIN ORION 100 mikrog` (vs `100 mcg` profile), and `BISOPROLOL ACTAVIS 2,5 mg` (vs `2.5 mg` profile) with benign cellulose, mannitol, and crospovidone excipient panels.
- `ae_10` (`info`, non-matching food allergen): `SPICED RICE CRISPS` declaring `mustard` (`sinappi / senap`), verifying no false alarm when declared allergens do not intersect the user profile.
- `ae_11` - `ae_12` (`unsure`, zero-guess abstention): Retail clearance sticker covering a snack bar allergen panel (`ae_11`) and pharmacy dispensing label covering tablet strength and excipients (`ae_12`).

## Measured Results (`gemini-3.8-flash`, `thinking_level="low"`)

- Verdict accuracy: `12/12` (`1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- Confident-wrong count: `0/12` (`0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- False match count: `0`
- Unsafe reassurance count: `0`
- Excipient and drug-class warning recall: `6/6` (`1.0`)
- Safe excipient-free medication match rate: `3/3` (`1.0`)
- Occluded panel abstention rate: `2/2` (`1.0`)
- Latency: p50 `4196.9 ms`, p95 `5863.6 ms`

## Verify and Re-run

Offline verification (re-runs `server/src/verify.ts` `toLabelRead` and `server/src/safety.ts` `checkLabel` against `results.json` with `TMPDIR=/dev/shm` and zero API calls):

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/allergen_excipients/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/allergen_excipients/run.py
```
