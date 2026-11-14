# HoldUp Hardware Filming Shot List (2-Minute Field Runbook)

**Cast & Crew:** **Momin AlDahdouh** (wearer, hands-free on camera) + **Camera Operator / Tripod** (second phone or mirrorless camera).
**Goal:** Capture one continuous ~95 s master proof take plus 6 quick insert shots proving real Meta DAT camera streaming, open-ear Gemini Live coaching, Ray-Ban Display waveguide HUD, Neural Band input, deterministic safety catches, and offline resilience for `docs/HARDWARE_LOG.md` (`H1`-`H10`).

---

## 1. Pre-Shoot 5-Minute Checklist

### Hardware & Firmware
- [ ] **Ray-Ban Meta Gen 2 (DAT camera + Bluetooth audio):** Firmware `V128+`, battery `>20%` (DAT glasses-app install fails below `10%`). If updated to `V128+` recently, **power-cycle the glasses** first so the camera initializes cleanly.
- [ ] **Meta AI app (`V292+`) on Android (`API 31+`):** Enable **Developer Mode** (`Settings -> App Info -> tap "App version" 5 times -> toggle Developer Mode -> Enable`), then close and reopen Meta AI. Pair Gen 2 glasses as the active **Bluetooth HFP headset**.
- [ ] **Ray-Ban Display + Neural Band (HUD):** Firmware `V125+`, Meta AI `V272+`, Meta account has a date of birth on file. Connect and pin the Web App in `Meta AI -> App Settings -> Apps -> Web Apps -> Connect Web App`:
  - Open URL: `https://<tunnel>/hud/` (trailing slash required; append `?key=<HOLDUP_KEY>` if `HOLDUP_KEY` is set).
  - Open from the bottom of the glasses app grid and confirm the idle card reads **`Hold it up.`**
- [ ] **HoldUp Bridge APK on Android phone:** Verify checksum (`164dea1bb474fbdbcb7bdeccd3270ccc42c46c2c1c5683f2a9bd2b894a3bfe20`) and install Silas's prebuilt debug APK:
  ```bash
  shasum -a 256 /tmp/holdup-bridge-debug.apk
  adb devices
  adb install -r /tmp/holdup-bridge-debug.apk
  adb shell am start -n app.holdup.bridge/.MainActivity
  ```
  *(If `INSTALL_FAILED_UPDATE_INCOMPATIBLE` appears from a different debug keystore, run `adb uninstall app.holdup.bridge` and re-run `adb install`.)*
- [ ] **Phone settings:** Do Not Disturb **ON**, screen timeout **10 min**, media volume **80%**. Pre-train Android Airplane mode once before rolling: toggle **Airplane mode ON -> turn Bluetooth back ON -> toggle Airplane mode OFF** (Android remembers to keep glasses Bluetooth alive during Shot 5).
- [ ] **Filming camera:** **1080p60 landscape**, **locked exposure (-0.7 to -1.0 EV)** and locked focus at counter distance so glossy white medicine boxes and OLED/waveguide screens never blow out.

### Props on Kitchen Table (Left-to-Right Order)
1. **Amlodipine 5 mg box** (evening blood-pressure pill): **scan this physical box's real barcode** into `Profile -> Amlodipine -> Edit -> Scan` before rolling, and verify **zero** Amlodipine doses are logged today.
2. **Ibuprofen 400 mg box** (painkiller): triggers not-on-list + `avoid NSAIDs` safety warning.
3. **Second med box (e.g. Metformin 500 mg)** with an opaque strip of tape over the strength digits (or pre-marked thumb placement covering `5 mg` / `500 mg`).
4. **Hazelnut or peanut snack bar** (optional 5 s food-allergy beat if ahead of time).

