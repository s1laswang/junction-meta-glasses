# HoldUp Accessible Backup Demo Video Production & Open-Caption Guide (`docs/VIDEO_PRODUCTION.md`)

Production runbook for recording, synchronizing, compositing, open-captioning, and QA-auditing the **2m 30s (`150 s`)** HoldUp submission and backup demo video during **Hardware Test Slot 2 (`Sun 15 Nov 06:30-08:30` Helsinki time)** ahead of the `09:30` Junction upload target and `10:00` deadline ([`docs/PLAN.md`](PLAN.md), [`docs/DEMO_VIDEO_STORYBOARD.md`](DEMO_VIDEO_STORYBOARD.md), [`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md), [`docs/SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md)).

- **Crew ([`docs/PLAN.md`](PLAN.md), [`docs/TEAM.md`](TEAM.md))**:
  - **Momin010**: Ray-Ban Meta Gen 2 (`android-dat/` DAT SDK `1.0.1` camera + device state stream) and Ray-Ban Display (`/hud` Web App + Neural Band / touchpad).
  - **Chintufp**: First-person POV camera operator, laptop `/hud` + Phone PWA screen capture, sync check, and `ffmpeg` master render.
  - **Silas**: Live presenter, voiceover/dialogue pacing, final accessibility review, and Junction submission upload.
- **Master Deliverable Spec**:
  - **Container / Codec**: `.mp4` (`H.264` High@L4.2, `yuv420p`, `+faststart` progressive web atom) + `AAC-LC` stereo `48 kHz` (`192 kbps`).
  - **Canvas & Frame Rate**: `1920 x 1080` progressive @ `60 fps`, duration `02:30` (`150.0 s`).
  - **Upload Size Budget**: Nominal `67.35 MB` (`64.23 MiB`) at `3400 kbps` video + `192 kbps` audio; hard VBV ceiling `75.60 MB` (`72.10 MiB`, including `1%` MP4 muxing overhead) at `-maxrate 3800k`, staying strictly **`< 80 MB`** for fast Junction platform upload.
  - **Accessibility & Audio Verification**: High-contrast burned-in open captions (`>= 10.5:1` WCAG 2.2 AAA contrast even over white medicine boxes) paired with `-16 LUFS` broadcast-normalized speech, zero background music, open-ear spoken verdicts verified at **`16/16` (`5.0/5`)** clarity (`eval/spoken_verdict_clarity_results.json`), EN/FI/SV caregiver & wallet handoff copy verified at **`12/12` (`5.0/5`)** clarity (`eval/caregiver_handoff_results.json`), and companion `captions.srt` sidecar export.
  - **Benchmark & Bundle Baseline**: Every metric spoken or captioned in the `150 s` master comes from **`37` committed `eval/*.json` artifacts (`36` evaluation suites + `eval/combined_summary.json`)**, totaling **`276` real-model label reads across `25` label suites** with **`0` confident-wrong doses** at `STRENGTH_MIN_CONF = 0.80`, **`0` false-safe allergens**, **`2738.8 ms` glass-to-HUD `p50`**, **`662` passing automated tests** across `102` test files (`235` `server` + `395` `web` + `32` Python `eval/`), and a **`205.4 KB` (`205,403 B`) gzipped JS+CSS production bundle** (`eval/production_footprint.json`).

---

## 1. 3-Pane Split-Screen Compositing Layout (`1920x1080` @ `60fps`)

Judges must simultaneously see **what the wearer's hands hold in first person**, **what the in-lens Ray-Ban Display `/hud` projects**, and **how the Phone PWA (`205.4 KB` gzipped JS+CSS) verifies per-field confidence, tracks daily adherence, prepares caregiver/emergency handoff, and reacts to hardware/network state changes**.

### 1.1 Exact Pixel Grid (`1920 x 1080`)

```text
0                                      1152                             1920
+--------------------------------------+----------------------------------+ 0
|  [1ST-PERSON GLASSES POV (LED ON)]   | [RAY-BAN DISPLAY /hud (600x600)] |
|                                      |                                  |
|  PANE A: Left 60%                    |  PANE B: Top-Right 40%           |
|  1152 x 1080 (x=0, y=0)              |  768 x 540 (x=1152, y=0)         |
|                                      |  - Pure #000000 waveguide canvas |
|  - Wearer hands + 3 white pill boxes |  - 1:1 540x540 centered HUD card |
|    + 25 mm holdup://rx side-flap QR  |  - 114px #000000 side margins    |
|  - Ray-Ban Meta glasses + active     |    (zero aspect distortion)      |
|    front hardware capture LED view   |  - 2738.8 ms glass-to-HUD p50    |
|                                      +----------------------------------+ 540
|  Safe label action zone: y=70..880   | [PHONE PWA (CONFIDENCE + STATE)] |
|                                      |                                  |
|  +--------------------------------+  |  PANE C: Bottom-Right 40%        |
|  | Burned-In Open Captions (95%   |  |  768 x 540 (x=1152, y=540)       |
|  | #000000 box, #FFFFFF bold,     |  |  - VoiceActivityPill (barge-in)  |
|  | <= 2 lines, <= 42 chars/line,  |  |  - VerdictCard + 80% Dose Gate   |
|  | x=40..1110, y=935..1042)       |  |  - ScheduleChecklist & Caregiver |
|  +--------------------------------+  |  - DeviceResiliencePanel + Pilot |
+--------------------------------------+----------------------------------+ 1080
```

### 1.2 Per-Pane Capture & Framing Rules

