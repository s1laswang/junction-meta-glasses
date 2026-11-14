# HoldUp: hold it up, know it's the right one

Hands-free label assistant for blind and low-vision people on **Meta AI glasses**, powered by **Gemini Live**.
Hold up a medicine box or a food package. HoldUp coaches you by voice until the label is readable ("turn it left… closer… got it"). It then reads the label with per-field confidence and checks it against *your* medication list and allergies, which are stored on your phone only. You get one of three answers:
- ✅ *"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."*
- ⚠️ *"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."*
- ❓ *"It looks like Metformin, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist."*

**It only states a dose it can read clearly (strength confidence ≥ 0.8, otherwise "I'm not sure").** Who it's for: the ~55,000 Finns with a visual impairment (most of them 65+) and older adults with fading sight who juggle look-alike boxes ([sources](docs/RESEARCH.md)).

Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · Google DeepMind "Best Use of Gemini API".

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| Node.js 20+ (this box ran v24) | workspaces, Vite, TypeScript | https://nodejs.org |
| npm (comes with Node) | `npm install`, scripts | — |
| Optional: `cloudflared` | `npm run tunnel` for a phone / glasses HTTPS URL | Cloudflare docs |
| Optional: Android Studio + DAT 1.0.1 | compile `android-dat/` on the hardware lead's machine | see `android-dat/README.md` |
| Optional: Meta Ray-Ban Display glasses | the DAT bridge and `/hud/` path | [docs/HARDWARE_NOTES.md](docs/HARDWARE_NOTES.md) |

Environment variables (copy `.env.example` to `.env`; never commit `.env` or print values):

| Variable | Required for | If missing |
|---|---|---|
| `GEMINI_API_KEY` | live server (`npm run dev` without `?mock=1`), `npm -w server run smoke`, eval pipeline, TTS | Use **`http://localhost:5173/?mock=1`** (and `/hud/?mock=1`). `npm run typecheck` and `npm -w server test` are keyless. |
| `LIVE_MODEL`, `VERIFY_MODEL`, `PORT` | optional overrides | defaults in `server/src/env.ts` |
| `HOLDUP_KEY` | optional shared access key on a public tunnel | static files stay public |
| `ELEVENLABS_API_KEY` | optional. Pre-rendered phrases and `POST /api/tts/eleven` | Unset: those routes return 404 `disabled`, and the app speaks with the browser voice. Live ElevenLabs TTS also needs `ELEVENLABS_LIVE=1`. The key is read from the environment only. |

One-command check (keyless steps + documented skips):

```bash
cp .env.example .env    # add GEMINI_API_KEY if you have it
make accept             # or: bash scripts/judge_accept.sh
```

## Run (one command)
```bash
cp .env.example .env   # add GEMINI_API_KEY
npm install && npm run dev
```
Open http://localhost:5173 (add `?mock=1` to run without a server or Gemini). For a phone or the glasses you need HTTPS: run `npm start` (production build on :8787), then `npm run tunnel`, and open the printed `https://…trycloudflare.com` URL on the phone. The Ray-Ban Display page is at `https://<host>/hud/`.

Checks: `npm run typecheck` · `npm -w server test` (safety rules) · `npm -w server run smoke` (real Gemini Live end to end; SKIP if `GEMINI_API_KEY` is unset). `npm -w web test` (contract and a11y). Status on `main`, Sat 14 Nov 2026 late evening: typecheck clean, **server 60/60**, **web 213/213**, smoke **13/13** against real Gemini (incl. scene mode and readiness), `make accept` `RESULT: PASS`.

## The plan (authoritative: read this before building anything)
**THE CHOSEN PLAN IS HOLDUP, as described here and in [docs/PLAN.md](docs/PLAN.md). It is not a pill reminder or a "Did I take my pills?" app.** The core flow, the server, the phone app, the HUD and the glasses bridge are **already built and merged**. Don't rebuild them. Improve them through small PRs.

