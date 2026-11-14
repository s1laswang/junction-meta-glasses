# HoldUp Accessible Backup Demo Video Production & Open-Caption Guide (`docs/VIDEO_PRODUCTION.md`)

Production runbook for recording, synchronizing, compositing, and open-captioning the **2m 30s (`150 s`)** HoldUp submission and backup demo video during **Hardware Test Slot 2 (`Sun 15 Nov 06:30-08:30` Helsinki time)** ahead of the `09:30` Junction upload target and `10:00` deadline (`BRIEF.md`, `docs/PLAN.md` Section 6, `docs/HARDWARE_NOTES.md`).

- **Crew (`docs/PLAN.md` Section 6, `docs/TEAM.md`)**:
  - **Momin010**: Ray-Ban Meta Gen 2 (`android-dat/` DAT SDK `1.0.1` camera + device state stream) and Ray-Ban Display (`/hud` Web App + Neural Band / touchpad).
  - **Chintufp**: First-person POV camera operator, laptop `/hud` + Phone PWA screen capture, sync check, and `ffmpeg` master render.
  - **Silas**: Live presenter, voiceover/dialogue pacing, final accessibility review, and Junction submission upload.
- **Master Deliverable Spec**:
  - **Container / Codec**: `.mp4` (`H.264` High@L4.2, `yuv420p`, `+faststart` progressive web atom) + `AAC-LC` stereo `48 kHz` (`192 kbps`).
  - **Canvas & Frame Rate**: `1920 x 1080` progressive @ `60 fps`, duration `02:30` (`150.0 s`).
  - **Upload Size Budget**: Nominal `67.35 MB` (`64.23 MiB`) at `3400 kbps` video + `192 kbps` audio; hard VBV ceiling `75.60 MB` (`72.10 MiB`, including `1%` MP4 muxing overhead) at `-maxrate 3800k`, staying strictly **`< 80 MB`** for fast Junction platform upload.
  - **Accessibility**: High-contrast burned-in open captions (`>= 10.5:1` WCAG 2.2 AAA contrast even over white medicine boxes) paired with `-16 LUFS` broadcast-normalized speech, zero background music, and companion `.srt` sidecar export.

---

## 1. 3-Pane Split-Screen Compositing Layout (`1920x1080` @ `60fps`)

Judges must simultaneously see **what the wearer's hands hold in first person**, **what the in-lens Ray-Ban Display `/hud` projects**, and **how the Phone PWA verifies confidence and reacts to hardware/network state changes**.

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
|  - Ray-Ban Meta glasses + active     |  - 114px #000000 side margins    |
|    front hardware capture LED view   |    (zero aspect distortion)      |
|                                      +----------------------------------+ 540
|  Safe label action zone: y=70..880   | [PHONE PWA (CONFIDENCE + STATE)] |
|                                      |                                  |
|  +--------------------------------+  |  PANE C: Bottom-Right 40%        |
|  | Burned-In Open Captions (95%   |  |  768 x 540 (x=1152, y=540)       |
|  | #000000 box, #FFFFFF bold,     |  |  - VerdictCard confidence bars   |
|  | x=40..1110, y=935..1042)       |  |  - DeviceResiliencePanel RTT,    |
|  +--------------------------------+  |    Camera Eye & Glasses state    |
+--------------------------------------+----------------------------------+ 1080
```

### 1.2 Per-Pane Capture & Framing Rules

| Pane | Geometry (`1920x1080`) | Source File | Required Visual Content & Framing Rules |
|---|---|---|---|
| **Pane A: Left 60% (Wearer POV + Glasses LED)** | `1152 x 1080` at `x=0, y=0` | `pov_raw.mp4` | First-person chest/temple-mounted action camera or phone (`1920x1080` @ `60fps` landscape) filming hands holding the three nearly identical white medicine boxes (`Amlodipine 5 mg`, `Ibuprofen 400 mg`, strength-covered `Amlodipine`). At `00:36` when DAT streaming starts (`HoldUp Bridge -> Start streaming`), include a `2 s` countertop mirror reflection or tight 45-degree angle proving the Ray-Ban Meta front **hardware capture LED** locks ON (`docs/HARDWARE_NOTES.md` Section 5, `docs/PRIVACY.md` Section 3). Keep hands and pill boxes inside `y=70..880` so top badge (`y=20..56`) and bottom open captions (`y=935..1042`) never cover printed box text. |
| **Pane B: Top-Right 40% (Ray-Ban Display `/hud`)** | `768 x 540` at `x=1152, y=0` | `hud_raw.mp4` | Pure `#000000` additive-light waveguide view from `http://localhost:5173/hud` (or `https://<tunnel>/hud` in the Chrome **Meta Ray-Ban Display Simulator** extension `jpjlmmodokemlepklkdbimceggpbjcll`, or `Meta AI -> Devices -> Record Display` per `docs/HARDWARE_NOTES.md` Section 6.8). Scaled to `540x540` (`1:1` square) and centered on `#000000` (`114 px` left/right pillarbox) so the 4-channel multimodal badges (`Circle` `#00E676` `MATCH`, `Triangle` `#FF5252` `WARNING`, `Diamond` `#FFD600` `UNSURE`, `Square` `#38BDF8` `INFO`) keep true 1:1 geometry (`docs/HUD_SPEC.md` Section 1.3). |
| **Pane C: Bottom-Right 40% (Phone PWA)** | `768 x 540` at `x=1152, y=540` | `pwa_raw.mp4` | Live PWA capture (`http://localhost:5173` or `https://<tunnel>`) showing `VerdictCard` (`Per-Field Confidence Breakdown` bars + `Below 80% safety threshold: dose never guessed` alert) and `DeviceResiliencePanel` (`Transport Mode`, `Network RTT`, `Camera Eye: Glasses DAT / Phone Camera`, `Ray-Ban Glasses: Connected / Worn / Battery`, `Ray-Ban Display HUD: Connected (/hud)`). **Legibility rule**: record the PWA in a `1152x810` or `768x540` responsive window at `125%` browser zoom (or crop the active card column of a phone screen recording) so confidence bars and RTT telemetry stay crisp at `>= 16 px` effective text height rather than tiny portrait pillarbox text. |