| Pane | Geometry (`1920x1080`) | Source File | Required Visual Content & Framing Rules |
|---|---|---|---|
| **Pane A: Left 60% (Wearer POV + Glasses LED)** | `1152 x 1080` at `x=0, y=0` | `pov_raw.mp4` | First-person chest/temple-mounted action camera or phone (`1920x1080` @ `60fps` landscape) filming hands holding the three nearly identical white medicine boxes (`Amlodipin 5 mg` with side-flap `25 mm` `holdup://rx` QR, `Burana` / `Ibuprofen 400 mg`, strength-covered `Amlodipin` from [`docs/printable-props.html`](printable-props.html)). At `00:36` when DAT streaming starts (`HoldUp Bridge -> Start streaming`), include a `2 s` countertop mirror reflection or tight 45-degree angle proving the Ray-Ban Meta front **hardware capture LED** locks ON ([`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md) Section 5, [`docs/PRIVACY.md`](PRIVACY.md) Section 3). Keep hands and pill boxes inside `y=70..880` so top badge (`y=20..56`) and bottom open captions (`y=935..1042`) never cover printed box text or embossed Braille dots. |
| **Pane B: Top-Right 40% (Ray-Ban Display `/hud`)** | `768 x 540` at `x=1152, y=0` | `hud_raw.mp4` | Pure `#000000` additive-light waveguide view (`1.92 KB` gzipped `/hud` CSS in `eval/production_footprint.json`) from `http://localhost:5173/hud` (or `https://<tunnel>/hud` in the Chrome **Meta Ray-Ban Display Simulator** extension `jpjlmmodokemlepklkdbimceggpbjcll`, or `Meta AI -> Devices -> Record Display` per [`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md) Section 6.8). Scaled to `540x540` (`1:1` square) and centered on `#000000` (`114 px` left/right pillarbox) so the 4-channel multimodal badges (`Circle` `#00E676` `MATCH`, `Triangle` `#FF5252` `WARNING`, `Diamond` `#FFD600` `UNSURE`, `Square` `#38BDF8` `INFO`) keep true 1:1 geometry (`<= 65%` verdict fill, `<= 35%` `CoachCue`, `<= 8` headline words per [`docs/HUD_SPEC.md`](HUD_SPEC.md) Section 1.3). |
| **Pane C: Bottom-Right 40% (Phone PWA)** | `768 x 540` at `x=1152, y=540` | `pwa_raw.mp4` | Live React 19 PWA capture (`http://localhost:5173` or `https://<tunnel>`, `205.4 KB` gzipped JS+CSS bundle) stepping cleanly across the shipped Wave-9 surfaces: `WhyGlassesComparisonCard` (0-hand glasses vs 3-hand phone OCR & `EUR 341.68` vs `EUR 4,150.00` 3-yr TCO), `ConsentOnboarding` + `PilotOnboardingCard` (`4`-step loaner readiness) + `BrailleStickerGuardCard` (Art. 56a Braille-clear `25 mm` `holdup://rx` side flap & EAN-13 optical anchor), `VoiceActivityPill` (`MIC LISTENING` / `HOLDUP SPEAKING` + `Interrupt Speech` barge-in), `VerdictCard` + `ConfidenceBreakdownCard` (`0..100%` per-field `<meter>` bars + `80% Dose Gate: PASSED` / `BLOCKED < 80%` never-guess tick), `ScheduleChecklistCard` (*"Did I Take My Pills?"* daily checklist & `Dose Logged` duplicate-dose guard), `CaregiverAlertCard` (1-tap SMS/mailto Family Safety-Catch Alert) + `EmergencyMedCard` (`100%` on-device EN/FI/SV Emergency Medication & Allergy Wallet Card), and `DeviceResiliencePanel` (`Transport Mode`, `Network RTT`, `Camera Eye: Glasses DAT / Phone Camera`, `Ray-Ban Glasses: Connected / Worn / Battery`, `Ray-Ban Display HUD: Connected (/hud)`). **Legibility rule**: record the PWA in a `1152x810` or `768x540` responsive window at `125%` browser zoom so `ConfidenceBreakdownCard` bars, `ScheduleChecklistCard` pills, and RTT telemetry stay crisp at `>= 16 px` effective text height. |

### 1.3 Shipped Pane C Card Scroll Choreography

To avoid fast, disorienting scrolling in Pane C (`768x540`), park on one clean card group per beat (`<= 1` smooth scroll per beat transition):

| Beat Window | Active Pane C Card Focus | Key Visible UI States to Capture |
|---|---|---|
| **Beat 1 (`00:00 - 00:18`)** | `VerdictCard` (`Ready to check`) + `WhyGlassesComparisonCard` + `ScheduleChecklistCard` | `"Did I Take My Pills?"` (`Evening window`, `Due` badge on `Amlodipin 5 mg`) and `0 hands on device` vs `3-hand problem` comparison row. |
| **Beat 2 (`00:18 - 00:36`)** | `ConsentOnboarding` -> `PilotOnboardingCard` + `BrailleStickerGuardCard` | `01..03` consent guarantees (`45 s` auto-stop, `0` server storage, local wipe), `4/4` pilot readiness steps green, and SVG diagram showing embossed Braille front kept `100%` sticker-free while `25 mm` `holdup://rx` sits on the unembossed side flap. |
| **Beat 3 (`00:36 - 01:22`)** | `VoiceActivityPill` + `VerdictCard` + `ConfidenceBreakdownCard` + `ScheduleChecklistCard` | `MIC LISTENING` -> `HOLDUP SPEAKING` (`Interrupt Speech` barge-in button visible), `80% Dose Gate: PASSED (99%)` meter on `Strength: 5 mg`, and `"Did I Take My Pills?"` updating from `Due` to `Complete` (`Dose Logged` duplicate-dose guard active). |
| **Beat 4 (`01:22 - 01:52`)** | `VerdictCard` (`WARNING` / `UNSURE`) + `ConfidenceBreakdownCard` + `CaregiverAlertCard` + `EmergencyMedCard` | Double-border `WARNING` (`ibuprofen is an NSAID, on your avoid list`) with 1-tap SMS/mailto `HoldUp Safety Catch` in `CaregiverAlertCard` and `100% On-Device / Zero Cloud` `EmergencyMedCard`, followed by dashed `UNSURE` (`80% Dose Gate: BLOCKED` below `0.80` tick). |
| **Beat 5 (`01:52 - 02:12`)** | `DeviceResiliencePanel` + `VoiceActivityPill` (`OFFLINE LOCAL` -> `MIC LISTENING`) | `Transport Mode: LIVE -> SNAPSHOT -> OFFLINE` (`0.00 KB` `BarcodeDetector` match catching duplicate dose), `/hud-ws` `0.78 ms` `p50` reconnect (`50/50` flaps), and `Ray-Ban Glasses: Doffed` hot-swapping `Camera Eye: Glasses DAT -> Phone Camera`. |
| **Beat 6 (`02:12 - 02:30`)** | `EvalProofCard` + `PilotOnboardingCard` | Verified safety gates (`>= 80%` strength gate, `ECE = 0.0138`, `8/8` coaching/privacy judge) alongside Helsinki pilot readiness. |

### 1.4 Structural Dividers & Non-Occluding Overlays

- **Divider lines**: Because Pane B (`/hud`) uses pure `#000000` (`transparent waveguide`) and Pane C (`PWA`) uses `#0B0F17` / `#121926`, `ffmpeg` draws a `2 px` vertical divider at `x=1151` (`h=1080`) and a `2 px` horizontal divider at `y=539` (`x=1152..1920`) in slate `#2C3A52` (`tokens.css` `--border-subtle`).
- **Pane identification pills**: Compact top-left labels (`1ST-PERSON GLASSES POV (LED ON)`, `RAY-BAN DISPLAY /hud (600x600)`, `PHONE PWA (CONFIDENCE + TELEMETRY)`) orient judges within the first second of playback even if they scrub mid-video.

---

## 2. Video & Audio Accessibility Requirements

Because HoldUp is built for blind, low-vision, and older adults (`25%` UX & accessibility weight), the submission video itself meets strict visual, auditory, and captioning invariants:

1. **Burned-In High-Contrast Open Captions (`>= 10.5:1` Contrast)**:
   - Many judging laptops and hall projectors play muted or fail to enable `.srt` closed-caption tracks. Captions are **burned directly into the MP4 video stream** (open captions) AND uploaded alongside as `captions.srt` when the platform provides a subtitle slot.
   - **ASS Alpha Precision (`&HAABBGGRR`)**: In `libass`, the leading byte `AA` encodes **transparency** (`00` = `100%` opaque, `FF` = `0%` opaque). Our `force_style` sets `OutlineColour=&H0D000000,BackColour=&H0D000000,BorderStyle=3` (`95%` opaque pure black box behind `100%` opaque `#FFFFFF` bold sans-serif text). Even directly over a sunlit `255,255,255` white pill box, luminance contrast stays **`>= 10.5:1`** (exceeding WCAG 2.2 AAA `7:1`), and reaches **`19:1` to `21:1`** over normal scenes.
   - **Pane-Locked Placement (`PlayResX=384, PlayResY=288` SRT Virtual Grid)**: `ffmpeg`/`libass` maps `.srt` files onto a `384x288` virtual grid (`5.0x` horizontal scale, `3.75x` vertical scale at `1920x1080`). Setting `MarginL=8,MarginR=162,MarginV=10,Alignment=2,FontSize=11` locks captions to `x=40..1110` (centered at `x=575`, matching the `576 px` midpoint of the `1152 px` Left POV pane) at `41 px` rendered font size, ensuring captions **never cover** `VerdictCard`, `ConfidenceBreakdownCard`, `ScheduleChecklistCard`, or `DeviceResiliencePanel` in Pane C.
   - **Caption Pacing & Non-Speech Cues**: Strictly **`<= 2` lines per cue**, **`<= 42` characters per line**, **`<= 17` characters/second** reading rate, monotonically non-overlapping timestamps from `00:00:00` to `00:02:30`, explicit speaker tags (`[Presenter]`, `[HoldUp]`), and non-speech audio cues (`[Earcon: camera on]`, `[Earcon: check complete]`).

2. **Spoken Audio Clarity & Verified Handoff Brevity (WCAG 1.4.7)**:
   - **Zero background music**: Do not add music beds under speech. Maintaining `>= 20 dB` foreground speech margin ensures screen-reader users and blind/low-vision judges clearly hear presenter questions, Gemini Live `24 kHz` voice replies (`582.0 ms` first-audio latency in `eval/live_models_probe.json`), `VoiceActivityPill` barge-in transitions, and earcon chimes.
   - **Measured Open-Ear Verdict & Caregiver Clarity**: HoldUp's spoken outputs are verified in `eval/spoken_verdict_clarity_results.json` at **`16/16` (`100.0%`) verdict match and `5.0/5` open-ear clarity** (`100.0%` `<= 8`-word headline cap, `100.0%` `<= 2`-sentence speech cap, `100.0%` auditory distinction, blind actionability, and EU MDR Art. 2(1) non-medical boundary pass rate; `p50 = 3181.4 ms`), while plain-text caregiver SMS/mailto alerts, adherence summaries, and EN/FI/SV Emergency Wallet exports score **`12/12` (`5.0/5`)** clarity with `100.0%` URI encoding validity in `eval/caregiver_handoff_results.json` (`p50 = 3011.4 ms`).
   - **Broadcast Loudness & Rumble Filtering**: The `ffmpeg` audio chain applies an `80 Hz` high-pass filter (removing table/cardboard handling thumps), a `14 kHz` low-pass filter, gentle `3:1` speech dynamics leveling, and EBU R128 loudness normalization (`loudnorm=I=-16:TP=-1.5:LRA=11`) so presenter mic and HoldUp voice output play at balanced, unclipped volume on laptop speakers or headphones.

---

## 3. Multi-Track Synchronization Workflow (`Sun 06:30-08:30`)

Before each full rehearsal take (`3` takes scheduled in [`docs/PLAN.md`](PLAN.md) Section 6):

1. Start the local production stack (`npm start` + `npm run tunnel`, verified cold-start `p50 = 767.2 ms` across `5` boots and `200/200` HTTP `200` burst at `631.94 req/s` in `eval/production_footprint.json`, or `npm run dev` on `http://localhost:5173` and `/hud` on `http://localhost:5173/hud`).
2. Start all recorders (`pov_raw.mp4`, `hud_raw.mp4`, `pwa_raw.mp4`, and `audio_master.wav` or separate `mic_raw.wav` + `pwa_raw.mp4` system audio).
3. **Execute Sync Marker at `t = 0`**: Hold hands in POV view and perform **one sharp hand clap** (`1.0 s` before starting Beat 1 so both the visual clap frame + audio spike AND the `00:36` `CAMERA ON` transition across PWA `VoiceActivityPill` + `/hud` status dot give dual sync points).
4. Inspect each input's clap timestamp (`HH:MM:SS.mmm`) and assign `POV_OFFSET`, `HUD_OFFSET`, `PWA_OFFSET`, and `AUD_OFFSET` in Section 4 below:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 pov_raw.mp4 hud_raw.mp4 pwa_raw.mp4
```

---

## 4. Exact `ffmpeg` Commands

### 4.1 Primary One-Pass Composite + Audio Leveling + Open-Caption Burn-In (`< 80 MB`)

Save the `.srt` block from Section 5.3 as `captions.srt` in the working folder alongside `pov_raw.mp4`, `hud_raw.mp4`, `pwa_raw.mp4`, and `audio_master.wav` (combined presenter mic + HoldUp system/glasses audio), set the four sync offsets, and run:

```bash
POV_OFFSET="00:00:00.000"
HUD_OFFSET="00:00:00.000"
PWA_OFFSET="00:00:00.000"
AUD_OFFSET="00:00:00.000"
DURATION="150"

ffmpeg -y \
  -ss "$POV_OFFSET" -i pov_raw.mp4 \
  -ss "$HUD_OFFSET" -i hud_raw.mp4 \
  -ss "$PWA_OFFSET" -i pwa_raw.mp4 \
  -ss "$AUD_OFFSET" -i audio_master.wav \
  -t "$DURATION" \
  -filter_complex "\
    color=c=black:s=1920x1080:r=60:d=150[base]; \
    [0:v]fps=60,setpts=PTS-STARTPTS,scale=1152:1080:force_original_aspect_ratio=increase,crop=1152:1080,setsar=1[pov]; \
    [1:v]fps=60,setpts=PTS-STARTPTS,scale=540:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[hud]; \
    [2:v]fps=60,setpts=PTS-STARTPTS,scale=768:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=0x0B0F17,setsar=1[pwa]; \
    [base][pov]overlay=x=0:y=0:shortest=1[v1]; \
    [v1][hud]overlay=x=1152:y=0[v2]; \
    [v2][pwa]overlay=x=1152:y=540[v3]; \
    [v3]drawbox=x=1151:y=0:w=2:h=1080:color=0x2C3A52@1.0:t=fill,\
        drawbox=x=1152:y=539:w=768:h=2:color=0x2C3A52@1.0:t=fill,\
        drawtext=font=Sans:text='1ST-PERSON GLASSES POV (LED ON)':x=24:y=20:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.85:boxborderw=8,\
        drawtext=font=Sans:text='RAY-BAN DISPLAY /hud (600x600)':x=1172:y=20:fontsize=18:fontcolor=0x00E676:box=1:boxcolor=black@0.88:boxborderw=7,\
        drawtext=font=Sans:text='PHONE PWA (CONFIDENCE + TELEMETRY)':x=1172:y=560:fontsize=18:fontcolor=0x38BDF8:box=1:boxcolor=black@0.88:boxborderw=7,\
        subtitles=filename=captions.srt:force_style='FontName=Sans,FontSize=11,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H0D000000,BackColour=&H0D000000,BorderStyle=3,Outline=3,Shadow=0,MarginL=8,MarginR=162,MarginV=10,Alignment=2'[vout]; \
    [3:a]asetpts=PTS-STARTPTS,highpass=f=80,lowpass=f=14000,acompressor=threshold=-18dB:ratio=3:attack=10:release=120:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -profile:v high -level:v 4.2 -pix_fmt yuv420p \
  -r 60 -g 120 -bf 2 \
  -b:v 3400k -maxrate 3800k -bufsize 7600k \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart \
  holdup_demo_1080p60.mp4
```

### 4.2 Dual-Audio Variant (Separate Presenter Mic + System Loopback Audio)

If Silas's lavalier/headset microphone (`mic_raw.wav`) and laptop/PWA system loopback audio (`pwa_raw.mp4` audio stream `[2:a]` carrying Gemini Live `24 kHz` voice + Web Audio earcons) are recorded on separate tracks rather than pre-mixed into `audio_master.wav`, run this variant to level and mix both streams cleanly:

```bash
POV_OFFSET="00:00:00.000"
HUD_OFFSET="00:00:00.000"
PWA_OFFSET="00:00:00.000"
MIC_OFFSET="00:00:00.000"
DURATION="150"

ffmpeg -y \
  -ss "$POV_OFFSET" -i pov_raw.mp4 \
  -ss "$HUD_OFFSET" -i hud_raw.mp4 \
  -ss "$PWA_OFFSET" -i pwa_raw.mp4 \
  -ss "$MIC_OFFSET" -i mic_raw.wav \
  -t "$DURATION" \
  -filter_complex "\
    color=c=black:s=1920x1080:r=60:d=150[base]; \
    [0:v]fps=60,setpts=PTS-STARTPTS,scale=1152:1080:force_original_aspect_ratio=increase,crop=1152:1080,setsar=1[pov]; \
    [1:v]fps=60,setpts=PTS-STARTPTS,scale=540:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[hud]; \
    [2:v]fps=60,setpts=PTS-STARTPTS,scale=768:540:force_original_aspect_ratio=decrease,pad=768:540:(ow-iw)/2:(oh-ih)/2:color=0x0B0F17,setsar=1[pwa]; \
    [base][pov]overlay=x=0:y=0:shortest=1[v1]; \
    [v1][hud]overlay=x=1152:y=0[v2]; \
    [v2][pwa]overlay=x=1152:y=540[v3]; \
    [v3]drawbox=x=1151:y=0:w=2:h=1080:color=0x2C3A52@1.0:t=fill,\
        drawbox=x=1152:y=539:w=768:h=2:color=0x2C3A52@1.0:t=fill,\
        drawtext=font=Sans:text='1ST-PERSON GLASSES POV (LED ON)':x=24:y=20:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.85:boxborderw=8,\
        drawtext=font=Sans:text='RAY-BAN DISPLAY /hud (600x600)':x=1172:y=20:fontsize=18:fontcolor=0x00E676:box=1:boxcolor=black@0.88:boxborderw=7,\
        drawtext=font=Sans:text='PHONE PWA (CONFIDENCE + TELEMETRY)':x=1172:y=560:fontsize=18:fontcolor=0x38BDF8:box=1:boxcolor=black@0.88:boxborderw=7,\
        subtitles=filename=captions.srt:force_style='FontName=Sans,FontSize=11,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H0D000000,BackColour=&H0D000000,BorderStyle=3,Outline=3,Shadow=0,MarginL=8,MarginR=162,MarginV=10,Alignment=2'[vout]; \
    [3:a]asetpts=PTS-STARTPTS,highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=8:release=120:makeup=2[mic]; \
    [2:a]asetpts=PTS-STARTPTS,highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=5:release=100:makeup=1.5[sys]; \
    [mic][sys]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]" \
  -map "[vout]" -map "[aout]" \
  -c:v libx264 -preset slow -profile:v high -level:v 4.2 -pix_fmt yuv420p \
  -r 60 -g 120 -bf 2 \
  -b:v 3400k -maxrate 3800k -bufsize 7600k \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart \
  holdup_demo_1080p60.mp4
```

### 4.3 Post-Render Verification Check (`1080p60` + `< 80 MB` Gate)

Run immediately before uploading to the Junction submission form:

```bash
ffprobe -v error \
  -show_entries format=size,duration,bit_rate:stream=codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels \
  -of default=noprint_wrappers=1 holdup_demo_1080p60.mp4 && \
python3 -c '
import os
sz = os.path.getsize("holdup_demo_1080p60.mp4")
assert sz < 80_000_000, f"Exceeds 80 MB upload target: {sz} bytes"
print(f"Upload check OK: {sz / 1e6:.2f} MB ({sz / (1024**2):.2f} MiB)")
'
```

---

## 5. `150 s` (`02:30`) Shot Beats, Narration Script & `captions.srt` Sidecar

### 5.1 6-Beat Production Cue Sheet (`00:00` -> `02:30`)

| Beat & Time Window | Demo Beat Name | Pane A: Left 60% (Wearer POV) | Pane B: Top-Right 40% (`/hud`) | Pane C: Bottom-Right 40% (Phone PWA) & `eval/*.json` Proof |
|---|---|---|---|---|
| **Beat 1** (`00:00` - `00:18`, `18 s`) | `Hook & Why Glasses` | Hands feel three identical white pill boxes on kitchen counter while holding a water glass; Ray-Ban Meta glasses put on (`0 hands on device`). | Pure `#000000` transparent standby canvas (`0%` lit pixel fill; unobstructed forward sight). | `VerdictCard` (`Ready to check`), `ScheduleChecklistCard` (*"Did I Take My Pills?"*, `Evening window`, `Amlodipin 5 mg` `Due`), and `WhyGlassesComparisonCard` (`0 hands` vs `3-hand` phone OCR, `EUR 341.68` vs `EUR 4,150.00` 3-yr TCO). |
| **Beat 2** (`00:18` - `00:36`, `18 s`) | `Consent, Privacy & Braille-Safe QR` | Right hand points to `25 mm` `holdup://rx` QR sticker on smooth side flap of `Amlodipin 5 mg` while embossed Braille front & rear EAN-13 stay uncovered. | `#000000` standby; zero-code `/hud-ws` `floatingHuds` link (`HUD connected`, `0 B` HUD storage). | `ConsentOnboarding` (`01` active check `45 s` stop, `02` `8`-frame RAM ring / `0` server disk storage, `03` local profile `3` meds + `NSAIDs` avoid + nut allergy + 1-tap wipe) -> `PilotOnboardingCard` (`4/4` ready) + `BrailleStickerGuardCard` (`pharmacy_sticker_overlay_results.json`: `8/8`). |
| **Beat 3** (`00:36` - `01:22`, `46 s`) | `Capture LED, Barge-In Coaching, MATCH & Checklist` | Start check; `2 s` mirror check proves **glasses capture LED is ON**; lift `Amlodipin 5 mg` backwards -> rotate `180 deg` -> move closer & hold still -> Neural Band swipe/pinch `Log Dose`. | Compact `CoachCue` (`Turn it around` -> `Hold still, reading...`) -> emerald `Circle` `MATCH` (`#00E676`): `Yes: Amlodipine 5 mg, your evening pill` (`2738.8 ms` `p50`) -> `Taken today`. | `VoiceActivityPill` (`MIC LISTENING` -> `HOLDUP SPEAKING` + `Interrupt Speech` barge-in), `ConfidenceBreakdownCard` (`80% Dose Gate: PASSED (99%)` bar), and `ScheduleChecklistCard` (*"Did I Take My Pills?"* -> `Dose Logged` duplicate-dose guard; `spoken_verdict_clarity_results.json`: `16/16` `5.0/5`). |
| **Beat 4** (`01:22` - `01:52`, `30 s`) | `NSAID Catch, Caregiver Handoff & 0.80 Dose Gate` | Lift Box 2 (`Burana` / `Ibuprofen 400 mg`); then lift Box 3 (`Amlodipin` with thumb covering `5 mg` digits). | Coral-red `Triangle` `WARNING` (`#FF5252`): `Ibuprofen 400 mg: not on your list`; then amber `Diamond` `UNSURE` (`#FFD600`): `Amlodipine: strength unclear`. | `VerdictCard` `WARNING` (`avoid NSAIDs`) + `CaregiverAlertCard` (1-tap SMS/mailto `HoldUp Safety Catch`) + `EmergencyMedCard` (`100%` on-device EN/FI/SV wallet, `caregiver_handoff_results.json`: `12/12` `5.0/5`); then `ConfidenceBreakdownCard` `80% Dose Gate: BLOCKED` (`calibration_curve.json`: `ECE = 0.0138`, `0` wrong doses). |
| **Beat 5** (`01:52` - `02:12`, `20 s`) | `Offline Barcode, /hud-ws Replay & Glasses-Doff Hot-Swap` | Toggle Wi-Fi off -> scan saved `Amlodipin` EAN-13 (`6432100012345`) locally -> restore Wi-Fi -> take Ray-Ban glasses off head (`!worn`) and hold box to phone camera. | Corner `RECONNECTING` -> `ws_reconnect_resilience.json` replays 4-msg HUD state in `0.78 ms` `p50` (`50/50` flaps, `100/100` hostile storm defense) -> reflects `device.worn: false`. | `DeviceResiliencePanel` + `VoiceActivityPill` (`OFFLINE LOCAL`): `Transport Mode: LIVE -> SNAPSHOT -> OFFLINE` (`0.00 KB` barcode match catches duplicate dose), then `LIVE` + `Ray-Ban Glasses: Doffed` -> `Camera Eye: Phone Camera` with zero state loss. |
| **Beat 6** (`02:12` - `02:30`, `18 s`) | `Wave-9 Proof, Bundle Footprint & Helsinki Pilot` | Presenter frames Ray-Ban Meta Gen 2, Ray-Ban Display, Neural Band, and printable props on table. | Clean `#000000` waveguide or final emerald `MATCH` card. | `EvalProofCard` + `PilotOnboardingCard`: `276` real-model reads across `36` suites (`37` `eval/*.json` files, including `8/8` each on `liquid_concentrations_results.json`, `pharmacy_sticker_overlay_results.json`, `water_droplet_pouch_results.json`), `0` wrong doses, `0` false-safe allergens, `662` tests (`235+395+32`), `205.4 KB` gzip bundle, `EUR 341.68` 3-yr TCO (`-91.8%`), ready for `Näkövammaisten liitto` pilot. |

### 5.2 Word-for-Word `150 s` (`02:30`) Spoken Narration & Open-Ear Dialogue Script

Speak at a calm, unhurried pace (`~125-135` words/min) with zero background music so open-ear Bluetooth HFP replies and Web Audio earcons remain `>= 20 dB` above room tone:

- **`00:00 - 00:18` (Beat 1: Hook & Why Glasses)**
  - **`[Presenter]`** (`00:00 - 00:06`): *"Three look-alike white pill boxes on a kitchen counter: 'Did I take my evening pill?'"*
  - **`[Presenter]`** (`00:06 - 00:12`): *"For 2.2 billion low-vision adults, phone OCR needs a third hand just to aim and rotate."*
  - **`[Presenter]`** (`00:12 - 00:18`): *"Meta AI glasses leave both hands free and see what you naturally hold at chest height."*
- **`00:18 - 00:36` (Beat 2: Consent, RAM Ring & Braille-Safe QR)**
  - **`[Presenter]`** (`00:18 - 00:24`): *"Consent comes first: active check only, auto-stopping after 45 seconds of inactivity."*
  - **`[Presenter]`** (`00:24 - 00:30`): *"An 8-frame RAM ring clears on disconnect; zero images or audio ever touch server disk."*
  - **`[Presenter]`** (`00:30 - 00:36`): *"A Braille-safe side-flap pharmacy QR loads my 3 meds, NSAID rule, and nut allergy locally."*
- **`00:36 - 01:22` (Beat 3: Capture LED, Barge-In Coaching, `MATCH` & Checklist)**
  - **`[Earcon: camera on]` + `[Presenter]`** (`00:36 - 00:41.5`): *"Hardware capture LED locks on, and the open-ear microphone is listening."*
  - **`[Presenter]`** (`00:41.5 - 00:46.2`): *"Hey HoldUp, is this box my evening pill?"*
  - **`[HoldUp]`** (`00:46.4 - 00:52.2`): *"Turn it around, the printed label is on the other side."*
  - **`[HoldUp]` + `[Presenter]`** (`00:52.4 - 00:58.2`): *"[HoldUp] Move closer and hold still. [Presenter] Voice barge-in stays ready live."*
  - **`[Earcon: check complete]` + `[HoldUp]`** (`00:58.4 - 01:10.8`): *"Yes, Amlodipine 5 mg, your evening pill. You haven't taken it today, and strength confidence at 99 percent passes the 80 percent never-guess gate."*
  - **`[Presenter]`** (`01:11.0 - 01:16.4`): *"Ray-Ban Display shows MATCH in 2738.8 milliseconds median on pure black. Log Dose: I took it."*
  - **`[HoldUp]`** (`01:16.6 - 01:21.8`): *"Logged in 'Did I Take My Pills?' Your duplicate-dose guard is now active today."*
- **`01:22 - 01:52` (Beat 4: NSAID Catch, Caregiver Handoff & `0.80` Dose Gate)**
  - **`[Presenter]`** (`01:22.1 - 01:27.8`): *"Now the second white box, Burana 400 mg: can I take this for a headache?"*
  - **`[HoldUp]`** (`01:28.0 - 01:33.8`): *"Warning: this is Ibuprofen 400 mg. It isn't on your list, and your profile avoids NSAIDs."*
  - **`[Presenter]`** (`01:34.0 - 01:39.6`): *"One-tap Caregiver Alert SMS and the on-device Emergency Wallet card are ready too."*
  - **`[Presenter]` + `[HoldUp]`** (`01:39.8 - 01:51.8`): *"[Presenter] What if my thumb covers the milligrams on box three? [HoldUp] Amlodipine, strength unclear. Blocked below the 80 percent dose gate: move your thumb, or ask a pharmacist."*
- **`01:52 - 02:12` (Beat 5: Offline Barcode, `/hud-ws` Replay & Glasses-Doff Hot-Swap)**
  - **`[Presenter]`** (`01:52.0 - 01:57.2`): *"Wi-Fi off live: stream degrades to Snapshot, then zero-kilobyte Offline barcode mode."*
  - **`[HoldUp]`** (`01:57.4 - 02:02.4`): *"Offline barcode match: Amlodipine 5 mg, already taken today."*
  - **`[Presenter]`** (`02:02.6 - 02:07.2`): *"Wi-Fi reconnects: HUD state replays in 0.78 milliseconds median across 50 of 50 flaps."*
  - **`[Presenter]`** (`02:07.4 - 02:11.9`): *"Taking the glasses off hot-swaps to the phone camera mid-session with zero state loss."*
- **`02:12 - 02:30` (Beat 6: Wave-9 Proof, Footprint & Helsinki Pilot)**
  - **`[Presenter]`** (`02:12.1 - 02:16.6`): *"276 real-model reads across 36 suites and 37 JSONs: zero wrong doses, zero false-safe allergens."*
  - **`[Presenter]`** (`02:16.8 - 02:21.2`): *"16 of 16 five-star open-ear clarity, and 12 of 12 EN, FI, SV caregiver and wallet handoffs."*
  - **`[Presenter]`** (`02:21.4 - 02:25.7`): *"662 automated tests, a 205.4 kilobyte gzipped PWA, and 341.68 euro 3-year TCO, saving 91.8 percent."*
  - **`[Presenter]`** (`02:25.9 - 02:29.9`): *"Ready to pilot with Näkövammaisten liitto. HoldUp: know it is the right one."*

### 5.3 Ready-to-Save `captions.srt` Sidecar (`00:00:00` -> `00:02:30`)

Save the block below directly to `captions.srt` (UTF-8, Unix LF line endings, `27` monotonically non-overlapping cues from `00:00:00,200` to `00:02:29,900`, strictly `<= 2` lines per cue, strictly `<= 42` characters per line, `<= 17` chars/s reading rate):

```srt
1
00:00:00,200 --> 00:00:05,800
[Presenter] Three look-alike white pill
boxes: "Did I take my evening pill?"

2
00:00:06,000 --> 00:00:11,800
For 2.2B low-vision adults, phone OCR
needs a third hand to aim and rotate.

3
00:00:12,000 --> 00:00:17,800
Meta AI glasses leave both hands free
and see what you hold at chest height.

4
00:00:18,100 --> 00:00:23,800
[Presenter] Consent first: active check
only, auto-stopping at 45 seconds.

5
00:00:24,000 --> 00:00:29,800
8-frame RAM ring clears on disconnect;
zero images or audio touch server disk.

6
00:00:30,000 --> 00:00:35,800
Braille-safe pharmacy QR loads 3 meds,
NSAID rule & nut allergy locally only.

7
00:00:36,100 --> 00:00:41,400
[Earcon: camera on] [Presenter] Capture
LED locks on; open-ear mic is active.

8
00:00:41,600 --> 00:00:46,200
[Presenter] Hey HoldUp, is this box
my evening pill?

9
00:00:46,400 --> 00:00:52,200
[HoldUp] Turn it around, the printed
label is on the other side.

10
00:00:52,400 --> 00:00:58,200
[HoldUp] Move closer and hold still.
[Presenter] Barge-in stays ready live.

11
00:00:58,400 --> 00:01:04,800
[Earcon: check complete] [HoldUp] Yes,
Amlodipine 5 mg, your evening pill.

12
00:01:05,000 --> 00:01:10,800
[HoldUp] Not taken today. Strength 99%
passes the 80% never-guess gate.

13
00:01:11,000 --> 00:01:16,400
[Presenter] HUD shows MATCH (2738.8 ms
p50) on #000000. Log Dose: I took it.

14
00:01:16,600 --> 00:01:21,800
[HoldUp] Logged in "Did I Take My
Pills?" Duplicate-dose guard active.

15
00:01:22,100 --> 00:01:27,800
[Presenter] Second white box: Burana
400 mg. Can I take this for headache?

16
00:01:28,000 --> 00:01:33,800
[HoldUp] Warning: Ibuprofen 400 mg.
Not on your list; avoid NSAIDs.

17
00:01:34,000 --> 00:01:39,600
[Presenter] 1-tap Caregiver Alert and
on-device Emergency Wallet ready too.

18
00:01:39,800 --> 00:01:45,800
[Presenter] Thumb over mg on box 3:
[HoldUp] Amlodipine, strength unclear.

19
00:01:46,000 --> 00:01:51,800
[HoldUp] Blocked below 80% dose gate.
Move your thumb, or ask a pharmacist.

20
00:01:52,000 --> 00:01:57,200
[Presenter] Wi-Fi off: Live degrades
to Snapshot, then 0 KB Offline EAN.

21
00:01:57,400 --> 00:02:02,400
[HoldUp] Offline barcode match: 5 mg
Amlodipine, already taken today.

22
00:02:02,600 --> 00:02:07,200
[Presenter] Wi-Fi back: /hud-ws state
replays in 0.78 ms p50 (50/50 flaps).

23
00:02:07,400 --> 00:02:11,900
Glasses off: hot-swaps to phone cam
mid-session with zero state loss.

24
00:02:12,100 --> 00:02:16,600
[Presenter] 276 reads in 36 suites (37
JSONs): 0 wrong doses, 0 false-safe.

25
00:02:16,800 --> 00:02:21,200
16/16 (5.0/5) open-ear clarity; 12/12
(5.0/5) EN/FI/SV caregiver & wallet.

26
00:02:21,400 --> 00:02:25,700
662 tests (235+395+32) & 205.4 KB gzip
PWA; EUR 341.68 3-yr TCO (-91.8%).

27
00:02:25,900 --> 00:02:29,900
Ready with Näkövammaisten liitto.
HoldUp: know it is the right one.
```

---

## 6. Pre-Upload QA & Submission Parity Checklist

Complete every check below before uploading `holdup_demo_1080p60.mp4` and `captions.srt` to the Junction 2026 submission portal (`Sun 15 Nov 08:30-09:30`):

- [ ] **Container, Resolution & Upload Budget (`< 80 MB`)**: `ffprobe` confirms `1920x1080` progressive @ `60 fps` (`H.264` High@L4.2, `yuv420p`, `+faststart`), `AAC-LC` `48 kHz` stereo (`192 kbps`), duration `150.0 s` (`02:30`), and file size strictly `< 80,000,000` bytes.
- [ ] **Audio Normalization & Zero Music (WCAG 1.4.7)**: Integrated loudness measures `-16 LUFS` (`TP <= -1.5 dBTP`), zero background music bed is present, `[Earcon: camera on]` / `[Earcon: check complete]` chimes are audible, and spoken verdicts obey `<= 2` sentences (`16/16` `5.0/5` in `eval/spoken_verdict_clarity_results.json`).
- [ ] **Open-Caption & `captions.srt` Sidecar Audit (WCAG 2.2 AAA)**: Burned-in captions render inside `x=40..1110, y=935..1042` at `>= 10.5:1` contrast over white medicine cartons without overlapping Pane C; every cue in `captions.srt` has `<= 2` lines, `<= 42` characters/line, `<= 17` chars/s reading rate, and monotonically non-overlapping timecodes within `00:00:00` to `00:02:30`.
- [ ] **Hardware Privacy & Waveguide Geometry Proof**: Beat 3 (`00:36`) includes the `2 s` mirror reflection proving the Ray-Ban Meta front **hardware capture LED** locks ON (`V128+` firmware + DAT `1.0.1`), zero bystander faces appear in Pane A (`0` leaks across `8/8` scenes in `eval/bystander_privacy_results.json`), and Pane B preserves `1:1` `540x540` geometry on pure `#000000` (`<= 65%` fill, `<= 8`-word headline).
- [ ] **Shipped Pane C UI Surface Coverage**: Recording clearly shows `WhyGlassesComparisonCard`, `ConsentOnboarding`, `PilotOnboardingCard`, `BrailleStickerGuardCard`, `VoiceActivityPill` (`Interrupt Speech` barge-in), `VerdictCard`, `ConfidenceBreakdownCard` (`80%` dose gate bar), `ScheduleChecklistCard` (*"Did I Take My Pills?"*), `CaregiverAlertCard`, `EmergencyMedCard`, and `DeviceResiliencePanel`.
- [ ] **Wave-9 Benchmark & Test Parity**: Every number spoken or captioned matches committed repo artifacts:
  - `276` real-model label reads across `25` label suites in `36` evaluation suites (`37` `eval/*.json` files including `eval/combined_summary.json`), `0` confident-wrong doses at `STRENGTH_MIN_CONF = 0.80`, `0` false-safe allergens (`52/53` = `98.1%` core 4-suite accuracy, `ECE = 0.0138`).
  - Wave-9 optical & packaging suites at `100.0%` (`8/8` each, `0` wrong doses): `eval/liquid_concentrations_results.json` (`120 mg/5 ml`, `5 mg/ml`, `100 IU/ml`, `2x` concentration traps & occluded denominators; `p50 = 3244.4 ms`), `eval/pharmacy_sticker_overlay_results.json` (`5/5` FI/SV sticker recall + `3/3` crooked/torn/price-tag abstention; `p50 = 3615.2 ms`), and `eval/water_droplet_pouch_results.json` (`5/5` wet/crinkled pouch recall + `3/3` crease/smudge abstention; `p50 = 3458.3 ms`).
  - Voice, caregiver & transport benchmarks: `16/16` (`5.0/5`) open-ear spoken clarity (`eval/spoken_verdict_clarity_results.json`), `12/12` (`5.0/5`) EN/FI/SV caregiver & wallet handoff clarity (`eval/caregiver_handoff_results.json`), `2738.8 ms` glass-to-HUD `p50` (`eval/e2e_websocket_live.json`), and `50/50` `/hud-ws` flap replay at `0.78 ms` `p50` + `100/100` hostile payload rejection (`eval/ws_reconnect_resilience.json`).
  - Production footprint & automated test gate: `205.4 KB` (`205,403 B`) gzipped JS+CSS bundle (`< 250 KB`), `767.2 ms` cold-start `p50`, `200/200` HTTP burst at `631.94 req/s` (`eval/production_footprint.json`), `EUR 341.68` vs `EUR 4,150.00` 3-year TCO (`91.8%` savings in `eval/unit_economics.json`), and **`662` passing automated tests** across `102` suites (`235` `server` + `395` `web` + `32` Python `eval/`).
- [ ] **Automated Repo & Caption Verification Gate**: Run before final upload and in incognito browser playback:

```bash
node scripts/verify-submission.mjs
node --import tsx --test server/test/submission-links.test.ts
node scripts/verify-all.mjs
```
