# HoldUp evaluation (template: `eval/make_report.py` overwrites this file with measured numbers)

Status: **TEMPLATE, no model numbers yet.** Every field below maps one-to-one to deck slide 10 ("We measure what matters: confident wrong answers") in `deck/index.html`. Fill each one from the source in the third column, and never type a number by hand.

| Slide 10 field | Value | Source (command → JSON key) |
|---|---|---|
| Images scored (synthetic) | TODO | `bash eval/local.sh all` → `eval/out/results.json` → synthetic `strength.n` |
| Images scored (real photos) | TODO | `bash eval/local.sh predict real && bash eval/local.sh score` → real `strength.n` (needs `eval/real/labels.csv` + photos) |
| Confident-wrong strength reads (confidence ≥ 0.8) | TODO | results.json → `strength.confident_wrong` and `confident_wrong_rate` (headline metric) |
| Unsafe reassurances (said "match" when the truth was a warning) | TODO | results.json → safety `unsafe_reassurance` / `unsafe_reassurance_rate` (server `safety.ts` via `eval/safety_bridge.mts`) |
| Strength accuracy when readable | TODO | results.json → `strength.acc_visible` |
| Calibration (ECE) | TODO | results.json → `calibration.ece` |
| Real-photo results | TODO | the same keys for the `real` set |
| Rules layer alone: unsafe reassurances over adversarial reads | **0 of 216** unsafe reassurances (0.0%); match recall on safe, confident reads **15/15** (100.0%). Re-run Sat 14 Nov 2026, 20:48 EET, on this branch (`safety.ts` unchanged from 822994b). **This tests the rules in `server/src/safety.ts`, not the model.** | `cd server && npx --yes tsx scripts/eval-rules.ts` (no key, deterministic; exit 0) |

Every model number carries n, and a 95% CI where `make_report.py` provides one. The method is in `eval/make_report.py` (specs → renders → degradations → predict → score).
