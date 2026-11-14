# HUD spec: Ray-Ban Display Web App (`/hud`)

For the **web engineer**, who builds the page. The glasses engineer owns the packaging and loading (steps in `docs/HARDWARE_NOTES.md` §6).
Source: Meta Web Apps docs v1.0 ([setup](https://wearables.developer.meta.com/docs/develop/webapps/setup/), [build overview](https://wearables.developer.meta.com/docs/develop/webapps/build/overview/), [display and layout](https://wearables.developer.meta.com/docs/develop/webapps/build/display-and-layout/), [input and navigation](https://wearables.developer.meta.com/docs/develop/webapps/build/input-and-navigation/), [app icons](https://wearables.developer.meta.com/docs/develop/webapps/build/app-icons/), [TTS](https://wearables.developer.meta.com/docs/develop/webapps/build/text-to-speech/), [troubleshoot](https://wearables.developer.meta.com/docs/develop/webapps/troubleshoot/)).

## 1. What the platform is
- A normal web page at a **public HTTPS URL**, rendered by a **Chromium browser on the glasses**. No SDK, build step or package is required. The page has **no camera or mic** (camera frames come from the DAT bridge).
- The display is **600 × 600, additive**: **black = transparent** (no light), bright pixels overlay the real world. Treat 600×600 as the *validation target*. **Don't hard-code it.** Size from the viewport.
- Input arrives as standard **`keydown` `ArrowUp/ArrowDown/ArrowLeft/ArrowRight` and `Enter`** from the glasses touchpad and the **Neural Band**. Chromium's **spatial navigation** moves focus between focusable elements, and **Enter clicks the focused one**. The system **Back** gesture calls `history.back()` (max 5 history entries). When there's no history left, Back goes to the native shell. A **middle tap** opens the system menu (Restart / Resume / Permissions). Which Neural Band gesture maps to which key: TBD at the booth (HARDWARE_NOTES §2 Q6).
- Also available: `speechSynthesis` (one en-US voice, through the glasses speaker), `navigator.getBattery()` (the **Display glasses'** own battery), `localStorage`, Service Worker. A wrist-orientation sensor exists but we don't need it.

## 2. URL and session
- Serve the HUD at a **directory-style URL with a trailing slash**: `https://<host>/hud/`. Make `/hud` redirect to `/hud/`. The `.well-known` manifest location resolves relative to that directory.
- Session: per the CEO decision in `docs/TEAM.md`, `session` is **optional**. The URL saved in Meta AI is just **`https://<host>/hud/`** → open `wss://<host>/hud-ws` (no param), and the server attaches it to the latest live session and replays the last verdict and device state. If the page URL has `?session=<id>`, pass it through to `/hud-ws?session=<id>`.
- Don't make anyone type on the glasses during the demo. An optional "Enter session code" `<input type="text">` is fine as a fallback; activating it opens the system composer, and the value arrives through the `change` event.
- Reconnect the WS with backoff (1 s → 2 s → 5 s, capped). Show a small "Reconnecting…" line. Never leave a stale verdict on screen without marking it stale (dim it and add "(old)").

## 3. Required `<head>`
```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">   <!-- do NOT add user-scalable=no -->
<meta name="description" content="HoldUp: is this the right one? Verdicts for the label you're holding.">
<meta name="mrbd-web-app-capable" content="yes">
<meta name="application-name" content="HoldUp">
<title>HoldUp</title>
<link rel="icon" type="image/png" sizes="96x96" href="/hud/icon-96.png"> <!-- PNG > 52×52; SVG favicons NOT supported -->
```

## 4. App icon manifest (optional but nice; name and icon in the glasses app grid)
Serve **`https://<host>/hud/.well-known/meta-wearables-manifest.json`** with `Content-Type: application/json; charset=utf-8`, ≤ 64 KiB:
```json
{
  "version": 1,
  "name": "HoldUp",
  "description": "Hold up a medicine box or food package; HoldUp tells you if it's the right one.",
  "appearance": {
    "theme_color": "#2E7D32",
    "icon": { "src": "../icon-mono.png", "type": "monochrome" }
  }
}
```
- `icon-mono.png`: **transparent background, single-colour mask** (alpha is the shape; colours are ignored), designed for a 64×64 area with padding, ≤ 2 MiB. It resolves to `/hud/icon-mono.png`.
- Meta's generator/previewer: https://meta.github.io/meta-ray-ban-display-ui-toolkit-web/utilities/app-icons/
- With the Vite/Express setup: put the files under `web/public/hud/` (including `web/public/hud/.well-known/…`). **Server change needed:** `server/src/index.ts` serves `web/dist` with `express.static(dist, …)`, whose default `dotfiles: "ignore"` makes `/hud/.well-known/meta-wearables-manifest.json` fall through to the SPA `index.html` (wrong content type). Add `dotfiles: "allow"`, or an explicit route for that path with `Content-Type: application/json; charset=utf-8`. After `vite build`, check that `web/dist/hud/.well-known/meta-wearables-manifest.json` exists, and `curl -i https://<tunnel>/hud/.well-known/meta-wearables-manifest.json` returns JSON.

## 5. Layout and visual rules
- `html, body { background:#000; margin:0; height:100%; }`. Black is invisible on the glasses, so draw **bounded cards**, not full-screen colour.
- One screen, one card, no scrolling in the normal state. Use relative sizes (`rem`, `%`, `clamp()`), and keep controls well inside the edges (system UI and focus rings live there).
- Verdict card (from `{type:"verdict"}`):
  - Level as **text + icon + colour** (never colour alone): `✓ RIGHT ONE` (green #66BB6A), `⚠ CHECK` (amber #FFCA28), `? NOT SURE` (light blue #4FC3F7), `i INFO` (white).
  - `verdict.headline` (≤ 8 words) in very large type (~2.2–2.8rem, weight 700). Then 1–2 key fields (`read.product.value`, `read.strength.value`) at ~1.4rem. `reasons[0]` small.
- Coach cue (`{type:"coach"}`): one big arrow/glyph + `text` ("Turn it left"), auto-clear after ~3 s.
- Status strip (bottom, small): live state, `device` battery / "glasses camera" vs "phone camera", WS state. Optionally the Display's own battery via `navigator.getBattery()` (feature-detect it).
- Test readability over bright and dark backgrounds (Simulator scenes). Prefer thick strokes and high luminance. Avoid thin grey text.

## 6. Controls (Neural Band / touchpad)
- Use **native `<button>`s only**, e.g. a row of three: **Repeat** · **I took it** · **Dismiss**. Each sends `{type:"event", name:"repeat"|"log_dose"|"dismiss"}` on `click`.
- Let the browser handle focus. **Don't** build a custom focus manager, use positive `tabindex`, synthesize clicks, or call `preventDefault()` on arrows/Enter. Keep `:focus-visible` obvious (3px outline + offset). After a new verdict arrives, `focus()` the most likely action (**I took it** for `match`, **Repeat** otherwise).
- Don't push history entries for transient states, so Back cleanly exits the app. If you add a settings/code-entry view, one `pushState` for it is fine.
- No hover-only UI. No drag (we don't set `touch-action: none`).

## 7. Speech
The phone's Gemini Live audio already plays through the glasses speakers (Bluetooth). **Don't speak verdicts from the HUD by default** (it would double up). Add an optional "Speak on HUD" toggle that uses `speechSynthesis` (attach handlers to the utterance, not to `speechSynthesis`). It's useful if the phone audio path fails. Keep sensitive medication details short. The speaker is audible to bystanders.

## 8. Test checklist (before handing to Momin)
1. Desktop Chrome at a **600×600 viewport**, no console errors, no horizontal overflow.
2. Start Chrome with `--enable-spatial-navigation` (quit Chrome first, or use `--user-data-dir=/tmp/x`). The arrows reach every button and Enter activates each one **once**.
3. [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll) extension: additive preview, quality checklist (viewport meta, favicon, focus targets, overflow, focus styles). Its **View on Glasses QR** is a backup way to install the app on the glasses.
4. Fake data: `/hud/?session=demo` should render a sample verdict when the WS sends one. A `?mock=1` mode that cycles match → warning → unsure every 4 s is very useful for the hardware slot.
5. On device: Meta AI app → App Settings → Apps → Web Apps → Connect Web App → `https://<tunnel>/hud/` → Save. Open it from the app grid. Reload with middle tap → Restart.