### Open-Ear Glasses Audio Capture
- [ ] **Primary:** Clip a wireless lavalier mic to Momin's right collar or glasses temple **~10 cm below the right temple speaker** in a quiet room (turn off fridge/AC/fans if possible).
- [ ] **Backup:** Second phone running Voice Memos held near Momin's right shoulder; clap once on camera at `0:00` for waveform sync.
- [ ] **Why this matters:** Judges must hear Gemini Live's coaching and verdicts radiating from the **open-ear glasses speakers**, not a phone speaker.

### Server, Profile & Hardware Probe Setup
- [ ] **Start server + single tunnel** on laptop (optionally set `HOLDUP_KEY=<8+ random chars>` in `.env` and never commit it; run `npm start` on `:8787` in terminal 1 and `npm run tunnel` in terminal 2, and do **not** restart `tunnel` once Display HUD URL is saved):
  ```bash
  npm start
  npm run tunnel
  ```
- [ ] Check `https://<tunnel>/api/health` returns `"gemini":"ok"`.
- [ ] **Capture `H1` first (5 s):** Before registering HoldUp Bridge, record 5 s of Meta's `CameraAccess` sample streaming (`Connect my glasses -> Start Session -> Preview -> Allow always`), because Developer Mode allows only one registered app at a time.
- [ ] **Phone Chrome PWA:** Open `https://<tunnel>/` (or `/?key=<HOLDUP_KEY>`), accept the 3 consent cards, tap **Profile -> Load demo profile**, scan the real Amlodipine barcode, and confirm **Check -> Device state** shows server `ok` and audio routed to glasses.
- [ ] **HoldUp Bridge app:** Paste `https://<tunnel>` (or `https://<tunnel>/?key=<HOLDUP_KEY>`) into **Server URL**, leave **Session code** **blank** (attaches to latest live session), tap **Connect glasses** (approve in Meta AI), then tap **Start streaming** (`Allow always`). Switch phone to Chrome PWA Check tab (foreground service keeps streaming) or use Android split-screen; optional `scrcpy` mirror on laptop.
- [ ] **Probe terminal ready** (from `justSilas-meta-integration` / commit `3b4f465`, appends live telemetry rows to `docs/HARDWARE_LOG.md` without logging keys):
  ```bash
  HOLDUP_KEY=<key-if-set> npm -w server run hw:probe -- --base https://<tunnel> --label "<step>"
  ```

---

## 2. Master Uncut 95s Continuous Take (0:00-1:35, Mapped to H1-H10)

Roll filming camera + lavalier mic continuously from `0:00` to `1:35`. Operator runs `hw:probe` in terminal 3 right after each milestone.

