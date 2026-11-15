# HoldUp × Gemini: Best Use of Gemini API

**Code pointers:**
- Live API with mid-stream function calling: `server/src/live.ts:166-171` (`ai.live.connect`, `functionDeclarations: toolsFor(...)`); non-blocking `show_cue` at `live.ts:34`; tool responses at `live.ts:267`.
- Schema-constrained verify: `server/src/verify.ts:136` (`responseJsonSchema`), prompt `shared/verify_prompt.md`, schema `shared/label_schema.json`.
- `box_2d` grounding: `server/src/find.ts:21` (scene mode, "Which one?").
- Speculative verify cache: `server/src/speculate.ts:22` (`class Speculator`); cache hits are logged at `speculate.ts:93`. (Line numbers as of main on Sun 15 Nov, about 03:00; search for the quoted symbol if they drift.)
- Deterministic safety layer: `server/src/safety.ts`. Eval: `docs/EVAL.md`, `eval/results/v1_results.json`.

## 1. The problem and why it matters
About 55,000 people in Finland are visually impaired, most of them over 65, and many manage several look-alike medicine boxes a day. "Is this my evening pill?" and "does this contain nuts?" are questions they can't answer alone. A wrong answer is a medication error or an allergic reaction. Existing options leave a safety gap: **Seeing AI** needs a free hand to aim a phone blind and reads raw text aloud, **Be My Eyes** exposes private prescriptions to a volunteer or gives general AI descriptions, and **built-in "Hey Meta"** describes a scene without abstaining on partial text or knowing *your* regimen. HoldUp closes that gap with hands-free voice coaching into calibrated per-field confidence (abstaining when dose confidence `< 0.8` or allergen confidence `< 0.95`), a deterministic `safety.ts` check against your on-device medication, allergy, and dose profile, and an EU FMD DataMatrix cross-check.

**HoldUp** runs on Meta AI glasses:
- you hold the item up;
- it coaches you by voice until the label is readable;
- it reads the label with a confidence for each field;
- it checks the read against *your* medication list and allergies, kept on your phone;
- if it isn't sure, it says so.

## 2. How Gemini is integrated (code: `server/src/`)
| Capability | Model | Where | What it does |
|---|---|---|---|
| **Live API**: audio + video in, native audio out, **mid-stream function calling** | `gemini-3.8-live` (fallbacks: 3.1-flash-live, 2.5-flash-native-audio) | `live.ts` | Conversational coaching from the camera stream. Tools: `verify_label`, `find_item`, `add_medication`, `show_cue` (non-blocking), `log_dose`. Session resumption and context compression survive drops. |
| **Structured multimodal extraction** with `responseJsonSchema`, thinking LOW | `gemini-3.8-flash` (fallbacks: 3.5-flash, 3-flash-preview) | `verify.ts`, `shared/verify_prompt.md`, `shared/label_schema.json` | Every field is `{value, confidence}`, null when not legible. The model never infers strength from a brand name and never completes a half-read word. Reads Finnish and Swedish packs. |
| **Spatial grounding** with `box_2d` | `gemini-3.8-flash` | `find.ts`, `shared/find_prompt.md` | "Which one?": several boxes on a table are read, located and checked, and the answer is spoken by position ("your evening pill is on the right"). |
| **Image generation as a test workforce** | `gemini-3.1-flash-image`, `gemini-3-pro-image` | `eval/gen_images.py` | Rendered 210 first-person label photos from 172 Gemini-written specs. Flash checks legibility and drops garbled renders. |
| **TTS** | `gemini-3.8-flash-tts` | `/api/tts` | Spoken fallback in snapshot mode |

Gemini's output never decides safety alone. A deterministic `safety.ts` turns the structured read into a verdict (match, warning or unsure), using confidence gates and an optional cross-check against the EU FMD DataMatrix on the pack.

## 3. What's innovative and technically impressive
- **Speculative verify:** while the user is still asking, the server already reads the sharpest new frame. The Live tool call is answered from that cache in under 5 ms, so time from question to first audio fell from **5.8 s (one run, before the change) to p50 2.1 s / p95 3.4 s** (n = 26 live sessions, `docs/evidence/`).
- **Calibrated abstention, measured:** across **1,740 images**, **0 of 754 confident strength reads were wrong** (95% upper bound 0.4%), and calibration ECE is 0.022 (0.018–0.028). End-to-end silent unsafe reassurance fell from 1.0% (49/4,730) to **0.06% (3/4,730, CI 0.02–0.19%)** after the allergen gate. The cost: safe foods get "not sure" more often (`docs/EVAL.md`). Not counted as silent: 47/4,730 (0.99%, 0.75–1.32%) are matches that say aloud "I couldn't read the expiry date". The allergen gate also halves correct "allergen-free" answers on truly safe foods: 44/130 = 33.8% (26.3–42.3%), down from 67.7%.
- **The AI read must agree with the pack's own machine code** (GS1 DataMatrix: GTIN and expiry) before HoldUp says "double-checked".
- **Gemini on both sides:** Gemini builds the test set, Gemini is tested on it, and fixed rules plus confidence gates keep it honest.

## 4. Why Gemini is essential
- One API gives us **realtime audio and video with tool calls mid-conversation**. The camera-to-coaching loop isn't possible with a text-only LLM or a separate STT → LLM → TTS chain at this latency.
- **Schema-constrained vision with thinking control** gives a confidence per field that is well calibrated (ECE 0.022), which is what makes "I'm not sure" trustworthy.
- `box_2d` grounding powers the scene mode.
- Image generation let us build a 1,740-image eval overnight.
- **Measured comparison** (150 paired images, the same prompt and `safety.ts`; `docs/EVAL.md` v2 §2, chart `docs/img/eval_model_compare.png`):
  - All three models made **0 confident-wrong strength reads** (n = 82 each, ≤ 3.7% by the rule of three). Strength accuracy when readable (n = 59): `gemini-3.8-flash` and Gemma tie at 46/59 = 78.0% (65.9–86.7%); `gemini-3.5-flash` 42/59 = 71.2% (58.6–81.2%), a non-significant difference (p = 0.22).
  - `gemma-4-31b-it` was confidently wrong on other fields **twice as often** (7.2% vs 3.6%): 38/528 = 7.2% (5.3–9.7%) vs 19/528 = 3.6% (2.3–5.6%), mostly allergens. That's the only significant paired difference.
  - Gemma was the only model with a silent unsafe reassurance: 2/377 = 0.53% (0.15–1.91%), vs 0/377 for both Gemini models; not significant on its own (p = 0.5). It ran **~9× slower** (p50 27.8 s vs 3.2 s; Gemma speed depends on our endpoint quota).
  - `gemini-3.5-flash` matched 3.8-flash within the CI and was 1.2 s faster.

## Usage ledger (metadata only, no content)
- Every Gemini call is logged as `{ts, feature, model, in, out, thinking, cached, latency_s, ok}`: the server in `server/logs/ledger.jsonl` (served at `GET /api/stats` with p50/p95 per feature), the eval in `eval/out/ledger.jsonl`.
- The eval run made 26 spec calls, about 260 image renders, about 270 legibility checks and 1,740 scoring calls (p50 3.43 s, p95 5.55 s). All were interactive.
