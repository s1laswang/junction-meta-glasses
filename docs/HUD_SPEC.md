# HoldUp Ray-Ban Display HUD Specification (`docs/HUD_SPEC.md`)

Engineering specification for the HoldUp in-lens Display Web App (`/hud`), paired with the phone PWA (`/live`), the Android Device Access Toolkit bridge (`android-dat/` -> `/ingest/*`), and the Node/TypeScript session hub (`server/src/hub.ts`).

Target runtime: **Meta Ray-Ban Display** in-lens Chromium Web App (firmware `v125+`, or `V128+` when paired alongside DAT SDK `1.0.1`; Meta AI app `v272+`, or `V292+` for DAT) with optional **Meta Neural Band** and built-in **temple touchpad** input. Referenced from `docs/HARDWARE_NOTES.md` (Section 6) and `docs/TEAM.md` (`/hud-ws` interface contract) for hardware test slots and booth review with Meta Web Apps mentors (Ming Lin, William La, Amy Lee, Odil Nikadambaev) and DAT Android contact (Amanda Le).

---

## 1. Optical and Waveguide Layout Rules (600 x 600 Additive Display)

### 1.1 Pure `#000000` Canvas = Transparent Waveguide
- **Additive optics**: Ray-Ban Display projects light into an in-lens waveguide combiner with a nominal **600 x 600** CSS pixel viewport. Pure black (`#000000` / `rgb(0, 0, 0)`) emits zero light and leaves the lens optically transparent.
- **Unobstructed peripheral and forward sight**: `html`, `body`, and `#root` on `/hud` enforce `background-color: #000000`, `margin: 0`, and `overflow: hidden`. Full-viewport fills, translucent gray scrims, drop shadows, and `backdrop-filter` blurs are prohibited because they inject stray light across the combiner and obscure the wearer's hands, cane, pill bottle, or room environment.
- **Standby transparency**: When idle or dismissed, `/hud` renders a pure `#000000` canvas (zero lit pixels except an optional corner status dot `<= 1%` area during active connection transitions) so the wearer's natural sight is completely clear between checks.
- **Responsive viewport sizing**: Per Meta Web Apps layout rules, `/hud` never hard-codes `600px` widths or heights. Layouts use `100vw`, `100vh`, `vmin`, CSS Flexbox, and `clamp()` typography so the same route scales cleanly on the 600 x 600 waveguide, the Chrome Ray-Ban Display Simulator, and laptop/phone preview viewports with zero scrollbars.

### 1.2 Bounded High-Contrast Cards (`<= 65%` Lit Pixel Fill Budget)
- **Waveguide bloom and glare control**: Illuminating large solid regions on an additive waveguide causes optical haloing (veiling glare), reduces perceived edge sharpness, and triggers visual fatigue or photophobia in low-vision wearers (cataracts, macular degeneration, diabetic retinopathy).
- **Lit pixel fill budget**:
  - **Verdict state**: Bounded card container occupies **at most `<= 65%` of total viewport area**, leaving `>= 35%` pure `#000000` outer margin and negative space. Card interiors stay dark (`#000000` to `#060A0F`) and draw crisp `3px` to `4px` luminous borders rather than solid bright background floods.
  - **Coaching state (`CoachCue`)**: Compact centered prompt occupies **`<= 35%` of viewport area** with a bold directional glyph and short cue text (`<= 6` words from the `show_cue` tool in `server/src/live.ts`, capped at 60 characters).
- **Low-vision waveguide typography**:
  - Wide-aperture geometric/humanist sans-serif stack (`Inter`, `system-ui`, `-apple-system`, `sans-serif`) at `font-weight: 700` to `800`. Thin strokes (`< 2px`) and light weights (`< 500`) are disallowed because they shimmer on waveguide gratings.
  - Headline scale: `clamp(32px, 6.8vmin, 46px)`, `line-height: 1.18`, `letter-spacing: 0.015em`.
  - Badge and button label scale: `clamp(20px, 3.8vmin, 26px)`, uppercase tracking `0.06em` on status badges, contrast ratio `>= 10:1` against `#000000`.

