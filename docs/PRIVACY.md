# HoldUp: data flow and privacy

This page describes what the code on `main` actually does. Every statement points to a file, so a reviewer can check it. If the code changes, update this page.

HoldUp is a hackathon prototype, not a medical device. It never stores pictures, audio or what you said on the server, and your medicine list lives on your phone.

## 1. What moves, and where it goes

```
 phone (PWA)                      HoldUp server (laptop, in memory)            Google Gemini API
 ─────────────                    ──────────────────────────────────           ─────────────────
 camera frames (JPEG) ──WSS──►  frame ring: last 8 frames  ──────────────►  Live API: ≤ ~1 frame/s
 mic audio (PCM16)    ──WSS──►  passed straight through    ──────────────►  Live API: audio
 typed question       ──WSS──►  passed straight through    ──────────────►  Live API: text
 profile (on start)   ──WSS──►  held in memory for the session ──(names)──►  Live API system instruction
                                verify_label: 1–2 sharpest frames + question ►  Flash: label read (JSON)
                       ◄──────  reply audio, captions, verdicts ◄───────────  Live API
 glasses bridge: JPEG ─HTTPS─►  /ingest/frame: used only while the phone chose the glasses camera
 HUD (Display)       ◄──WSS───  verdicts, cues, status, device state
```

| Data | Leaves the phone? | Sent to Gemini? | Kept where, for how long | Code |
|---|---|---|---|---|
| **Camera frames** (phone) | Yes. Only while a check is running, the app is in the foreground and the phone camera is the source. JPEG, ≤ 768 px long side, quality 0.5–0.7, about 1 per second (less on a slow network). | Yes. Gemini Live gets at most about 1 frame per second. The label reader (Gemini Flash) gets the 1–2 sharpest recent frames, when you ask and also speculatively while the check runs. | Server: a **memory-only** ring buffer of the last 8 frames per session, plus the latest label read. Both are cleared when the phone disconnects and are never written to disk. Phone: a small in-memory ring for snapshot mode, cleared on stop. | `web/src/lib/frames.ts`, `checker.ts`; `server/src/verify.ts` (FrameRing), `speculate.ts`, `index.ts` (`dropFrames` on close) |
| **Camera frames** (glasses, via the Android DAT bridge) | Yes, from the bridge app to `/ingest/frame`, at most about 1 per second while "Start streaming" is on. | As above. | Used only if the latest live session chose the **glasses camera**. Otherwise the frame is dropped immediately. | `android-dat/…/Uploader.kt`; `server/src/index.ts` (`hub.source === "glasses"`) |
| **Microphone audio** | Yes, while a check runs in live mode (16 kHz PCM, ~100 ms chunks). | Yes, streamed to Gemini Live. | Not stored. It passes through the server without being buffered. | `web/src/lib/audio.ts`; `server/src/live.ts` (`audio()`) |
| **Typed questions** | Yes. | Yes (Gemini Live, or the reader in snapshot mode). | Not stored. | `live.ts` (`text()`), `verify.ts` |
| **Transcripts and captions** | They come *from* Gemini. | They are produced by Gemini. | Shown on the phone (the last 40 lines, in memory only, gone on reload). Not stored on the server, and **redacted from the server log**. | `checker.ts` (`MAX_CAPTIONS`), `server/src/log.ts` |
| **Profile**: medicines (name, ingredient, strength, schedule, barcode, notes), allergies, avoid list, language | Yes, inside the `start` message of each check, and in `/api/verify` in snapshot mode. | **Partly**: the Live system instruction contains medicine names, ingredients, schedule, allergies and the avoid list. Strengths, barcodes, notes and the dose log are **not** sent to Gemini. The label reader never sees the profile. | Phone: `localStorage` (`holdup.profile`). Server: **memory only**, while the session exists. A session is removed 10 minutes after its last activity with no phone connected. | `web/src/lib/storage.ts`; `server/src/live.ts` (`systemInstruction`), `hub.ts` (GC) |
| **Dose log** ("I took it") | Yes. The phone sends a `log_dose` event, so the server's in-memory copy knows ("you already took it today"). | No (Gemini only gets a short "confirm in a few words" prompt with the medicine name). | Phone: `localStorage`, the last 200 entries. Server: memory, as for the profile. | `storage.ts` (`logDose`), `live.ts` (`logDose`) |
| **Verdicts** (headline, spoken answer, the fields read, confidences) | They come from the server. | They are built from Gemini's read by deterministic rules (`safety.ts`, no model). | Phone and HUD: on screen only. Server: the last verdict per session in memory (to replay to a HUD that connects late). | `hub.ts` (`lastVerdict`) |
| **Spoken answer text** for `/api/tts` | Only if a client calls it. The current phone app uses the browser's own voice instead. | Yes, if called (Gemini TTS). | Not stored. | `server/src/index.ts` (`/api/tts`) |
| **Consent record** | No. | No. | Phone `localStorage`: `holdup.consent` = `{version, timestamp}`. | `storage.ts` |
| **Settings, session code, HUD "speak" toggle** | The 4-character session code is in the WebSocket URL. | No. | Phone `localStorage`: `holdup.settings`, `holdup.session`; HUD: `holdup.hud.speak`. | `storage.ts`, `Hud.tsx` |

