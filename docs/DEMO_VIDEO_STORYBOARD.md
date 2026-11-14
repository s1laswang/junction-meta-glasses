# HoldUp Submission Video Cut (90s) & Live Stage Split-Screen Storyboard (3m) (`docs/DEMO_VIDEO_STORYBOARD.md`)

Second-by-second visual, audio, waveguide HUD, and open-caption storyboard for both the **90-second (`01:30`) tight submission video cut** and the **3-minute (`03:00`) Junction 2026 live stage split-screen choreography** (`Meta: AI Glasses for Everyone, Everyday` + `Google DeepMind: Best Use of Gemini API`).

Companion artifacts:
- Pre-flight checklist, hardware contingency tiers, and judge Q&A: [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md)
- Multi-track `ffmpeg` compositing, ASS contrast styling, and `150 s` backup master: [`docs/VIDEO_PRODUCTION.md`](VIDEO_PRODUCTION.md)
- Ray-Ban Display `600x600` `#000000` waveguide rules and Neural Band gestures: [`docs/HUD_SPEC.md`](HUD_SPEC.md)
- Printable A4 stage prop wraps, GS1 EAN-13 / Code-128 barcodes, and zero-PII pharmacy QR: [`docs/printable-props.html`](printable-props.html)
- Measured benchmark artifacts and deterministic safety invariants: [`docs/EVAL.md`](EVAL.md) and [`eval/combined_summary.json`](../eval/combined_summary.json)

Every quantitative figure cited in this storyboard is read directly from committed `eval/*.json` artifacts with zero estimated or unmeasured numbers.

---

## 1. Split-Screen Visual Canvas, `#000000` `/hud` Inset & Open-Ear HFP Caption Spec

Both the `90 s` recorded cut and the `180 s` live stage projection synchronize three visual surfaces with open-ear Bluetooth HFP audio and burned-in WCAG 2.2 AAA open captions (`1920x1080` @ `60 fps`):

```text
0                                      1152                             1920
+--------------------------------------+----------------------------------+ 0
|  PANE A: FIRST-PERSON RAY-BAN META   | PANE B: 600x600 #000000 /hud     |
|  POV (1152 x 1080, Left 60%)         | WAVEGUIDE INSET (768 x 540)      |
|                                      |                                  |
|  - DAT 1.0.1 720x1280 stream or      |  - Pure #000000 additive canvas  |
|    temple-level 60fps POV camera     |    (= optically transparent)     |
|  - Front hardware capture LED ON     |  - 540x540 1:1 square inset with |
|    verified via mirror check         |    114px #000000 side margins    |
|  - Hands hold Props 1..4 + 25 mm     |  - <= 65% verdict fill budget,   |
|    holdup://rx pharmacy QR sticker   |    <= 35% CoachCue, <= 8 words   |
|    inside safe zone y=70..880        |  - 4-channel shape+icon+badge    |
|                                      +----------------------------------+ 540
|  +--------------------------------+  | PANE C: PHONE / LAPTOP PWA       |
|  | OPEN-EAR HFP BURNED CAPTIONS   |  | TELEMETRY (768 x 540)            |
|  | 95% #000000 box, #FFFFFF bold, |  |  - VerdictCard [0,1] meters      |
|  | >= 10.5:1 contrast over white  |  |    (STRENGTH_MIN_CONF = 0.80)    |
|  | cartons, <= 2 lines, <= 42 ch  |  |  - DeviceResiliencePanel RTT,    |
|  +--------------------------------+  |    Transport, Eye & HUD status   |
+--------------------------------------+----------------------------------+ 1080
```

| Channel | Runtime / Hardware Source | Optical & Accessibility Invariants |
|---|---|---|
| **Pane A: First-Person Ray-Ban Meta POV** | **Ray-Ban Meta Gen 2** (`firmware V128+`) via `android-dat/` (`mwdat-core` & `mwdat-camera` `1.0.1` -> `POST /ingest/frame` throttled to `<= 1.0 fps`, `>= 900 ms`) or temple-mounted `1080p60` POV camera for split-screen video. | Front hardware capture LED locked ON in firmware whenever streaming; hands and printable cartons stay inside `y=70..880`; zero bystander faces (`bystander_privacy_results.json`: `0` leaks across `8/8` canary scenes). |
| **Pane B: `600x600` `#000000` `/hud` Waveguide Inset** | **Meta Ray-Ban Display** (`https://<host>/hud` connected via `/hud-ws` `floatingHuds` zero-code attach) + **Meta Neural Band** (`ArrowLeft`/`ArrowRight` focus, `Enter` index-thumb pinch with `150 ms` debounce). | Pure `#000000` background emits zero waveguide light; card area `<= 65%` (`CoachCue <= 35%`); headline `<= 8` words (`clampHeadline`); 4-channel redundant encoding: `Circle` `#00E676` `MATCH`, `Triangle` `#FF5252` `WARNING`, `Diamond` `#FFD600` `UNSURE`, `Square` `#38BDF8` `INFO`; history depth `<= 2` (`<= 5` OS cap). |
| **Pane C: Phone / Laptop React 19 PWA** | `web/` (`/` route at `125%` zoom) showing `VerdictCard`, `ConfidenceBreakdownCard`, and `DeviceResiliencePanel`. | WCAG 2.2 AA (`dark` / `light` / `high-contrast`), dual-slot ARIA live announcer, screen-reader `<meter min=0 max=100 low=60 high=80 optimum=95>` per extracted field, local-only `localStorage` (`holdup.*`). |
| **Open-Ear Bluetooth HFP Audio & Open Captions** | Bluetooth HFP temple mic (`16 kHz` PCM16 uplink) + open-ear speakers (`24 kHz` `gemini-3.8-live` downlink + Web Audio earcons: `camera_on` `440 -> 659 Hz`, `checking`, `camera_off`). | Zero background music (`>= 20 dB` foreground speech margin), EBU R128 `-16 LUFS` normalization, burned-in captions on `95%` `#000000` box (`>= 10.5:1` contrast over sunlit white boxes), `<= 2` lines, `<= 42` chars/line, explicit `[Presenter]`, `[HoldUp]`, and `[Earcon]` tags. |

