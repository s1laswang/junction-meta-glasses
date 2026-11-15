# Morning brief for Silas (Sun 15 Nov, written 05:40; submit by 09:30, deadline 10:00)

## Where we stand
- `main` is green and tagged `submission-candidate`. A clean copy with no keys passes everything: typecheck, server tests 303/303 (run twice), web tests, build, `make accept`. Live checks against real Gemini pass 13/13.
- The harshest reviewer scored us 68 at midnight and re-scored about 72 after the safety fixes. My estimate after the rest of the night's work is 79–82. **The remaining 8–10 points need people and hardware this morning** (steps 1–6 below). Without the glasses run, 90 is out of reach.

## What changed overnight
- **Safety:** every unsafe "Yes" the judges found is fixed and pinned as a test (wrong box name vs ingredient, free-text allergies, "may contain nuts", pack code mismatch, dose taken minutes ago, liquid vs tablet, low-confidence expired date).
- **Held-out eval (new, 1,060 fresh images never used for tuning):** 1 of 536 confident strength reads was wrong (an eye-drop strength under motion blur); 4 of 3,033 answers were silently over-reassuring. These are in the deck. The earlier "0 of 754" is from the first set and is still true for that set.
- **Spoken-answer check:** after every verdict the server compares what Gemini said with the checked sentence. On a mismatch the phone plays an alert and repeats the checked sentence. 16 live verdicts checked, 1 corrected.
- **Dose finder (off by default):** our own small model finds the dose on the label each second. It draws a "Dose" box on the phone preview and says "Something is covering the dose. Move your thumb." Verified on the real server with a test image. It has never seen a real camera frame, so check it before using it on stage (step 3).
- **Layout:** the tab bar no longer covers controls; verdict buttons stay clear of the Stop button.
- **Deck and demo script:** now show the "Which one?" opening, the spoken-answer check, the red-team and held-out numbers, and a measured cost of about $0.003 per label read.

## 08:00 checklist
1. **Start everything (2 min).**
   ```bash
   cd ~/junction-aimo-team/junction-meta-glasses && git pull
   SPOTTER=1 bash scripts/hw-session.sh start
   ```
   It prints four URLs (phone, bridge app, display, projector) with the access key. Keep that terminal session; don't restart the tunnel.
2. **Phone.** Open the phone URL in Chrome on the Android phone. Profile → Load demo profile. Pair the glasses as the Bluetooth headset. Press Start and hold up the amlodipine box: you should hear "Yes, Amlodipine 5 mg…".
3. **Dose finder check (2 min, decides whether to use it on stage).** With the phone camera, hold the box so "5 mg" shows: a yellow "Dose" box should sit on it. Cover "5 mg" with your thumb for 3 seconds: you should hear "Something is covering the dose." If the box is in the wrong place or the cue fires when nothing is covered, restart without it: `bash scripts/hw-session.sh stop && bash scripts/hw-session.sh start`, then re-open the URLs it prints (new tunnel).
4. **Glasses (Momin).** `adb install -r /tmp/holdup-bridge-debug.apk`, paste the bridge URL into the app, Connect glasses → Start streaming. In the phone app choose Glasses camera. Run steps H1–H4 in `docs/HARDWARE_LOG.md`. After each step: `bash scripts/hw-session.sh probe "H1"` (it appends an evidence row).
5. **Film one take from the side (Chintufp):** box held label-away → coaching → "Yes, Amlodipine 5 mg" → thumb over the dose → "not sure". AirDrop the clip to this laptop and tell the Claude session where it is. It then puts the link on slide 5 and changes "built for" back to "runs on" Ray-Ban Meta.
6. **Real photos (Ivar).** Photos into `eval/real/`, one row each in `eval/real/labels.csv`, then `bash eval/score_real.sh`. Tell the Claude session; it adds the table to `docs/EVAL.md` and one line to the deck.
7. **One real person (Chintufp + Ivar).** A low-vision user or a Meta mentor tries it for 10 minutes: `docs/USER_TEST_KIT.md`, results in `docs/USER_FEEDBACK.md`. Only real quotes.
8. **09:30 submit.** `bash scripts/hw-session.sh stop` only after the demo.

## What to submit where
| Track | Point the submission at |
|---|---|
| Meta: AI Glasses for Everyone, Everyday | repo `main`, `deck/index.html` (print to PDF), `docs/DEMO_SCRIPT.md`, the video from step 5 |
| Google DeepMind: Best Use of Gemini API | `GEMINI.md` (the Gemini CEO also cites it from tag `gemini-quote-0515`) |
| Google DeepMind: Best Use of Gemma | `GEMMA.md` |
| Verda Compute Track | owned by the Arena CEO; our evidence is `docs/evidence/verda-fieldspotter.md` |

## Say these carefully on stage
- "It only states a dose it can read clearly", not "it never makes mistakes". On fresh test images 1 of 536 confident dose reads was wrong.
- The eval is synthetic (Gemini-made images). Real photos count only if step 6 happens.
- The dose finder and the Gemma detector were trained on synthetic images this weekend. Call them prototypes.
- Until step 5 is filmed, the deck says "built for" the glasses. That is deliberate.
