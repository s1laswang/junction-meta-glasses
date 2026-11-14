# HoldUp Deployment & Hardware Provisioning Guide (`docs/DEPLOY.md`)

HoldUp serves the installable phone PWA (`/`), the Meta Ray-Ban Display in-lens Web App (`/hud`), the 12-slide submission pitch deck (`/deck`), printable judge and stage artifacts (`/judge-handout.html`, `/printable-props.html`), the Meta Wearables manifest (`/.well-known/meta-wearables-manifest.json`), HTTP API and DAT ingest endpoints (`/api/*`, `/ingest/*`), and bidirectional WebSockets (`/live`, `/hud-ws`) from a **single Node.js Express 5 + `ws` origin** (`:8787` locally, `:8080` in Cloud Run).

Both mobile `getUserMedia` (camera and microphone in Chrome/Safari) and Meta Ray-Ban Display Web Apps require a valid public **HTTPS** origin (`http://` URLs are rejected by the glasses runtime). HoldUp supports two production deployment topologies:

| Topology | Best For | Origin Format | Port | URL Persistence |
|---|---|---|---|---|
| **Option A: Local Laptop + Cloudflare Quick Tunnel** | Low-latency venue iteration and live bench debugging | `https://<name>.trycloudflare.com` | `8787` (local) -> `443` (edge) | Rotates if `cloudflared` restarts; keep process open during demo slot |
| **Option B: Google Cloud Run (`europe-north1`, Hamina, Finland)** | Permanent production host and hands-free stage demos | `https://holdup-<hash>-lz.a.run.app` | `8080` (container) -> `443` (TLS) | Permanent URL; `/hud` is registered in Meta AI once and never changes |

---

## 1. Single-Origin Route Table & Vite Bundle Layout

In production (`npm start` or Docker/Cloud Run), `server/src/index.ts` disables `x-powered-by` across every response, enforces `Cache-Control: no-store` on all `/api/*` endpoints, and serves every client surface, booth artifact, and WebSocket from one origin:

