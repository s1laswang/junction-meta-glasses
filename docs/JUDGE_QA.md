# HoldUp: Stage & Grand Jury Q&A Cheatsheet

Stage-ready 2-sentence spoken answers for Silas on stage and in grand jury Q&A, paired with exact repository source paths and line numbers on `main`. Every metric below comes directly from committed evaluation results, server usage ledgers, and cited public health sources.

## (a) Seeing AI vs Be My Eyes vs built-in "Hey Meta"

**Question:** Why does this need HoldUp on glasses when Seeing AI, Be My Eyes on Ray-Ban Meta, and built-in "Hey Meta" already exist?

**Answer:** Seeing AI needs a third hand for blind phone aiming and dumps raw OCR text without knowing your profile, while Be My Eyes on Ray-Ban Meta exposes private prescriptions to sighted volunteers across 21 markets. Built-in "Hey Meta" offers general scene description without safety gates, whereas HoldUp (built for Ray-Ban Meta and Ray-Ban Display, running on the phone camera today until `docs/HARDWARE_LOG.md` is logged) coaches your hands into frame and runs a deterministic `safety.ts` check against your on-device profile with `< 0.8` strength and `< 0.95` allergen abstention plus EU FMD DataMatrix cross-checking.

**Source:** `README.md:13-19`, `docs/RESEARCH.md:19-20`, `deck/index.html:197-200`, `deck/index.html:211-219`, `docs/HARDWARE_LOG.md:1-4`, `server/src/safety.ts:5`, `server/src/safety.ts:15-16`, `server/src/safety.ts:847-911`, `web/src/lib/storage.ts:5-10`.

## (b) EU MDR Class IIa (Rule 11) positioning and adoption/pilot story

**Question:** Isn't medication verification a regulated EU MDR medical device, and how do you actually get this to visually impaired users in Finland?

**Answer:** Today HoldUp is a research prototype, not CE-marked, positioned on Slide 9 as `Decision support, not diagnosis` because full medication-list software likely falls under EU MDR Class IIa (Rule 11): it only states a dose at confidence >= 0.8, never recommends or changes a dose, and hands every uncertain read off to a pharmacist. With HoldUp built for Ray-Ban Meta and Ray-Ban Display (running on the phone camera today until `docs/HARDWARE_LOG.md` is logged), Slide 12 Adoption and Slide 13 Team+Ask propose a supervised 4-week, 20-member home pilot with Näkövammaisten liitto (NKL), pharmacy prescription-pickup onboarding, and wellbeing services counties' home-care nurses serving Finland's ~55,000 visually impaired people (~45,000 aged 65+), where 21.6% of Finns 75+ buy 10+ medicines in 4 months per Fimea 2025.

**Source:** `README.md:9`, `deck/index.html:219`, `deck/index.html:389-392`, `deck/index.html:412-431`, `deck/index.html:490-513`, `deck/index.html:528-549`, `docs/PILOT_PLAN.md:5-10`, `docs/HARDWARE_LOG.md:1-4`, `docs/RESEARCH.md:14`, `docs/RESEARCH.md:18`, `docs/PRIVACY.md:5`, `web/src/screens/Onboarding.tsx:39`.

## (c) Why Gemini 3.8 Live + Flash vs Gemma 4 31B

**Question:** Why use Gemini 3.8 Live plus Gemini 3.8 Flash instead of an open-weights model like Gemma 4 31B?

**Answer:** `gemini-3.8-live` gives us bidirectional audio-video coaching with mid-stream tool calls (plus server-side spoken-answer fidelity checking in `server/src/fidelity.ts`, `15 / 16` live verdicts passed and `1` auto-corrected) while speculative `gemini-3.8-flash` verification cuts question-to-first-audio from `5.8 s` to `p50 2.1 s / p95 3.4 s` across `n = 26` live sessions, delivering `0 / 754` confident-wrong strength reads (95% upper bound `0.4%`), `0.022` ECE, and `3 / 4,730` = `0.06%` (CI `0.02-0.19%`) silent unsafe reassurances across `1,740` synthetic images. On our `150`-image paired test, `gemma-4-31b-it` had 2x any-field confident-wrong reads (`7.2%` vs `3.6%`), gave the only silent unsafe reassurances (`2 / 377` vs `0 / 377`), and ran ~9x slower (`p50 27.8 s` vs `3.2 s`).

**Source:** `GEMINI.md:3-8`, `GEMINI.md:21-49`, `server/src/live.ts:179-189`, `server/src/speculate.ts:22-98`, `server/src/fidelity.ts:8-30`, `docs/evidence/live-fidelity.md:12-17`, `docs/evidence/api-stats-snapshot.json:1`, `docs/evidence/smoke-runs.md:20`, `docs/EVAL.md:18-26`, `docs/EVAL.md:61-85`, `eval/results/v1_results.json:10`, `eval/results/v1_results.json:132-144`, `eval/results/v1_results.json:6173`, `eval/results/v2_safety_rescore.json:4-13`, `eval/results/v2_model_compare.json:5`, `eval/results/v2_model_compare.json:44-82`, `eval/results/v2_model_compare.json:184-221`.

