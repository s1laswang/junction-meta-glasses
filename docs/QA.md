# HoldUp QA: bug bash (Sat 14 Nov, ~18:30)

Scope: a read-through of `server/src` and `web/src` on `main` @ `e0b0c26`, plus a quick run on the demo laptop:

- `npm run typecheck`: ✅ clean
- `npm -w server test`: ✅ 18 / 18
- `npm run build`: ✅
- `vite preview` with headless Chrome in `?mock=1` (consent, check screen, `/hud/?mock=1` at 600×600): ✅ renders. The HUD verdict cards look right.

No real Gemini session, glasses or phone were tested here. Hardware and phone checks belong in test slot 1.

Severity: **High** = could give a wrong or unsafe answer, or break the demo. **Medium** = a visible failure on a plausible path, or a privacy gap. **Low** = polish.
For the CEO to route: S = server, W = web, H = HUD, G = glasses bridge.

## Open

| # | Sev | Area | Finding | Where | Suggested fix |
|---|---|---|---|---|---|
| 1 | **High** | W | **The offline barcode "match" ignores the dose log and says "Yes" even when today's doses are already taken.** `matchVerdict` always returns level `match` with "Yes. … You already logged a dose today." The online rules (`safety.ts`) return a **warning** "already taken today" once `taken >= schedule.length`. This could prompt a double dose while offline. | `web/src/lib/verdicts.ts` `matchVerdict` | Mirror the server rule: count today's doses against `schedule.length`. When the limit is reached, use level `warning` and the headline "already taken today", with speech that doesn't start with "Yes". |
| 2 | **Medium** | W/S | **"Back to live" after Gemini Live failed leaves a dead live mode.** After the server sends `status: degraded`, its `LiveProxy` is finished. The device panel's "Back to live" (`toggleSnapshotMode`) only flips the client mode. No new `start` is sent, so frames and audio go nowhere, and typed text gets the error "send start first". | `checker.ts` `toggleSnapshotMode`, `onServerStatus` | When switching to live while `serverLive` is `degraded` or `closed`, re-send `buildStart()` (the server creates a fresh `LiveProxy` when the old one is inactive), or reconnect the socket. |
| 3 | **Medium** | W | **Snapshot and offline modes don't work with the glasses camera.** `snapshot()` uses the phone's own frame ring, and barcode scanning reads the phone `<video>`. With the source on "Glasses camera" the user hears "I don't have a picture yet" or gets nothing. The server already has glasses frames in `hub.ring`. | `checker.ts` `snapshot`, `startBarcodeScan` | Short term: when entering snapshot or offline mode with the glasses source, auto-switch to the phone camera and announce it. Better: add an `/api/verify?session=` path that uses the server ring. (The demo script works around it.) |
| 4 | **Medium** | S | **No authentication on the public tunnel.** `/hud-ws` without `?session` attaches to the latest session and receives its verdicts (medicine names). `/ingest/frame` accepts frames for the latest session (only while it uses the glasses camera). `/api/stats` is open. Fine for a supervised demo; it must be fixed before any pilot. | `server/src/index.ts`, `hub.ts` | A per-pairing token in the HUD URL, bridge and phone. Documented in PRIVACY.md §6. |
| 5 | **Medium** | W | **Live always runs in English.** `buildStart` hard-codes `lang: "en"`, and the profile's `lang` has no UI. Finnish or Swedish speakers can't choose their language. The prompt only says to switch if the user does. | `checker.ts` line ~197 | Send `loadProfile().lang`, and add a language picker (en / fi / sv) on the Profile tab. |
| 6 | Low | S/W | **Spoken medicine name uses the stored ingredient.** With the demo profile, the real server says "Yes, **Amlodipine besilate** 5 mg, your evening pill", while mock mode, the HUD headline and the deck say "Amlodipine 5 mg". `safety.ts` names the med as `med.ingredient \|\| med.name`. | `server/src/safety.ts`, `web/src/lib/storage.ts` `demoProfile` | Either prefer `med.name` in speech, or set the demo profile ingredient to "amlodipine" (likewise "metformin", "atorvastatin"). |
| 7 | Low | W | **Profile edits made during a running check don't reach the server** until the next `start` (on reconnect or a new check). The server's safety check uses the profile from the start of the session. | `checker.ts` (`buildStart` only on open) | Re-send `start` (the server treats it as a profile update while Live is active) whenever the profile changes during a check. |
| 8 | Low | W | **"Remove" medicine has no confirmation** and sits in the same row as Save. It's destructive, and the deleted med's history becomes an orphaned `medId` in the dose log. | `Profile.tsx` `MedEditor` | Use `confirm()` like "Delete all my data", or an undo toast. |
| 9 | Low | W (a11y) | The demo-control toggles combine `aria-pressed` with a label that changes ("Slow network off" → "on"), so a screen reader says "Slow network off, toggle button, not pressed". | `DevicePanel.tsx` | Keep the label static ("Slow network") and let `aria-pressed` carry the state. |
| 10 | Low | W (a11y) | The question box has only a placeholder as its visible label ("Type a question"). The `sr-only` label is fine for screen readers, but low-vision users lose the hint once they type. | `Live.tsx` `.textask` | Add a visible label or helper text above the input. |
| 11 | Low | W | The client 45 s auto-stop timer resets only on coach cues, verdicts, user speech and typed text, not on assistant speech. A long assistant answer near the limit can be cut off by the auto-stop. | `checker.ts` `armAutoStop` | Also re-arm on assistant transcripts and while `speaking` is true. |
| 12 | Low | S | The ledger (`server/logs/ledger.jsonl`) has no rotation or retention limit. It's metadata only, but it grows without bound. | `server/src/ledger.ts` | Rotate it daily, or cap the size. |
| 13 | Info | — | Not verified at phone width: headless Chrome on macOS can't render narrower than 500 px, so the 390 px screenshots were inconclusive (this tool artifact was confirmed with a test page). **Check at 360–390 px on a real phone in test slot 1**, including VoiceOver/TalkBack on the check screen. | | |
| 14 | Info | G | Android bridge still not compiled (HARDWARE_NOTES findings). The glasses-off fallback depends on DAT reporting `donState`; when it is unknown the server now keeps `worn: null`, so no false fallback is triggered (fixed on main). | | |