| Route | Protocol / Method | Caching & Limits | Purpose |
|---|---|---|---|
| `/` | `GET` (`text/html`) | `max-age=3600` | Phone & laptop WCAG 2.2 AA/AAA React 19 PWA (`web/dist/index.html`), including SPA query routes (`/?tab=profile`, `/?tab=device`, `/?rx=...`, `/?scenario=...`). |
| `/hud` | `GET` (`text/html`) | SPA shell (`index.html`) | Meta Ray-Ban Display `600x600` pure `#000000` waveguide Web App (`web/src/hud/HudApp.tsx`); skips PWA service-worker registration (`shouldRegisterPwaServiceWorker`) so temple reloads fetch fresh bundles immediately. |
| `/deck` (`/deck/`) | `GET` (`text/html`, CSS, JS) | `max-age=3600` | Self-contained 12-slide 16:9 HTML pitch deck ([`deck/index.html`](../deck/index.html)), live-hydrated via `/api/eval-summary` when served over HTTP/HTTPS. |
| `/judge-handout.html` | `GET` (`text/html`) | Static file | Self-contained A4 portrait judge & mentor quick-start sheet ([`docs/judge-handout.html`](judge-handout.html)). |
| `/printable-props.html` | `GET` (`text/html`) | Static file | Self-contained A4 stage prop carton wraps, scannable GS1 EAN-13 / Code-128 barcodes, and Finnish `holdup://rx` pharmacy QR counter sticker ([`docs/printable-props.html`](printable-props.html)). |
| `/.well-known/meta-wearables-manifest.json` | `GET` (`application/json`) | `max-age=3600`, `dotfiles: "allow"` | Meta Ray-Ban Display Web App manifest (`"name": "HoldUp"`, `"start_url": "/hud"`, `"background_color": "#000000"`, `/icon.svg` `512x512`). |
| `/manifest.webmanifest`, `/sw.js`, `/icon.svg`, `/fixtures/*.jpg` | `GET` | `max-age=3600` | Standard PWA manifest, offline shell service worker (explicitly bypassing `/api`, `/ingest`, `/live`, `/hud-ws`), vector icon, and `7` `768x768` demo prop JPEGs. |
| `/api/health` | `GET` (`application/json`) | `Cache-Control: no-store` | Liveness probe, 30s cached Gemini model reachability (`"ok"` / `"down"`), configured 3-model fallback chains (`live`, `verify`, `tts`), and active `hubStats()`. |
| `/api/stats` | `GET` (`application/json`) | `Cache-Control: no-store` | Sanitized call ledger metrics (`verify`, `verify_live`, `live`, `tts` latency `p50`/`p95`, token counts, model split) powering `EvalProofCard`. |
| `/api/eval-summary` | `GET` (`application/json`) | `Cache-Control: no-store` (10s RAM TTL) | Normalized benchmark summary read from `eval/combined_summary.json` (`headline_metrics`, calibration, extended & wave-6 suites) for `/deck` hydration. |
| `/api/verify` | `POST` (`application/json`) | `no-store`, `12mb` body limit | Snapshot Mode & fallback verification: ranks up to last 3 base64 JPEG frames by `jpegSharpness()` (top 2), runs `readLabel()` + `checkLabel()`, returns `Verdict`, and fans `{ type: "verdict" }` to attached `/hud-ws` sockets. |
| `/api/tts` | `POST` (`audio/wav`) | `no-store`, `64kb` body limit | Synthesizes `24 kHz` 16-bit mono PCM WAV speech via `gemini-3.8-flash-tts` -> `gemini-2.5-flash-preview-tts` (`Kore` voice; returns recoverable `503` so clients fall back to `speechSynthesis`). |
| `/ingest/frame` | `POST` (`image/jpeg` / `octet-stream`) | `6mb` limit -> `204` | Android/iOS DAT Bridge camera ingest (`1.17 ms` loopback `p50`): scores `jpegSharpness()`, pushes to the 8-slot RAM `FrameRing`, and forwards `<= 1 fps` frames to `LiveProxy`. |
| `/ingest/state` | `POST` (`application/json`) | `16kb` limit -> `204` | DAT Bridge telemetry ingest (`connected`, `worn`, `streaming`, `battery`), fanning `{ type: "device" }` to `/live` and `/hud-ws` (`1.30 ms` loopback `p50`). |
| `/live` | `WSS` (`?session=<id>`) | `4 MB` max WS payload | Bidirectional phone/laptop session socket (`16 kHz` PCM16 mic + JPEG frames + text/events <-> `24 kHz` PCM16 audio + transcripts + coach + verdicts + RTT `ping`/`pong`); clears `FrameRing` on final disconnect. |
| `/hud-ws` | `WSS` (optional `?session=<id>`) | `64 KB` max WS payload | Zero-code Ray-Ban Display waveguide socket: auto-attaches to `markLatest` session via `floatingHuds`, replays `status -> device -> coach -> verdict` in `1.78 ms` `p50` (`674 B` verdict wire), and relays Neural Band `repeat` / `log_dose` events. |
| Unmatched `/api/*` or HTML routes | Any | `404` (`application/json`) | Deterministic `{ "type": "error", "code": "not_found", "message": "not found", "recoverable": false }` with zero stack traces. |

### Vite Chunk Splitting & Dev Proxy Parity (`web/vite.config.ts`)
- **Vendor + App JS Chunk Split**: `manualChunks` in `web/vite.config.ts` isolates `node_modules` (`react`, `react-dom`) into `dist/assets/vendor-<hash>.js` (`~223 kB`, `~69 kB` gzip) and application code into `dist/assets/index-<hash>.js` (`~430 kB`, `~116 kB` gzip), alongside `dist/assets/index-<hash>.css` (`~22 kB`) and `dist/assets/hud-<hash>.css` (`~8.2 kB`). Every JavaScript chunk stays cleanly below `500 kB`, keeping vendor caching stable across rapid UI rebuilds over `cloudflared` tunnels and the Ray-Ban Display WebView.
- **Development Proxy Parity (`npm run dev`)**: When iterating locally on `:5173`, Vite proxies `/api`, `/ingest`, `/deck`, `/printable-props.html`, `/judge-handout.html`, `/live` (`ws: true`), and `/hud-ws` (`ws: true`) to `http://localhost:8787` so dev and single-origin production share identical relative URLs.