### 1.3 Redundant Multimodal Encoding (`VerdictLevel`)
Low-vision wearers, color-vision-deficient users (protanopia, deuteranopia, tritanopia, monochromacy), and outdoor wearers facing bright sky or foliage backgrounds must **never** rely on color alone. Every `VerdictLevel` in `shared/types.ts` (`"match" | "warning" | "unsure" | "info"`) simultaneously pairs **four independent channels**:

1. **Distinct outer/badge geometric silhouette** (distinguishable even under severe refractive blur)
2. **High-stroke vector icon** (`>= 3.5px` stroke weight)
3. **Explicit uppercase text badge** (`MATCH`, `WARNING`, `UNSURE`, `INFO`)
4. **High-luminance additive color** (avoiding dim saturated `#FF0000` or `#0000FF` primaries that lose luminance on RGB waveguides)

| `VerdictLevel` | Geometric Shape | Icon | Text Badge | Luminous Accent (`border` / `badge`) | Headline Ink | Deterministic Trigger (`server/src/safety.ts`) |
|---|---|---|---|---|---|---|
| `match` | **Circle / Pill** (`border-radius: 999px` badge + solid left bar) | Bold Checkmark | `MATCH` | `#00E676` (vivid emerald) | `#FFFFFF` | Saved medication matched (`NAME_MIN_CONF >= 0.6`), `sameStrength` verified (`STRENGTH_MIN_CONF >= 0.8`), not expired, no allergy/avoid hit, `taken < perDay` today. |
| `warning` | **Triangle** (`polygon` warning badge + double/angled frame) | Exclamation `!` | `WARNING` | `#FF5252` / `#FF6B35` (high-luma coral-amber red) | `#FFFFFF` | Allergen hit (`allergenHits`), drug class avoid hit (`avoidHits`, e.g., NSAIDs), medicine not on profile list, wrong strength, expired (`isExpired`), or `taken >= perDay` today. |
| `unsure` | **Diamond** (45-deg rotated square badge + dashed border) | Question `?` | `UNSURE` | `#FFD600` (vivid amber-yellow) | `#FFFFFF` | `kind === "unreadable"`, name confidence `< 0.6`, strength missing or confidence `< 0.8`, or food allergen panel confidence `< 0.6` (`ALLERGEN_MIN_CONF`). Never guesses doses. |
| `info` | **Square** (crisp 90-deg square badge + single solid border) | Info `i` | `INFO` | `#38BDF8` (luminous sky-cyan) | `#FFFFFF` | Food item with readable allergen panel (`>= 0.6`) containing none of the user's listed allergens, or general non-medication item read. |

### 1.4 Strict Headline Word Cap (`<= 8` Words)
- **Server enforcement**: Every `Verdict.headline` emitted by `checkLabel` in `server/src/safety.ts` passes through `clampHeadline(s: string)`, which trims whitespace, splits on `/\s+/`, caps output at **at most `8` words**, and strips trailing punctuation (`[,.;:]`).
- **Client guard**: `/hud` applies the identical `<= 8` word clamp at render time so snapshot/fallback payloads can never overflow 3 lines inside the 600 x 600 card.
- **Spoken parity**: While `/hud` displays the `<= 8` word `headline` (plus optional secondary metadata chip such as strength or `Taken today` status), spoken audio uses `Verdict.speech` (`<= 2` sentences via `clampSpeech` in `server/src/safety.ts`) over Bluetooth HFP on the paired phone or local `window.speechSynthesis` (`en-US` single voice on Ray-Ban Display) if running standalone.

---

## 2. Neural Band and Temple Touchpad Input Mapping

Ray-Ban Display Web Apps have no camera or raw microphone stream (`getUserMedia` is unavailable; camera frames arrive via `android-dat/` or phone fallback). All on-glasses interaction uses **Meta Neural Band** sEMG gestures and the **temple touchpad**, which the glasses Chromium runtime translates into standard DOM keyboard and history events.

