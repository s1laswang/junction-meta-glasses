# HoldUp demo script (3 minutes)

The words in quotes are spoken. **[Brackets]** are actions. Every step has a fallback. The operator decides on the spot, and the presenter keeps talking.

## Roles

| Who | Role | Where |
|---|---|---|
| **Silas** | Presenter. Wears the glasses and holds the props. Does all the talking. | Centre stage, facing judges |
| **Momin010** | Operator. Runs the laptop (deck, mirrored phone screen, HUD view), switches fallbacks, and owns the glasses and the bridge. | Laptop, side of stage |
| **ivarakerholm-wq** | Props. Hands Silas each box in order and takes it back. Holds the phone if it's not on a lanyard. | Next to Silas |
| **Chintufp** | Timekeeper (shows 2:00 and 2:30 cards). Has the backup video open and paused. | Front row |

**Screen layout on the projector:** the deck in one window. When live: the phone screen mirrored (Android: `scrcpy` over USB) on the left and `https://<tunnel>/hud/` in a browser on the right. The HUD page attaches to the latest session and shows the audience what the lens shows.

---

## Pre-demo checklist (start T-30 min)

**Power and hardware**
- [ ] Glasses charged above 50% (DAT install fails below 10%). Phone above 70%. Laptop on the charger.
- [ ] Glasses paired in the Meta AI app, Developer Mode on, firmware V128+. If they were just updated, **reboot the glasses** (camera bug).
- [ ] HoldUp Bridge: Server URL is the current tunnel URL, session code **blank**. Tap "Connect glasses", then "Start streaming". The frames-sent counter goes up.
- [ ] Ray-Ban Display: the HoldUp Web App URL in Meta AI matches the current tunnel (`https://<tunnel>/hud/`, trailing slash). Open it on the glasses; it says "Hold it up."
- [ ] Glasses connected to the phone as the **Bluetooth headset**. The device panel's "Audio route" shows the glasses.
- [ ] Airplane-mode rehearsal: on Android, turn airplane mode on, **turn Bluetooth back on while in airplane mode** (Android remembers this), then turn airplane mode off. Now the offline step won't kill the glasses audio.

**Server and network**
- [ ] Set an access key in `.env`: `HOLDUP_KEY=<random 8+ chars>`. That blocks anyone else on the public tunnel from the live feed and the HUD. Every URL below then gets `?key=<k>` once: the phone at `https://<tunnel>/?key=<k>` (stored, then removed from the address bar), the Display Web App at `https://<tunnel>/hud/?key=<k>`, and the Bridge server field at `https://<tunnel>/?key=<k>`.
- [ ] `npm start` (production build) on the laptop and **one** `npm run tunnel`. Write the tunnel URL here: `______________________`. Don't restart the tunnel after this point (the HUD URL depends on it).
- [ ] `https://<tunnel>/api/health` shows `"gemini":"ok"`.
- [ ] Open `https://<tunnel>/` on the phone. Consent is done and the mode chip says **Ready**.
- [ ] Device panel (Check tab → "Device state") shows: server ok, RTT under 700 ms, barcode supported.
- [ ] Laptop has a backup network (phone hotspot or second SIM). The venue Wi-Fi can die.

**Profile and props (do this on the demo phone)**
- [ ] Profile tab → "Load demo profile": Amlodipine 5 mg (evening), Metformin 500 mg (morning and evening), Atorvastatin 20 mg (evening); allergies: tree nuts, peanut; avoid: NSAIDs.
- [ ] **Scan the real barcode of the amlodipine prop box** into Amlodipine (Edit → Scan). The demo profile's barcodes are placeholders, so the offline step won't work without this.
- [ ] The dose log has **no amlodipine entry today**. If it does, load the demo profile again.
- [ ] Props in order, on a tray: (1) amlodipine 5 mg box, (2) ibuprofen 400 mg box, (3) metformin box with the strength covered by a finger-sized sticker or tape, (4) optional: a snack with hazelnuts.
- [ ] Test each prop once in the lighting on stage. Note which side faces the audience.

**Audio and screen**
- [ ] Phone media volume at 80%. Do Not Disturb on (no notifications). Screen timeout 10 min.
- [ ] Laptop: notifications off, deck on slide 1, browser zoom 100%. Backup video file open and paused.
- [ ] Mic check: Silas says "Is this my evening pill?" during rehearsal and the captions show it.
- [ ] Mock fallback ready in a spare tab: `https://<tunnel>/?mock=1` (plus `/hud/?mock=1` in a second tab on the laptop if needed).

---

## The script

### 0:00–0:20 · Hook (slide 1)
**Silas** [holds up three white boxes]: "Three boxes. One is my blood-pressure pill, one is a painkiller my doctor told me to avoid, one is for diabetes. If you can't read the print, they're the same box. For 55,000 Finns with a visual impairment, that's every morning and every evening."