| Time | Log ID | Shot & Camera Framing | Momin Action & Spoken Line | Expected System Output & Probe Command |
|---|---|---|---|---|
| **0:00-0:10** | `H2`, `H3` *(H1 pre-shot)* | **Shot 1 - Bridge + PWA + Temple LED Close-Up:** Start tight on Android screen next to Gen 2 glasses capture LED lit, then swipe/split to Chrome PWA Check tab. | Show Bridge status card, switch to Chrome PWA, tap **Start check** (hear start earcon). | Bridge shows `Streaming`, `Frames: sent <N>` rising, `HTTP 204`, `connected · worn · <battery>%`. Chrome PWA shows **`Using glasses camera`**. Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H2-H3-streaming"` |
| **0:10-0:40** | `H4` | **Shot 2 - Signature Third-Person Medium Shot:** Pull back to frame Momin wearing glasses, **both hands free** holding **Amlodipine 5 mg** with **back side facing Momin**, phone flat on counter (or `scrcpy` mirror) visible in frame. | Ask: ***"Is this my evening pill?"*** Follow voice coaching: slowly turn box around, bring to ~30 cm, hold steady. | Open-ear speaker coaches (*"The label is on the other side. Turn it around... A bit closer... got it"*), arrow cue shows on phone/HUD, then green **`MATCH`** card + voice: ***"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today."*** Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H4-match"` |
| **0:40-0:55** | `H7`, `H5` | **Shot 3 - Through-the-Lens Ray-Ban Display HUD Macro + Dose Log + Re-Check:** Move camera lens **flush behind right waveguide lens** aimed at a dark jacket/wall (with `Meta AI -> Devices -> Record Display` running as backup). | Pinch with **Neural Band (`Enter`)** on focused **`I took it`** button (or say ***"I took it"***). Hold up **Amlodipine 5 mg** a second time. Open a fresh `/hud/` tab on laptop to verify replay. | Additive green **`✓ RIGHT ONE`** card crisp in lens -> `Dose logged` toast + phone Profile timestamp. Second hold-up triggers amber **`WARNING`** (`⚠ CHECK` on HUD): ***"already taken today"***. Late-joining `/hud/` tab immediately replays the latest verdict. Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H5-H7-hud-logged"` |
| **0:55-1:15** | `H6` | **Shot 4 - Safety Catches (Medium -> Tight on Hands & Card):** Keep box label + phone/HUD card in frame. | 1) Pick up **Ibuprofen 400 mg**, ask: ***"And this one?"***<br>2) Hold second box with **thumb/tape covering `5 mg` / `500 mg` strength**, ask: ***"What about this?"*** *(Optional: hazelnut bar -> "Does this have nuts?")* | 1) Amber **`WARNING`** (`⚠ CHECK`): not on medication list + **avoid NSAIDs**.<br>2) Blue **`NOT SURE`** (`? NOT SURE`): ***"I can't read the strength confidently... Turn the box so the side panel faces you, or ask a pharmacist."*** Zero dose guessing. Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H6-safety-catches"` |
| **1:15-1:35** | `H8`, `H9`, `H10` | **Shot 5 - Live Hardware & Network Resilience:** Medium-tight framing Momin taking glasses off + phone screen on counter. | 1) **Take glasses off** (`H8`).<br>2) Swipe Quick Settings -> **Airplane mode ON** (Bluetooth stays ON) -> show **Amlodipine barcode** to phone camera (`H9`).<br>3) Toggle **Airplane mode OFF** (`H10`). | 1) Alert earcon + Bridge `not worn` (`worn: false`) -> PWA auto-switches to **`Phone camera`**. Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H8-glasses-off"`<br>2) *"You're offline..."* -> offline barcode scan recognizes saved Amlodipine (`WARNING: already taken today` after Shot 3, or `MATCH` if unlogged).<br>3) `Back online` -> **`Live assistant connected`** within **10 s**. Run:<br>`npm -w server run hw:probe -- --base https://<tunnel> --label "H10-live-recovered"` |

---

## 3. Six Dedicated Insert / Backup Shots Table (5-10 s Each)

Shoot these 6 tight pick-ups immediately before (`H1`) and after the master take so the deck and backup cut have isolated, razor-sharp close-ups for every `HARDWARE_LOG.md` row:

| Insert # | Maps To | Duration | Framing & Exact Capture Action | Pass Evidence |
|---|---|---|---|---|
| **Insert 1** | `H1` | 5 s | Android native screen recording of Meta `CameraAccess` sample **before** connecting HoldUp Bridge (`Connect my glasses -> Start Session -> Preview`). | Chip moves `starting -> started -> streaming` with live 720x1280 glasses video. |
| **Insert 2** | `H2`, `H3` | 6 s + 2 stills | Native screenshots + macro video of HoldUp Bridge (`Streaming`, `Frames: sent`, `HTTP 204`, `worn`, battery %) and Chrome PWA (`Using glasses camera` + Device state panel open). | Rising frame counter + `HTTP 204` + temple capture LED visible. |
| **Insert 3** | `H4` | 10 s | Over-the-shoulder POV of Momin's hands rotating the backwards Amlodipine box in sync with the HUD/phone directional cue arrow (`Turn it around` -> `A bit closer` -> green `MATCH`). | Clear visual cause-and-effect between voice/arrow coaching and box rotation. |
| **Insert 4** | `H7` | 8 s + 1 still | Filming lens pressed **flush behind right Ray-Ban Display waveguide lens** against dark fabric (`✓ RIGHT ONE`, `⚠ CHECK`, `? NOT SURE`) + `Meta AI -> Devices -> Record Display` + Neural Band pinch on `I took it` + late-join `/hud/` browser tab replay. | Zero background glare; crisp 600x600 additive green card + Neural Band focus activation. |
| **Insert 5** | `H6` | 8 s | Macro shot of Momin's thumb physically covering the `5 mg` / `500 mg` digits next to the phone turning blue **`NOT SURE`**. | Visual proof for judges that covered strength digits never produce a guessed dose. |
| **Insert 6** | `H8`, `H9`, `H10` | 15 s | Tight top-down shot of glasses folded/doffed next to phone (`Phone camera` switch) -> Airplane toggle ON (Bluetooth icon active) -> instant Amlodipine barcode read -> Airplane OFF -> `Live assistant connected` (<10 s). | Uncut offline-to-live recovery on real phone hardware. |