## Fixed (verified in code on main)

| # | Sev | Finding | Fix |
|---|---|---|---|
| F1 | High | **A dose logged from the HUD never reached `/live`.** The server's in-memory profile missed it, so a second check in the same session still said "You haven't taken it today". Also, a dose logged by voice (Gemini `log_dose` tool) never reached the phone's on-device log. | `c8b6bb0` (CEO): HUD `repeat`/`log_dose` always go to `/live`, and voice-logged doses reach the phone as `{type:"dose_logged"}`. |
| F2 | Medium | HUD did not follow HUD_SPEC: missing `mrbd-web-app-capable` and PNG favicon, custom arrow-key focus manager, history handling that trapped Back. | `46eddda` (web): spec head tags, wearables manifest and mono icon, native focus, one history entry per verdict. |
| F3 | Medium | `/ingest/state` coerced unknown `worn` to `false`, which would wrongly trigger "glasses taken off". | `5796b2b` (server): `worn: boolean \| null`. |
| F4 | Medium | Glasses frames from the bridge were injected into the latest session even when the phone was using its own camera. | `a803512`: the server only accepts `/ingest/frame` while the phone's chosen source is `glasses`. |
| F5 | Info | PLAN.md said ~80,000 visually impaired people in Finland. The NKL/THL figure is ~55,000. | `c8b6bb0`; sources in `docs/RESEARCH.md`. |

## Re-test list for hardware test slot 1 (19:30)
1. Real Live session: coach → match → "I took it" from the **HUD**, then ask again: the answer must be "already taken today" (F1).
2. Airplane mode on the phone with the phone camera: offline banner, then a barcode match on the prop box (its real barcode must be saved in the profile).
3. Live down: there's no env switch that fails only Live (`LIVE_MODEL` is followed by the built-in fallbacks). Use mock mode's "Gemini down" for the UI path, and on the real server test "Force snapshot" → check → "Back to live" (bug 2 needs a real `degraded` status, so it may only show up under a real outage).
4. TalkBack on: start a check; the verdict is announced once (not duplicated by the captions); focus lands on the verdict heading.