---

## 2. Second-by-Second `90-Second` (`00:00 - 01:30`) Submission Video Cut

Tight, high-retention `90.0 s` edit covering the everyday problem, consent/privacy, real-time physical coaching, multi-frame Gemini Flash verification, three deterministic safety catches, offline/hardware fault recovery, and measured `eval/*.json` proof.

### 2.1 Master `90-Second` Shot-by-Shot Choreography (`00:00` to `01:30`)

| Time (`s`) | Pane A: First-Person Ray-Ban Meta POV | Pane B: `600x600` `#000000` `/hud` Inset | Pane C: Phone PWA & Open-Ear HFP Captions | Measured Runtime & `eval/*.json` Proof |
|---|---|---|---|---|
| **`00:00 - 00:08`** (`8 s`) **Shot 1: Everyday Hook** | Wearer holds a glass of water in left hand; right hand touches three look-alike white Nordic cartons (`Prop 1`, `Prop 2`, `Prop 3` from `printable-props.html`). Puts on Ray-Ban Meta glasses (`both hands free`). | Pure `#000000` transparent standby (`0%` lit fill; unobstructed forward sight). | PWA `Ready to check`.<br>**HFP / Caption:** `[Presenter] For 2.2B low-vision adults, identical white pill boxes need 3 hands with phone OCR. Glasses leave hands free.` | Establishes chest-height natural POV vs 3-hand smartphone OCR roulette. |
| **`00:08 - 00:16`** (`8 s`) **Shot 2: Consent & Zero-PII `holdup://rx` Profile** | Right hand points briefly to the `25 mm` Braille-clear `holdup://rx` pharmacy QR sticker (`Yliopiston Apteekki`, EAN `6432100012345`), then rests by `Prop 1`. | Pure `#000000` standby; corner dot confirms `/hud-ws` zero-code `floatingHuds` link (`HUD connected`). | `ConsentOnboarding` -> tap `I Understand`; profile shows `3` meds, `avoid: NSAIDs`, `peanut`/`tree nut` allergy in `localStorage`.<br>**HFP / Caption:** `[Presenter] Active check only, 45s auto-stop, 8-frame RAM ring, local profile via zero-PII pharmacy QR.` | `IDLE_STOP_MS = 45000`; `FrameRing(8)` cleared on close; `/hud` writes `0 B` storage. |
| **`00:16 - 00:24`** (`8 s`) **Shot 3: Active Check & Capture LED Proof** | Tap temple / press `Space`. `1.5 s` mirror angle confirms front **hardware capture LED is ON**. Right hand lifts **Prop 1 (*Amlodipin 5 mg*) backwards** showing rear barcode `6432100012345`. | Status dot pulses -> compact `CoachCue` box (`<= 35%` area) prepares on `#000000`. | `Eye: Glasses DAT`, `CAMERA ON` banner.<br>**HFP / Caption:** `[Earcon: camera on 440->659 Hz]`<br>`[Presenter] Capture LED is on. Is this my evening pill?` | `live_models_probe.json`: `gemini-3.8-live` WS connect `706.0 ms`, first audio `582.0 ms`. |
| **`00:24 - 00:34`** (`10 s`) **Shot 4: Live Body-Relative Coaching (`show_cue`)** | `gemini-3.8-live` sees rear barcode panel (`back_of_box`), refuses to guess drug name, and speaks cue. Wearer flips `Prop 1` 180 degrees to crisp front label `Amlodipin 5 mg` (`EXP 08/2027`) and holds steady. | `CoachCue`: **`Turn it around`** -> **`Hold still, reading...`** (`#FFFFFF` bold on `#000000`, `<= 35%` fill). | Live transcript streams coaching cue; `FrameRing(8)` buffers post-flip sharp frame (`sharpness 0.2830 > 0.2738`).<br>**HFP / Caption:** `[HoldUp] Turn it around, the label is on the other side.` | `coaching_eval.json` (`back_of_box`): `5/5`; `coaching_trajectories.json`: `4/4` (`100.0%`) sharp post-coaching frame picked first. |
| **`00:34 - 00:44`** (`10 s`) **Shot 5: Multi-Frame `MATCH` & Neural Band `Log Dose`** | Wearer holds `Prop 1` steady (`1 s`), hears spoken confirmation, then performs **Neural Band** thumb-swipe (`ArrowRight` to `Log Dose`) + index-pinch (`Enter`). | Emerald **Circle** `#00E676` `MATCH` (`<= 65%` fill): **`Yes: Amlodipine 5 mg, your evening pill`**. Focus ring (`4px #FFFFFF`) moves `Repeat` -> `Log Dose` -> `Log Dose` hides, `Taken today` chip appears. | `VerdictCard` `MATCH`: `strength: 5 mg` (`0.99 >= 0.80` gate) -> `doseLog` records `aml` (`1/1 today`).<br>**HFP / Caption:** `[Earcon: check complete]` `[HoldUp] Yes, Amlodipine 5 mg, your evening pill. Not taken today.` -> `[HoldUp] Logged your Amlodipine dose.` | `demo_fixtures_results.json` (`amlodipine_match`): `0.99` strength conf, `3817.2 ms`; `coaching_eval.json` (`dose_log_request`): `5/5`. |
| **`00:44 - 00:52`** (`8 s`) **Shot 6: Catch 1 - Nordic NSAID Contraindication** | Wearer sets down `Prop 1` and holds up look-alike **Prop 2 (*Burana 400 mg*, `ibuprofeeni / ibuprofen`)**. | Coral-red **Triangle** `#FF5252` `WARNING`: **`Ibuprofen 400 mg: not on your list`** (`Log Dose` hidden; focus stays safely on `Repeat`). | `VerdictCard` `WARNING`: maps Finnish brand `Burana` -> `ibuprofen` -> `NSAID` avoid rule.<br>**HFP / Caption:** `[Presenter] Can I take this for a headache?`<br>`[HoldUp] Warning: Ibuprofen 400 mg. Not on your list, and avoid NSAIDs.` | `demo_fixtures_results.json` (`ibuprofen_nsaid`): `3414.3 ms`; `polypharmacy_confusion_results.json`: `10/10` (`100.0%`) catches. |
| **`00:52 - 01:00`** (`8 s`) **Shot 7: Catch 2 - Covered Dose (`0.80` Never-Guess Gate)** | Wearer holds **Prop 1** with **thumb covering `"5 mg"`** on front panel. | Vivid amber **Diamond** `#FFD600` `UNSURE` (dashed border): **`Amlodipine: strength unclear`**. | `ConfidenceBreakdownCard` flags `strength` `< 0.80` (`0.20`): `Dose never guessed`.<br>**HFP / Caption:** `[Presenter] What if my thumb covers the mg?`<br>`[HoldUp] Looks like Amlodipine, strength unclear. Check with a pharmacist.` | `calibration_curve.json`: `ECE = 0.0138`, `Brier = 0.0005`, `100.0%` unreadable abstention, `0` confident-wrong doses at `0.80`. |
| **`01:00 - 01:08`** (`8 s`) **Shot 8: Catch 3 - Hidden Food Allergen Synonym** | Wearer holds up **Prop 4 (*Nordic Oat & Hazelnut Bar*, `roasted hazelnuts 12%, arachis oil`)**. | Coral-red **Triangle** `#FF5252` `WARNING`: **`Warning: contains hazelnut`**. | `VerdictCard` `WARNING`: flags `hazelnuts` (`tree nuts`) + `arachis oil` (`peanut` synonym).<br>**HFP / Caption:** `[Presenter] Does this bar have nuts?`<br>`[HoldUp] Warning: contains hazelnuts and arachis oil, peanut allergy.` | `results_batch2.json` (`18/18`) & `multilingual_labels_results.json` (`12/12` across `6` languages): `100.0%` allergen recall, `0` false-safe. |
| **`01:08 - 01:15`** (`7 s`) **Shot 9: Fault 1 - WS Drop & Offline Barcode Match** | Toggle `WS Drop` -> `Force Offline`; hold rear of **Prop 1 (`6432100012345`)** to run on-device `BarcodeDetector`. | Corner pill `RECONNECTING` -> local double-dose `WARNING` (`Amlodipine 5 mg: already taken today`). | `Transport: LIVE -> SNAPSHOT (38.67 KB) -> OFFLINE (0.00 KB)`; catches duplicate dose offline.<br>**HFP / Caption:** `[Presenter] Wi-Fi off: Snapshot, then 0 KB local EAN match catches double dose.` | `unit_economics.json`: adaptive saves `84.0%` video bytes (`724.64 -> 116.02 KB`), Snapshot `38.67 KB`, Offline `0.00 KB`. |
| **`01:15 - 01:21`** (`6 s`) **Shot 10: Fault 2 - Glasses Doffed Hot-Swap** | Restore Wi-Fi; wearer lifts **Ray-Ban Meta glasses off head** (`!worn`) and holds `Prop 3` (*Metformin 500 mg*, `EXP 04/2025`) toward phone camera. | `Hub.replay` restores `/hud` state; `Triangle` `#FF5252` `WARNING`: **`Metformin 500 mg: expired`**. | `DAT !worn` hot-swaps `Eye: Glasses DAT -> Phone Camera` mid-session; catches `EXP 04/2025`.<br>**HFP / Caption:** `[Presenter] Glasses off: hot-swaps to phone cam and catches expired Metformin.` | `demo_fixtures_results.json` (`expired_med`): `2538.6 ms`; zero session or `localStorage` loss on eye handoff. |
| **`01:21 - 01:26`** (`5 s`) **Shot 11: Measured Safety & Privacy Proof** | Clean tabletop shot of Ray-Ban Meta Gen 2, Ray-Ban Display, Neural Band, and 4 printable props. | Emerald **Circle** `#00E676` `MATCH` card cleanly framed on `#000000`. | `EvalProofCard` overlay.<br>**HFP / Caption:** `[Presenter] 98.1% verdict match (52/53), 0 wrong doses, 8/8 coaching & bystander privacy.` | `combined_summary.json`: `52/53` (`98.1%`), `0` confident-wrong doses, verify `p50 = 3537.1 ms`, coaching `8/8` (`5.0/5`). |
| **`01:26 - 01:30`** (`4 s`) **Shot 12: 91.8% TCO Savings & Helsinki Pilot Close** | Wearer holds up `Prop 1` (`Amlodipin 5 mg`) at chest height and nods. | Pure `#000000` waveguide fades cleanly after `MATCH` confirmation. | Title lockup: `HoldUp: Hold it up. Know it is the right one.`<br>**HFP / Caption:** `[Presenter] EUR 341.68 3-yr TCO, 91.8% under OrCam. Ready for Helsinki pilot.` | `unit_economics.json`: `EUR 341.68` vs `EUR 4,150.00` (`91.8%` lower, `12.1x` reduction, `EUR 0.00294`/check). |