### 1.3 Structural Dividers & Non-Occluding Overlays
- **Divider lines**: Because Pane B (`/hud`) uses pure `#000000` (`transparent waveguide`) and Pane C (`PWA`) uses `#0B0F17` / `#121926`, `ffmpeg` draws a `2 px` vertical divider at `x=1151` (`h=1080`) and a `2 px` horizontal divider at `y=539` (`x=1152..1920`) in slate `#2C3A52` (`tokens.css` `--border-subtle`).
- **Pane identification pills**: Compact top-left labels (`1ST-PERSON GLASSES POV (LED ON)`, `RAY-BAN DISPLAY /hud (600x600)`, `PHONE PWA (CONFIDENCE + TELEMETRY)`) orient judges within the first second of playback even if they scrub mid-video.

---

## 2. Video & Audio Accessibility Requirements

Because HoldUp is built for blind, low-vision, and older adults (`BRIEF.md` UX & accessibility 25% weight), the submission video itself must meet strict visual and auditory accessibility standards:

1. **Burned-In High-Contrast Open Captions (`>= 10.5:1` Contrast)**:
   - Many judging laptops and hall projectors play muted or fail to enable `.srt` closed-caption tracks. Captions are **burned directly into the MP4 video stream** (open captions) AND uploaded alongside as `captions.srt` when the platform provides a subtitle slot.
   - **ASS Alpha Precision (`&HAABBGGRR`)**: In `libass`, the leading byte `AA` encodes **transparency** (`00` = `100%` opaque, `FF` = `0%` opaque). Our `force_style` sets `OutlineColour=&H0D000000,BackColour=&H0D000000,BorderStyle=3` (`95%` opaque pure black box behind `100%` opaque `#FFFFFF` bold sans-serif text). Even directly over a sunlit `255,255,255` white pill box, luminance contrast stays **`>= 10.5:1`** (exceeding WCAG 2.2 AAA `7:1`), and reaches **`19:1` to `21:1`** over normal scenes.
   - **Pane-Locked Placement (`PlayResX=384, PlayResY=288` SRT Virtual Grid)**: `ffmpeg`/`libass` maps `.srt` files onto a `384x288` virtual grid (`5.0x` horizontal scale, `3.75x` vertical scale at `1920x1080`). Setting `MarginL=8,MarginR=162,MarginV=10,Alignment=2,FontSize=11` locks captions to `x=40..1110` (centered at `x=575`, matching the `576 px` midpoint of the `1152 px` Left POV pane) at `41 px` rendered font size, ensuring captions **never cover** `VerdictCard` or `DeviceResiliencePanel` in Pane C.
   - **Caption Pacing & Non-Speech Cues**: Maximum `2` lines per cue, `<= 42` characters per line, `<= 17` characters/second reading rate, explicit speaker tags (`[Presenter]`, `[HoldUp]`), and non-speech audio cues (`[Earcon: camera on]`, `[Earcon: check complete]`).

