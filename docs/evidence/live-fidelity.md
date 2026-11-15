# Spoken-answer check (evidence)

**What it is.** The deterministic rules write the sentence for every verdict. Gemini Live is told to say it. Since Sun 15 Nov the server also **checks** what was said (Gemini's own output transcription) against that sentence after every verdict (`server/src/fidelity.ts`, wired in `server/src/live.ts`). It flags only differences that matter:
- a strength that is missing, changed or invented;
- a warning or "not sure" that opens like a yes, or loses its caution;
- the medicine name missing;
- nothing said within 12 s;
- in Finnish and Swedish, the fixed opener missing.

On a flag, the server sends `{type:"correction"}` and the phone stops playback and speaks the rule's sentence itself. Each check is logged to the usage ledger as `live_fidelity` with category codes only (no transcript text).

**Measured, Sun 15 Nov about 05:20** (8 smoke runs against real `gemini-3.8-live`, English, a synthetic amlodipine box and a 3-box scene; `npm -w server run smoke`):

| Verdicts checked | Passed | Corrected aloud | Reason |
|---|---|---|---|
| 16 | 15 | 1 | medicine name not found in what was said |

That is a small sample from scripted sessions (95% Wilson interval for the flag rate: 1.1–28.3%), so read it as "the check works and fires", not as a fidelity rate. The rate on real use will show in `GET /api/stats` under `live_fidelity`.

**Limits.** The check reads Gemini's transcription of its own audio, so a transcription error can cause a needless correction (the user then hears the checked sentence twice). In Finnish and Swedish it checks the fixed opener and digits only; the translated detail is not verified. Unit tests: `server/test/fidelity.test.ts`.