---

## 2. Option A: Local Laptop + Cloudflare HTTPS Quick Tunnel

Use this path at the hackathon venue when iterating rapidly on code while testing on a paired Android phone and loaned Meta AI glasses over venue Wi-Fi or a dedicated 5 GHz phone hotspot.

### Prerequisites
- Node.js `>= 20` (`22` LTS or `24` recommended) and `npm`.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed on the demo laptop.
- A `.env` file in the repository root (gitignored) containing `GEMINI_API_KEY`.

### Step-by-Step Launch
1. Configure local environment variables and install workspace dependencies:

```bash
cp .env.example .env
npm install
```

Set `GEMINI_API_KEY=<your-key>` inside `.env` (never commit `.env`).

2. Build `web/dist` (`vendor.js` + `index.js`) and start the unified production server on `http://localhost:8787` in **Terminal 1**:

```bash
npm start
```

Unlike `npm run dev` (which runs Vite on `:5173` and Express on `:8787`), `npm start` compiles `web/dist` and serves `/`, `/hud`, `/deck`, `/judge-handout.html`, `/printable-props.html`, `/.well-known/meta-wearables-manifest.json`, `/api/*`, `/ingest/*`, `/live`, and `/hud-ws` from port `8787` so a single tunnel handles every client.

3. Open an HTTPS quick tunnel to `http://localhost:8787` in **Terminal 2**:

```bash
npm run tunnel
```

Copy the printed `https://<words>.trycloudflare.com` origin and **keep Terminal 2 running** for the entire hardware slot so the hostname does not rotate.

4. Verify server health, manifest, and pitch/booth routes:

```bash
curl -fsS https://<words>.trycloudflare.com/api/health
curl -fsS https://<words>.trycloudflare.com/.well-known/meta-wearables-manifest.json
curl -fsSI https://<words>.trycloudflare.com/deck/
```

Confirm `/api/health` returns `"ok": true` and `"gemini": "ok"`.

---

## 3. Option B: Google Cloud Run (`europe-north1`, Hamina, Finland)

Deploying HoldUp to **Google Cloud Run** in `europe-north1` (Hamina, Finland, ~140 km from Espoo/Helsinki) provides Nordic low-latency TLS termination and a **permanent `https://...run.app` URL**. Because Meta Ray-Ban Display requires editing `Connect Web App` inside the Meta AI app whenever a host domain changes, a permanent Cloud Run URL lets you register `https://<service>.run.app/hud` once and keep it across every session, reboot, and redeployment.

### Container Architecture (`Dockerfile` + `.dockerignore`)
- **Multi-stage `node:22-slim` image**:
  - `build` stage installs workspace dependencies, copies `shared/`, `server/`, `web/`, `docs/`, `deck/`, and `eval/combined_summary.json`, and runs `npm run typecheck && npm run build` into `web/dist`.
  - `runtime` stage sets `NODE_ENV=production` and `PORT=8080`, copies `node_modules`, `package.json`, `shared/`, `server/`, `web/package.json`, `web/dist/`, `docs/`, `deck/`, and `eval/combined_summary.json`, initializes `/app/server/logs`, `/app/eval`, and `/app/deck` owned by non-root `USER node`, defines a built-in Node `fetch` `HEALTHCHECK` against `http://127.0.0.1:8080/api/health`, and starts `npm -w server run start`.
- **Secret & payload isolation**: `.dockerignore` strips `.git`, `node_modules`, `.env` / `.env.*` secrets (keeping `!.env.example`), heavy image directories (`eval/synthetic`, `eval/out`, `eval/real/*.jpg`), `server/logs`, and `android-dat/` build artifacts from the Cloud Build upload context while keeping `docs/`, `deck/`, and `eval/combined_summary.json` intact. `GEMINI_API_KEY` is mounted at runtime from Google Secret Manager into server RAM only.

