# HoldUp: "Hold it up. Know it's the right one."

Junction 2026 · Meta "AI Glasses for Everyone, Everyday" · deadline **Sun 15 Nov 10:00 Helsinki**
Also entered for Google DeepMind "Best Use of Gemini API".

## Questions for Silas

0. **URGENT (Sat 17:00): freighter can't be reached from the venue network.** `ssh freighter` worked at 14:05, but from the venue LAN (192.168.8.x) both `freighter.fr8.so` and the LAN address `10.10.172.201` time out on port 22. Tailscale is stopped on the laptop. The eval (synthetic label dataset and the accuracy and calibration sweep) is written and was smoke-tested on 12 images. It needs about 45–60 min of mostly Gemini API calls (network-bound, light on CPU). Choose one: **(a)** start Tailscale or give me a route to freighter, **(b)** approve running it on the laptop, niced and capped at 12 concurrent API calls, or **(c)** let it run in GitHub Actions with GEMINI_API_KEY as a repo secret. Without one of these, the deck won't have the eval numbers.
1. **Phones for the demo.** The glasses camera path (Device Access Toolkit) needs an **Android phone** paired to the loaned glasses through the Meta AI app with developer mode on. Which teammate has an Android phone (Android 10+) and Android Studio? If nobody does, we demo the glasses as a Bluetooth audio headset (mic and speaker) with the **phone camera** as the eye, and show the DAT bridge as code plus a recorded clip. Default if you don't answer: **Momin010's phone**.
2. **Hosting.** Default: the backend runs on the demo laptop behind a `cloudflared` quick tunnel (gives HTTPS, which phone camera and mic require). Can we deploy to Google Cloud Run? The gcloud config on this laptop points to project `fixera-502707` (account fonora.eu), so I have **not** touched it. Cloud Run would help the Gemini prize story. Reply "use fixera" or name another project.
3. **Gemini API tier.** Is the key in `.env` on a paid (billing-enabled) project? Under the paid tier, Google does not use prompts to train its models. That lets us state the data claim on the privacy slide. If it isn't paid, the slide will be worded more weakly.
4. **Overnight loan.** Can we keep the glasses overnight? Ask Amanda Le at pickup. If not, see the hardware plan for two test slots instead.

---

## 1. Problem and audience

**Audience.** Blind and low-vision people. There are about 2.2 billion people with vision impairment worldwide, about 80,000 in Finland, and most of them are over 65. The second audience is older adults with declining sight who manage several medications.

**Everyday problem.** *"Is this the right one?"* Several times a day you hold a box, bottle or package you can't read. Is this the blood-pressure pill or the sleeping pill? Is this oat milk the one without nuts? Has it expired? Today the options are:
- Ask someone. This costs independence and isn't always possible.
- Phone OCR apps (Seeing AI and similar). You need **two hands for the item and a third for the phone**. You aim blind, and the app reads whatever text it finds with no idea whether it matters to *you*.
- Video call a volunteer (Be My Eyes). It's slow, needs another person, and medication is private.

**Why glasses beat a phone here.**
- The camera **is already pointing at what your hands hold**, so you don't have to aim. Both hands stay free for the bottle and the cane, or the pill and the glass of water.
- Audio goes to the open-ear speakers, so it's private and your ears stay open to the room.
- **Active guidance.** Because the frames stream continuously, the assistant can coach you: *"Turn it left… a bit closer… got it."* A single snapshot can't do that.
- On Ray-Ban Display a large high-contrast card shows the verdict, so low-vision users get audio *and* a visual confirmation.

## 2. The product

HoldUp is a hands-free label assistant powered by Gemini Live.

1. **Ask naturally.** "Hey, is this my evening pill?" Or press the glasses' capture button, or tap the Neural Band.
2. **Guided capture (Gemini Live, streaming).** The assistant watches the frames and speaks short coaching cues until the label is readable: rotate, move closer, more light, the barcode side is facing you.
3. **Verified read (Gemini structured extraction).** Once the frame is good, a tool call sends the 1–3 sharpest frames to a strong model with a strict JSON schema: product, active ingredient, strength, dosing, expiry, allergens and a **confidence for each field**. The model must leave a field out when it can't read it.
4. **Personal safety check.** The read is matched against the user's own profile, which is stored **on the device only**: their medication list with schedule, and their allergies. The verdict is one of three:
   - ✅ *"Yes. Amlodipine 5 mg, your evening pill. You haven't taken it today."*
   - ⚠️ *"This is Ibuprofen 400 mg. It isn't on your list, and your list says to avoid NSAIDs."*
   - ❓ *"I can't read the strength confidently. Turn the box so the side panel faces you, or ask a pharmacist."* **It never guesses on doses.**
5. **Log it** (optional). "I took it." The dose goes into an on-device log, so the next time you ask, it can say "you already took this today".

**Second scenario for the demo:** food. *"Does this contain nuts?"* reads the allergen panel, checks it against your allergies and gives the expiry date.