### 2.1 Hardware Gesture to DOM Event Mapping

| Wearer Input (Neural Band / Temple) | Browser Delivery | `/hud` Handler Behavior |
|---|---|---|
| Directional swipe Left / Up | `keydown` (`ArrowLeft`, `ArrowUp`) | Move focus to previous button in cyclic 1D action bar: `(index - 1 + count) % count`; call `button.focus()` and `event.preventDefault()`. |
| Directional swipe Right / Down | `keydown` (`ArrowRight`, `ArrowDown`) | Move focus to next button in cyclic 1D action bar: `(index + 1) % count`; call `button.focus()` and `event.preventDefault()`. |
| Index-thumb pinch / Temple tap | `keydown` (`Enter`) + synthesized `click` | Activate currently focused `<button>` and send `{ "type": "event", "name": ... }` on `/hud-ws`. Guarded by a `150 ms` per-action debounce so `Enter` + synthesized `click` never double-fires. |
| System Back gesture | `window.history.back()` (`popstate`) | If a verdict card is active (`#verdict` state), dismiss card back to `#000000` standby. From root standby, exits cleanly to the glasses app grid. |
| Temple middle tap | OS Universal Web App Menu | Handled natively by Ray-Ban Display OS (`Restart` / `Resume` / `Permissions`). Not intercepted by page JS. |

### 2.2 Spatial Focus Compatibility and Action Strip Rules
- **1D horizontal button strip**: Because Chromium on Ray-Ban Display performs spatial focus navigation alongside `keydown` events, interactive controls on a verdict card are arranged in a single horizontal flex row of real `<button type="button">` elements (`min-height: 64px`, `gap: 16px`) at the bottom of the bounded card.
- **Unmistakable focus ring**: The focused button renders a `4px solid #FFFFFF` outline with `outline-offset: 3px` and high-contrast inverted or bright-accent label styling (`>= 10:1` contrast) so low-vision wearers and the Display Simulator clearly show focus position.
- **Available actions and outbound `/hud-ws` messages** (`docs/TEAM.md`, `server/src/index.ts` `onHud`, `server/src/live.ts` `LiveProxy.handleEvent`):
  1. **Repeat** (`{ "type": "event", "name": "repeat" }`): Re-emits `lastVerdict` and prompts Gemini Live to repeat the last answer word for word. **Default initial focus (`index = 0`)** whenever a verdict opens so an accidental pinch repeats audio safely rather than mutating dose records.
  2. **Log Dose** (`{ "type": "event", "name": "log_dose" }`): Rendered **only** when `verdict.level === "match"`, `Boolean(verdict.matchedMedId)`, and `!verdict.takenToday`. Appends `{ medId, ts }` to `hub.profile.doseLog`, broadcasts an updated `{ "type": "verdict", "verdict": { ...lastVerdict, "takenToday": true } }` (which immediately hides `Log Dose` on `/hud`), and triggers a 3-to-4 word spoken confirmation. Hidden on `warning`, `unsure`, and `info` verdicts so unsafe or unmatched items cannot be logged.
  3. **Dismiss** (`{ "type": "event", "name": "dismiss" }`): Clears the verdict card locally back to the `#000000` transparent standby canvas (`"dismiss"` affects `/hud` locally per `server/src/index.ts`).

### 2.3 History Budget (`<= 5` Entries) and System Menu Recovery
- **Hardware history cap**: The Ray-Ban Display Web App container caps session history at **`5` entries**. Pushing a history entry per WebSocket event or per verdict would saturate the stack and break Back-to-exit behavior.
- **2-entry flat state machine (`<= 5` invariant)**:
  - **Entry 1 (Root `/hud`)**: Standby / coaching view (`history.state = { hudView: "standby" }`). Invoking system Back here exits the Web App to the glasses launcher.
  - **Entry 2 (Active Verdict)**: When transitioning from `standby` to a `verdict`, `/hud` calls `history.pushState({ hudView: "verdict" }, "")` **once**. Subsequent verdicts arriving while already in `verdict` state call `history.replaceState({ hudView: "verdict" }, "")`. Total history depth never exceeds **`2` entries** (`<= 5`).
  - **`popstate` listener**: When system Back pops Entry 2 back to Entry 1, `/hud` clears the active verdict card to `#000000` standby without tearing down the `/hud-ws` WebSocket.
