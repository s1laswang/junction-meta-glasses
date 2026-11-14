# HoldUp Deployment & Hardware Provisioning Guide (`docs/DEPLOY.md`)

HoldUp serves the installable phone PWA (`/`), the Meta Ray-Ban Display in-lens Web App (`/hud`), HTTP endpoints (`/api/health`, `/api/stats`, `/api/verify`, `/api/tts`, `/ingest/frame`, `/ingest/state`), and bidirectional WebSockets (`/live`, `/hud-ws`) from a **single Node.js Express + `ws` origin**.

Both mobile `getUserMedia` (camera and microphone in Chrome/Safari) and Meta Ray-Ban Display Web Apps require a valid public **HTTPS** origin (`http://` URLs are rejected by the glasses runtime). HoldUp supports two production deployment topologies:

| Topology | Best For | Origin Format | Port | URL Persistence |
|---|---|---|---|---|
| **Option A: Local Laptop + Cloudflare Quick Tunnel** | Low-latency venue iteration and live bench debugging | `https://<name>.trycloudflare.com` | `8787` (local) -> `443` (edge) | Rotates if `cloudflared` restarts; keep process open during demo slot |
| **Option B: Google Cloud Run (`europe-north1`, Hamina, Finland)** | Permanent production host and hands-free stage demos | `https://holdup-<hash>-lz.a.run.app` | `8080` (container) -> `443` (TLS) | Permanent URL; `/hud` is registered in Meta AI once and never changes |

---

## 1. Option A: Local Laptop + Cloudflare HTTPS Quick Tunnel

Use this path at the hackathon venue when iterating rapidly on code while testing on a paired Android phone and loaned Meta AI glasses over venue Wi-Fi or a phone hotspot.

### Prerequisites
- Node.js `>= 20` (`22` LTS recommended) and `npm`.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed on the demo laptop.
- A `.env` file in the repository root (gitignored) containing `GEMINI_API_KEY`.

### Step-by-Step Launch
1. Configure local environment variables and install workspace dependencies:

```bash
cp .env.example .env
npm install
```

Set `GEMINI_API_KEY=<your-key>` inside `.env` (never commit `.env`).

2. Build `web/dist` and start the unified production server on `http://localhost:8787` in **Terminal 1**:

```bash
npm start
```

Unlike `npm run dev` (which splits Vite on `:5173` and Express on `:8787`), `npm start` compiles `web/dist` and serves static assets, `/hud`, `/api/*`, `/ingest/*`, `/live`, and `/hud-ws` from port `8787` so a single tunnel handles every client.

3. Open an HTTPS quick tunnel to `http://localhost:8787` in **Terminal 2**:

```bash
npm run tunnel
```

Copy the printed `https://<words>.trycloudflare.com` origin and **keep Terminal 2 running** for the entire hardware slot so the hostname does not rotate.

4. Verify server health and Gemini reachability:

```bash
curl -sS https://<words>.trycloudflare.com/api/health
```

Confirm `"ok": true` and `"gemini": "ok"`.

---

## 2. Option B: Google Cloud Run (`europe-north1`, Hamina, Finland)

Deploying HoldUp to **Google Cloud Run** in `europe-north1` (Hamina, Finland, ~140 km from Espoo/Helsinki) provides Nordic low-latency TLS termination and a **permanent `https://...run.app` URL**. Because Meta Ray-Ban Display requires editing `Connect Web App` inside the Meta AI app whenever a host domain changes, a permanent Cloud Run URL lets you register `https://<service>.run.app/hud` once and keep it across every session, reboot, and redeployment.

### Container Architecture (`Dockerfile` + `.dockerignore`)
- **Multi-stage `node:22-slim` image**:
  - `build` stage installs workspace dependencies, runs `npm run typecheck` across `server` and `web`, and builds the production Vite bundle into `web/dist`.
  - `runtime` stage sets `NODE_ENV=production` and `PORT=8080`, copies workspace `node_modules`, `package.json`, `shared/`, `server/`, and `web/dist/`, runs as non-root `USER node`, defines a built-in Node `fetch` `HEALTHCHECK` against `http://127.0.0.1:8080/api/health`, and starts `npm -w server run start`.
- **Secret & payload isolation**: `.dockerignore` strips `.git`, `node_modules`, `.env*` secrets, `eval/` datasets, and `android-dat/` build artifacts from the Cloud Build upload context. `GEMINI_API_KEY` is mounted at runtime from Google Secret Manager into server RAM only.

### Optional Local Container Smoke Check
Before deploying, you can verify the production container locally if Docker is installed:

```bash
docker build -t holdup:local .
docker run --rm -p 8080:8080 --env-file .env holdup:local
curl -sS http://127.0.0.1:8080/api/health
```

### Step 1: Store `GEMINI_API_KEY` in Google Secret Manager
Select your target Google Cloud project (confirm project authorization first; see `docs/PLAN.md` Question 2), enable the required APIs, and store `GEMINI_API_KEY` in Secret Manager so no secret ever touches disk or build logs:

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
Run from the repository root:

```bash
gcloud run deploy holdup \
  --source . \
  --region europe-north1 \
  --allow-unauthenticated \
  --session-affinity \
  --timeout=3600 \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest
```

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
- `--region europe-north1`: Runs in **Hamina, Finland**, minimising network RTT for 16 kHz / 24 kHz PCM16 audio and ~1 fps guided camera coaching from Helsinki/Espoo.
- `--allow-unauthenticated`: Allows the phone browser, the Ray-Ban Display Chromium runtime (which cannot attach IAM headers), and the Android DAT Bridge to connect directly over HTTPS/WSS.
- `--session-affinity` (plus `--max-instances=1` for multi-device demos): Keeps `/live` WebSockets, `/hud-ws` HUD WebSockets, and `/ingest/*` HTTP frame posts routed to the stateful in-memory `Hub` holding the active `LiveProxy` and 8-frame `FrameRing`.
- `--timeout=3600`: Raises the WebSocket request timeout to 60 minutes (up from the 5-minute default) so continuous hands-free sessions stay open without premature proxy disconnects.
- `--set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest`: Injects `GEMINI_API_KEY` strictly into `process.env` inside server memory (`server/src/env.ts`).

