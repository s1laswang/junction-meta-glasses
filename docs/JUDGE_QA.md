# HoldUp: Stage & Grand Jury Q&A Cheatsheet

Stage-ready 2-sentence spoken answers for Silas on stage and in grand jury Q&A, paired with exact repository source lines. Every metric below comes directly from committed evaluation results, server usage ledgers, and cited public health sources.

## (a) Seeing AI vs Be My Eyes vs built-in "Hey Meta"

**Question:** Why does this need HoldUp on glasses when Seeing AI, Be My Eyes on Ray-Ban Meta, and built-in "Hey Meta" already exist?

**Answer:** Seeing AI needs a third hand for blind phone aiming and dumps raw OCR text without knowing your profile, while Be My Eyes on Ray-Ban Meta exposes private prescriptions to sighted volunteers across 21 markets. Built-in "Hey Meta" offers general scene description without safety gates, whereas HoldUp coaches your hands into frame and runs a deterministic `safety.ts` check against your on-device profile with `< 0.8` strength and `< 0.95` allergen abstention plus EU FMD DataMatrix cross-checking.

**Source:** `docs/RESEARCH.md:19-20`, `deck/index.html:197-200`, `deck/index.html:211-218`, `server/src/safety.ts:5`, `server/src/safety.ts:15-16`, `server/src/safety.ts:568-621`, `web/src/lib/storage.ts:4-9`.

## (b) EU MDR Class IIa (Rule 11) positioning and adoption/pilot story

**Question:** Isn't medication verification a regulated EU MDR medical device, and how do you actually get this to visually impaired users in Finland?

**Answer:** Today HoldUp is an assistive information-aid prototype, not a certified medical device, that never guesses a dose and hands every uncertain read off to a pharmacist because full medication-list software likely falls under EU MDR Class IIa (Rule 11). Before any CE-marking path, we propose a supervised 4-week, 20-member home pilot with Näkövammaisten liitto (NKL), pharmacy prescription-pickup onboarding, and wellbeing services counties' home-care nurses serving Finland's ~55,000 visually impaired people (~45,000 aged 65+), where 21.6% of Finns 75+ buy 10+ medicines in 4 months per Fimea 2025.

**Source:** `deck/index.html:390`, `deck/index.html:460-471`, `docs/RESEARCH.md:14`, `docs/RESEARCH.md:18`, `docs/PRIVACY.md:5`, `web/src/screens/Onboarding.tsx:39`.

## (c) Why Gemini 3.8 Live + Flash vs Gemma 4 31B

**Question:** Why use Gemini 3.8 Live plus Gemini 3.8 Flash instead of an open-weights model like Gemma 4 31B?

**Answer:** `gemini-3.8-live` gives us bidirectional audio-video coaching with mid-stream tool calls while speculative `gemini-3.8-flash` verification cuts question-to-first-audio from `5.8 s` to `p50 2.1 s / p95 3.4 s` across `n = 26` live sessions, delivering `0 / 754` confident-wrong strength reads (95% upper bound `0.4%`), `0.022` ECE, and `3 / 4,730` = `0.06%` (CI `0.02-0.19%`) silent unsafe reassurances across `1,740` synthetic images. On our `150`-image paired test, `gemma-4-31b-it` had 2x any-field confident-wrong reads (`7.2%` vs `3.6%`), gave the only silent unsafe reassurances (`2 / 377` vs `0 / 377`), and ran ~9x slower (`p50 27.8 s` vs `3.2 s`).

**Source:** `GEMINI.md:21-46`, `server/src/live.ts:166`, `server/src/speculate.ts:22-95`, `docs/evidence/api-stats-snapshot.json:1`, `docs/evidence/smoke-runs.md:20`, `docs/EVAL.md:18-26`, `docs/EVAL.md:61-85`, `eval/results/v1_results.json:10`, `eval/results/v1_results.json:132-144`, `eval/results/v1_results.json:6173`, `eval/results/v2_safety_rescore.json:4-13`, `eval/results/v2_model_compare.json:5`, `eval/results/v2_model_compare.json:44-82`, `eval/results/v2_model_compare.json:184-221`.

## (d) FieldSpotter YOLOv8n on Verda H100

**Question:** Did you train your own model, and what does FieldSpotter on Verda H100 actually do?

**Answer:** We distilled HoldUp's `1,740` Gemini-generated label set (`1,392` train / `348` val split by `src_id`) in `513 s` (`~0.15` GPU-hours) on a shared Verda H100 80GB into FieldSpotter, a `12.8 MB` YOLOv8n detector achieving `96.8%` "strength visible" precision (`122 / 126`, Wilson 95% CI `92.1-98.8%`, recall `65.6%`), `0.572` mAP@0.5, and `p50 34.5 ms` / `p95 35.3 ms` CPU ONNX latency. Gemini remains the reader of record, and our honest status is that `web/public/models/fieldspotter.onnx` is trained, evaluated, and committed in the repo today, not yet wired into live coaching.

**Source:** `docs/evidence/verda-fieldspotter.md:6-29`, `docs/evidence/fieldspotter/split.json:2-5`, `eval/results/fieldspotter.json:4-57`, `web/public/models/fieldspotter.onnx`.

## (e) EU FMD GS1 DataMatrix cross-check

**Question:** How do you defend against optical misreads on faded or blurry expiry dates and look-alike packs?

**Answer:** Paired GS1 parsers in `server/src/gs1.ts` and `web/src/lib/gs1.ts` decode the EU FMD 2D DataMatrix on prescription packs into `(01)` GTIN, `(17)` expiry, `(10)` batch, and `(21)` serial on both server and phone. Deterministic rules in `server/src/safety.ts` require the AI print read and machine code to agree before speaking "double-checked with the pack's code", immediately flag expired codes as a warning or print/code conflicts for a pharmacist, and match saved packs offline in `web/src/lib/verdicts.ts`.

**Source:** `server/src/gs1.ts:13-64`, `web/src/lib/gs1.ts:12-67`, `server/src/safety.ts:548-621`, `web/src/lib/verdicts.ts:41-128`.

## (f) Unit cost per check and GDPR/on-device privacy

**Question:** What does one label check cost in API tokens, and how do you protect medical and bystander privacy under GDPR?

**Answer:** Metered stats in `docs/evidence/api-stats-snapshot.json` log `30,852` in / `1,672` out / `1,071` thinking tokens across `12` `verify` calls (`~2,571` in + `~229` out+thinking tokens/call) and `141,922` in / `5,976` out / `9,626` thinking tokens across `49` `verify_spec` calls on `gemini-3.8-flash`, keeping verification sub-cent per check. HoldUp enforces 3-card onboarding consent, a check-only camera with `45 s` auto-stop, a memory-only `8`-frame ring, a content-redacting logger, and a phone `localStorage` profile with 1-button delete, while honestly noting in `docs/PRIVACY.md` that hackathon billing tier is unconfirmed so any pilot runs on a paid project with a Google DPA.

**Source:** `docs/evidence/api-stats-snapshot.json:1`, `docs/PRIVACY.md:22-68`, `web/src/screens/Onboarding.tsx:14-42`, `web/src/lib/checker.ts:88`, `server/src/env.ts:30`, `server/src/hub.ts:23`, `server/src/hub.ts:96`, `server/src/verify.ts:31-35`, `server/src/log.ts:6-18`, `web/src/lib/storage.ts:4-9`, `web/src/lib/storage.ts:112-124`.