---

## 4. File Naming & Drop Location (`docs/img/hw/`)

Save all raw clips and screenshots directly into `docs/img/hw/` using these exact names so `docs/HARDWARE_LOG.md` links resolve cleanly:

| File Path | Contents | Hardware Log Rows |
|---|---|---|
| `docs/img/hw/H4-live-check-master.mp4` | Master uncut 95 s third-person continuous take (`0:00-1:35`) with open-ear lavalier audio | `H2`-`H10` |
| `docs/img/hw/H1-camera-access.mp4` | 5 s phone screen recording of Meta `CameraAccess` sample live video | `H1` |
| `docs/img/hw/H2-bridge-204.png` | HoldUp Bridge screenshot showing `Streaming`, `Frames: sent`, `HTTP 204`, `worn`, battery % | `H2` |
| `docs/img/hw/H3-pwa-glasses-cam.png` | Chrome PWA screenshot showing `Using glasses camera` + Device state panel (`connected`, `worn`, `battery`) | `H3` |
| `docs/img/hw/H5-double-dose-warn.mp4` | `"I took it"` log followed by holding Amlodipine again -> amber `WARNING: already taken today` | `H5` |
| `docs/img/hw/H6-safety-ibuprofen-unsure.mp4` | Ibuprofen 400 mg `WARNING` (avoid NSAIDs) + thumb/tape over strength -> blue `NOT SURE` | `H6` |
| `docs/img/hw/H7-hud-through-lens.jpg` | Through-the-lens macro photo of Ray-Ban Display green `✓ RIGHT ONE` waveguide card | `H7` |
| `docs/img/hw/H7-hud-record-display.mp4` | `Meta AI -> Devices -> Record Display` capture of Neural Band `I took it` + late-join `/hud/` replay | `H7` |
| `docs/img/hw/H8-glasses-off-fallback.mp4` | Glasses taken off -> earcon + auto-switch to `Phone camera` (`worn: false`) | `H8` |
| `docs/img/hw/H9-H10-offline-barcode-reconnect.mp4` | Airplane mode ON (BT on) -> offline Amlodipine barcode -> Airplane OFF -> `Live assistant connected` (<10 s) | `H9`, `H10` |

---

## 5. On-Set Quick Fixes (30-Second Recovery)

- **Stream switches to `PAUSED`:** Accidental touch on the right temple touchpad paused DAT streaming; keep hands off the temple and wait 2 s for auto-resume.
- **Through-the-lens HUD looks faint or washed out:** Aim the glasses against a dark coat or unlit wall, press the camera lens flush behind the right waveguide lens, and lock exposure `-1 EV`.
- **Bridge stops sending frames when backgrounded:** Open HoldUp Bridge + Chrome PWA in **Android split-screen** so both stay visible.
- **Offline barcode does not trigger in Shot 5:** Confirm camera source flipped to **`Phone camera`** (offline barcode reads phone frames only) and the physical Amlodipine box's barcode was scanned into `Profile -> Amlodipine -> Edit -> Scan`.