2. **Spoken Audio Clarity for Blind & Low-Vision Reviewers (WCAG 1.4.7)**:
   - **Zero background music**: Do not add music beds under speech. Maintaining `>= 20 dB` foreground speech margin ensures screen-reader users and blind/low-vision judges clearly hear both presenter commands and Gemini Live `24 kHz` voice replies plus earcon chimes.
   - **Broadcast Loudness & Rumble Filtering**: The `ffmpeg` audio chain applies an `80 Hz` high-pass filter (removing table/cardboard handling thumps), a `14 kHz` low-pass filter, gentle `3:1` speech dynamics leveling, and EBU R128 loudness normalization (`loudnorm=I=-16:TP=-1.5:LRA=11`) so presenter mic and HoldUp voice output play at balanced, unclipped volume on laptop speakers or headphones.

---

## 3. Multi-Track Synchronization Workflow (`Sun 06:30-08:30`)

Before each full rehearsal take (`3` takes scheduled in `docs/PLAN.md` Section 6):

1. Start local production stack or tunnel (`npm start` + `npm run tunnel`, or `npm run dev` on `http://localhost:5173` and `/hud` on `http://localhost:5173/hud`).
2. Start all recorders (`pov_raw.mp4`, `hud_raw.mp4`, `pwa_raw.mp4`, and `audio_master.wav` or separate `mic_raw.wav` + `pwa_raw.mp4` system audio).
3. **Execute Sync Marker at `t = 0`**: Hold hands in POV view and perform **one sharp hand clap** (`1.0 s` before clicking `Start Check` so both the visual clap frame + audio spike AND the simultaneous `CAMERA ON` transition on PWA + `/hud` status dot give dual sync points).
4. Inspect each input's clap timestamp (`HH:MM:SS.mmm`) and assign `POV_OFFSET`, `HUD_OFFSET`, `PWA_OFFSET`, and `AUD_OFFSET` in Section 4 below:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 pov_raw.mp4 hud_raw.mp4 pwa_raw.mp4
```

---

## 4. Exact `ffmpeg` Commands

### 4.1 Primary One-Pass Composite + Audio Leveling + Open-Caption Burn-In (`< 80 MB`)

Save the `.srt` block from Section 5 as `captions.srt` in the working folder alongside `pov_raw.mp4`, `hud_raw.mp4`, `pwa_raw.mp4`, and `audio_master.wav` (combined presenter mic + HoldUp system/glasses audio), set the four sync offsets, and run:

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

## 5. Time-Coded `.srt` Caption Template (`captions.srt`, `02:30` Master)

### 5.1 6-Beat Production Cue Sheet (`00:00` -> `02:30`)

| Beat & Time Window | Demo Beat Name | Pane A: Left 60% (Wearer POV) | Pane B: Top-Right 40% (`/hud`) | Pane C: Bottom-Right 40% (Phone PWA) |
|---|---|---|---|---|
| **Beat 1** (`00:00` - `00:18`, `18 s`) | `Hook` | Hands feel three identical white pill boxes on table; Ray-Ban Meta glasses put on (`both hands stay free`). | Pure `#000000` transparent standby canvas (zero visual clutter). | `VerdictCard` in `Ready to check` state (`Live mode` pill). |
| **Beat 2** (`00:18` - `00:36`, `18 s`) | `Consent` | Hands rest beside pill boxes while wearer reviews consent on phone. | `#000000` standby; `HUD connected` link verified. | `ConsentOnboarding` (`01` camera on-demand `45 s` stop, `02` zero server storage, `03` local profile `3` meds + nut allergy, two-tap local wipe) -> tap `I Understand, Continue to HoldUp`. |
| **Beat 3** (`00:36` - `01:22`, `46 s`) | `Guided Coaching -> Match` | Start check; `2 s` mirror check proves **glasses capture LED is ON**; pick up box with back/barcode facing camera -> rotate around -> move closer & hold still -> tap/say `I took it`. | Compact `CoachCue` (`Turn it around` -> `Hold still, reading...`) -> emerald `Circle` `MATCH` (`#00E676`): `Yes: Amlodipine 5 mg, your evening pill` -> `Log Dose` hides & shows `Taken today`. | `Camera Eye: Glasses DAT` (`Active check`), `MATCH` card + `Per-Field Confidence Breakdown` (`Strength: 5 mg` `>= 80%`) -> `Taken today` pill updates. |
| **Beat 4** (`01:22` - `01:50`, `28 s`) | `NSAID + Covered-Dose Safety Catches` | Pick up Box 2 (`Ibuprofen 400 mg`); then pick up Box 3 (`Amlodipine` with thumb covering mg strength). | Coral-red `Triangle` `WARNING` (`#FF5252`): `Ibuprofen 400 mg: not on your list`; then amber `Diamond` `UNSURE` (`#FFD600`): `Amlodipine: strength unclear`. | `WARNING` double-border card (`ibuprofen is an NSAID, on your avoid list`); then `UNSURE` dashed card (`Below 80% safety threshold: dose never guessed`). |
| **Beat 5** (`01:50` - `02:12`, `22 s`) | `Offline Barcode + Glasses Doff Resilience` | Toggle Wi-Fi off -> scan saved `Amlodipine` EAN barcode locally -> restore Wi-Fi -> take Ray-Ban glasses off head and hold box to phone camera. | Corner `RECONNECTING` / offline sync -> reconnects cleanly via `Hub.replay` -> reflects `device.worn: false`. | `DeviceResiliencePanel`: `Transport Mode: LIVE -> SNAPSHOT -> OFFLINE` (`BarcodeDetector` match, `Network RTT: offline`), then `LIVE` + `Ray-Ban Glasses: Connected / Doffed` -> `Camera Eye: Phone Camera`. |
| **Beat 6** (`02:12` - `02:30`, `18 s`) | `Proof & Pilot` | Presenter holds Ray-Ban Meta glasses alongside the three white pill boxes. | Clean `#000000` standby or final `MATCH` summary card. | Nominal telemetry (`0` server disk storage, `80%` deterministic strength gate, `8/8` coaching & bystander checks passed; update final `docs/EVAL.md` label count if needed). |