- **Middle-tap OS menu (`Restart` / `Resume` / `Permissions`)**:
  - Selecting **Resume** closes the OS overlay and returns focus to the active `/hud` button.
  - Selecting **Restart** reloads `https://<tunnel>/hud` from scratch; zero-code session binding and server replay (Section 3) restore the active session state automatically in under one round-trip with no code entry.

---

## 3. Zero-Code Session Binding and Late-Join Replay

Entering random session codes on smart glasses is error-prone and inaccessible, and editing the URL inside Meta AI `Connect Web App` between runs breaks hands-free flow. HoldUp binds `/hud` to the wearer's active session automatically with zero query parameters required.

### 3.1 Launch URL and WebSocket Upgrade
- **Default single-wearer URL**: `https://<tunnel>/hud` -> opens `wss://<tunnel>/hud-ws` (or `ws://localhost:5173/hud-ws` -> `:8787` via Vite proxy during local dev).
- **Optional bench-isolation override**: `https://<tunnel>/hud?session=<id>` -> opens `wss://<tunnel>/hud-ws?session=<id>`, pinning that HUD to `getOrCreateHub(id)` when multiple demos share one server.
- **Server upgrade (`server/src/index.ts`)**: `wssHud` (`maxPayload: 64 * 1024`, i.e., `64 KiB`) upgrades `/hud-ws`, extracts optional `url.searchParams.get("session")`, and registers the socket via `addHud(ws, session)` in `server/src/hub.ts`.

### 3.2 `floatingHuds`, `markLatest`, and Phone HUD Presence
1. **HUD connects without `?session=` (`addHud(ws, null)`)**:
   - Socket is added to `floatingHuds` (`Set<WebSocket>` in `server/src/hub.ts`).
   - `hudsFor(hub)` includes `[...hub.huds, ...floatingHuds]` whenever `hub.id === latestId`.
   - If a live session hub already exists (`latestHub()`), `hub.replay(ws)` runs immediately.
   - If no `/live` session has started yet, `/hud` stays on `#000000` standby; if the Android DAT bridge has already posted `POST /ingest/state`, the cached `orphanDevice` state is sent immediately (`{ "type": "device", "device": orphanDevice }`).
2. **Phone starts or switches `/live` session (`markLatest(hub)`)**:
   - When the phone sends `{ "type": "start", "profile": ..., "lang": ..., "voice": ..., "source": ... }` on `/live`, `onLive` creates `LiveProxy` and calls `markLatest(hub)`.
   - `markLatest(hub)` sets `latestId = hub.id`, adopts `orphanDevice` if `hub.device` is unset, and calls `hub.replay(ws)` for every socket in `floatingHuds`.
3. **Phone notification (`{ type: "hud", connected: boolean }`)**:
   - Defined in `shared/types.ts` (`ServerMsg`) and tracked as `SessionSnapshot.hudConnected` in `web/src/types.ts`.
   - `notifyHudState(hub)` emits `{ "type": "hud", "connected": hasHud(hub) }` (`{ hud: false }`, phone clients only) whenever a HUD joins or closes on `addHud`, when a phone client attaches (`replayClient`), and when `markLatest(hub)` shifts `floatingHuds` from a previous hub (`connected: false` on `prev` if no explicit `prev.huds` remain) to the newly started `latestId` (`connected: true`).

### 3.3 Deterministic Late-Join Replay Sequence (`Hub.replay`)
Whenever `/hud` connects late, reconnects after a transient drop, or reloads via **Middle Tap -> Restart**, `Hub.replay(ws)` in `server/src/hub.ts` replays buffered hub state in strict order:

1. `lastStatus`: `{ "type": "status", "live": "connecting" | "open" | "reconnecting" | "degraded" | "closed", "detail"?: string }`
2. `device`: `{ "type": "device", "device": { "connected": boolean, "worn": boolean, "battery": number | null, "streaming": boolean, "source": "phone" | "glasses" } }`
3. `lastCoach`: `{ "type": "coach", "cue": CoachCue, "text": string }`
4. `lastVerdict`: `{ "type": "verdict", "verdict": Verdict }`

### 3.4 Bandwidth Filtering, Reconnect, and Privacy Invariants
- **Filtered fan-out (`HUD_TYPES`)**: `HUD_TYPES = Set(["verdict", "coach", "status", "device"])` in `server/src/hub.ts` ensures `hub.emit` only forwards those four message types to HUD sockets (while `verify_label` is in flight, `LiveProxy` emits `{ "type": "coach", "cue": "hold_still", "text": "Hold still, reading..." }` which `/hud` displays directly). Raw 24 kHz PCM `audio` chunks, `checking` / `interrupted` phone playback signals, and streaming `transcript` deltas are **never** sent over `/hud-ws`, keeping waveguide frame timing smooth and glasses Wi-Fi/BT radio load minimal.
- **Auto-reconnect**: On WebSocket `close`, `/hud` retries `/hud-ws` with bounded exponential backoff (`500 ms` -> `1000 ms` -> `2000 ms` -> `5000 ms` cap) while displaying a tiny non-intrusive corner status pill (`RECONNECTING`), never a blocking modal.
- **Zero on-glasses PII**: Profile medications, allergies, and dose logs live on the user's phone (`localStorage`) and transiently in server RAM during an active session (`hub.ring.clear()` wipes camera frames immediately on `/live` disconnect; idle hubs expire after `10` minutes; live camera auto-stops after `45 s` without frames). `/hud` writes **nothing** to `localStorage`, `sessionStorage`, or `IndexedDB` on loaner glasses.

---

## 4. Manifest and Provisioning

### 4.1 Meta Wearables Web App Manifest (`.well-known/meta-wearables-manifest.json`)
Served over HTTPS with `Content-Type: application/json` at `https://<tunnel>/.well-known/meta-wearables-manifest.json` (and mirrored under `/hud/.well-known/meta-wearables-manifest.json` if `/hud/` is registered as launch base):

```json
{
  "name": "HoldUp",
  "short_name": "HoldUp",
  "description": "Hands-free medication and allergen label verification HUD",
  "start_url": "/hud",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    {
      "src": "/icons/holdup-hud-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/holdup-hud-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

Key manifest rules:
- `name` / `short_name` stays `<= 12` characters (`"HoldUp"`) so the Ray-Ban Display launcher grid label never truncates.
- `background_color` and `theme_color` are `#000000` so browser boot and splash transitions emit zero stray waveguide light.
- `icons` use high-contrast luminous artwork on a dark/transparent background for crisp visibility in the glasses app tray.

### 4.2 Provisioning via Meta AI App (`Connect Web App`)
1. **Verify prerequisites**:
   - Ray-Ban Display glasses charged `> 10%` on firmware **`v125+`** (**`V128+`** when also running DAT SDK `1.0.1`; reboot glasses after firmware update).
   - Paired Android/iOS phone with **Meta AI app `v272+`** (**`V292+`** for DAT) logged into a Meta account that has a **date of birth on file** (Web Apps stay hidden without account DOB or in unsupported regions; check with booth mentors if hidden).
   - Enable **Developer Mode**: Meta AI app -> **Settings -> App Info -> tap "App version" 5 times -> toggle Developer Mode -> Enable**, then force-close and reopen Meta AI.