**Silas**: "HoldUp: hold it up, know it's the right one."

- *Fallback:* none needed. If the clicker fails, the operator advances.

### 0:20–0:40 · Consent and profile (slide 8 visible behind, phone mirrored)
**Momin010** [switches the projector to the mirrored phone, Profile tab].

**Silas**: "My medicine list and allergies are stored only on this phone, and travel with a check only while it runs. Before the camera ever turns on, HoldUp tells me in three plain cards what it captures, where it goes and what it keeps. The camera is only on during a check, and it switches itself off after 45 seconds."

**Momin010** [taps the **Check** tab].

- *Fallback:* if the phone mirror is down, show slide 8 and say the same words.

### 0:40–1:40 · Live on the glasses: coach, match, log
**Silas** [taps the glasses touchpad or presses **Start check** on the phone; hears the start earcon]: "Start."

**Silas** [is handed the amlodipine box **with the label facing away from him**]: "Is this my evening pill?"

**Expected:** HoldUp coaches: "The label is on the other side. Turn it around." (The cue arrow appears on the phone and on the HUD.) Then perhaps "A bit closer."

**Silas** [turns the box slowly, brings it closer, holds it still].

**Expected:** a short "Let me look", the "checking" earcon, then: **"Yes, Amlodipine … 5 mg, your evening pill. You haven't taken it today."** The green **MATCH** card (round check mark) appears on the phone and in the lens.

**Silas**: "I took it." *(or press **I took it** on the HUD with the Neural Band)*

**Expected:** a short confirmation. The dose log on the phone shows the time.

**Silas** [to the judges]: "It coached me. I didn't aim anything: the camera is where my eyes are, and both my hands are on the box."

Fallbacks, in order:
1. **The glasses camera isn't streaming** (no frames on the bridge, or the panel shows "Waiting for the glasses bridge"): **Momin010** taps **Phone camera** in the camera-source switch. Silas holds the phone at chest height (or it hangs on a lanyard) and keeps the glasses on as the headset. Say: "Today the phone is the eye, and the glasses are the ears and mouth."
2. **Live is down** (mode chip shows **Snapshot**, or a "Snapshot mode" banner): if the source is **Glasses camera**, Momin010 first taps **Phone camera**. Snapshot mode and offline barcode mode only use the phone's own frames (see QA.md). Then Silas holds the box steady and presses **Check label** (or Space). The phone reads the verdict out with the browser voice. Say: "When Gemini Live is unavailable, it drops to snapshot mode. It's less chatty, but it gives the same verdict from the same safety rules."
3. **No coaching cue** (the box is readable straight away): fine. Say: "It saw the label straight away. Usually it coaches you round."
4. **It answers "Not sure"**: that is the product working. Say: "It isn't sure, so it won't guess. Let me turn it." Turn the box front-on, closer, and ask again.

### 1:40–2:10 · Safety catch
**Silas** [is handed the ibuprofen box]: "And this one?"

**Expected:** an orange **WARNING** card (triangle): **"This is Ibuprofen 400 mg. It isn't on your medication list and your list says to avoid NSAIDs."**

**Silas** [is handed the metformin box with the strength taped over]: "What about this?"

**Expected:** a blue **NOT SURE** card (diamond): **"It looks like Metformin…, but I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist."**

**Silas**: "It only states a dose it can read clearly. Every field has a confidence, and below the bar it says so."

- *Fallback:* if the taped box is read as a match (the strength is visible elsewhere on the box), say "It found the strength on the side panel, which is exactly what it should do", and move on.
- *Optional (only if ahead of time):* the hazelnut snack: "Does this have nuts?" → warning, contains hazelnut.

### 2:10–2:35 · Resilience (slide 10 next)
**Silas**: "Now the network dies."

**Momin010** [switches the camera source to **Phone camera** (offline barcode reads the phone camera only), then turns on **airplane mode** on the phone; Bluetooth stays on, per the checklist].

**Expected:** an alert earcon and the spoken line "You're offline. I can still recognise your saved medicines by barcode, but I can't read new labels." The chip says **Offline**.

**Silas** [shows the **barcode side** of the amlodipine box].

