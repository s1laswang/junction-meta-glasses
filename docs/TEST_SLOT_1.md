# Glasses test slot 1: Sat 19:30–20:30

Who: **Momin010** (glasses, Android phone, Android Studio), **ivarakerholm-wq** (props, notes, timing), **Silas** (demo laptop, wearer for the run-through).
Goal: prove the full chain on real hardware and write down what breaks. Record every result in the **Findings log** at the bottom of `docs/HARDWARE_NOTES.md`, including the time, who saw it and what happened.

## A. Before 19:30 (Momin, about 30 min, on good Wi-Fi)
1. On Momin's laptop: Android Studio Narwhal or newer, JDK 17, SDK 36. Clone `meta-wearables-dat-android` and `s1laswang/junction-meta-glasses` on **main**; the bridge is merged. Gradle-sync both `samples/CameraAccess` and `android-dat/`.
   - Paste any compile error from `android-dat/` (first error line) to the CEO right away.
2. Android phone: Android 12 or newer, USB debugging on, Meta AI app V292 or newer, a Meta account with a birthday set.
3. Glasses charged above 10 %. In Meta AI → Devices, the firmware is V128 or newer. **Reboot the glasses after any update.**
4. Developer Mode: Meta AI → Settings → App Info → tap "App version" 5× → Enable. Close and reopen Meta AI.

## B. Demo laptop up (Silas, 19:25)
1. `cd junction-meta-glasses && git pull`. In `.env`, set `HOLDUP_KEY=<pick 8+ random chars>`.
2. `npm install && npm start` (production build on :8787). In a second terminal: `npm run tunnel`. Copy the `https://….trycloudflare.com` URL. **Leave both running for the whole slot**: a new tunnel URL means re-entering it everywhere.
3. Open `https://<tunnel>/api/health` and check it shows `"gemini":"ok"`.

## C. Phone app (Momin, 19:30)
1. On the Android phone, open Chrome at `https://<tunnel>/?key=<HOLDUP_KEY>`. Go through consent and allow camera and mic.
2. Profile → **Load demo profile**. This picks up plain names like "Amlodipine", not "Amlodipine besilate". Scan the **real barcode** of the amlodipine prop box into Amlodipine.
3. Pair the glasses as the phone's Bluetooth headset. The device panel's "Audio route" should name the glasses.
4. **Start** with the **phone camera** first and hold up the amlodipine box. ✅ Pass: spoken "Yes… Amlodipine 5 mg…" and a green card.

## D. Hardware path, step by step (stop at the first failure and log it)
1. **CameraAccess sample** (Meta's): Connect my glasses → Start Session → Preview → "Allow always". ✅ Live glasses video. Log the resolution and latency.
2. **HoldUp Bridge** (`android-dat/`, Run ▶): Server URL = `https://<tunnel>/?key=<HOLDUP_KEY>`, session code **blank**. Connect glasses (this replaces the sample registration) → Start streaming → Allow always. ✅ Frames sent goes up, last HTTP is 204, and battery and worn show.
3. In the phone app, switch the camera source to **Glasses camera**. ✅ "Using glasses camera", and the device panel shows the glasses connected, worn and battery.
4. Wearer puts the glasses on, picks up the amlodipine box **label facing away**, and asks "Is this my evening pill?". ✅ Coaching cue(s), then the match verdict, all heard in the glasses speakers. Note the time from question to first audio.
5. **Display HUD** (only if Ray-Ban Display glasses are on loan): Meta AI → App Settings → Apps → Web Apps → Connect Web App → `https://<tunnel>/hud/?key=<HOLDUP_KEY>` → Save. Open it from the bottom of the app grid. ✅ The verdict card appears on the lens, and Neural Band/touchpad → "I took it" logs the dose on the phone. Log which gesture maps to which key.

## E. Demo scenarios (ivarakerholm-wq times them; follow `docs/DEMO_SCRIPT.md`)
| # | Action | Expected |
|---|---|---|
| 1 | Amlodipine, label away | coaching, then ✅ match, "not taken today" |
| 2 | Say "I took it" | dose logged; phone Profile → dose log shows it |
| 3 | Amlodipine again | ⚠️ "already took it today" |
| 4 | Ibuprofen box | ⚠️ not on your list / avoid NSAIDs |
| 5 | Cover the strength with a thumb | ❓ unsure, asks you to turn it; **never says a dose** |
| 6 | Snack with nuts: "Does this contain nuts?" | ⚠️ allergy warning |
| 7 | Take the glasses off | announcement, falls back to the phone camera |
| 8 | Switch to the phone camera, then airplane mode with **Bluetooth back on** | offline banner; the amlodipine barcode still matches; honest "can't read new labels" |
| 9 | Airplane mode off | auto-recovers to live |

## F. Before leaving (20:30)
- Log every pass and failure in the HARDWARE_NOTES Findings log and push it (or message the CEO).
- Ask Amanda Le: overnight loan? Otherwise the return time and Sun 06:30 re-pickup.
- Note what Silas should say differently in the 3-minute demo.