2. **Start HTTPS server and tunnel**:
   - Run `npm start` (builds `web/dist` and starts Express + WebSocket server on port `8787`) and `npm run tunnel` (`cloudflared tunnel --url http://localhost:8787`), or use the deployed stable HTTPS host.
   - Open `https://<tunnel>/hud` in laptop Chrome first and confirm **zero TLS certificate errors and zero console errors** (plain `http://` URLs are rejected by the glasses).
3. **Register in Meta AI**:
   - On the phone, open **Meta AI -> App Settings (left drawer) -> Apps -> Web Apps -> Connect Web App**.
   - Paste `https://<tunnel>/hud` (no `?session=` needed) and tap **Save**.
4. **Launch and pin on glasses**:
   - Put on Ray-Ban Display: **HoldUp** appears at the **bottom of the app grid**. Pin it to the top row and open it.
   - Keep the same `cloudflared` process alive across the test slot so the hostname does not rotate. After frontend rebuilds, reload on glasses via **Middle Tap -> Restart**.
   - For demo video capture: Meta AI app -> **Devices -> (Ray-Ban Display) -> Record Display**.

### 4.3 `View on Glasses` Deep-Link QR Format
As a fast alternative to typing the tunnel URL in `Connect Web App`, generate or scan a **View on Glasses** QR code encoding the `fb-viewapp://` deep link:

```text
fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2F<tunnel-host>%2Fhud
```

Deep-link requirements:
- Scheme and host must be `fb-viewapp://web_app_deep_link`. A raw `https://` QR code will **not** open or register a Display Web App on the glasses.
- `appName`: URL-encoded title (`HoldUp`).
- `appUrl`: Strictly percent-encoded (`encodeURIComponent`) full HTTPS URL (`https%3A%2F%2F...%2Fhud`).
- Scan the QR with the Display glasses camera and confirm the on-lens launch prompt.

### 4.4 Chrome Ray-Ban Display Simulator Verification Checklist
Before and between hardware test slots (`Sat 19:30` and `Sun 06:30`), verify `/hud` in desktop Chrome using the **Meta Ray-Ban Display Simulator** extension (`jpjlmmodokemlepklkdbimceggpbjcll`):

- [ ] **Zero-bloom `#000000` canvas**: Load `https://<tunnel>/hud` inside the 600 x 600 additive simulator overlay; confirm `#000000` regions render completely transparent with no white startup flash and no scrollbars.
- [ ] **Lit pixel fill `<= 65%`**: Trigger all four `VerdictLevel` cards (`match`, `warning`, `unsure`, `info`) and `CoachCue` overlays (`rotate_left`, `closer`, `hold_still`); confirm lit card footprint stays `<= 65%` (`<= 35%` for cues).
- [ ] **4-channel multimodal redundancy + `<= 8` word cap**: Confirm every verdict renders its distinct shape (`Circle`, `Triangle`, `Diamond`, `Square`) + icon + uppercase badge + luminous color, and confirm headlines never exceed `8` words (`clampHeadline`).
- [ ] **Directional + Select input**: Test simulator **Up / Down / Left / Right** and **Select** controls plus physical `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` + `Enter`; verify cyclic focus ring visibility (`4px` `#FFFFFF`), `Log Dose` hidden on non-`match` verdicts, safe default focus on `Repeat`, and zero duplicate `event` frames on `Enter`.
- [ ] **System Back and `<= 5` history cap**: Trigger 10+ consecutive verdicts and coach cues, confirm `window.history.length <= 5` (capped at `<= 2`), and verify simulator **Back** dismisses an active verdict card to `#000000` standby before exiting.
- [ ] **Zero-code binding + late-join replay**: Start a `/live` session in Tab A, produce a verdict, then open a fresh `/hud` in Tab B with no `?session=` param; confirm Tab B immediately replays `status` -> `device` -> `coach` -> `verdict` and Tab A reflects `HUD connected`.
- [ ] **QR deep-link and TLS**: Generate the simulator **View on Glasses QR**, confirm it matches `fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=...` over valid HTTPS, and confirm `.well-known/meta-wearables-manifest.json` returns `200 OK` JSON.