### 2.2 Ready-to-Save `captions_90s.srt` (`01:30` Submission Cut)

UTF-8, `<= 2` lines per cue, `<= 42` characters per line, zero overlapping timecodes:

```srt
1
00:00:00,200 --> 00:00:07,800
[Presenter] Identical white pill boxes:
phone OCR needs 3 hands; glasses need 0.

2
00:00:08,100 --> 00:00:15,800
[Presenter] 45s active-only camera, 8-slot
RAM ring, zero-PII pharmacy QR on device.

3
00:00:16,100 --> 00:00:23,800
[Earcon: camera on] [Presenter] Capture
LED is on. Is this my evening pill?

4
00:00:24,100 --> 00:00:33,800
[HoldUp] Turn it around, the label is on
the other side. Hold still, reading...

5
00:00:34,100 --> 00:00:40,200
[Earcon: check complete] [HoldUp] Yes,
Amlodipine 5 mg, your evening pill.

6
00:00:40,400 --> 00:00:43,800
[HoldUp] Logged your Amlodipine dose.
Taken today guard is now active.

7
00:00:44,100 --> 00:00:51,800
[HoldUp] Warning: Ibuprofen 400 mg. Not
on your list, and profile avoids NSAIDs.

8
00:00:52,100 --> 00:00:59,800
[HoldUp] Looks like Amlodipine, strength
unclear (<80% gate). Ask a pharmacist.

9
00:01:00,100 --> 00:01:07,800
[HoldUp] Warning: contains hazelnuts and
arachis oil. Matches your nut allergy.

10
00:01:08,100 --> 00:01:14,800
[Presenter] Wi-Fi off: Snapshot, then 0 KB
offline EAN match catches double dose.

11
00:01:15,100 --> 00:01:20,800
[Presenter] Glasses off: hot-swaps to
phone cam and flags expired Metformin.

12
00:01:21,100 --> 00:01:25,800
[Presenter] 98.1% match (52/53), 0 wrong
doses at 0.80 gate, 8/8 privacy checks.

13
00:01:26,100 --> 00:01:29,800
[Presenter] EUR 341.68 3-yr TCO (-91.8%).
HoldUp: hold it up, know it is right.
```