### 5.2 Ready-to-Save `captions.srt` File

Save the block below directly to `captions.srt` (UTF-8, Unix LF line endings, zero overlapping timecodes, `<= 2` lines per cue, `<= 42` chars per line):

```srt
1
00:00:00,200 --> 00:00:05,800
[Presenter] Three nearly identical white
pill boxes on a kitchen counter.

2
00:00:06,000 --> 00:00:11,800
For 2.2 billion people with low vision:
"Which one is my evening pill?"

3
00:00:12,000 --> 00:00:17,800
Phone OCR needs a third hand. Meta AI
glasses see what your hands already hold.

4
00:00:18,100 --> 00:00:23,800
[Presenter] Consent comes first: camera
runs on demand and auto-stops at 45s.

5
00:00:24,000 --> 00:00:29,800
Frames process in memory only, with zero
images or transcripts stored on a server.

6
00:00:30,000 --> 00:00:35,800
My 3 meds, NSAID rule, and nut allergy
stay on this phone with a two-tap wipe.

7
00:00:36,100 --> 00:00:41,400
[Earcon: camera on]
[Presenter] Glasses capture LED is on.

8
00:00:41,600 --> 00:00:45,800
[Presenter] Hey HoldUp, is this box
my evening pill?

9
00:00:46,000 --> 00:00:52,200
[HoldUp] Turn it around, the printed
label is on the other side.

10
00:00:52,400 --> 00:00:58,200
[HoldUp] Move it a bit closer and hold
still while I verify the label.

11
00:00:58,400 --> 00:01:05,200
[Earcon: check complete]
[HoldUp] Yes, Amlodipine 5 mg.

12
00:01:05,400 --> 00:01:11,200
[HoldUp] Your evening pill, not taken
today. Strength confidence above 80%.

13
00:01:11,400 --> 00:01:16,200
[Presenter] Ray-Ban Display shows MATCH
on pure black. I took it.

14
00:01:16,400 --> 00:01:21,800
[HoldUp] Dose logged on your device.
Double-dose guard is now active today.

15
00:01:22,100 --> 00:01:26,400
[Presenter] Now let's check this second
white pill box.

16
00:01:26,600 --> 00:01:31,600
[HoldUp] Warning: this is Ibuprofen
400 mg. It isn't on your medication list,

17
00:01:31,800 --> 00:01:35,400
and your profile says to avoid NSAIDs.

18
00:01:35,600 --> 00:01:40,000
[Presenter] What if my thumb covers
the strength on the third box?

19
00:01:40,200 --> 00:01:45,200
[HoldUp] It looks like Amlodipine, but I
can't read the strength confidently.

20
00:01:45,400 --> 00:01:49,900
Turn the side panel toward you, or
ask a pharmacist. Never guess doses.

21
00:01:50,100 --> 00:01:55,400
[Presenter] Turning Wi-Fi off live:
Live stream degrades to Snapshot,

22
00:01:55,600 --> 00:02:01,200
then full Offline mode matches saved EAN
barcodes locally with zero network.

23
00:02:01,400 --> 00:02:06,400
[HoldUp] Offline barcode match: Amlodipine
5 mg, already taken today.

24
00:02:06,600 --> 00:02:11,800
[Presenter] Wi-Fi reconnects; taking the
glasses off switches seamlessly to phone.

25
00:02:12,100 --> 00:02:18,000
[Presenter] Deterministic 80% strength
gate: zero confident-wrong dose reads,

26
00:02:18,200 --> 00:02:24,000
8 of 8 coaching and bystander privacy
checks passed, assistive EU boundary.

27
00:02:24,200 --> 00:02:29,800
Ready to pilot with Näkövammaisten liitto
and pharmacies. HoldUp: know it's right.
```