### Trust and safety principles (visible in the UI and the deck)
- **No silent guessing.** Every field has a confidence. Low confidence becomes a coaching cue or an "I'm not sure" answer, never a hallucinated dose. Doses and strengths need a confident read from two frames.
- **The camera runs only during an active check.** The user starts it explicitly, it auto-stops after 45 s of no label, and an on-screen and audio "camera on" indicator shows while it runs. Frames go at 1 fps and are cut to the region of interest when possible.
- **Nothing stored on a server.** Frames and audio are processed in memory, then dropped. The server keeps no image logs and redacts transcripts from its logs. The profile and dose log live in the phone's local storage. One button deletes everything.
- **Consent first.** Onboarding explains what is captured, where it goes (Google Gemini API) and what is kept. Camera and mic permissions are requested *in context* with a plain explanation and a recovery path if they are denied.
- **Bystanders.** The glasses' capture LED is on while streaming. The model is told to ignore people and never describe faces.
- **Not a medical device.** For anything uncertain it hands off to a pharmacist. This is the adoption path, not a weakness.

### Graceful degradation (a judged requirement, shown live in the demo)
| Condition | Behaviour |
|---|---|
| Camera or mic permission denied | Plain-language explanation, a "how to enable" step and a text or snapshot mode that needs only the camera |
| Live WebSocket drops | Auto-reconnect with backoff; meanwhile switch to **Snapshot mode** (HTTP verify per frame, browser TTS) |
| Offline completely | **Offline mode**: barcode match (BarcodeDetector) against the user's own saved medications works without network, and it says clearly that it can't read new labels |
| Slow network | Adaptive frame rate and JPEG quality, so live latency stays under 1.5 s |
| Glasses disconnect, battery low or doffed (DAT state) | Announces it and falls back to the phone camera without losing the session |
| Gemini error or quota | Retry, then a fallback model chain (`gemini-3.8-live` → `gemini-3.1-flash-live-preview` → `gemini-2.5-flash-native-audio-latest`) |

A **device state panel** (developer and demo view) shows camera source, mic, network RTT, Live session state, glasses state and battery. Judges can watch the system react.

## 3. Platform decision

Research result (Meta dev blog, May 2026): **Ray-Ban Display Web Apps have no camera access** (only motion, GPS, Neural Band input and local storage). **The camera is available only through the Device Access Toolkit (DAT), the native iOS and Android SDK.**

**Decision:** one backend and three thin clients, built in order of demo robustness.

1. **P0: phone web app (PWA)**, the core product. It uses the phone camera through `getUserMedia` (this is the *phone-camera fallback*, and it unblocks development immediately). Audio goes through whatever the phone is connected to. **Paired Ray-Ban Meta glasses act as a Bluetooth headset**, so mic and speaker are already on the glasses with zero extra code.
2. **P1: DAT Android bridge** (`android-dat/`). A thin Kotlin app streams **glasses-camera frames** to the backend and reports glasses state (connected, doffed, battery). The web app then switches its "eye" to *Glasses*. This is the true first-person camera.
3. **P1: Ray-Ban Display HUD Web App** (`/hud` route). A large-type verdict card on the in-lens display, driven by the same session over WebSocket, with Neural Band input to confirm, repeat or log.

The judges get a robust demo even if the hardware misbehaves, and the full glasses story when it works.

## 4. Architecture

```
 Ray-Ban Meta / Display glasses
   │  camera (DAT)      │ mic+speaker (Bluetooth HFP)     ▲ HUD (Display Web App)
   ▼                    ▼                                  │
 android-dat bridge ── frames ──►┐                         │
 phone PWA (React) ─ audio PCM16 + frames (phone cam) ─► server (Node/TS, ws)
                    ◄─ audio 24k + captions + verdicts ──┤   ├─ Gemini Live (gemini-3.8-live): conversation + coaching + tool calls
                                                         │   ├─ verify_label tool → gemini-3.8-flash (JSON schema, per-field confidence)
                                                         │   ├─ safety check vs profile (deterministic TS rules + model explanation)
                                                         └──►└─ /hud ws fan-out
 eval/ (Python, runs on freighter via Slurm): synthetic label images (gemini-3.1-flash-image)
   → accuracy and calibration eval of verify_label → results table for the deck
```

- **Server**: Node 24, TypeScript (tsx), Express and `ws`, `@google/genai`. The API key stays on the server and is never sent to the browser.
- **Web**: Vite, React and TypeScript, installable PWA, WCAG 2.2 AA, built screen-reader-first (VoiceOver and TalkBack), large type, earcons and haptics.
- **Repo layout**: `server/`, `web/` (includes `/hud`), `android-dat/`, `eval/`, `deck/`, `docs/`.
- **Run**: `npm install && npm run dev` from the repo root starts the server and web together. `npm run tunnel` gives an HTTPS URL for phones.

## 5. Demo script (3 minutes)