Optional model or timeout overrides (`LIVE_MODEL`, `VERIFY_MODEL`, `TTS_MODEL`, `VERIFY_TIMEOUT_MS`, `IDLE_STOP_MS`) can be passed via `--set-env-vars`:

```bash
gcloud run services update holdup \
  --region europe-north1 \
  --set-env-vars=LIVE_MODEL=gemini-3.8-live,VERIFY_MODEL=gemini-3.8-flash
```

### Step 3: Verify the Deployed Origin
Let `HOST` be the printed Cloud Run URL (for example `https://holdup-<hash>-lz.a.run.app`):

```bash
curl -sS "$HOST/api/health"
curl -sS "$HOST/.well-known/meta-wearables-manifest.json"
```

Confirm:
- `/api/health` returns `200 OK` with `"ok": true` and `"gemini": "ok"`.
- `/.well-known/meta-wearables-manifest.json` returns `200 OK` JSON (`"name": "HoldUp"`, `"start_url": "/hud"`, `"background_color": "#000000"`).

---

## 3. Post-Deployment Device Pairing & Glasses Registration

Once `HOST` (`https://<words>.trycloudflare.com` or `https://holdup-...run.app`) is live, connect the three client surfaces in order.

### 3.1 Phone PWA & Device Resilience Panel
1. Pair the Meta AI glasses to the demo Android phone in the **Meta AI** app (`V292+`) so open-ear speakers and microphones route automatically as a Bluetooth HFP headset.
2. Open `HOST` in Chrome on the Android phone and complete the screen-reader-accessible consent onboarding (medications, allergies, and dose logs remain in phone `localStorage` only).
3. Expand the **Device Resilience Panel** in the PWA. It displays:
   - Your active **Session ID** (`Copy Session ID`).
   - The **Ray-Ban Display HUD (`/hud`)** URL and scannable QR preview.
   - The **Android DAT Bridge** deep link (`holdupbridge://connect?...`) and scannable QR code.

### 3.2 Android HoldUp Bridge QR Pairing (`android-dat/`)
The HoldUp Bridge Kotlin app streams first-person camera frames (`720x1280` @ 2 fps SDK capture, throttled to ~1 fps JPEG) to `POST /ingest/frame` and device telemetry (`connected`, `worn`, `battery`, `streaming`) to `POST /ingest/state`.

1. **Enable Meta AI Developer Mode**:
   - Ensure glasses battery is `> 10%` and firmware is `V128+` (reboot glasses after any firmware update).
   - Open **Meta AI -> Settings -> App Info -> tap "App version" 5 times -> toggle Developer Mode -> Enable**, then close and reopen Meta AI.
2. **Install HoldUp Bridge**:
   - Open `android-dat/` in Android Studio (Narwhal+, JDK 17, Android SDK 36) and run the `app` target on the Android phone (`minSdk 31`). Developer Mode uses `0` for app ID and client token, so no secrets or `local.properties` tokens are required.
3. **Pair Server & Session via QR or Deep Link**:
   - **From another screen (laptop PWA -> Android phone)**: Scan the **Android DAT Bridge QR code** inside the PWA Device Resilience Panel using the Android phone camera.
   - **On the same Android phone**: Tap **Launch DAT Bridge** in the PWA Device Resilience Panel (or paste `HOST` manually).
   - Both actions invoke the deep link:

```text
holdupbridge://connect?server=https%3A%2F%2F<host-domain>&session=<session-id>
```

   - HoldUp Bridge pre-fills **Server URL** and **Session code** automatically. (In single-wearer demos, `session` is also optional: when omitted, `/ingest/frame` and `/ingest/state` attach to the most recently started `/live` session.)
4. **Connect & Stream**:
   - Tap **Connect glasses** in HoldUp Bridge and approve the registration prompt in Meta AI (only one third-party Developer Mode app can be registered at a time).
   - Tap **Start streaming** and select **Allow always** on the first Meta AI camera permission prompt.
   - Confirm HoldUp Bridge reports `Streaming` with HTTP `204` responses and that the PWA Device Resilience Panel switches to **Glasses Linked** with camera source **Glasses**. Keep HoldUp Bridge running in its foreground service while switching back to Chrome.

### 3.3 Meta Ray-Ban Display Web App (`/hud`) Registration
The `/hud` route renders bounded high-contrast verdict and coaching cards on a pure `#000000` transparent waveguide canvas with Neural Band and temple touchpad navigation (`ArrowLeft` / `ArrowRight` / `Enter` / `Back`).

1. **Pre-check in Desktop Chrome**:
   - Open `$HOST/hud` in desktop Chrome first and confirm zero TLS certificate warnings and zero console errors. Optionally preview in the Chrome **Meta Ray-Ban Display Simulator** extension.
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
   - As soon as `/hud` opens, `wss://<host-domain>/hud-ws` attaches to the latest active `/live` session (`floatingHuds` in `server/src/hub.ts`), replays `status -> device -> coach -> verdict`, and updates the phone PWA indicator to **HUD Connected**.
   - After deploying a new Cloud Run revision or rebuilding `web/dist`, reload on the glasses with a **temple middle tap -> Restart**; the URL stays unchanged and the active session replays automatically.
