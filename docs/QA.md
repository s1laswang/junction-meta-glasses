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

Only #4 (mitigated: set `HOLDUP_KEY` on any public tunnel) and #13 (check phone width on a real device) remain.

| # | Sev | Area | Finding | Where | Suggested fix |
|---|---|---|---|---|---|
| 4 | **Medium** | S | **No authentication on the public tunnel.** `/hud-ws` without `?session` attaches to the latest session and receives its verdicts (medicine names). `/ingest/frame` accepts frames for the latest session (only while it uses the glasses camera). `/api/stats` is open. Fine for a supervised demo; it must be fixed before any pilot. | `server/src/index.ts`, `hub.ts` | A per-pairing token in the HUD URL, bridge and phone. Documented in PRIVACY.md §6. |
| 13 | Info | — | Not verified at phone width: headless Chrome on macOS can't render narrower than 500 px, so the 390 px screenshots were inconclusive (this tool artifact was confirmed with a test page). **Check at 360–390 px on a real phone in test slot 1**, including VoiceOver/TalkBack on the check screen. | | |

## Fixed (verified in code on main)

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 14 | — | Fixed after the bug bash (Sat 14 Nov evening). #1: offline barcode follows the dose rules (`web/src/lib/verdicts.ts`). #2: "Back to live" re-sends start. #3: snapshot verifies by session with glasses frames. #5: language picker (EN/FI/SV). #6: salt names stripped. #7: profile edits re-sent. #8–#11: confirm on remove, a11y labels, auto-stop timer. #12: ledger rotates at 5 MB. #14: bridge compiled on freighter, 4/4 tests. | Verified: server 60/60, web 213/213, smoke 13/13 |
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