1. **(20 s) Hook.** Video of a real low-vision user's kitchen counter with three nearly identical white pill boxes. "Which one is the evening pill?"
2. **(20 s) Consent onboarding.** It shows what is captured, where it goes and what is kept. The profile has 3 meds and a nut allergy, stored on the device only.
3. **(60 s) Live on the glasses.** The presenter wears the glasses and picks up a box *with the label facing away*. HoldUp: "I can see a box, the label is on the other side. Turn it around… a bit closer… got it." Then: "Amlodipine 5 mg, your evening pill, not taken today." The Display HUD shows a green card. "I took it" logs the dose.
4. **(30 s) Safety catch.** They pick up ibuprofen. ⚠️ "Not on your list, and your profile says to avoid NSAIDs." Then a box with a blurry or covered strength: ❓ "I can't read the strength confidently." It refuses to guess.
5. **(25 s) Resilience.** Turn Wi-Fi off live: "Connection lost, snapshot mode… now offline: I can still recognise *your* meds by barcode." Turn Wi-Fi on and it auto-recovers. Take the glasses off and the panel shows "glasses doffed, using phone camera".
6. **(25 s) Proof and path.** Eval numbers: field accuracy and **0 confident-wrong dose reads** on N synthetic plus real labels. Privacy architecture. Pilot plan with the Finnish Federation of the Visually Impaired (Näkövammaisten liitto) and a pharmacy chain.

## 6. Hardware plan (glasses on loan at the Meta booth, mentor Amanda Le)

| When (Helsinki) | Who | What |
|---|---|---|
| **Sat 15:30** | **Momin010** (backup: Chintufp) | Go to the Meta booth. Ask Amanda Le about DAT developer mode and Display Web App sideloading. Borrow **1× Ray-Ban Meta Gen 2** (camera and DAT) and **1× Ray-Ban Display + Neural Band** if available. Ask: overnight loan? Return times? Pre-registered dev app IDs? Then pair them to the Android demo phone in the Meta AI app and enable developer mode. |
| Sat 16:00–18:00 | Momin010 + glasses agent | Install the DAT sample app, confirm the camera stream works, then install our bridge. Log every finding in `docs/HARDWARE_NOTES.md`. |
| **Sat 19:30–20:30** | Momin010, ivarakerholm-wq | **Test slot 1**: end-to-end on the glasses (Bluetooth audio, DAT frames, HUD). Note bugs. |
| Sat 23:00 (if no overnight loan) | Momin010 | Return the glasses and book a morning pickup. |
| **Sun 06:30–08:30** | Momin010 (glasses), Chintufp (filming), Silas (presenter) | **Test slot 2, final rehearsal**: 3 full demo runs on the hardware, and record a backup demo video. |
| Sun after judging | Momin010 | Return all hardware to the booth. |

**Read before the pickup: [HARDWARE_NOTES.md](HARDWARE_NOTES.md).**
- No GitHub token or Developer Center registration is needed (DAT 1.0.1 is on Maven Central; in developer mode the app ID is 0).
- Needs the Meta AI app V292 or later and glasses firmware V128 or later. **Reboot the glasses after the update**, or the camera stays dead.
- Only one third-party app can be registered in developer mode.
- The Display Web App is added in the Meta AI app under Apps → Web Apps → Connect Web App and needs an HTTPS URL. Web Apps are limited by region and age, so ask Amanda Le whether Finland is enabled and set a birthday on the account.
- The Web App URL must stay the same between sessions. The HUD and the bridge therefore attach to the **latest active session** by default, with no code to enter, and we need a stable host (see question 2).

**Fallback if there's no hardware or DAT is blocked:** the phone camera plus glasses as a Bluetooth headset, which still gives hands-free audio, plus the phone on a neck lanyard or chest clip. The bridge code and the HUD page are shown separately.

## 7. Timeline

| Helsinki time | Milestone |
|---|---|
| Sat 14:00–15:00 | Plan, team docs, scaffold and agents spawned (**M0**) |
| Sat 15:00–19:00 | **M1, vertical slice on the phone**: consent → live session → coaching → verify_label → verdict spoken. Pushed to main. |
| Sat 19:00–23:00 | **M2, robustness**: snapshot and offline modes, device panel, reconnect, permission flows, HUD, DAT bridge, eval v1 on freighter |
| Sat 23:00–Sun 03:00 | **M3, polish**: accessibility pass (VoiceOver and TalkBack), latency tuning, eval v2 with real photos, deck draft |
| Sun 03:00–06:00 | Deck final, README, demo video script, bug bash |
| **Sun 06:00** | **Submission-ready freeze on main.** Fixes go through PR only. |
| Sun 06:30–08:30 | Hardware rehearsal and backup video |
| **Sun 09:30** | Submit (repo, deck, video). Deadline 10:00. |

## 8. Gemini usage (for the DeepMind prize)
- **In the product**: Gemini Live (bidirectional audio and video, native audio voice, tool calling) for coaching and conversation; Gemini 3.8 Flash for schema-constrained label extraction with per-field confidence; Gemini model explanations for safety verdicts; a fallback model chain.
- **As a workforce**: Gemini image models generate a synthetic dataset of medication and food labels with known ground truth and realistic degradations (blur, glare, rotation, partial view). A Gemini judge scores the coaching quality of transcripts. Gemini generates the drug-interaction and allergen synonym tables (for example "arachis oil" means peanut) that we then review.
