# HoldUp states reel

`states-reel.webm` (1:24.4, 12.0 MB, 990x844). Left: phone app at 390x844 (`/?mock=1`). Right: Display HUD at 600x600 (`/hud/?mock=1`), same browser context, so the mock HUD mirror shows the same check.
The yellow caption bar is injected by `scripts/record-states.mjs`; it is not part of the app. Everything runs in **mock mode** (scripted server, no Gemini calls), with Chromium's fake camera.

| # | State | Starts at |
|---|---|---|
| 1 | Consent | 0:00.6 |
| 2 | Camera permission denied → recovery | 0:08.8 |
| 3 | Live check → coaching → verdict | 0:19.2 |
| 4 | Drop connection → snapshot → auto-reconnect | 0:37.4 |
| 5 | Offline → offline barcode banner → back online | 0:46.1 |
| 6 | Glasses taken off → phone camera fallback | 0:57.1 |
| 7 | "Which one?" scene verdict | 1:05.6 |

How each state is produced:
1. Consent: fresh profile, the welcome screen and three privacy cards, then "I agree".
2. Camera denied: a browser without camera permission (headless Chromium dismisses the prompt), so "Allow camera and microphone" fails and the recovery screen appears.
3. Live check: the big button starts the mock Live session; it coaches (turn around, left, closer, hold still) and gives a verdict. The device panel is open, with RTT and the live socket state.
4. "Drop connection" (device panel demo control): snapshot mode, then the socket reconnects by itself.
5. `context.setOffline(true)`: the offline banner (saved medicines by barcode only), then `setOffline(false)`: "Back online", reconnecting.
6. "Glasses on" + glasses camera source, then "Glasses off face": the source flips to the phone camera.
7. Typed "Which one is my evening pill?": the "Which one?" scene verdict.

Regenerate: `npm run build && (PORT=8790 npm -w server run start &) && node scripts/record-states.mjs http://localhost:8790`
Generated 2026-11-15T00:55:23.664Z.
