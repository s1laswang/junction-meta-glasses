# DAT Optics and Codec Safety Suite (`dat_optics`)

Evaluates HoldUp's production label reader (`gemini-3.8-flash` with `shared/verify_prompt.md` and `shared/label_schema.json`) paired with the deterministic safety engine (`server/src/safety.ts` via `eval/safety_bridge.mts`) across 12 synthetic first-person frames modeling the Ray-Ban Meta Device Access Toolkit (`android-dat/`) camera pipeline.

## What Is Modeled
- **Portrait 720x1280 geometry**: Matches `StreamConfiguration(videoQuality = VideoQuality.HIGH, frameRate = 2)` in `BridgeViewModel.kt` with radial barrel distortion and corner vignette typical of the ultra-wide temple camera.
- **YUV 4:2:0 and grayscale layout fallback**: Simulates 2x2 chroma subsampling (`I420`/`NV12`) and `YuvJpeg.Layout.GRAY` neutral-chroma luma-only fallback (`YuvJpeg.kt`) at production `JPEG_QUALITY = 80` as well as degraded mobile upload tiers (`Q75`, `Q70`, `Q65`, `Q55`, `Q40`, and severe `Q10` macroblocks).
- **Framing, Nyquist distance, and temple parallax**: Tests close hold, comfortable arm's-length wide-FOV hold, a 95 cm tabletop carton where dose digits fall below sensor resolution, left-temple horizontal parallax clipping the strength off the right 720 px border even when the user asks about a specific dose, and a 2-frame 1 fps motion-to-sharp burst.
- **In-memory EXIF-scrubbed rendering**: All frames are synthesized as bare EXIF-free JPEGs in `io.BytesIO` at runtime; zero image files or base64 strings are stored in git.

## Measured Results (`results.json`)
- **Model**: `gemini-3.8-flash` (`thinking_level="low"`, prompt+schema sha256 prefix `814770315c42`)
- **Cases**: 12 (`errors = 0`, `timeouts = 0`)
- **Verdict accuracy**: 12/12 (`1.0`, Wilson 95% CI `[0.7575, 1.0]`)
- **Confident-wrong dose count**: 0 (`0.0`, Wilson 95% CI `[0.0, 0.2425]`, rule-of-three 95% upper bound `0.25`)
- **False match / unsafe reassurance**: 0 / 0
- **Safe abstentions (`unsure`)**: 3/3 on obliterated `Q10` digits, 95 cm sub-Nyquist tabletop box, and temple-parallax right-edge dose clip
- **Latency**: p50 `2807.6 ms`, p95 `4477.0 ms`

## Reproduce and Verify
```bash
TMPDIR=/dev/shm python3 eval/suites/dat_optics/run.py --check
TMPDIR=/dev/shm python3 eval/suites/dat_optics/run.py
python3 -m unittest eval/test_suites.py
```