## (d) FieldSpotter YOLOv8n on Verda H100

**Question:** Did you train your own model, and what does FieldSpotter on Verda H100 actually do?

**Answer:** We distilled HoldUp's `1,740` Gemini-generated label set (`1,392` train / `348` val split by `src_id`) in `513 s` (`~0.15` GPU-hours) on a shared Verda H100 80GB into FieldSpotter, a `12.8 MB` YOLOv8n detector achieving `96.8%` "strength visible" precision (`122 / 126`, Wilson 95% CI `92.1-98.8%`, recall `65.6%`), `0.572` mAP@0.5, and `p50 34.5 ms` / `p95 35.3 ms` CPU ONNX latency, alongside a Verda A100 PaliGemma 2 3B LoRA reaching `91.4%` recall in `GEMMA.md`. Gemini plus deterministic `safety.ts` remain the reader and judge of record, while `web/public/models/fieldspotter.onnx` is trained, evaluated, and committed in the repo and wired into optional server-side spatial coaching behind `SPOTTER=1` (off by default in `server/src/spotter.ts` and `server/src/spotcoach.ts`).

**Source:** `docs/evidence/verda-fieldspotter.md:6-29`, `docs/evidence/fieldspotter/split.json:2-5`, `eval/results/fieldspotter.json:4-57`, `GEMMA.md:19-28`, `eval/results/fieldspotter_gemma.json:36-50`, `server/src/spotter.ts:15-17`, `server/src/spotcoach.ts:21-58`, `web/public/models/fieldspotter.onnx`.

## (e) EU FMD GS1 DataMatrix cross-check and WS1 32-family red-team

**Question:** How do you defend against optical misreads on faded or blurry expiry dates, adversarial labels, and look-alike packs?

**Answer:** Paired GS1 parsers in `server/src/gs1.ts` and `web/src/lib/gs1.ts` decode the EU FMD 2D DataMatrix on prescription packs into `(01)` GTIN, `(17)` expiry, `(10)` batch, and `(21)` serial so `server/src/safety.ts` requires the AI print read and machine code to agree before speaking "double-checked with the pack's code", flags expired codes as a warning or print/code conflicts for a pharmacist, and matches saved packs offline in `web/src/lib/verdicts.ts`. We also stress-tested `safety.ts` with a WS1 32-family Gemini red-team across `2,264` adversarial images (`2,048` specs), cutting silent unsafe reassurances from `199 / 2,264` (`8.79%`) to `13 / 2,264` (`0.57%`, in-sample with `0` wrong-drug or wrong-strength matches and `199` regression fixtures), fixed `7/7` judge-panel probes in `server/test/judge-probes.test.ts`, and verified `1 / 536` (`0.19%`) confident-wrong strengths and `4 / 3,033` (`0.13%`) silent unsafe verdicts on `1,060` unseen held-out v3 images.

**Source:** `server/src/gs1.ts:13-64`, `web/src/lib/gs1.ts:12-67`, `server/src/safety.ts:847-911`, `web/src/lib/verdicts.ts:41-128`, `GEMINI.md:34-35`, `docs/EVAL.md:91-120`, `eval/results/redteam_v1.json:15-63`, `eval/results/v3_heldout_safety.json:7-16`, `server/test/safety-redteam-ws1.test.ts:1-40`, `server/test/judge-probes.test.ts:1-52`.

## (f) Unit cost per check and GDPR/on-device privacy

**Question:** What does one label check cost in API tokens, and how do you protect medical and bystander privacy under GDPR?

**Answer:** Metered stats in `docs/evidence/api-stats-snapshot.json` log `30,852` in / `1,672` out / `1,071` thinking tokens across `12` `verify` calls (`~2,571` in + `~229` out+thinking tokens/call) and `141,922` in / `5,976` out / `9,626` thinking tokens across `49` `verify_spec` calls on `gemini-3.8-flash`, keeping verification sub-cent (`~$0.003` per label read on Slide 12). HoldUp enforces 3-card onboarding consent, a check-only camera with `45 s` auto-stop, a memory-only `8`-frame ring, a content-redacting logger, and a phone `localStorage` profile (held in server memory only during a check and up to `10` minutes for reconnects) with 1-button delete, while honestly noting in `docs/PRIVACY.md` that hackathon billing tier is unconfirmed so any pilot runs on a paid project with a Google DPA.

**Source:** `docs/evidence/api-stats-snapshot.json:1`, `deck/index.html:512`, `docs/PRIVACY.md:5`, `docs/PRIVACY.md:22-69`, `web/src/screens/Onboarding.tsx:14-42`, `web/src/lib/checker.ts:84`, `server/src/env.ts:30`, `server/src/hub.ts:68`, `server/src/hub.ts:209`, `server/src/hub.ts:317-327`, `server/src/verify.ts:31-35`, `server/src/log.ts:2-19`, `web/src/lib/storage.ts:5-10`, `web/src/lib/storage.ts:113-131`.
