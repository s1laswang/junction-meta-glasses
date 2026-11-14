# 06:30 Helsinki 10-Minute Hardware Filming Checklist (Momin)

**Window:** Sun 15 Nov `06:30-06:40` Helsinki (10 min flat) · **Crew:** Momin AlDahdouh (wearer) + 1 camera/terminal operator.
**Goal:** Capture the uncut 95 s real-glasses proof clip + stills into `docs/img/hw/` and populate `docs/HARDWARE_LOG.md` (`H1`-`H10`) in one pass.

## Three Code-Verified Gotchas (Read Before `06:30`)
1. **`HOLDUP_KEY` in Terminal 3:** `/api/health` is public, while `/api/stats` requires `?key=`. Export `HOLDUP_KEY` and `TUNNEL` in Terminal 3 so `hw:probe` never hits `HTTP 401` and logs real latencies instead of dashes.
2. **`server/src/live.ts` `finish()` ledger flush:** `live.ts` writes `first_audio_s` to `ledger.jsonl` only when a session closes. Run **one 10 s pre-shoot mic check + `Stop check`** before rolling, and tap **`Stop check`** before the final `H10` probe.
3. **`H8` BEFORE `H9` (doff while online):** HoldUp Bridge sends `worn: false` via HTTP `POST /ingest/state` over the tunnel so Chrome PWA auto-flips to **`Phone camera`** (required for offline barcode). Take glasses OFF **while still online** (`H8`), run `H8-glasses-off`, then toggle Airplane mode ON (`H9`).

## Minute 0-2 (`06:30-06:32`) - Setup & Pre-Warm
- [ ] **Charge & firmware:** Glasses `>50%` (Gen 2 fw `V128+` power-cycled; Display fw `V125+`), phone `>70%`, Meta AI `V292+` Developer Mode **ON**, DND **ON**, screen timeout **10 min**, media volume **80%**.
- [ ] **Airplane + Bluetooth pre-train:** Toggle **Airplane mode ON -> Bluetooth ON -> Airplane mode OFF** once so Android keeps glasses HFP audio alive during `H9`.
- [ ] **Terminals 1-3 & APK (`164dea1bb474fbdbcb7bdeccd3270ccc42c46c2c1c5683f2a9bd2b894a3bfe20`):** Set `HOLDUP_KEY` once in `.env` (never commit `.env`), run `npm start` (Terminal 1) and `npm run tunnel` (Terminal 2, keep one tunnel alive), then run in **Terminal 3**:
```bash
export HOLDUP_KEY=<same-key-as-dotenv>
export TUNNEL=https://<id>.trycloudflare.com
shasum -a 256 /tmp/holdup-bridge-debug.apk
adb install -r /tmp/holdup-bridge-debug.apk
```
- [ ] **Profile & props:** Open `$TUNNEL/?key=$HOLDUP_KEY` in Android Chrome, accept consent, tap **Profile -> Load demo profile**, **scan the physical Amlodipine 5 mg barcode** into Amlodipine, confirm **0** doses logged today, and place props left-to-right: **Amlodipine 5 mg**, **Ibuprofen 400 mg**, **strength-covered box**.
- [ ] **10 s pre-shoot mic check + `Stop check`:** Tap **Start check**, ask *"Can you hear me?"*, hear reply in glasses, then tap **`Stop check`** so `server/src/live.ts` `finish()` flushes a `live` `first_audio_s` entry to `ledger.jsonl`.

## Minute 2-3 (`06:32-06:33`) - `H1` First (5 s) + Bridge & Display HUD
- [ ] **`H1` BEFORE HoldUp Bridge (Dev Mode single-app rule):** Screen-record 5 s of Meta `CameraAccess` (`Connect my glasses -> Start Session -> Preview -> Allow always`) -> save `docs/img/hw/H1-camera-access.mp4`.
- [ ] **Connect HoldUp Bridge:** Paste `$TUNNEL/?key=$HOLDUP_KEY` in **Server URL**, leave **Session code** blank, tap **Connect glasses** -> **Start streaming** (`Allow always`). Use **Android split-screen** with Chrome PWA if backgrounding pauses frames.
- [ ] **Verify Ray-Ban Display HUD:** Open `$TUNNEL/hud/?key=$HOLDUP_KEY` (trailing slash required) on the glasses and confirm **`Hold it up.`** Start `Meta AI -> Devices -> Record Display` (`docs/img/hw/H7-hud-record-display.mp4`).

## Minute 3-5 (`06:33-06:35`) - Uncut 95 s Master Take (`docs/img/hw/H4-live-check-master.mp4`)
Clip lavalier mic **10 cm below right temple**; lock filming camera at **1080p60**, **`-0.7 EV` locked exposure**, counter focus. Roll uncut `0:00-1:35` (`1:15-1:35` split into `H8` online first, then `H9`+`H10`):