### Optional Local Container Smoke Check
Before deploying, you can verify the production container locally if Docker is installed:

```bash
docker build -t holdup:local .
docker run --rm -p 8080:8080 --env-file .env holdup:local
curl -fsS http://127.0.0.1:8080/api/health
```

### Step 1: Store `GEMINI_API_KEY` in Google Secret Manager
Select your target Google Cloud project, enable the required APIs, and store `GEMINI_API_KEY` in Secret Manager so no secret ever touches disk or build logs:

```bash
gcloud config set project YOUR_GCP_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
printf "%s" "$GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
```

If updating an existing secret version:

```bash
printf "%s" "$GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
```

Ensure the Cloud Run runtime service account has `roles/secretmanager.secretAccessor` on `GEMINI_API_KEY`.

### Step 2: One-Command Cloud Run Deploy (`europe-north1`)
For live stage judging where the phone PWA (`/live`), the Android DAT Bridge (`POST /ingest/frame` without browser cookies), and the Ray-Ban Display Web App (`/hud-ws`) all share HoldUp's ephemeral in-memory `Hub` (`server/src/hub.ts`) with zero disk persistence, pin scaling to a warm single instance to eliminate cold starts and guarantee all three devices land on the same in-memory hub:

```bash
gcloud run deploy holdup \
  --source . \
  --region europe-north1 \
  --allow-unauthenticated \
  --session-affinity \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=3600 \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest
```

### Why These Cloud Run Flags Are Required
- `--region europe-north1`: Runs in **Hamina, Finland**, minimizing network RTT for 16 kHz / 24 kHz PCM16 audio and ~1 fps guided camera coaching from Helsinki/Espoo.
- `--allow-unauthenticated`: Allows the phone browser, the Ray-Ban Display Chromium runtime (which cannot attach IAM headers), and the Android DAT Bridge to connect directly over HTTPS/WSS.
- `--session-affinity` + `--min-instances=1 --max-instances=1`: Keeps `/live` WebSockets, `/hud-ws` HUD WebSockets, and `/ingest/*` HTTP frame posts routed to the stateful in-memory `Hub` holding the active `LiveProxy` and 8-frame `FrameRing`.
- `--timeout=3600`: Raises the WebSocket request timeout to 60 minutes (up from the 5-minute default) so continuous hands-free sessions stay open without premature proxy disconnects.
- `--set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest`: Injects `GEMINI_API_KEY` strictly into `process.env` inside server memory (`server/src/env.ts`).

Optional model or timeout overrides (`LIVE_MODEL`, `VERIFY_MODEL`, `TTS_MODEL`, `TTS_VOICE`, `VERIFY_TIMEOUT_MS`, `IDLE_STOP_MS`) can be passed via `--set-env-vars`:

```bash
gcloud run services update holdup \
  --region europe-north1 \
  --set-env-vars=LIVE_MODEL=gemini-3.8-live,VERIFY_MODEL=gemini-3.8-flash
```

### Step 3: Verify the Deployed Origin
Let `HOST` be the printed Cloud Run URL (for example `https://holdup-<hash>-lz.a.run.app`):

```bash
curl -fsS "$HOST/api/health"
curl -fsS "$HOST/api/eval-summary"
curl -fsS "$HOST/.well-known/meta-wearables-manifest.json"
curl -fsSI "$HOST/deck/"
curl -fsSI "$HOST/judge-handout.html"
curl -fsSI "$HOST/printable-props.html"
```

Confirm `/api/health` returns `200 OK` (`"ok": true`, `"gemini": "ok"`), `/api/eval-summary` returns `"ok": true`, `/.well-known/meta-wearables-manifest.json` returns `"start_url": "/hud"` with `"background_color": "#000000"`, and `/deck/`, `/judge-handout.html`, and `/printable-props.html` return `200 OK`.

---

## 4. Automated Verification & Production Smoke Scripts

Run these three zero-model-call verification gates locally or in CI before every stage rehearsal, deployment, or submission push:

```bash
node scripts/verify-all.mjs
node scripts/smoke-production.mjs
node scripts/verify-submission.mjs
```

- **`node scripts/verify-all.mjs`**: Runs full workspace `npm run typecheck`, `npm run build` (`vendor.js` + `index.js`), `server` unit & integration tests (`190` tests across `24` suites), `web` unit, SSR & accessibility tests (`320` tests across `50` suites; `510/510` total), `server/scripts/simulate-bridge.ts --self-test`, `android-dat/verify-structure.mjs`, `scripts/smoke-production.mjs`, `scripts/verify-submission.mjs`, an ephemeral `startServer(0)` HTTP probe (`/`, `/hud`, `/api/health`, `/api/nonexistent`), and a repository hygiene scan (`0` `AIza...` keys, `0` tracked `.env` files, `0` em dashes).
- **`node scripts/smoke-production.mjs`**: Boots `startServer(0)` against `web/dist` and verifies all **`19` single-origin production HTTP routes**: `/`, `/hud`, `/printable-props.html`, `/judge-handout.html`, `/manifest.webmanifest`, `/sw.js`, `/.well-known/meta-wearables-manifest.json`, all `7` `/fixtures/*.jpg` JPEGs (`FFD8`/`FFD9` markers), `/api/health`, `/api/stats`, `/api/eval-summary`, `/api/unknown` (`404` JSON), and `/deck/`, enforcing `Cache-Control: no-store` on `/api/*` and `x-powered-by` removal everywhere.
- **`node scripts/verify-submission.mjs`**: Checks all `20` Markdown documents (`README.md` + `docs/*.md`) for zero broken relative links, audits all `4` standalone HTML artifacts (`deck/index.html` `>= 12` slides, `docs/judge-handout.html`, `docs/printable-props.html`, `docs/architecture-poster.html`), validates all `27` `eval/*.json` artifacts (`total_confident_wrong_dose_count === 0`, `total_false_safe_allergen_count === 0`, zero embedded `data:image` base64 blobs or API keys), verifies all `7` `web/public/fixtures/*.jpg` byte bounds, and scans all tracked files for zero em dashes and zero co-author trailers.
- **Live Gemini API smoke check (optional, requires `GEMINI_API_KEY` in `.env`)**:

```bash
npm -w server run smoke
```

---

## 5. Post-Deployment Device Pairing & Glasses Registration

Once `HOST` (`https://<words>.trycloudflare.com` or `https://holdup-...run.app`) is live, connect the three client surfaces in order.

### 5.1 Phone PWA & Device Resilience Panel
1. Pair the Meta AI glasses to the demo Android phone in the **Meta AI** app (`V292+`) so open-ear speakers and microphones route automatically as a Bluetooth HFP headset.
2. Open `HOST` in Chrome on the Android phone and complete `ConsentOnboarding` (or import a prescription sticker via `PharmacyImportModal` -> `Scan QR with Camera`; medications, allergies, and dose logs remain in phone `localStorage` only).
3. Switch to the **Device** tab (`DeviceResiliencePanel`). It displays:
   - Your active **Session ID** (`Copy Session ID`).
   - The **Ray-Ban Display HUD (`/hud`)** URL and scannable SVG QR code.
   - The **Android DAT Bridge** deep link (`holdupbridge://connect?...`) and scannable SVG QR code.

### 5.2 Android HoldUp Bridge QR Pairing (`android-dat/`)
The HoldUp Bridge Kotlin app ([`docs/HARDWARE_NOTES.md`](HARDWARE_NOTES.md)) streams first-person camera frames (`720x1280` @ 2 fps SDK capture, throttled to ~1 fps JPEG) to `POST /ingest/frame` and device telemetry (`connected`, `worn`, `battery`, `streaming`) to `POST /ingest/state`.

1. **Enable Meta AI Developer Mode**:
   - Ensure glasses battery is `> 10%` and firmware is `V128+` (reboot glasses after any firmware update).
   - Open **Meta AI -> Settings -> App Info -> tap "App version" 5 times -> toggle Developer Mode -> Enable**, then close and reopen Meta AI.