### 2.3 `90-Second` `ffmpeg` Render Command (`< 48 MB` MP4)

Uses the exact 3-pane compositor from [`docs/VIDEO_PRODUCTION.md`](VIDEO_PRODUCTION.md) with `DURATION="90"` (nominal output size `~40.4 MB` at `3400 kbps` video + `192 kbps` `AAC-LC` audio):

```bash
DURATION="90"
ffmpeg -y \
  -ss "00:00:00.000" -i pov_raw.mp4 \
  -ss "00:00:00.000" -i hud_raw.mp4 \
  -ss "00:00:00.000" -i pwa_raw.mp4 \
  -ss "00:00:00.000" -i audio_master.wav \
  -t "$DURATION" \
  -filter_complex "\
    color=c=black:s=1920x1080:r=60:d=90[base]; \
    [0:v]fps=60,setpts=PTS-STARTPTS,scale=1152:1080:force_original_aspect_ratio=increase,crop=1152:1080,setsar=1[pov]; \
    [1:v]fps=60,setpts=PTS-STARTPTS,scale=540:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[hud]; \
    [2:v]fps=60,setpts=PTS-STARTPTS,scale=768:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=0x0B0F17,setsar=1[pwa]; \
    [base][pov]overlay=x=0:y=0:shortest=1[v1]; \
    [v1][hud]overlay=x=1152:y=0[v2]; \
    [v2][pwa]overlay=x=1152:y=540[v3]; \
    [v3]drawbox=x=1151:y=0:w=2:h=1080:color=0x2C3A52@1.0:t=fill,\
        drawbox=x=1152:y=539:w=768:h=2:color=0x2C3A52@1.0:t=fill,\
        subtitles=filename=captions_90s.srt:force_style='FontName=Sans,FontSize=11,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H0D000000,BackColour=&H0D000000,BorderStyle=3,Outline=3,Shadow=0,MarginL=8,MarginR=162,MarginV=10,Alignment=2'[vout]; \
    [3:a]asetpts=PTS-STARTPTS,highpass=f=80,lowpass=f=14000,acompressor=threshold=-18dB:ratio=3:attack=10:release=120:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -profile:v high -level:v 4.2 -pix_fmt yuv420p \
  -r 60 -g 120 -bf 2 -b:v 3400k -maxrate 3800k -bufsize 7600k \
  -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart \
  holdup_submission_90s_1080p60.mp4
```

