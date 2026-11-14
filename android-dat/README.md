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
   - `MainActivity` (`launchMode="singleTop"`) handles `holdupbridge://connect` in both `onCreate` and `onNewIntent`, sanitizing and persisting **Server URL** and **Session Code** via `BridgePreferences.kt` so subsequent app launches reconnect without re-scanning.
   - Leave **Session Code** blank in single-wearer demos to follow the most recently started `/live` session automatically, or tap **Forget Saved Server** in the **Endpoint Pairing** card to wipe stored endpoint preferences in one tap.
4. Tap **Connect Glasses** and approve registration in **Meta AI**.
5. Tap **Start Streaming** and select **Allow always** on the first Meta AI camera permission prompt.
   - The glasses front hardware capture LED illuminates whenever streaming is active, and the UI displays a high-contrast `CAMERA ON - CAPTURE LED ACTIVE` privacy banner alongside live frame and battery telemetry.

---

## 4. Foreground Service & Chrome PWA Coexistence

`StreamingForegroundService` (`connectedDevice` foreground service type) keeps the DAT camera stream running in the background with a persistent **"HoldUp Glasses Camera Active"** notification (including a 1-tap **Stop Camera** action) while you switch to Chrome for the HoldUp PWA and Bluetooth HFP open-ear voice session.

If an OEM battery saver suspends background camera callbacks on a specific phone, run HoldUp Bridge and Chrome side-by-side in **Android split-screen**. Tap **Stop Streaming** at any time to close the camera stream and turn off the capture LED, or **Disconnect** to end the DAT session.

---

## 5. Endpoint Persistence, Network Security & App Resources

- **`BridgePreferences.kt`** (`app/src/main/java/app/holdup/bridge/BridgePreferences.kt`): Persists only the sanitized `server_url` (`http` or `https`, `<= 256` chars, trailing slashes stripped, credentials/query/fragment/path-traversal rejected) and optional `session_code` (`^[A-Za-z0-9_-]{4,64}$`) in mode-private `SharedPreferences` (`holdup_bridge_prefs`). Zero health data, medication schedules, or camera frames are ever written to disk. Tapping **Forget Saved Server** in `BridgeScreen.kt` invokes `BridgePreferences.clearSavedEndpoint` and resets `DatBridgeController.updateEndpoint("", "")` in one tap before returning shared or loaner handsets.
- **`network_security_config.xml`** (`app/src/main/res/xml/network_security_config.xml`): Referenced by `AndroidManifest.xml` (`android:networkSecurityConfig="@xml/network_security_config"`, with global `usesCleartextTraffic` disabled). Enforces HTTPS-by-default via `<base-config cleartextTrafficPermitted="false">` trusting system CAs (`<certificates src="system" />`) for public tunnel and Cloud Run origins, while scoping cleartext HTTP (`<domain-config cleartextTrafficPermitted="true">`) strictly to local development and LAN hosts (`localhost`, `127.0.0.1`, Android emulator host `10.0.2.2`, and `.local` mDNS hostnames).
- **`ic_launcher_foreground.xml`** (`app/src/main/res/drawable/ic_launcher_foreground.xml`): `108dp` vector launcher drawable (`android:icon="@drawable/ic_launcher_foreground"`) depicting glasses frames, active mint capture-LED indicator, and verification shield inside the `108x108` adaptive icon viewport.
- **`themes.xml`** (`app/src/main/res/values/themes.xml`): Defines `Theme.HoldUpBridge` (and alias `Theme.HoldUp`) atop `android:Theme.Material.NoActionBar` with low-luminance `#0B0F17` window, status-bar, navigation-bar, and splash backgrounds plus `#121926` dark surface colors matching the Compose Material 3 palette.

---

## 6. JUnit4 Unit Test Suites & Structure Verification

Pure-JVM JUnit 4 (`junit:4.13.2`) test suites live under `app/src/test/java/app/holdup/bridge/`:

- **`BridgeContractTest.kt`**: Verifies `YuvJpegEncoder.i420ToNv21` planar and direct `ByteBuffer` chroma interleaving, `BridgeDeviceState` / `IngestMetrics` / `BridgeUiState` defaults, and `holdupbridge://connect` deep-link parameter validation.
- **`BridgePreferencesTest.kt`**: Verifies `BridgePreferences.sanitizeServerUrl` (`<= 256` char cap, valid HTTPS and local dev origins, hostile scheme/credential/port/traversal rejection) and `BridgePreferences.sanitizeSessionCode` (`4..64` char bounds and injection guards).
- **`IngestPayloadContractTest.kt`**: Verifies `IngestClient` and `DatBridgeController` wire contracts including `/ingest/frame?session=...` and `/ingest/state?session=...` URL builders, `DeviceState` JSON payload fields (`connected`, `worn`, `streaming`, `battery`), `<= 1 fps` (`>= 950-1000 ms`) frame throttle and in-flight drop gate math, and low-battery (`< 15%`) / doffed camera fallback state transitions.

Run the JUnit4 unit test suites from `android-dat/` (with JDK 17 and Android SDK configured):

```bash
./gradlew testDebugUnitTest
```

Run the fast Node structure, manifest, XML security, `mwdat:1.0.1` version, and comment/em-dash hygiene verifier from the repository root (no Android SDK required):

```bash
node android-dat/verify-structure.mjs
```

---

## 7. Quick Endpoint Smoke Check (No Glasses Required)

Verify that your server or tunnel accepts HoldUp Bridge telemetry before connecting hardware:

```bash
curl -i -X POST -H 'Content-Type: application/json' \
  -d '{"connected":true,"worn":true,"battery":80,"streaming":false}' \
  "$TUNNEL/ingest/state?session=TEST"
```

Expected response: `HTTP/2 204` (or `HTTP/1.1 204 No Content`).