## 2. What the server writes to disk

- **Nothing that contains content.** No images, audio, transcripts, profiles or verdicts.
- **Console log** (`server/src/log.ts`): event names, 8-character session-ID prefixes, model names, enums, numbers and timings. A deny-list redacts any field named like `text`, `transcript`, `frame`, `audio`, `profile`, `speech`, `headline`, `question`, `prompt`, `key`… Any string longer than 48 characters is replaced with `[redacted:N ch]`, and API keys are masked.
- **Usage ledger** (`server/logs/ledger.jsonl`, gitignored; `server/src/ledger.ts`): one line per Gemini call with timestamp, feature, model, token counts, latency, ok/error kind, number of frames. For Live sessions it also records duration, first-audio latencies, number of tool calls and the stop reason. **No content.** It is served in aggregate at `/api/stats`. There is no automatic retention limit: delete the file to clear it.

## 3. Consent, control and deletion

- **Consent first.** On first run, three plain-language cards explain what is captured, where it goes and what stays on the phone, before any camera or microphone prompt. "Not now" leaves the camera off; the profile can still be edited. (`web/src/screens/Onboarding.tsx`)
- **Permissions in context**, asked separately for camera and mic, with a per-platform recovery screen and a photo or typed-question path if refused.
- **Camera on only during a check.** You start it, and there is a **CAMERA ON** badge, a start sound and a vibration. The camera stops on **Stop**, **auto-stops after 45 s** without a coaching cue, verdict or speech (phone), or after 45 s without frames (server), and is **paused while the app is in the background**. (`checker.ts` `AUTO_STOP_MS`, `onVisibility`; `live.ts` idle timer)
- **Withdraw consent** in Privacy: the camera stays off until you agree again.
- **Delete all my data** (Privacy tab): removes every `holdup.*` key from `localStorage`, clears `sessionStorage` and the offline app cache. There is nothing else to delete server-side, apart from the content-free ledger. (`storage.ts` `deleteAllData`)

## 4. Bystanders

- Both prompts tell the models to **ignore people and faces and never describe a person** (`server/src/prompts/live.md`, `shared/verify_prompt.md`). The Live model answers questions about people with "I only help with labels".
- Frames are **not** filtered for faces before sending. A person in the background of a frame does reach Gemini, but is never described or stored by HoldUp.
- On the glasses, the hardware **capture LED** is lit while the DAT camera stream runs. "Stop streaming" in the bridge turns it off.
- The Display HUD's optional "Speak" toggle is off by default, because the glasses speaker can be heard by people nearby.

## 5. Third parties

- **Google Gemini API** receives the frames, audio, typed questions and profile fragments listed above. Under Google's terms, the paid tier does not use prompts and responses to improve Google's products, while the unpaid tier may. We have **not confirmed** that the hackathon key is on a paid project, so we make **no** "not used for training" claim for this prototype. A pilot would run on a paid, billing-enabled project with a data-processing agreement.
- **Cloudflare** (quick tunnel, `npm run tunnel`) terminates TLS between the phone and the laptop for the demo. A production deployment would use its own TLS endpoint.
- The **Meta AI app and Meta glasses firmware** handle pairing, the DAT camera stream and Bluetooth audio under Meta's own terms. HoldUp sends nothing to Meta.

## 6. Known limitations (demo build; fix before any pilot)

- **No authentication.** Anyone with the tunnel URL can open `/live`, read `/api/stats`, and, because the session is optional, attach a HUD to the **latest** session via `/hud-ws` and see its verdicts, or post frames to `/ingest/frame` while that session uses the glasses camera. Pilot fix: pair the phone, bridge and HUD with a per-user token.
- The profile is kept in server memory for up to 10 minutes after the phone disconnects (so that a reconnect can resume). A pilot should drop it on disconnect, or encrypt it per session.
- The ledger has no rotation.
- Gemini data handling depends on the API tier (see section 5).
