# HoldUp Judge Playbook (`/blindfold` + `?mock=1`)

> **OFFLINE DEMO - PHONE CAMERA ONLY (no physical glasses):** `/blindfold` runs 100% in your browser using your phone or laptop camera (`getUserMedia`), 42 pre-rendered offline voice clips, and deterministic safety rules. It makes zero live Gemini API calls and never claims to stream from physical Meta glasses hardware. For the live physical Ray-Ban Meta and Ray-Ban Display workflow and on-device proof rows, see [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md), [docs/HARDWARE_LOG.md](docs/HARDWARE_LOG.md), and [docs/HARDWARE_NOTES.md](docs/HARDWARE_NOTES.md).

## 1. Quick Start (100% Keyless - `GEMINI_API_KEY` Not Required)

Run either the Vite dev server or the single-origin production build (`ELEVENLABS_API_KEY` and `GEMINI_API_KEY` are not needed):

```bash
npm install && npm run dev
```

- **Dev playable challenge:** `http://localhost:5173/blindfold`
- **Production build (`npm start`):** `http://localhost:8787/blindfold`
- **One-command keyless check:** `make accept` (runs typecheck, server safety tests, and mock HTTP checks)

## 2. Playable `/blindfold` Walkthrough (~2 Minutes)

`/blindfold` pairs HoldUp's voice-first eyes-closed UX with a CC0 1.0 pixel-art pharmacy and home stage ([docs/demo/ASSETS.md](docs/demo/ASSETS.md)) and the shipped deterministic rule engine ([server/src/safety.ts](server/src/safety.ts)).

### Round 1 - Blindfold Camera Challenge (`~45 s`)

1. **Choose language & close your eyes:** Pick `English`, `Suomi`, or `Svenska` and toggle the **Blindfold** curtain (or close your eyes).
2. **Tap anywhere on the primary bar (or press `Space` / `Enter`):** Starts `getUserMedia` on your phone or laptop camera with high-contrast WCAG 2.2 AA status indicators and `CAMERA ON` disclosure.
3. **Follow the voice coach:** Move a medicine box or food pack in front of the lens. Real-time frame checks (brightness, sharpness, and motion stability) play the **42 pre-rendered EN/FI/SV voice clips** from [web/public/phrases/manifest.json](web/public/phrases/manifest.json) under `/phrases/{en,fi,sv}/` (`cue_closer.wav`, `cue_further.wav`, `cue_rotate.wav`, `cue_tilt.wav`, `cue_more_light.wav`, `cue_steady.wav`, `cue_reading.wav`, `not_sure.mp3`, `already_taken.mp3`, `offline.mp3`, `unknown_offline.mp3`, `back_online.mp3`, `glasses_off.mp3`, `camera_off.mp3`).
4. **Hear the checked verdict & clean stop:** Once the frame stabilizes (or a saved EAN / EU FMD GS1 DataMatrix decodes), HoldUp speaks the deterministic verdict against `demoProfile()` and stops the camera cleanly (`camera_off.mp3`).
5. **No camera permission or no physical box nearby?** Click the **1-click simulated pack fallback** button to run the full coaching-to-verdict audio sequence without granting camera access.

### Round 2 - Spot the Danger (`~60 s`, 5 Eval-Set Labels, Scored)

Active patient profile (`demoProfile()`): `Amlodipine 5 mg` (evening), `Metformin 500 mg` (morning and evening), `Atorvastatin 20 mg` (evening); allergies: `tree nuts`, `peanut`; avoid: `NSAIDs`.

1. **Inspect each real eval-set photo (`round1.jpg`..`round5.jpg`):** Five `640x480` (`< 40 KB`) label renders spanning HoldUp's core clinical traps:
   - **Safe match (`Match`):** Prescribed `Amlodipine 5 mg` evening pack -> `"Yes: Amlodipine 5 mg, your evening pill"`.
   - **NSAID class trap (`Danger` / `Warning`):** `Burana 400 mg` / `Ibuprofen 400 mg` OTC painkiller -> `"not on your list"` + `"avoid NSAIDs"`.
   - **Look-alike strength / decimal trap (`Danger` / `Warning`):** Same-house 2x or 10x look-alike dose (e.g. `Amlodipine 10 mg` vs `5 mg`) -> `"wrong strength"`.
   - **Hidden allergen synonym trap (`Danger` / `Warning`):** Culinary or Nordic nut/peanut synonym (`arachis oil`, `maapähkinä`, `hasselpähkinä`) -> `"Warning: contains ..."` (`allergy`).
   - **Occluded / low-confidence dose (`Not sure - abstain`):** Thumb-covered or glare-blurred strength (`confidence < 0.8`) -> plays `/phrases/{en,fi,sv}/not_sure.mp3` and tells the user to turn the box or ask a pharmacist instead of guessing.
2. **Guess first:** Click `Safe`, `Danger`, or `Not sure - abstain` before HoldUp answers.
3. **Compare against HoldUp:** HoldUp reveals per-field confidence (`>= 0.8` dose confidence gate; `>= 0.95` allergen reassurance gate with `>= 0.8` readability in [server/src/safety.ts](server/src/safety.ts)), the exact `checkLabel()` verdict and spoken clip, and your final scorecard (**`Judge X/5` vs `HoldUp 5/5`**).

## 3. Additional Keyless Judge Views

| View | URL / File | What to test |
|---|---|---|
| **Phone PWA (`?mock=1`)** | `http://localhost:5173/?mock=1` | Scripted in-browser `ServerMsg` transport ([README.md](README.md)). Type `"is this my evening pill"`, `"ibuprofen"`, `"metformin strength"`, `"nuts"`, or `"which one is on the table"`. |
| **Ray-Ban Display HUD (`600x600`)** | `http://localhost:5173/hud/?mock=1` | Open beside `/?mock=1` in the same browser ([docs/HUD_SPEC.md](docs/HUD_SPEC.md)): mirrors cues/verdicts live and syncs `I took it` dose logs back to the phone tab. |
| **Auditorium Stage (`16:9`)** | `http://localhost:5173/stage?mock=1` | Read-only projector view with Display lens replica, live captions, readiness bar, and latency/cache telemetry (zero camera frames). |
| **Split-screen video (`81.40 s`)** | [docs/demo/holdup-mock-demo.mp4](docs/demo/holdup-mock-demo.mp4) | Deterministic `1280x720` capture (`1.89 MB`) of Phone PWA + Display HUD ([docs/demo/README.md](docs/demo/README.md)). |
| **Safety & calibration proof** | [docs/EVAL.md](docs/EVAL.md) | `1,740` v1 synthetic images (`0/754` confident-wrong strengths), `1,060` held-out v3 images (`1/536`), and `3/4,730` silent unsafe reassurance after the `>= 0.95` allergen gate. |