**Expected:** **WARNING** · offline barcode, headline "Amlodipine: already taken today", spoken "You already took Amlodipine today at <time>. Don't take another unless your plan says so." (Since `e83ff22`, `matchVerdict` in `web/src/lib/verdicts.ts` applies the online dose rule offline: once today's logged doses reach the schedule, it warns instead of matching. This only happens because the 1:40 beat logged "I took it"; on a fresh profile the same box gives **MATCH** "Yes. Amlodipine 5 mg, your evening pill.")

**Silas**: "Even offline, it remembers I already took it. It stops a double dose."

- *Fallback:* if it says MATCH instead, the dose wasn't logged (the "I took it" beat was skipped). Say: "Offline, it still knows my saved boxes." and move on. If the barcode isn't recognised: "Offline it only knows the boxes I've saved."

**Momin010** [turns airplane mode off]. **Expected (on screen; it is only spoken to screen-reader users):** a "Back online" banner → **Snapshot** → "Live assistant connected" within a few seconds.

**Silas** [takes the glasses off]: **Expected:** an alert earcon, and the camera switch flips to **Phone camera** ("Glasses taken off. Switched to the phone camera." is announced to screen readers). This only works while the bridge is streaming and reporting "worn".

Fallbacks:
- **The phone has mobile data, so airplane mode is the only way to go offline.** If airplane mode would kill the glasses audio, use the device panel instead: **Drop connection**. That shows the reconnect and snapshot path. Say: "That's the connection dropping. It reconnects on its own and resumes the same Gemini conversation."
- **The barcode isn't recognised** (BarcodeDetector needs Chrome on Android; the barcode must be saved in the profile): say "Offline it only knows your own saved boxes", and move on.
- **The glasses-off step doesn't fire** (the bridge reports "worn" as unknown): skip it and point at the device panel's "Glasses" row instead.

### 2:35–3:00 · Proof and path (slides 7, 10, 11, 12)
**Momin010** [switches the projector to the deck, slide 7].

**Silas**: "Under the hood: Gemini Live with tool calls mid-conversation. While I'm still asking, the server is already reading the label, so the answer starts in about two to three-and-a-half seconds, median 2.1 seconds over 26 live runs, down from nearly six." [slide 11] "We measure the failure that matters: a confident wrong dose. Gemini built us 1,740 test images with known answers. Out of 754 confident strength reads, zero were wrong. After a stricter allergen rule, 3 in 4,730 answers were silently over-reassuring, down from 49. We narrowed that gap; we haven't closed it." (Source: docs/EVAL.md, eval/results/v1_results.json.) [slide 12] "Next: a home pilot with Näkövammaisten liitto, with pharmacists adding new prescriptions at pick-up." [slide 13] "HoldUp. Hold it up, know it's the right one."

- *Fallback:* if time has run out, jump straight to slide 13 and say the last line.

---

## Optional beats (use one only if it worked in the 08:00 rehearsal)
These are built and tested, but not yet rehearsed on real glasses. Each replaces or extends a beat above; skip any that misbehaved.

- **"Which one?" (opens the live part, 15 s).** Put the three boxes on the table, look at them, and ask: "Which one is my evening pill?" Expected: "Your evening pill is the box on the right. The middle one is Ibuprofen, not on your list." Then pick that box up and continue with the coaching beat. *If it says it isn't sure:* "It won't guess from a distance, so I pick one up." and continue.
- **Dose finder (inside the coaching beat, needs `SPOTTER=1`).** Hold the amlodipine box with your thumb over "5 mg". Expected, spoken by the phone within about 2 s: "Something is covering the dose. Move your thumb." Line: "That cue comes from a small model we trained ourselves this weekend, on labels Gemini generated."
- **Double-checked with the pack code (inside the match beat, needs a real EU prescription pack whose code you saved in Profile → Scan pack code).** Expected after the match: "...double-checked with the pack's code" and the badge on the card. Line: "It doesn't ask me to trust the AI. The AI has to agree with the pack's own code."
- **Set up by voice (only if there is spare time).** "Add this to my list." → it reads the box, asks when you take it, and shows a confirmation sheet. Nothing is saved until you press Add.
- **Corrected answer.** If the phone plays an alert tone and repeats a sentence in a different voice, that is the spoken-answer check: what Gemini said didn't match the checked sentence. Line: "It caught its own voice getting it wrong and repeated the checked answer."

## Last-resort fallbacks

| Situation | Do this |
|---|---|
| The laptop server is dead, or the tunnel can't be reached | Phone: open `https://<tunnel>/?mock=1` from a cached tab, or run `npm run dev` on the laptop and use `http://localhost:5173/?mock=1` on the projector. Mock mode plays the real message contract on a script (coach → checking → verdict), shows a **Demo** chip, and reads verdicts aloud with the browser voice. Type "is this my evening pill" or "ibuprofen" in the text box to choose the scenario. **Say it's a simulation.** |
| No network and no laptop | Play the backup video (Chintufp), and narrate over it with the same script. |
| The HUD doesn't load on the Display | Show `https://<tunnel>/hud/` (or `/hud/?mock=1`) on the laptop and say "this is what the lens shows". |
| The glasses mic picks up the room | Type the question in the "Type a question" box. The answer is still spoken. |
| Gemini quota is exhausted | The server walks the fallback models automatically. If everything is down, use snapshot mode; if that fails too, use mock mode. |

## After the demo
- Stop streaming in the bridge (the capture LED goes off), stop the check, and stop the server. Return the glasses to the booth (Momin010).
