# HoldUp × Gemini: Best Use of Gemini API

## 1. The problem and why it matters
About 55,000 people in Finland are visually impaired, most of them over 65, and many manage several look-alike medicine boxes a day. "Is this my evening pill?" and "does this contain nuts?" are questions they can't answer alone. A wrong answer is a medication error or an allergic reaction. Phone OCR apps need a free hand to aim, and they read every word without knowing what matters to *you*.

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
- **Speculative verify:** while the user is still asking, the server already reads the sharpest new frame. The Live tool call is answered from that cache in under 5 ms, so time from question to first audio fell from **5.8 s to about 0.8–1.8 s**.
- **Calibrated abstention, measured:** across **1,740 images**, **0 of 754 confident strength reads were wrong** (95% upper bound 0.4%), and calibration ECE is 0.022 (0.018–0.028). End-to-end unsafe reassurance was 1.0% (0.78–1.37%), and the two causes found were fixed (`docs/EVAL.md`).
- **The AI read must agree with the pack's own machine code** (GS1 DataMatrix: GTIN and expiry) before HoldUp says "double-checked".
- **Gemini on both sides:** Gemini builds the test set, Gemini is tested on it, and fixed rules plus confidence gates keep it honest.

## 4. Why Gemini is essential
- One API gives us **realtime audio and video with tool calls mid-conversation**. The camera-to-coaching loop isn't possible with a text-only LLM or a separate STT → LLM → TTS chain at this latency.
- **Schema-constrained vision with thinking control** gives a confidence per field that is well calibrated (ECE 0.022), which is what makes "I'm not sure" trustworthy.
- `box_2d` grounding powers the scene mode.
- Image generation let us build a 1,740-image eval overnight.
- Directional comparison (n = 12 paired cases, `eval/suites/model_comparison`): Gemini 3.8 and 3.5 Flash got 12/12 verdicts right with 0 confident-wrong reads. Gemma 4 31B got 11/12 with 1 false match, at a p50 of 5.6 s vs 3.2 s.

## Usage ledger (metadata only, no content)
- Every Gemini call is logged as `{ts, feature, model, in, out, thinking, cached, latency_s, ok}`: the server in `server/logs/ledger.jsonl` (served at `GET /api/stats` with p50/p95 per feature), the eval in `eval/out/ledger.jsonl`.
- The eval run made 26 spec calls, about 260 image renders, about 270 legibility checks and 1,740 scoring calls (p50 3.43 s, p95 5.55 s). All were interactive.
