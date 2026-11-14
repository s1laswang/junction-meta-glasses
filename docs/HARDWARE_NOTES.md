# HoldUp hardware notes (glasses runbook)

Owner: glasses engineer (Claude) + **Momin010** (hands on the hardware).
Pickup: **Sat 15:30**, Meta booth, mentor **Amanda Le** (DAT Android contact). First hardware test: **Sat 19:30**.

Everything below was checked against the live docs on Sat 14 Nov 2026 (DAT SDK **1.0.1**, released 2026-10-09). Sources are linked inline. If something on the device differs from this file, write it down in the **Findings log** at the bottom.

---

## 0. TL;DR (read this if nothing else)

1. **No GitHub PAT is needed.** The DAT Android SDK moved to **Maven Central** (`com.meta.wearable:mwdat-*:1.0.1`). Plain Gradle sync works. ([repo README](https://github.com/facebook/meta-wearables-dat-android#including-the-sdk-in-your-project))
2. **No Wearables Developer Center app registration is needed for the hackathon.** In **Developer Mode** the app ID and client token are `0`. ([Android integration guide, step 1](https://wearables.developer.meta.com/docs/develop/dat/build-integration-android/))
3. Required versions for SDK 1.0.1: **Meta AI app V292+** and **glasses firmware V128+**. **Reboot the glasses after the V128 update**, or the camera won't work (known issue). ([version dependencies](https://wearables.developer.meta.com/docs/develop/dat/version-dependencies/), [known issues](https://wearables.developer.meta.com/docs/develop/dat/knownissues/))
4. Developer Mode: Meta AI app → **Settings → App Info → tap "App version" 5 times → toggle Developer Mode → Enable**.
5. **Only one third-party app can be registered in Developer Mode at a time.** When you register the HoldUp Bridge, the Meta sample is unregistered automatically, and the other way round. ([permissions doc](https://wearables.developer.meta.com/docs/develop/dat/permissions-requests/))
6. Order: build and run Meta's **CameraAccess** sample first (proves the glasses, the phone and the account work). Then run **HoldUp Bridge** (`android-dat/`).
7. The Display HUD is a **Web App**: Meta AI app → **App Settings → Apps → Web Apps → Connect Web App → paste the HTTPS URL → Save**. It shows up at the bottom of the app grid on the glasses. ([Web Apps test guide](https://wearables.developer.meta.com/docs/develop/webapps/test/))

---

## 1. Before the pickup (do it on wifi, before 15:30)

### Laptop (Momin's)
- [ ] **Android Studio Narwhal (2025.1.1) or newer**, with **JDK 17** (the bundled JBR is fine). In the SDK Manager install **Android SDK Platform 36** and Build-Tools. (Sample prerequisites: [CameraAccess README](https://github.com/facebook/meta-wearables-dat-android/tree/main/samples/CameraAccess).)
- [ ] `git clone https://github.com/facebook/meta-wearables-dat-android.git`
- [ ] `git clone https://github.com/s1laswang/junction-meta-glasses.git` and check out branch `feat/glasses` (until it's merged to main).
- [ ] Open `meta-wearables-dat-android/samples/CameraAccess` in Android Studio and let **Gradle sync finish**. That downloads Gradle 8.14.1, AGP 8.11.1, Kotlin 2.2.21 and the mwdat 1.0.1 AARs while you still have good wifi.
- [ ] Create `samples/CameraAccess/local.properties` (Android Studio usually creates it with `sdk.dir=...`) and **add** these lines (Developer Mode values, not secrets):
  ```properties
  mwdat_application_id=0
  mwdat_client_token=0
  ```
- [ ] Open `junction-meta-glasses/android-dat` as a second project and let it sync too (same dependency versions, so it's quick).

### Android phone
- [ ] **Android 12 (API 31) or newer.** The DAT docs say Android 10+, but both the Meta sample and our bridge use `minSdk 31`.
- [ ] **Settings → About phone → tap Build number 7×** → Developer options → **USB debugging ON**. Plug into the laptop and accept the RSA prompt. `adb devices` should list it.
- [ ] Install or update the **Meta AI** app (Play Store: `com.facebook.stella`) to **V292 or newer**. Check under Meta AI → Settings → App Info → App version.
- [ ] Log in to a Meta account. **The account needs a date of birth on file**, or Display Web Apps stay hidden even in Developer Mode ([Web Apps troubleshoot](https://wearables.developer.meta.com/docs/develop/webapps/troubleshoot/)).
- [ ] Bluetooth ON. Location ON (Android BT pairing sometimes needs it).

---

## 2. At the booth: questions for Amanda Le

Ask these and write the answers in the Findings log:

1. **Overnight loan?** Can we keep 1× Ray-Ban Meta Gen 2 and 1× Ray-Ban Display + Neural Band until after judging on Sun ~10:30? If not, what are the return and re-pickup times? (Our test slots: Sat 19:30–20:30, Sun 06:30–08:30.)
2. **Which Meta account?** Are the loaned glasses already paired to a Meta booth account or phone? Should we **pair them to Momin's own Meta AI app**, or use a booth phone/account? Do we need to factory-reset or unpair them when we return them?
3. **Firmware / app versions.** Are the loaner glasses on **firmware V128+**? Is anything newer than DAT 1.0.1 coming that we should use (an internal build, or Meta AI app V292+)? Should we reboot them after an update (known issue: camera fails after the V128 OTA until reboot)?
4. **Pre-registered app IDs.** Do we need a Wearables Developer Center project / `APPLICATION_ID` + `CLIENT_TOKEN`, or is **Developer Mode with `0`/`0`** fine on the loaners? Is there a **hackathon org or release channel** we should join?
5. **Display Web App loading.** Is **Web Apps** enabled for these Display glasses and accounts *in Finland / at this event*? (Docs: it's gated by country and account age. Developer Mode doesn't change that.) Is the flow still Meta AI app → App Settings → Apps → Web Apps → **Connect Web App** → URL? Or should we use the **View on Glasses QR** (`fb-viewapp://web_app_deep_link?appName=…&appUrl=…`)? Does a **cloudflared `trycloudflare.com` URL** work, or is any domain blocked?
6. **Neural Band → Web App input mapping.** Docs: the page receives `keydown` `ArrowUp/Down/Left/Right` + `Enter`, the system Back calls `history.back()`, and a **middle tap opens the universal Web App menu**. **Which Neural Band gesture produces which key** (thumb swipe = arrows? index pinch = Enter? which one is Back)? Is drag (`touch-action: none` + pointer events) enabled on the loaners?
7. **DAT camera + Web App at the same time on the Display glasses?** Can a DAT camera stream (phone app) run **while** our Web App is in the foreground on the Display? If not, our plan is: **Gen 2 = camera via DAT**, **Display = HUD via Web App**, with both paired to the same phone. Can **one phone / Meta AI app hold both pairs connected at once**?
8. **Camera-stream practicalities.** Is the **2 fps** `frameRate` OK on the loaners? What's the typical latency? Does the stream keep running if our app is backgrounded (we use a foreground service)? Is there a **capture-LED / privacy** requirement we should mention in the pitch?
9. **Mic/speaker.** Any problem using the glasses as a normal **Bluetooth HFP headset** for a phone-browser web app (Chrome `getUserMedia`) while a DAT session is active?
10. **DAT Display (`mwdat-display`) instead of a Web App?** The SDK can render native display content on Ray-Ban Display from the phone app. Is that enabled on the loaners? It would be our backup HUD path if Web Apps are geo-blocked.

---

## 3. Pair the glasses and enable Developer Mode

1. Charge the glasses to **> 10 %**. The DAT glasses-app install fails below 10 % (known issue).
2. Meta AI app → **Devices** (glasses icon) → add / pair the glasses. Follow the in-app flow.
3. Check the firmware: **Devices → (your glasses) → gear icon → General → About → Version**. It must be **V128 or newer**. If it's older, update, then **reboot the glasses** (hold the power button off/on).
4. **Developer Mode**: Meta AI app → **Settings → App Info → tap the "App version" number 5 times** → toggle **Developer Mode** → **Enable**. ([DAT setup](https://wearables.developer.meta.com/docs/develop/dat/getting-started-toolkit/#enable-developer-mode-in-the-meta-ai-app)) After connecting the glasses, close and reopen the Meta AI app.
5. Developer Mode can **reset after an app or firmware update** and is **per linked device**, so recheck it after any update. ([debugging rule](https://github.com/facebook/meta-wearables-dat-android/blob/main/.cursor/rules/debugging.mdc))

---

## 4. Build and run Meta's CameraAccess sample (proves the hardware path)

1. Android Studio → open `meta-wearables-dat-android/samples/CameraAccess` → **File → Sync Project with Gradle Files** → select the phone → **Run ▶ app**.
2. On the phone: allow the Bluetooth permission prompt.
3. Tap **"Connect my glasses"**. The Meta AI app opens. Approve the connection, and you're returned to the sample. (The app now shows under Meta AI → App connections → **Developer mode apps**.)
4. Tap **Start Session** and wait until the session chip shows `started`.
5. Tap **Preview**. The first time, the app asks to redirect you to Meta AI for the **camera permission**. Choose **Allow always**.
6. You should see the live glasses camera. The stream chip goes `starting → started → streaming`.
7. ✅ If this works, the glasses, account, Developer Mode and phone are all good. **Write the observed resolution and latency in the Findings log.**

If it fails, go to §7 Troubleshooting **before** trying our bridge.

---

## 5. Build and run HoldUp Bridge (`android-dat/`)

What it does: connects to the glasses via DAT, starts a camera stream at **720×1280 (`VideoQuality.HIGH`) @ 2 fps** (the lowest the SDK allows; valid fps are 2/7/15/24/30). It JPEG-encodes **at most ~1 frame/s** and POSTs it to `{server}/ingest/frame` (`image/jpeg`; `?session=<id>` only if a code is entered, otherwise the server uses the latest live session). If a POST is still in flight, the frame is dropped. It also POSTs device state (`connected`, `worn`, `battery`, `streaming`) to `{server}/ingest/state` on every change and every 10 s.

1. The server and tunnel must be running on the demo laptop: `npm run dev` + `npm run tunnel`. Copy the printed `https://….trycloudflare.com` URL.
2. Open the phone PWA (same tunnel URL) and start a session there. A session code is **not needed**: the server attaches the bridge to the latest live session.
3. Android Studio → open `junction-meta-glasses/android-dat` → sync → **Run ▶ app** on the phone. No `local.properties` edits are needed (Developer Mode IDs default to `0`).
4. In **HoldUp Bridge**:
   - **Server URL**: paste the tunnel URL (no trailing slash needed).
   - **Session code**: leave it **blank** (= latest session). Only fill it in if several phones run sessions at once. A link `holdupbridge://connect?server=<url>&session=<code>` (for example from a QR code) fills both fields.
   - Tap **Connect glasses**. The Meta AI app opens. Approve. **This unregisters the CameraAccess sample** (only one dev-mode app at a time). Status should read `Registered`, then `Device: <name> connected`.
   - Tap **Start streaming**. The first time, Meta AI opens for the camera permission. Choose **Allow always**.
   - Status shows `Streaming`, **frames sent / dropped / last HTTP code**, and the glasses' **battery and worn** state.
5. Check on the laptop: the server log or device panel should show glasses frames arriving. The phone PWA should switch its eye to **Glasses** when it receives `{type:"device", ...}`.
6. **Keep the bridge running** while you switch to Chrome for the PWA: streaming continues in the background via a foreground service ("HoldUp is streaming from your glasses" notification). If frames stop when backgrounded, use **Android split-screen** (bridge + Chrome) and log it in the Findings log.
7. **Stop streaming** stops the camera (capture LED off). **Disconnect** ends the DAT session.

Quick server check from the laptop (no glasses needed), to test that the endpoint is up:
```bash
curl -i -X POST -H 'Content-Type: application/json' \
  -d '{"connected":true,"worn":true,"battery":80,"streaming":false}' \
  "$TUNNEL/ingest/state?session=TEST"
```

---

## 6. Ray-Ban Display HUD as a Web App

Facts from the docs ([setup](https://wearables.developer.meta.com/docs/develop/webapps/setup/), [test](https://wearables.developer.meta.com/docs/develop/webapps/test/), [display and layout](https://wearables.developer.meta.com/docs/develop/webapps/build/display-and-layout/), [input](https://wearables.developer.meta.com/docs/develop/webapps/build/input-and-navigation/), [app icons](https://wearables.developer.meta.com/docs/develop/webapps/build/app-icons/)):

- A Web App is a normal web page at a **public HTTPS URL** (valid TLS; HTTP is rejected) that runs in a **Chromium-based browser on the glasses**. There's no build, packaging or SDK step. Our `/hud` route on the tunnel URL is the app.
- **Requirements**: Ray-Ban Display glasses with **firmware v125+** and the **Meta AI app v272+**. The Neural Band is optional. Developer Mode is on (same toggle as §3).
- **Display**: **600 × 600 additive light**. Black = transparent/unlit. Use a black canvas with bright, bounded cards. Don't hard-code 600 px.
- **Input**: the page receives `keydown` **ArrowUp/Down/Left/Right** and **Enter** from the touchpad and Neural Band. The browser does spatial focus navigation and Enter clicks the focused element. The system **Back** calls `history.back()` (history is capped at 5 entries). A **middle tap opens the universal Web App menu** (Restart / Resume / Permissions).
- **Speech**: `speechSynthesis` works through the glasses speaker (one voice, en-US).
- **Not available**: camera, mic capture (only dictation into text fields). This is why the camera goes through DAT.
- Icon/name: optional `.well-known/meta-wearables-manifest.json` next to the launch URL. See `docs/HUD_SPEC.md`.

### Steps to load the HUD on the glasses
1. The server and tunnel are running. The web engineer has built `/hud` (spec in `docs/HUD_SPEC.md`).
2. On the laptop, open `https://<tunnel>/hud/` in Chrome first (no session param: the server attaches the HUD to the latest live session and replays the last verdict). It must load with **no console or certificate errors**. Optional: preview with the [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll) Chrome extension (600×600 additive preview, arrow/Select buttons, and a **View on Glasses QR** generator).
3. On the phone: **Meta AI app → App Settings (left panel) → Apps → Web Apps → Connect Web App** → enter `https://<tunnel>/hud/` (with the trailing slash) → **Save**.
4. On the glasses: the app appears at the **bottom of the app grid**. Pin it, then open it.
5. Alternative: scan the **View on Glasses QR** from the simulator with the glasses, then confirm on the glasses. The QR encodes `fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=<https-url>`. A plain URL QR does **not** work.
6. **Every time the cloudflared quick-tunnel URL changes**, you must edit the Web App URL again. So keep one tunnel process running for the whole demo, or ask the CEO for a named tunnel or stable host.
7. After redeploying, reload with **middle tap → Restart**.
8. To record the HUD for the video: Meta AI app → Devices → (Display glasses) → **Record Display**.

---

## 7. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Gradle sync can't find `com.meta.wearable:mwdat-*` | Check that `mavenCentral()` is in `settings.gradle.kts` and you're online. **No PAT is needed** (SDK ≥ 0.9 is on Maven Central). A corporate/event proxy can block `repo1.maven.org`: try a phone hotspot. |
| Build fails: "Kotlin metadata version" / AGP errors | Use Android Studio Narwhal+, JDK 17 and SDK 36. The toolkit is compiled with Kotlin 2.2, so the app needs Kotlin ≥ 2.2. |
| "Connect" does nothing / registration never completes | Meta AI app missing or too old (needs V292+), Developer Mode off, or no internet. Recheck §3. Close and reopen Meta AI after enabling Developer Mode. |
| Registered, but `devices` is empty / session never `STARTED` | Glasses off, folded, out of range, or not connected in Meta AI. Open them, put them on, and check the Meta AI Devices tab shows "Connected". Battery > 10 %. |
| Session error `DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED` | Meta AI → App connections → update the DAT app on the glasses (the bridge has an **Update glasses app** button that calls `Wearables.openDATGlassesAppUpdate`). |
| Session error `INSUFFICIENT_SDK_VERSION` | Our SDK is too old for the glasses firmware. Bump `mwdat` in `android-dat/gradle/libs.versions.toml` to the newest version on Maven Central. |
| `DWA_OUT_OF_STU_RANGE` warning | Not blocking. Continue. |
| `DWA_UNAVAILABLE` | The DAT app on the glasses didn't start. Reboot the glasses, recheck the Meta AI setup, retry. |
| Device "update required" | Update firmware (bridge **Update firmware** button → `Wearables.openFirmwareUpdate`), then **reboot the glasses**. |
| Camera permission denied | Tap **Start streaming** again to re-request, or Meta AI → App connections → HoldUp Bridge → Camera → Allow. |
| Stream goes `PAUSED` | A cap-touch tap paused it. It resumes on its own. Don't tap the temple during the demo. |
| Stream stuck at `STARTING` / black | Camera broken after the V128 OTA → **reboot the glasses**. Too hot → let them cool (thermal level shown in the bridge). |
| `CAPABILITY_DENIED` | The capability is server-gated for that account. Ask Amanda. Fallback: phone camera. |
| Bridge says `HTTP 404` on /ingest | The server branch doesn't have the ingest routes yet. Tell the CEO. `HTTP 0 / network error` = wrong URL or the tunnel is down. |
| Frames arrive but the PWA doesn't switch to the glasses | Clear the bridge's session code (blank = latest session), or the phone session started after a different one. Restart the session on the phone. |
| Sample worked, now the bridge can't connect (or the other way round) | Only one dev-mode app can be registered: tap **Connect glasses** again in the app you want to use. |
| Web App not visible on the Display | Web Apps are geo/age gated (see §2 Q5). Add a birthday to the account. Update the glasses and Meta AI. Fallback: DAT Display API from the bridge, or show the HUD on the phone. |
| Web App shows an old version | Middle tap → **Restart**. Check the tunnel serves the new build. |
| HFP mic silent | Known issue on iPhone 17/iOS 26 only. On Android, check that Chrome's mic source is the glasses (BT headset). |

**Fallback if DAT is blocked entirely:** phone camera + glasses as a Bluetooth headset (PLAN §6). Record a short clip of the CameraAccess sample working for the deck.

---

## 8. Reference

- DAT Android repo + samples: https://github.com/facebook/meta-wearables-dat-android (`samples/CameraAccess`, `samples/DisplayAccess`)
- DAT docs: https://wearables.developer.meta.com/docs/develop/dat/ · API ref: https://wearables.developer.meta.com/docs/reference/android/dat/latest
- Web Apps docs: https://wearables.developer.meta.com/docs/develop/webapps/setup/ · AI toolkit / issue tracker: https://github.com/meta/meta-wearables-webapp
- Machine-readable docs index: https://wearables.developer.meta.com/llms.txt (navigate via `?product=all&version=1.0&document=…`)
- Docs MCP (no auth): `https://mcp.developer.meta.com/wearables`
- Bridge API facts used (from SDK 1.0.1 sample + docs): `Wearables.initialize`, `startRegistration`, `registrationState`, `devices`, `devicesMetadata[id]` → `Device.batteryLevel` (0 = unknown) / `donState` / `thermalLevel`, `createSession(AutoDeviceSelector())`, `session.state` / `errors` / `deviceInfo`, `session.addCamera(StreamConfiguration(videoQuality, frameRate))`, `camera.stream.videoStream` / `state` / `errorStream`, `checkPermissionStatus(Permission.CAMERA)`, `RequestPermissionContract()`. Default (uncompressed) frames are **YUV** in `VideoFrame.buffer`.

---

## Findings log (fill in at the booth and during tests)

| Time | Who | Finding |
|---|---|---|
| Sat 14:20 | glasses agent | Docs research done. SDK 1.0.1 is on Maven Central (no PAT). Dev Mode uses app ID `0`. Web Apps are loaded via Meta AI → Connect Web App. |
| Sat 14:25 | glasses agent | **Bridge not compiled yet.** freighter (FR8) is unreachable from the venue network (ports 22 and 443 time out), and building on Silas' laptop is off-limits. Every DAT call was checked with `javap` against the real `mwdat-core`/`mwdat-camera` 1.0.1 AARs from Maven Central, so the API names and signatures match. **Momin's first Android Studio sync and build of `android-dat/` is the compile check.** Send any compile error to the glasses agent (paste the first error line). |
| Sat 14:25 | glasses agent | Uncompressed DAT frames are the raw MediaCodec output. The SDK requests color format 19 (I420, found in the AAR), but phone decoders can return NV12 or padded rows. `YuvJpeg.kt` auto-detects the layout. The bridge shows the detected layout next to the frame size. **If colours look wrong (blue/orange swapped) on the server, note it here.** Text stays readable either way. |
| Sat 14:35 | glasses agent | The bridge sends `worn: null` / `battery: null` when the glasses report UNKNOWN (often the case before the first wear-detection event). `server/src/index.ts` currently maps `worn: !!b.worn`, so null becomes **false (doffed)**, which could trigger the "glasses doffed, use phone camera" fallback wrongly. Server fix requested: keep `null` as unknown. |
| | | |
