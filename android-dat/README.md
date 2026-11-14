# HoldUp Bridge (`android-dat`)

Native Kotlin + Jetpack Compose companion app (`package app.holdup.bridge`) built on the **Meta Wearables Device Access Toolkit (DAT) SDK `1.0.1`**.

HoldUp Bridge connects to paired Meta AI Glasses (`Ray-Ban Meta Gen 2` or `Meta Ray-Ban Display`), opens a `720x1280` (`VideoQuality.HIGH` @ `2 fps`, the lowest SDK step) camera stream, encodes at most `~1 frame/s` to JPEG (`POST /ingest/frame`, dropping incoming frames whenever an HTTP POST is still in flight), and forwards real-time device telemetry (`connected`, `worn`, `battery`, `streaming`) to `POST /ingest/state`.

---

## 1. Prerequisites

- **Android Studio Narwhal (2025.1.1) or newer** with **JDK 17** (bundled JBR) and **Android SDK Platform 36** installed via SDK Manager.
- **Zero GitHub PAT required**: `com.meta.wearable:mwdat-core:1.0.1` and `com.meta.wearable:mwdat-camera:1.0.1` resolve directly from **Maven Central**.
- **Zero Developer Center credentials required**: Developer Mode uses `0` for both `mwdat_application_id` and `mwdat_client_token` by default in `app/build.gradle.kts` (optional overrides can be placed in `local.properties` without touching git).
- **Android demo phone**: Android 12+ (`minSdk 31`), USB debugging enabled, Bluetooth ON, and **Meta AI** app (`com.facebook.stella`) **V292+**.
- **Meta AI Glasses**: Firmware **V128+** and battery **> 10%** (reboot glasses once after updating to `V128+`).

---

## 2. Enable Meta AI Developer Mode

1. Pair the glasses in the **Meta AI** app and verify they show **Connected**.
2. Open **Meta AI -> Settings -> App Info -> tap "App version" 5 times -> toggle Developer Mode -> Enable**.
3. Force-close and reopen **Meta AI**.
4. Note: Only **one** third-party Developer Mode app can be registered at a time. Registering HoldUp Bridge automatically unregisters Meta's `CameraAccess` sample (and vice versa).

---

## 3. Build, Pair via QR Deep Link, and Stream

1. Start the HoldUp server and HTTPS tunnel on the laptop:
   ```bash
   npm start
   npm run tunnel
   ```
2. Open `android-dat/` in Android Studio, let Gradle sync (`Gradle 8.14.1`, `AGP 8.11.1`, `Kotlin 2.2.21`), and run **`app`** on the Android phone. Grant Bluetooth and notification runtime permissions when prompted.
3. Pair the endpoint automatically via the `holdupbridge://connect` deep link:
   - Scan the **Android DAT Bridge QR code** in the HoldUp PWA **Device & Resilience Panel** with the phone camera (or tap **Launch DAT Bridge** on the same phone):
     ```text
     holdupbridge://connect?server=https%3A%2F%2F<host-domain>&session=<session-id>
     ```
   - `MainActivity` (`launchMode="singleTop"`) handles `holdupbridge://connect` in both `onCreate` and `onNewIntent`, prefilling **Server URL** and **Session Code** immediately.
   - Leave **Session Code** blank in single-wearer demos to follow the most recently started `/live` session automatically.
4. Tap **Connect Glasses** and approve registration in **Meta AI**.
5. Tap **Start Streaming** and select **Allow always** on the first Meta AI camera permission prompt.
   - The glasses front hardware capture LED illuminates whenever streaming is active, and the UI displays a high-contrast `CAMERA ON - CAPTURE LED ACTIVE` privacy banner alongside live frame and battery telemetry.

---

## 4. Foreground Service & Chrome PWA Coexistence

`StreamingForegroundService` (`connectedDevice` foreground service type) keeps the DAT camera stream running in the background with a persistent **"HoldUp Glasses Camera Active"** notification (including a 1-tap **Stop Camera** action) while you switch to Chrome for the HoldUp PWA and Bluetooth HFP open-ear voice session.

If an OEM battery saver suspends background camera callbacks on a specific phone, run HoldUp Bridge and Chrome side-by-side in **Android split-screen**. Tap **Stop Streaming** at any time to close the camera stream and turn off the capture LED, or **Disconnect** to end the DAT session.

---

## 5. Quick Endpoint Smoke Check (No Glasses Required)

Verify that your server or tunnel accepts HoldUp Bridge telemetry before connecting hardware:

```bash
curl -i -X POST -H 'Content-Type: application/json' \
  -d '{"connected":true,"worn":true,"battery":80,"streaming":false}' \
  "$TUNNEL/ingest/state?session=TEST"
```

Expected response: `HTTP/2 204` (or `HTTP/1.1 204 No Content`).