2. **Install HoldUp Bridge**:
   - Open `android-dat/` in Android Studio (Narwhal+, JDK 17, Android SDK 36) and run the `app` target on the Android phone (`minSdk 31`). Developer Mode uses `0` for app ID and client token, so no secrets or `local.properties` tokens are required.
3. **Pair Server & Session via QR or Deep Link**:
   - **From another screen (laptop PWA -> Android phone)**: Scan the **Android DAT Bridge QR code** inside `DeviceResiliencePanel` using the Android phone camera.
   - **On the same Android phone**: Tap **Launch DAT Bridge** in `DeviceResiliencePanel` (or paste `HOST` manually).
   - Both actions invoke the deep link:

```text
holdupbridge://connect?server=https%3A%2F%2F<host-domain>&session=<session-id>
```

   - HoldUp Bridge pre-fills **Server URL** and **Session code** automatically. (In single-wearer demos, `session` is also optional: when omitted, `/ingest/frame` and `/ingest/state` attach to the most recently started `/live` session.)
4. **Connect & Stream**:
   - Tap **Connect glasses** in HoldUp Bridge and approve the registration prompt in Meta AI (only one third-party Developer Mode app can be registered at a time).
   - Tap **Start streaming** and select **Allow always** on the first Meta AI camera permission prompt.
   - Confirm HoldUp Bridge reports `Streaming` with HTTP `204` responses and that the PWA `DeviceResiliencePanel` switches to **Glasses Linked** with active eye **Glasses DAT**. Keep HoldUp Bridge running in its foreground service while switching back to Chrome.

### 5.3 Meta Ray-Ban Display Web App (`/hud`) Registration
The `/hud` route ([`docs/HUD_SPEC.md`](HUD_SPEC.md)) renders bounded high-contrast verdict and coaching cards on a pure `#000000` transparent waveguide canvas with Neural Band and temple touchpad navigation (`ArrowLeft` / `ArrowRight` / `Enter` / `Back`).

1. **Pre-check in Desktop Chrome**:
   - Open `$HOST/hud` in desktop Chrome first and confirm zero TLS certificate warnings and zero console errors. Optionally preview inside `HudPreviewFrame` or the Chrome **Meta Ray-Ban Display Simulator** extension.
2. **Register via Meta AI (`Connect Web App` - Recommended Permanent Setup)**:
   - Confirm the logged-in Meta account has a **date of birth on file** and Developer Mode is enabled in Meta AI.
   - On the paired phone, open **Meta AI -> App Settings (left drawer) -> Apps -> Web Apps -> Connect Web App**.
   - Enter the base HUD URL **without** a `?session=` query parameter so it never needs editing between sessions:

```text
https://<host-domain>/hud
```

   - Tap **Save**. (Use `https://<host-domain>/hud?session=<id>` only when isolating multiple simultaneous demos on a shared server.)
   - Put on Ray-Ban Display: **HoldUp** appears at the **bottom of the app grid**. Pin it and open it.
3. **Alternative Registration via `View on Glasses` Deep-Link QR**:
   - Generate the **View on Glasses QR** in the Chrome Ray-Ban Display Simulator, or encode the `fb-viewapp://` deep link directly (a raw `https://` QR code will not install a Display Web App on the glasses):

```text
fb-viewapp://web_app_deep_link?appName=HoldUp&appUrl=https%3A%2F%2F<host-domain>%2Fhud
```

   - Scan the QR code with the Ray-Ban Display glasses and confirm the launch prompt on-lens.
4. **Zero-Code Session Binding & Reloading**:
   - As soon as `/hud` opens, `wss://<host-domain>/hud-ws` attaches to the latest active `/live` session (`floatingHuds` in `server/src/hub.ts`), replays `status -> device -> coach -> verdict` in `1.78 ms` `p50`, and updates the phone PWA header badge to **HUD Connected**.
   - After deploying a new Cloud Run revision or rebuilding `web/dist`, reload on the glasses with a **temple middle tap -> Restart**; the URL stays unchanged and the active session replays automatically.