| Take Time | Rows | Wearer Action & Framing | Expected Output & Terminal 3 `hw:probe` Command |
|---|---|---|---|
| **`0:00-0:10`** | `H2`, `H3` | Tight on Bridge (`Streaming`, rising `Frames: sent`, `HTTP 204`, `worn`, battery) + lit temple LED -> Chrome PWA **Start check** | PWA shows **`Using glasses camera`**. Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H2-H3-streaming"` |
| **`0:10-0:40`** | `H4` | Medium third-person shot: both hands holding **backwards Amlodipine 5 mg**; ask *"Is this my evening pill?"* -> rotate per voice coaching | Open-ear coaching -> green **`MATCH`** (*"Yes, Amlodipine 5 mg..."*). Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H4-match"` |
| **`0:40-0:55`** | `H7`, `H5` | Lens flush behind right Display waveguide -> Neural Band **`I took it`** -> re-show Amlodipine + open late-join `/hud/` laptop tab | Lens shows **`✓ RIGHT ONE`** -> dose logged -> amber **`WARNING: already taken today`** + `/hud/` tab replay. Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H5-H7-hud-logged"` |
| **`0:55-1:15`** | `H6` | Show **Ibuprofen 400 mg** (*"And this one?"*), then cover strength digits with thumb/tape (*"What about this?"*) | Amber **`WARNING`** (avoid NSAIDs), then blue **`NOT SURE`** (zero dose guessing). Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H6-safety-catches"` |
| **`1:15-1:22`** | `H8` | Take glasses **OFF while still online** (`H8` BEFORE `H9`) | Bridge POSTs `worn: false` to `/ingest/state` -> earcon + PWA auto-flips to **`Phone camera`**. Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H8-glasses-off"` |
| **`1:22-1:35`** | `H9`, `H10` | **Airplane mode ON** (BT stays ON) -> scan **Amlodipine barcode** (`H9`) -> **Airplane mode OFF** (`H10`) -> tap **`Stop check`** | Offline barcode verdict (`H9`) -> **`Live assistant connected`** `<10 s` (`H10`) -> **`Stop check`** flushes session `first_audio_s` to ledger -> Run:<br>`npm -w server run hw:probe -- --base "$TUNNEL" --label "H10-live-recovered"` |

## Minute 5-8 (`06:35-06:38`) - Fast Pick-Ups (Only If Missed in Master Take)
- [ ] **3 crisp stills (~60 s):** Through-lens macro photo `docs/img/hw/H7-hud-through-lens.jpg` (`H7`) against a dark coat (`-1 EV`) + 2 native screenshots: `docs/img/hw/H2-bridge-204.png` (`H2`) and `docs/img/hw/H3-pwa-glasses-cam.png` (`H3`).
- [ ] **Optional isolated clips / `ffmpeg` trims (skip if `H4-live-check-master.mp4` is clean):** `docs/img/hw/H5-double-dose-warn.mp4` (`H5`), `docs/img/hw/H6-safety-ibuprofen-unsure.mp4` (`H6`), `docs/img/hw/H8-glasses-off-fallback.mp4` (`H8`), `docs/img/hw/H9-H10-offline-barcode-reconnect.mp4` (`H9`, `H10`).

## Minute 8-10 (`06:38-06:40`) - Pull, Verify & Commit
```bash
mkdir -p docs/img/hw
adb pull /sdcard/DCIM/ScreenRecorder/ docs/img/hw/
adb pull /sdcard/Pictures/Screenshots/ docs/img/hw/
git diff docs/HARDWARE_LOG.md
```
- [ ] Place files at the exact `docs/img/hw/` filenames above, fill top `Setup used` (`git rev-parse --short HEAD`, firmware, phone, network) + `H1`-`H10` pass table in `docs/HARDWARE_LOG.md`, and check the 6 appended `Probe rows` have non-dash latencies.
- [ ] Confirm zero secrets (`git diff` check: no `HOLDUP_KEY`, `GEMINI_API_KEY`, or raw `?key=` values), commit, and paste the hosted video link into Slide 5 (`#s5-h`) of `deck/index.html`.

## 30-Second On-Set Recovery
- **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`:** Run `adb uninstall app.holdup.bridge` then `adb install /tmp/holdup-bridge-debug.apk`.
- **Stream flips to `PAUSED`:** Accidental temple touchpad touch; keep hands off the right temple for 2 s to auto-resume.
- **Offline barcode silent in `H9`:** Verify `H8` flipped Chrome PWA to **`Phone camera`** while online and the physical Amlodipine box barcode is saved in `Profile`.
