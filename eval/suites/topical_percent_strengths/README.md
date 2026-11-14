# Topical Percentage & mg/g Strength Safety Suite (`topical_percent_strengths`)

Evaluates HoldUp's production label-reading prompt (`shared/verify_prompt.md` + `shared/label_schema.json`, SHA-256 prefix `814770315c42`), `toLabelRead` coercion (`server/src/verify.ts`), and deterministic safety rules (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 topical cream, gel, and ointment cartons and metallic tubes using `%` and `mg/g` strength units.

## Scenarios Covered (`n = 12`)

- `tp_01`, `tp_04`, `tp_06`, `tp_07` (`match`, prescribed `%` and `mg/g` topicals): `HYDROCORTISON ORION 1 %` cream carton (`hydrocortisone`), `FUCIDIN 2 %` ointment tube (`fusidic acid`), `ACYRAX 50 mg/g` antiviral cream tube (`aciclovir`), and `BEMETSON 0,1 %` cream carton (`betamethasone`, Nordic comma decimal `0,1 %` normalised to `0.1 %`).
- `tp_02`, `tp_08` (`warning`, look-alike `%` corticosteroid potency mismatches): `HYDROCORTISON ORION 2,5 %` and `HYDROCORTISON ORION 0,5 %` cream cartons caught against the user's saved `1 %` profile entry.
- `tp_03`, `tp_09` (`warning`, topical NSAID gel `avoid` rules): `VOLTAREN FORTE 23,2 mg/g` diclofenac gel tube and `ORUDIS 2,5 %` ketoprofen gel tube intercepted by `avoid: ["NSAIDs"]`.
- `tp_05` (`warning`, look-alike `2 %` antibacterial ointment): `BACTROBAN 2 %` (`mupirocin`) ointment carton flagged as not on the medication list despite matching the `2 %` strength of saved `Fucidin 2 %`.
- `tp_10` (`warning`, expired topical antibiotic tube): `FUCIDIN 2 %` ointment tube with `EXP 2025-05` flagged as expired.
- `tp_11`, `tp_12` (`unsure`, rolled and crimped metal tube zero-guess abstention): Rolled aluminum `HYDROCORTISON ORION` tube hiding the `%` strength band (`tp_11`) and crimped/folded `ACYRAX` metal tube hiding the `mg/g` concentration (`tp_12`), verifying that HoldUp abstains (`strength not readable`) rather than guessing from the brand name.

## Measured Results (`gemini-3.8-flash`, `thinking_level="low"`, concurrency `<= 4`)

- Verdict accuracy: `12/12` (`1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- Confident-wrong count: `0/12` (`0.0`, Wilson 95% CI `[0.0, 0.2425]`)
- False match count: `0`
- Unsafe reassurance count: `0`
- Topical warning recall: `6/6` (`1.0`)
- Topical match accuracy: `4/4` (`1.0`)
- Rolled and crimped tube abstention rate: `2/2` (`1.0`)
- Latency: p50 `3424.6 ms`, p95 `6437.1 ms`

## Verify and Re-run

Offline verification (re-runs `server/src/verify.ts` `toLabelRead` and `server/src/safety.ts` `checkLabel` against `results.json` with `TMPDIR=/dev/shm` and zero API calls):

```bash
TMPDIR=/dev/shm python3 eval/suites/topical_percent_strengths/run.py --check
```

Full live evaluation against `gemini-3.8-flash`:

```bash
TMPDIR=/dev/shm python3 eval/suites/topical_percent_strengths/run.py
```