---

## 3. Second-by-Second `3-Minute` (`00:00 - 03:00`) Live Stage Split-Screen Choreography

Synchronized stage choreography for **Silas** (presenter), **Momin010** (Ray-Ban Meta DAT bridge & Ray-Ban Display `/hud`), **ivarakerholm-wq** (prop tray & accessibility check), and **Chintufp** (split-screen stage projector & hard timer), expanding the 6 stage acts in [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md) into **18 continuous sub-beats** (`00:00` to `03:00`).

### 3.1 Full `180-Second` Stage Choreography (`00:00` to `03:00`)

| Stage Window | Act & Crew Cue | First-Person Ray-Ban Meta POV (`Pane A`) | `600x600` `#000000` `/hud` Waveguide Inset (`Pane B`) | Phone PWA (`Pane C`) & Open-Ear HFP / Stage Captions |
|---|---|---|---|---|
| **`0:00 - 0:10`** (`10 s`) | **Act 1a: Audience & Problem** (`Silas`) | Silas stands behind matte tray with 3 white pharmacy cartons (`Prop 1`, `Prop 2`, `Prop 3`), holding water glass in left hand. | Pure `#000000` transparent standby (`0%` lit pixels). | `ConsentOnboarding` (`v2026-11`) ready.<br>**HFP / Caption:** `[Silas] 2.2 billion people live with vision impairment, ~80,000 in Finland, >80% aged 65+.` |
| **`0:10 - 0:20`** (`10 s`) | **Act 1b: Why Glasses Beat Phone OCR** (`Silas`) | Right hand rotates `Prop 1` at chest height while left hand holds water glass (`zero third hand for phone`). | Pure `#000000` standby; `HUD Connected` verified via `/hud-ws`. | `DeviceResiliencePanel` shows `Ray-Ban Glasses: Connected / Worn`.<br>**HFP / Caption:** `[Silas] Phone OCR needs 3 hands. Meta AI Glasses already point where your hands hold the box.` |
| **`0:20 - 0:30`** (`10 s`) | **Act 2a: Explicit Consent & RAM-Only Privacy** (`Silas`) | Silas taps `I Understand, Continue to HoldUp` (`Space` / click). | `#000000` standby (`0 B` written to glasses storage). | Consent card highlights `45s` auto-stop & `8`-frame RAM `FrameRing`.<br>**HFP / Caption:** `[Silas] Camera runs only on active check, auto-stops at 45s, and keeps frames in an 8-slot RAM ring only.` |
| **`0:30 - 0:40`** (`10 s`) | **Act 2b: Local `holdup://rx` Profile** (`ivarakerholm-wq` / `Silas`) | Points to `25 mm` `holdup://rx` QR sticker (`Yliopiston Apteekki Helsinki`) on Sheet 2 prop card. | `#000000` standby. | Profile badge: `3 Meds` (`Amlodipin 5 mg`, `Metformin 500 mg`, `Panadol 500 mg`), `avoid: NSAIDs`, `peanut`/`tree nut` allergy.<br>**HFP / Caption:** `[Silas] Prescriptions and allergies stay in phone localStorage via zero-PII pharmacy QR, with 1-tap wipe.` |
| **`0:40 - 0:52`** (`12 s`) | **Act 3a: Start Active Check & Rear-Box Pickup** (`Momin010` + `Silas`) | Momin010/Silas starts stream; front **hardware capture LED turns ON**. Silas lifts **Prop 1 backwards** (rear barcode `6432100012345` facing glasses). | Corner status dot -> ready for live `CoachCue` (`<= 35%` viewport). | `Eye: Glasses DAT`, `CAMERA ON` banner.<br>**HFP / Caption:** `[Earcon: camera on 440->659 Hz]`<br>`[Silas] Is this my evening pill?` |
| **`0:52 - 1:06`** (`14 s`) | **Act 3b: Streaming Body-Relative Coaching** (`gemini-3.8-live`) | `gemini-3.8-live` (`582.0 ms` first-audio capability) calls `show_cue` without guessing dose. Silas flips `Prop 1` to front `Amlodipin 5 mg` label. | `CoachCue` on `#000000`: **`Turn it around`** -> **`Hold still, reading...`**. | Live transcript renders coaching cue; `FrameRing(8)` ranks sharpest post-flip frames (`pick(2)`).<br>**HFP / Caption:** `[HoldUp] Turn it around, the label is on the other side.` |
| **`1:06 - 1:24`** (`18 s`) | **Act 3c: Multi-Frame `verify_label` -> `MATCH`** (`gemini-3.8-flash` + `safety.ts`) | Holds front of `Prop 1` (`Amlodipin 5 mg`, `EXP 08/2027`) steady for `verify_label` (`p50 = 3537.1 ms`). | Emerald **Circle** `#00E676` `MATCH` (`<= 65%` fill, `<= 8` words): **`Yes: Amlodipine 5 mg, your evening pill`**. Default focus on `Repeat`. | `VerdictCard` `MATCH` + `ConfidenceBreakdownCard` (`product 0.99`, `ingredient 0.99`, `strength 0.99 >= 0.80`).<br>**HFP / Caption:** `[Earcon: check complete]` `[HoldUp] Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today.` |
| **`1:24 - 1:40`** (`16 s`) | **Act 3d: Neural Band / Voice `Log Dose`** (`Silas`) | Silas swipes **Neural Band** (`ArrowRight` -> `Log Dose`) and index-pinches (`Enter`), or says *"I took it, please log it."* | `4px #FFFFFF` focus ring selects `Log Dose` -> `Log Dose` button disappears -> **`Taken today`** badge renders. | `doseLog` updates `0/1 -> 1/1` in `localStorage`; double-dose guard armed.<br>**HFP / Caption:** `[Silas] I took it, please log it.`<br>`[HoldUp] Logged your Amlodipine dose.` |
| **`1:40 - 1:50`** (`10 s`) | **Act 4a: Safety Catch 1 - Nordic NSAID (`Burana 400 mg`)** (`Silas`) | Picks up **Prop 2 (*Burana 400 mg*, `ibuprofeeni / ibuprofen`, barcode `6412345000400`)**. | Coral-red **Triangle** `#FF5252` `WARNING`: **`Ibuprofen 400 mg: not on your list`** (`Log Dose` suppressed). | `VerdictCard` `WARNING`: resolves Finnish brand `Burana` -> `ibuprofen` -> `NSAID` avoid rule.<br>**HFP / Caption:** `[Silas] Can I take this for a headache?`<br>`[HoldUp] This is Ibuprofen 400 mg. Not on your list, and your list says to avoid NSAIDs.` |
| **`1:50 - 2:00`** (`10 s`) | **Act 4b: Safety Catch 2 - Thumb-Occluded Strength** (`Silas`) | Holds **Prop 1** with **thumb covering `"5 mg"`** on the front label. | Vivid amber **Diamond** `#FFD600` `UNSURE` (dashed border): **`Amlodipine: strength unclear`**. | `ConfidenceBreakdownCard` highlights `strength < 0.80` (`STRENGTH_MIN_CONF = 0.80` zero-guess gate).<br>**HFP / Caption:** `[Silas] What if my thumb covers 5 mg?`<br>`[HoldUp] It looks like Amlodipine, but I can't read the strength confidently. Check with a pharmacist.` |
| **`2:00 - 2:10`** (`10 s`) | **Act 4c: Safety Catch 3 - Hidden Allergen Synonym** (`Silas`) | Holds **Prop 4 (*Nordic Oat & Hazelnut Bar*, `hazelnuts 12%, arachis oil`, barcode `7310100555111`)**. | Coral-red **Triangle** `#FF5252` `WARNING`: **`Warning: contains hazelnut`**. | `VerdictCard` `WARNING`: flags both `hazelnuts` (`tree nuts`) and `arachis oil` (`peanut` synonym).<br>**HFP / Caption:** `[Silas] Does this snack have nuts?`<br>`[HoldUp] Warning: contains hazelnuts and arachis oil, matching your nut allergy.` |
| **`2:10 - 2:18`** (`8 s`) | **Act 5a: Fault 1 - Live WebSocket Drop** (`Chintufp` + `Silas`) | Toggle `Simulate Live WS Drop` in `DeviceResiliencePanel`. | Corner pill shows `RECONNECTING` (`500 -> 5000 ms` backoff) without blocking waveguide view. | `Transport Mode: LIVE -> SNAPSHOT` (`POST /api/verify` = `38.67 KB` + TTS + `sessionResumption`).<br>**HFP / Caption:** `[Silas] Drop the Live WebSocket: HoldUp degrades immediately to HTTP Snapshot + TTS mode.` |
| **`2:18 - 2:27`** (`9 s`) | **Act 5b: Fault 2 - Complete Offline EAN Match** (`Chintufp` + `Silas`) | Toggle `Simulate Complete Offline`; scan rear of **Prop 1 (`6432100012345`)** (`B` key / `BarcodeDetector`). | Offline double-dose `WARNING` (`Amlodipine 5 mg: already taken today`). | `Transport Mode: OFFLINE` (`0.00 KB` network); matches `6432100012345` in `localStorage` and catches duplicate dose.<br>**HFP / Caption:** `[Silas] Kill Wi-Fi completely: local BarcodeDetector matches EAN 6432100012345 at 0 KB and blocks a double dose.` |
| **`2:27 - 2:35`** (`8 s`) | **Act 5c: Fault 3 - Glasses Doffed Hot-Swap** (`Momin010` + `Silas`) | Clear fault toggles; Silas **takes Ray-Ban Meta glasses off** (`!worn` via `/ingest/state`). | `Hub.replay` syncs `device.worn: false` cleanly onto `/hud`. | Announces transition aloud; hot-swaps `Eye: Glasses DAT -> Phone Camera` mid-session with zero state loss.<br>**HFP / Caption:** `[Silas] Take the glasses off: DAT state switches my active eye to the phone camera mid-session.` |
| **`2:35 - 2:44`** (`9 s`) | **Act 6a: Measured Accuracy & Calibration Proof** (`Chintufp` + `Silas`) | Silas holds Ray-Ban Meta Gen 2 & Ray-Ban Display at chest height beside the prop tray. | Clean `#000000` standby or final `MATCH` summary card. | Stage screen highlights `EvalProofCard` (`52/53` = `98.1%`, `0` wrong doses, `ECE = 0.0138`).<br>**HFP / Caption:** `[Silas] Across 53 core checks plus stress suites: 0 confident-wrong doses at our 0.80 gate, ECE 0.0138.` |
| **`2:44 - 2:52`** (`8 s`) | **Act 6b: Coaching, Privacy & 91.8% TCO Advantage** (`Silas`) | Gesture to glasses front capture LED and waveguide lens. | `#000000` transparent waveguide. | Displays `8/8` coaching/privacy pass (`2574.8 ms` face refusal) & `EUR 341.68` vs `EUR 4,150.00` TCO.<br>**HFP / Caption:** `[Silas] 8/8 coaching and bystander face refusal passed, and EUR 341.68 3-year TCO saves 91.8% vs OrCam.` |
| **`2:52 - 3:00`** (`8 s`) | **Act 6c: EU MDR Boundary & Helsinki Pilot Close** (`Silas`) | Lifts `Prop 1` (`Amlodipin 5 mg`) once at chest height for final pose at `02:58`. | Pure `#000000` standby. | Closing banner: `12-Week Helsinki Pilot (N = 24) - Nakovammaisten liitto + Yliopiston Apteekki QR`.<br>**HFP / Caption:** `[Silas] Inside the EU MDR assistive boundary, ready for our 12-week Helsinki pilot. Hold it up. Know it is the right one.` |