| Part | Path | Status |
|---|---|---|
| Server: Gemini Live proxy (`gemini-3.8-live`), `verify_label` tool (`gemini-3.8-flash`, JSON schema, per-field confidence), speculative verify, deterministic safety check, HUD fan-out, glasses ingest, usage ledger + `/api/stats` | `server/` | ✅ done, smoke + robustness tests pass |
| Phone PWA: consent, permissions, live check, snapshot and offline modes, device panel, a11y (axe clean) | `web/` | ✅ done |
| Ray-Ban Display HUD Web App (600×600 additive display, Neural Band input) | `web/src/screens/Hud.tsx`, `/hud/` | ✅ done |
| Device Access Toolkit Android bridge (glasses camera → `/ingest/frame`) | `android-dat/` | ✅ compiles (freighter Slurm build, 4/4 unit tests, APK sha256 in HARDWARE_NOTES). ⏳ on-glasses proof: docs/HARDWARE_LOG.md |
| Eval: synthetic labels (Gemini image) → accuracy, confident-wrong rate, calibration | `eval/`, results in `eval/results/v1_results.json` | ✅ v1: 1,740 images, 0/754 confident-wrong strengths, 1.0% unsafe before the allergen gate ([docs/EVAL.md](docs/EVAL.md)). ⏳ real photos |
| Deck, demo script, privacy one-pager, research, QA | `deck/`, `docs/` | ✅ drafts done, ⏳ eval numbers and the backup video still to add |

**Contract:** [shared/types.ts](shared/types.ts) and [docs/TEAM.md](docs/TEAM.md) (WebSocket and HTTP messages). Only the CEO changes it.
**Verify prompt and schema** are shared by the server and the eval: `shared/verify_prompt.md` and `shared/label_schema.json`.

