# HoldUp Browser Simulation Demo Video (?mock=1)

**Disclosure: SIMULATION / MOCK MODE (`?mock=1`) - browser simulation only, NOT physical Meta glasses hardware.**
Every frame of `docs/demo/holdup-mock-demo.mp4` carries a permanent yellow top banner stating that it runs HoldUp's deterministic in-browser `?mock=1` transport rather than live Gemini or physical glasses.
For real on-device Meta glasses verification, probe rows, and lens/wearer captures, see `docs/HARDWARE_LOG.md` and `docs/img/hw/`.

## File Specifications

- **Path:** `docs/demo/holdup-mock-demo.mp4`
- **Layout:** Split-screen `Phone PWA (/?mock=1)` on the left and `Ray-Ban Display HUD (/hud/?mock=1)` (`600x600` additive lens view) on the right
- **Format:** `1280x720`, 24 fps H.264 (`avc1`, `yuv420p`) + 44.1 kHz mono AAC (`mp4a`), `+faststart` (`moov` before `mdat`)
- **Measured output:** `81.40 s` duration, `1,982,987 bytes` (`1.89 MB`, under the `4 MB` cap)

## Five-Beat Walkthrough

- **Beat 1 (Consent & onboarding):** Plain-language privacy cards, explicit camera consent, and `Start check` in `?mock=1` mode.
- **Beat 2 (Coach, MATCH & HUD dose sync):** Asking `"Is this my evening pill?"` triggers directional coaching arrows, a green `MATCH` card for Amlodipine 5 mg on both screens, and clicking `I took it` on the Display HUD syncs `Dose logged` back to the Phone PWA.
- **Beat 3 (Safety warning & < 80% abstention):** Asking `"Ibuprofen 400 mg"` raises an amber `WARNING` (not on medication list, avoid NSAIDs); asking `"Metformin strength"` returns blue `NOT SURE` at `31% < 80%` strength confidence instead of guessing.
- **Beat 4 (Multi-box scene mode):** Asking `"Which one is on the table?"` renders the 3-box `WHICH ONE` strip on the Display HUD alongside spatial scene cards on the Phone PWA.
- **Beat 5 (Device & network fallbacks):** Toggling `Glasses on` (82% battery streaming), `Glasses off face` (automatic switch to Phone rear camera with earcon + spoken notice), and `Simulate offline` (offline banner with local barcode/DataMatrix fallback).

## Reproduce Deterministically

Run from the repository root (uses shared Chromium and shared ffmpeg, cleans up `/tmp/opencode/mock-video` on exit):

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/fleet-root/shared/ms-playwright node scripts/record-mock-demo.mjs
```

Verify the binary MP4 atoms, duration, codecs, size cap, and disclosure contract:

```bash
npx tsx --test web/test/mockDemoVideoContract.test.ts
```