### 3.2 Stage Clock Checkpoints & Drift Guardrails (`Chintufp` Timer)

| Stage Clock | Expected Position | If `> 8 s` Behind Schedule |
|---|---|---|
| **`00:40`** | Entering Act 3a (`Start Check` on `Prop 1`) | Skip spoken list of all 3 profile meds in Act 2b; point to profile badge and trigger `Space` immediately. |
| **`01:40`** | Dose logged; entering Act 4a (`Prop 2: Burana 400 mg`) | Run Beat 4a (`Burana` NSAID) + Beat 4b (`thumb over 5 mg`) live (`16 s` total) and reference `Prop 4` hazelnut catch verbally while advancing to Act 5. |
| **`02:35`** | Fault drills complete; entering Act 6a (`Measured Proof`) | Deliver the 25-second closing summary verbatim so speech lands cleanly at `02:58` before the `03:00` hard horn. |

---

## 4. Verified Metrics Ledger Cited in Video & Stage Choreography (`eval/*.json`)

Every number spoken on stage or shown in open captions and overlays maps 1-to-1 to a committed `eval/*.json` artifact:

| Metric Cited in Video / Stage | Exact Value | Source Artifact & Key |
|---|---|---|
| Never-guess medication strength confidence gate | `0.80` (`STRENGTH_MIN_CONF`), name `0.60`, allergen `0.60`, expiry `0.70` | `eval/combined_summary.json` -> `safety_invariants` |
| Core 4-suite label verdict accuracy | `98.1%` (`52 / 53` matched), `100.0%` clean field accuracy, `98.2%` (`0.9815`) occluded abstention | `eval/combined_summary.json` -> `overall_verdict_accuracy`, `clean_field_accuracy`, `occluded_abstention_rate` |
| Confident-wrong medication dose count | `0` across `53` core label checks, `16` calibration reads, `36` 3-model probe calls, and all stress suites | `eval/combined_summary.json` -> `total_confident_wrong_dose_count`; `eval/calibration_curve.json`; `eval/model_comparison.json` |
| False-safe food allergen count | `0` (`100.0%` allergen recall across `results_batch2`, `nordic_stickers_results`, and `multilingual_labels_results`) | `eval/combined_summary.json` -> `total_false_safe_allergen_count`; `eval/multilingual_labels_results.json` |
| End-to-end `verify_label` latency (`gemini-3.8-flash`) | `p50 = 3537.1 ms`, `p95 = 5638.1 ms`, `mean = 3657.8 ms` (`demo_fixtures_results.json`: `7/7`, `p50 = 3817.2 ms`) | `eval/combined_summary.json` -> `verify_latency_ms`; `eval/demo_fixtures_results.json` |
| Strength confidence calibration (`16` degraded frames) | `ECE = 0.0138`, `Brier = 0.0005`, `100.0%` unreadable abstention at `0.80` (`tier_0 = 0.9875`, `tier_1 = 0.9575`, `tier_2 = 0.0`, `tier_3 = 0.0`) | `eval/calibration_curve.json` -> `ece`, `brier_score`, `mean_strength_confidence_by_tier` |
| Gemini Live WebSocket connect & first-audio latency | Primary `gemini-3.8-live`: `706.0 ms` connect, **`582.0 ms` first audio**; fallback `gemini-3.1-flash-live-preview`: `222.0 ms` connect, `489.0 ms` first audio (`3/3` Live models reachable) | `eval/live_models_probe.json` -> `primary_connect_ms`, `primary_first_audio_ms`, `models` |
| 3-Model Flash verify fallback chain (`36` calls) | `12/12` (`100.0%`) verdict accuracy & `0` confident-wrong doses on `gemini-3.8-flash` (`p50 3530.9 ms`), `gemini-3.5-flash` (`p50 1946.0 ms`), `gemini-3-flash-preview` (`p50 1310.4 ms`) | `eval/model_comparison.json` -> `models` |
| Coaching & bystander privacy LLM judge (`8` scenarios) | **`8 / 8` passed (`100.0%`)**, mean score **`5.0 / 5`**, assistant `p50 = 5118.3 ms`, direct bystander face refusal **`2574.8 ms`** (`"I only help with labels."`) | `eval/coaching_eval.json` -> `passed_all_checks`, `mean_overall_score`, `scenarios` |
| Two-stage `FrameRing(8)` coaching trajectories | `4 / 4` (`100.0%`) pre-coaching abstentions, `4 / 4` (`100.0%`) post-coaching sharp frame selected first & matched (`p50 = 3536.5 ms`, `0` wrong doses) | `eval/coaching_trajectories.json` -> `summary` |
| Bystander & background PII canary benchmark | `8 / 8` (`100.0%`) verdict accuracy, **`0` PII or bystander leaks** (`100.0%` privacy pass rate), `p50 = 4323.1 ms` | `eval/bystander_privacy_results.json` -> `summary` |
| Curved bottles, blister foil glare, lighting & motion sweeps | Curved/blister: `10 / 10` (`100.0%`, `p50 = 3987.5 ms`); lighting/motion (`3%..100%` luma, `24 px` blur): `12 / 12` (`100.0%`, `p50 = 3559.9 ms`); `0` wrong doses | `eval/curved_blister_results.json`; `eval/lighting_motion_results.json` |
| Multilingual European labels & polypharmacy traps | Multilingual (`fi, sv, de, fr, es, en`): `12 / 12` (`100.0%`, `p50 = 3249.6 ms`); polypharmacy (double-dose, LASA strength, `2,5 mg` comma decimal): `10 / 10` (`100.0%`, `p50 = 2978.4 ms`) | `eval/multilingual_labels_results.json`; `eval/polypharmacy_confusion_results.json`; `eval/nordic_stickers_results.json` (`10/10`) |
| Adaptive slow-Wi-Fi bandwidth & fallback payloads | Normal `1.0 fps` (`12 s`): `724.64 KB` video (`1,348.64 KB` total) -> Adaptive `0.5 fps` (`>650 ms` RTT): `116.02 KB` video (**`84.0%` video saved**, `740.02 KB` total = `45.1%` saved); Snapshot `38.67 KB`; Offline `0.00 KB` | `eval/unit_economics.json` -> `bandwidth_modes` |
| Inference unit cost & 3-year assistive TCO | **`EUR 0.00294` (`$0.00319`) / check** (`7,488` tokens), **`EUR 0.35 / mo`** (`EUR 4.23 / yr`, economy `EUR 2.48 / yr`, uncached ceiling `EUR 10.79 / yr`); **3-yr TCO `EUR 341.68` vs `EUR 4,150.00` OrCam midpoint (`91.8%` savings, `12.1x` reduction, `1,214` users per `100`-OrCam budget)** | `eval/unit_economics.json` -> `pricing_tiers`, `three_year_tco` |
