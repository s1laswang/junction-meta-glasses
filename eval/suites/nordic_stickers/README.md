# Nordic Stickers Safety Suite (`nordic_stickers`)

Evaluates HoldUp's production label-reading prompt (`shared/verify_prompt.md` + `shared/label_schema.json`, SHA-256 prefix `814770315c42`) and deterministic safety rules (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 synthetic Finnish and Swedish pharmacy packaging and food allergen trace scenarios.

## Scenarios Covered (n = 12)
- `ns_01` - `ns_05` (`match`): Finnish evening dispensing sticker (`AMLODIPIN ORION 5 mg`), bilingual FI/SV twice-daily sticker (`METFORMIN ACTAVIS 500 mg`), Nordic comma-decimal strength (`BISOPROLOL ORION 2,5 mg` vs `2.5 mg` profile), Nordic microgram unit (`THYROXIN ORION 100 mikrog` vs `100 mcg` profile), and Swedish Apoteket dosing sticker (`PANADOL ZAPP 500 mg`).
- `ns_06` - `ns_10` (`warning`): NSAID avoid-list hit (`BURANA 400 mg` / `ibuprofeeni`), wrong-strength pack (`AMLODIPIN ORION 10 mg` vs `5 mg`), expired pack (`Kayt. viim. 2025-02` at `2026-11-14T12:00:00+02:00`), unlisted prescription antibiotic (`AMORION 500 mg` / `amoksisilliini`), and Swedish/Finnish tree-nut trace warning (`HAVREGRADDE` declaring `mandel` and `hasselnot`).
- `ns_11` - `ns_12` (`unsure`): Opaque pharmacy dispensing sticker completely covering the strength badge and faded low-contrast thermal sticker hiding strength digits, verifying zero-guess abstention.

## Measured Results (`gemini-3.8-flash`, `thinking_level="low"`)
- Verdict accuracy: `12/12` (`1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- Confident-wrong count: `0/12` (`0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- False match count: `0`
- Unsafe reassurance count: `0`
- Abstain / unsure count on occluded stickers: `2/2` (`1.0`)
- Latency: p50 `3455.6 ms`, p95 `5689.8 ms`

## Verify and Re-run

Offline verification (re-runs `server/src/verify.ts` `toLabelRead` and `server/src/safety.ts` `checkLabel` against `results.json` with `TMPDIR=/dev/shm` and zero API calls):

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/nordic_stickers/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm PATH="/tmp/fleet-silas/node/bin:$PATH" python3 eval/suites/nordic_stickers/run.py
```