### For the FR8 "meta" fleet and other helpers: where help is wanted
**Read [docs/FLEET_REQUEST.md](docs/FLEET_REQUEST.md) first (Silas's decision, Sat 18:50).** This `main` on GitHub is the submission. `fr8/meta/main` isn't. Stop building a parallel UI or deck, start from this main, and take tickets F1–F5 there.
Work on branches, never on `main`. Open small PRs. Don't change `shared/types.ts`.
1. **Run the eval** (most valuable): `eval/pipeline.sh setup|specs|images|degrade|predict|score` → `docs/EVAL.md`. Headline metric: the strength confident-wrong rate (wrong strength at confidence ≥ 0.8).
2. **More, harder test data:** Finnish and Swedish pharmacy labels, look-alike strengths (2.5 vs 25 mg), allergen synonyms, back-of-box views. Add them as specs in `eval/`.
3. **Gemini judge** for coaching transcripts (brevity, actionability). Script in `eval/`.
4. **Review PRs** for the safety rules (`server/src/safety.ts`), with new unit tests in `server/test/`.
5. **Compile check** of `android-dat/` (Gradle, DAT 1.0.1 from Maven Central). Report the errors; don't redesign it.

## How to demo
- **No hardware, no key:** `npm run dev`, then open http://localhost:5173/?mock=1. A scripted in-browser server speaks the real message contract (coach → checking → verdict). Type "is this my evening pill", "ibuprofen" or "nuts". Open http://localhost:5173/hud/?mock=1 in a second tab to watch the Display HUD follow along. The device panel has demo controls (drop the connection, slow network, Gemini down, offline, glasses on, off or disconnected, low battery).
- **Real, on a phone:** `npm start` + `npm run tunnel`, open the tunnel URL on the phone, agree to the consent cards, then **Start check**, hold up a box and ask. Profile → "Load demo profile" gives 3 medicines, nut allergies and "avoid NSAIDs".
- **On the glasses:** follow [docs/HARDWARE_NOTES.md](docs/HARDWARE_NOTES.md) (DAT bridge and Display Web App at `https://<host>/hud/`). The stage script, with a fallback for every step, is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Architecture
```
Ray-Ban Meta ──camera (DAT)──► android-dat bridge ──JPEG ≤1 fps──► /ingest/frame ─┐
Ray-Ban Meta ──Bluetooth mic/speaker──► phone PWA ──WSS /live: PCM16 + frames──────┤
                                                                                   ▼
                                 server (Node/TS, one origin; the API key stays here)
                                 ├─ Gemini Live proxy: voice, coaching, tools (verify_label, show_cue, log_dose)
                                 ├─ verify_label → Gemini Flash, JSON schema, per-field confidence (+ speculative cache)
                                 ├─ safety.ts: deterministic rules vs the profile (no model, unit-tested)
                                 └─ /hud-ws ──► Ray-Ban Display HUD Web App (/hud/, Neural Band)
Fallbacks: snapshot mode (POST /api/verify) · offline barcode match · phone camera when the glasses are off
```

Glasses mic audio reaches the phone over Bluetooth HFP as 8 kHz mono (DAT docs); the PWA sends it to Gemini Live as 16 kHz PCM16, so voice from the glasses is phone-call quality.

## How we use Gemini
| Where | Model (fallbacks in `server/src/env.ts`) | What it does |
|---|---|---|
| Conversation and coaching | Live API `gemini-3.8-live` | Bidirectional audio + video, native audio voice, transcripts, barge-in, session resumption, **mid-session tool calls**. It is forbidden to state a name, dose, expiry or allergen from its own view and must call `verify_label`. |
| Reading the label | `gemini-3.8-flash` | `responseJsonSchema` with `{value, confidence}` per field, null when not legible (`shared/verify_prompt.md`, `shared/label_schema.json`). Runs **speculatively** while the user is still asking: first audio in 0.8–3.3 s, down from 5.8 s. |
| Spoken fallback | `gemini-3.8-flash-tts` | `/api/tts` (optional; the browser voice is the default). |
| Building the eval set | `gemini-3.8-flash`, `gemini-3.1-flash-image` | Gemini as a workforce: label specs → first-person renders → legibility check → degradations → scoring (`eval/`, results in `docs/EVAL.md`). |
| Metering | — | Every call writes one metadata-only line to `server/logs/ledger.jsonl`; `GET /api/stats` gives p50/p95 latency, first-audio time, tool latency and tokens per feature. |

## Privacy in one paragraph
The camera runs only during a check that you start, shows CAMERA ON, and stops after 45 s without a label. Frames and audio go to the Gemini API and live only in server memory (the last 8 frames, dropped when the session ends). Nothing with content is written to disk, and logs are redacted. Your medicine list, allergies and dose log stay in the phone's localStorage, and one button deletes them. Details and known limits: [docs/PRIVACY.md](docs/PRIVACY.md).

## Repo map
| Path | What |
|---|---|
| `server/src/` | `index.ts` (HTTP + WS routes), `live.ts` (Gemini Live proxy and tools), `verify.ts` (label reader, frame ring), `speculate.ts`, `safety.ts`, `hub.ts` (sessions, HUD fan-out), `ledger.ts`, `log.ts` (redaction), `prompts/live.md` |
| `server/test/`, `server/scripts/` | safety unit tests; smoke and robustness scripts against real Gemini |
| `web/src/` | PWA: `lib/checker.ts` (session controller: camera, mic, modes, fallbacks), `screens/` (Onboarding, Live, Profile, Privacy, Hud), `lib/mock.ts` (`?mock=1`) |
| `shared/` | the contract (`types.ts`), verify prompt and label schema shared by the server and the eval |
| `android-dat/` | Kotlin Device Access Toolkit bridge: glasses camera → `/ingest/frame`, state → `/ingest/state` |
| `eval/` | Gemini-workforce dataset generator and the eval harness (`pipeline.sh`) |
| `deck/index.html` | pitch deck: open it in a browser (arrow keys); print to PDF for a 16:9 handout |
| `docs/` | PLAN, TEAM, HARDWARE_NOTES, HUD_SPEC, DEMO_SCRIPT, PRIVACY, RESEARCH, QA, EVAL |

## For judges

The repository is public. **`main` is the submission.**

```bash
git clone https://github.com/s1laswang/junction-meta-glasses.git holdup
cd holdup && cp .env.example .env && make accept   # keyless checks; add GEMINI_API_KEY for the live smoke
```

Don't mix this up with our other entries (`s1laswang/agent-arena`, `s1laswang/junction-aimo-agents`).

## Docs
- [docs/PLAN.md](docs/PLAN.md): idea, architecture, demo script, hardware plan, timeline, questions for Silas
- [docs/TEAM.md](docs/TEAM.md): roles, interfaces, milestones
- [docs/HARDWARE_NOTES.md](docs/HARDWARE_NOTES.md) and [docs/HUD_SPEC.md](docs/HUD_SPEC.md): glasses setup, DAT bridge, Display Web App
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md): the 3-minute stage script with fallbacks and a pre-demo checklist
- [docs/PRIVACY.md](docs/PRIVACY.md): data flow, storage, retention, consent, bystanders, deletion
- [docs/RESEARCH.md](docs/RESEARCH.md): problem statistics with sources
- [docs/QA.md](docs/QA.md): bug bash results, open and fixed
