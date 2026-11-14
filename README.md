# HoldUp: hold it up, know it's the right one

Hands-free label assistant for blind and low-vision people on **Meta AI glasses**, powered by **Gemini Live**.
Hold up a medicine box or a food package. HoldUp coaches you by voice until the label is readable ("turn it left… closer… got it"). It then reads the label with per-field confidence and checks it against *your* medication list and allergies, which are stored on your phone only. You get one of three answers:
✅ *"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."*
⚠️ *"Ibuprofen isn't on your list, and you should avoid NSAIDs."*
❓ *"I can't read the strength confidently, turn the box."*
**It never guesses a dose.**

Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · Google DeepMind "Best Use of Gemini API".

## Run (one command)
```bash
cp .env.example .env   # add GEMINI_API_KEY
npm install && npm run dev
```
Open http://localhost:5173 (add `?mock=1` to run without a server or Gemini). For a phone or the glasses you need HTTPS: run `npm start` (production build on :8787), then `npm run tunnel`, and open the printed `https://…trycloudflare.com` URL on the phone. The Ray-Ban Display page is at `https://<host>/hud/`.

Checks: `npm run typecheck` · `npm -w server test` (safety rules) · `npm -w server run smoke` (real Gemini Live end to end).

## The plan (authoritative: read this before building anything)
**THE CHOSEN PLAN IS HOLDUP, as described here and in [docs/PLAN.md](docs/PLAN.md). It is not a pill reminder or a "Did I take my pills?" app.** The core flow, the server, the phone app, the HUD and the glasses bridge are **already built and merged**. Don't rebuild them. Improve them through small PRs.

| Part | Path | Status |
|---|---|---|
| Server: Gemini Live proxy (`gemini-3.8-live`), `verify_label` tool (`gemini-3.8-flash`, JSON schema, per-field confidence), speculative verify, deterministic safety check, HUD fan-out, glasses ingest, usage ledger + `/api/stats` | `server/` | ✅ done, smoke + robustness tests pass |
| Phone PWA: consent, permissions, live check, snapshot and offline modes, device panel, a11y (axe clean) | `web/` | ✅ done |
| Ray-Ban Display HUD Web App (600×600 additive display, Neural Band input) | `web/src/screens/Hud.tsx`, `/hud/` | ✅ done |
| Device Access Toolkit Android bridge (glasses camera → `/ingest/frame`) | `android-dat/` | ✅ code done, ⏳ first compile on the hardware lead's Android Studio |
| Eval: synthetic labels (Gemini image) → accuracy, confident-wrong rate, calibration | `eval/` (`bash eval/pipeline.sh …`) | ⏳ pipeline built, full run pending |
| Deck, demo script, privacy one-pager | `deck/`, `docs/` | ⏳ in progress |

**Contract:** [shared/types.ts](shared/types.ts) and [docs/TEAM.md](docs/TEAM.md) (WebSocket and HTTP messages). Only the CEO changes it.
**Verify prompt and schema** are shared by the server and the eval: `shared/verify_prompt.md` and `shared/label_schema.json`.

### For the FR8 "meta" fleet and other helpers: where help is wanted
Work on branches, never on `main`. Open small PRs. Don't change `shared/types.ts`.
1. **Run the eval** (most valuable): `eval/pipeline.sh setup|specs|images|degrade|predict|score` → `docs/EVAL.md`. Headline metric: the strength confident-wrong rate (wrong strength at confidence ≥ 0.8).
2. **More, harder test data:** Finnish and Swedish pharmacy labels, look-alike strengths (2.5 vs 25 mg), allergen synonyms, back-of-box views. Add them as specs in `eval/`.
3. **Gemini judge** for coaching transcripts (brevity, actionability). Script in `eval/`.
4. **Review PRs** for the safety rules (`server/src/safety.ts`), with new unit tests in `server/test/`.
5. **Compile check** of `android-dat/` (Gradle, DAT 1.0.1 from Maven Central). Report the errors; don't redesign it.

## Docs
- [docs/PLAN.md](docs/PLAN.md): idea, architecture, demo script, hardware plan, timeline, questions for Silas
- [docs/TEAM.md](docs/TEAM.md): roles, interfaces, milestones
- [docs/HARDWARE_NOTES.md](docs/HARDWARE_NOTES.md) and [docs/HUD_SPEC.md](docs/HUD_SPEC.md): glasses setup, DAT bridge, Display Web App
