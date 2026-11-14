# HoldUp Bridge (android-dat)

A small Android app that streams the **Ray-Ban Meta glasses camera** (via Meta's Wearables Device Access Toolkit, DAT 1.0.1) to the HoldUp server:

- `POST {server}/ingest/frame?session=<id>`, `Content-Type: image/jpeg`. 720×1280 (`VideoQuality.HIGH`), stream at 2 fps, **≤ 1 frame/s forwarded**. If a POST is in flight, the new frame is dropped (backpressure). Network failures back off to one try every 8 s, then recover automatically.
- `POST {server}/ingest/state?session=<id>`, JSON `{connected, worn, battery, streaming}`. Sent on every change and as a 10 s heartbeat. `worn`/`battery` are `null` when the glasses don't report them.

The structure, dependencies and DAT lifecycle are adapted from Meta's sample `samples/CameraAccess` in https://github.com/facebook/meta-wearables-dat-android (see that repo's LICENSE).

## Build (Android Studio)
1. Android Studio Narwhal (2025.1.1)+, JDK 17, Android SDK 36.
2. **File → Open → `android-dat/`**, then let Gradle sync. Dependencies come from Maven Central and Google. **No GitHub token is needed.**
3. Select the phone (USB debugging on) → **Run ▶ app**.
4. Developer Mode builds use DAT app ID / client token `0` (the default). To use real Wearables Developer Center credentials, add `mwdat_application_id=…` and `mwdat_client_token=…` to `android-dat/local.properties` (gitignored).

CLI alternative: `./gradlew :app:assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk` → `adb install -r …`.

## Use
Full runbook: `docs/HARDWARE_NOTES.md` §5. In short: paste the tunnel URL and the session code (or open `holdupbridge://connect?server=<url>&session=<code>`) → **Connect glasses** (approve in Meta AI) → **Start streaming** (allow camera in Meta AI, "Allow always").

## Files
- `BridgeViewModel.kt`: DAT init/registration, device metadata (battery, don state, thermal), session with auto-reconnect, camera stream with auto-retry, frame throttling and posting, state posting.
- `YuvJpeg.kt`: converts DAT YUV 4:2:0 frames to JPEG. It infers row stride, auto-detects I420 vs NV12, and falls back to grayscale.
- `Uploader.kt`: `HttpURLConnection` POSTs, single in-flight frame.
- `StreamingService.kt`: foreground service (connectedDevice), so streaming continues while Chrome (the PWA) is in front.
- `MainActivity.kt`: Compose UI, Android and DAT permission flows, deep link.

## Status
Written against the SDK 1.0.1 public API, which was checked with `javap` on the Maven Central AARs and against the sample. **Not yet compiled**, see the blocker in `docs/HARDWARE_NOTES.md` (Findings log). The first Android Studio sync and build on Momin's laptop is the compile check.
