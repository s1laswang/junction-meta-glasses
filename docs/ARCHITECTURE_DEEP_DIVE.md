# HoldUp Technical Architecture Deep-Dive

Authoritative systems engineering reference for **HoldUp** on **Meta AI Glasses** (**Ray-Ban Meta Gen 2**, **Meta Ray-Ban Display**, and **Meta Neural Band**) paired with **Gemini Live** (`gemini-3.8-live`) and **Gemini Flash** (`gemini-3.8-flash`). Every protocol message, constant, buffer bound, fallback transition, and benchmark figure in this document maps directly to committed source files and measured evaluation artifacts in `eval/*.json`.

---

## 1. Architectural Rationale: Why One Ephemeral Backend Serves Three Thin Surfaces

Meta AI Glasses expose complementary hardware primitives across two developer surfaces that do not overlap in a single runtime:

1. **First-person camera + wear/battery telemetry** require the native **Meta Wearables Device Access Toolkit (DAT) SDK `1.0.1`** (`com.meta.wearable:mwdat-core:1.0.1` and `mwdat-camera:1.0.1`) running on a paired mobile companion (`android-dat/`).
2. **In-lens `600x600` additive waveguide cards + Meta Neural Band gestures** run inside the **Ray-Ban Display Chromium Web App** container (`/hud`), where `navigator.mediaDevices.getUserMedia` (camera and raw microphone capture) is intentionally absent.
3. **Full-duplex open-ear voice + on-device health storage + screen-reader UI** run in the **Phone / Laptop PWA** (`web/`) over standard Bluetooth Hands-Free Profile (HFP) audio (`16 kHz` PCM16 mic uplink, `24 kHz` PCM16 voice downlink) with `localStorage` isolation (`holdup.*`).

HoldUp unifies all three surfaces around a single stateless **Node 24 TypeScript session hub** (`server/src/hub.ts` + `server/src/index.ts`) so that hardware camera frames, conversational voice coaching, schema-locked label extraction, deterministic clinical rule checking, and in-lens HUD projection stay synchronized without persisting a single frame, audio chunk, or medication list to server disk.

| Surface | Entrypoint & Runtime | Primary Responsibility | Wire Endpoints | Persistent State |
|---|---|---|---|---|
| **1. Android DAT Bridge** | `android-dat/` (Kotlin 2.2.21, Jetpack Compose, `minSdk 31`, `mwdat-*:1.0.1`) | Streams `720x1280` (`VideoQuality.HIGH` @ `2 fps`) frames throttled to `<= ~1 fps` JPEG (`quality = 78`) and forwards `connected`, `worn`, `battery`, `streaming` state. | `POST /ingest/frame` (`image/jpeg`), `POST /ingest/state` (`application/json`), `holdupbridge://connect` | Endpoint URL + optional session code only; zero health data or frames. |
| **2. Phone / Laptop PWA** | `web/src/App.tsx`, `useHoldUpController.ts`, `sessionManager.ts` (React 19, Vite 6) | WCAG 2.2 AA VoiceOver/TalkBack UI, Web Audio PCM16 bridge + earcons, `getUserMedia` camera backup, 7-fixture Demo Prop Mode, `holdup://rx` QR onboarding, offline `BarcodeDetector`. | `WSS /live?session=<id>`, `POST /api/verify`, `POST /api/tts` | `localStorage` (`holdup.profile`, `holdup.consent`, `holdup.theme`); 1-tap `wipeAllLocalData()`. |
| **3. Ray-Ban Display HUD** | `web/src/hud/HudApp.tsx`, `hud.css` (`600x600` additive Chromium Web App) | Pure `#000000` transparent-background waveguide UI (`<= 65%` lit fill budget), 4-channel verdict cards, Neural Band `Arrow*`/`Enter` + `<= 2`-entry `popstate` nav. | `WSS /hud-ws` (optional `?session=<id>`), `fb-viewapp://web_app_deep_link` | **Zero** (`localStorage`, `sessionStorage`, and `IndexedDB` untouched). |
| **4. Ephemeral Node Hub** | `server/src/index.ts`, `hub.ts`, `live.ts`, `verify.ts`, `safety.ts`, `gemini.ts`, `log.ts` | RAM-only `FrameRing(8)`, zero-code `/hud-ws` + `/ingest/*` session binding, `LiveProxy` (`gemini-3.8-live`), `readLabel` (`gemini-3.8-flash`), deterministic `checkLabel`. | HTTP `:8787` + WebSocket upgrade router (`/live`, `/hud-ws`) | `server/logs/ledger.jsonl` (gitignored ops token/latency counters only; zero PII). |

---

## 2. End-to-End Protocol Sequence Diagrams

### 2.1 Sequence 1: Zero-Code 3-Surface Session Binding & Late-Join Replay

Typing random session tokens on smart glasses or editing the URL in Meta AI `Connect Web App` between runs breaks hands-free accessibility. `server/src/hub.ts` implements out-of-order hardware startup (`orphanDevice`), session-less HUD attachment (`floatingHuds`), automatic session adoption (`markLatest`), filtered fan-out (`HUD_TYPES`), and deterministic 4-step state replay (`Hub.replay`).

```text
Android DAT Bridge             Phone PWA (web/)             Node Hub (hub.ts / index.ts)        Ray-Ban Display (/hud)
(IngestClient.kt)            (sessionManager.ts)          (latestId, floatingHuds, hubs)          (HudApp.tsx)
        |                             |                                  |                              |
        | 1. POST /ingest/state       |                                  |                              |
        |    (no ?session= param)     |                                  |                              |
        |    {connected:true,worn:true|                                  |                              |
        |     battery:84,streaming:0} |                                  |                              |
        |--------------------------------------------------------------->|                              |
        |                             |       setDevice(device, null):   |                              |
        |                             |       latestHub() is undefined   |                              |
        |<---------------------------------------------------------------|                              |
        |    204 No Content           |       caches orphanDevice        |                              |
        |                             |                                  |                              |
        |                             |                                  |  2. WSS /hud-ws (no ?session)|
        |                             |                                  |<-----------------------------|
        |                             |       addHud(ws, null):          |                              |
        |                             |       floatingHuds.add(ws)       |                              |
        |                             |       sends cached orphanDevice  |                              |
        |                             |                                  |----------------------------->|
        |                             |                                  |  {type:"device", device:...} |
        |                             |                                  |  HUD shows: "WORN 84%"       |
        |                             |                                  |                              |
        |                             | 3. WSS /live?session=hup-7f3a    |                              |
        |                             |--------------------------------->|                              |
        |                             |    getOrCreateHub("hup-7f3a")    |                              |
        |                             |    hub.clients.add(ws)           |                              |
        |                             |                                  |                              |
        |                             | 4. {type:"start", profile,       |                              |
        |                             |     lang:"en", voice:true,       |                              |
        |                             |     source:"glasses"}            |                              |
        |                             |--------------------------------->|                              |
        |                             |       markLatest(hub):           |                              |
        |                             |       - latestId = "hup-7f3a"    |                              |
        |                             |       - adopts orphanDevice      |                              |
        |                             |       - replays floatingHuds     |                              |
        |                             |                                  |----------------------------->|
        |                             |                                  |  Hub.replay(ws) strict order:|
        |                             |                                  |  1) lastStatus               |
        |                             |                                  |  2) {type:"device", ...}     |
        |                             |                                  |  3) lastCoach                |
        |                             |                                  |  4) {type:"verdict", ...}    |
        |                             |       notifyHudState(hub)        |                              |
        |                             |<---------------------------------|                              |
        |                             |  {type:"hud", connected:true}    |                              |
        |                             |                                  |                              |
        | 5. POST /ingest/frame       |                                  |                              |
        |    (image/jpeg, ~1 fps,     |                                  |                              |
        |     no ?session= param)     |                                  |                              |
        |--------------------------------------------------------------->|                              |
        |                             |       resolveHub(undefined)      |                              |
        |                             |       -> hubs.get(latestId)      |                              |
        |                             |       jpegSharpness(buf)         |                              |
        |                             |       hub.ring.push(source=      |                              |
        |                             |         "glasses")               |                              |
        |                             |       hub.live.frame(b64)        |                              |
        |<---------------------------------------------------------------|                              |
        |    204 No Content           |                                  |                              |
        |                             |                                  |                              |
        |                             | 6. Filtered Fan-Out on hub.emit: |                              |
        |                             |<---------------------------------|----------------------------->|
        |                             |  Phone receives ALL ServerMsg    |  HUD receives ONLY HUD_TYPES:|
        |                             |  (audio, transcript, checking,   |  verdict | coach | status |  |
        |                             |   interrupted, verdict, coach)   |  device (0 audio/transcript) |
        |                             |                                  |                              |
        |                             |                                  |  7. Neural Band Pinch (Enter)|
        |                             |                                  |  {type:"event",              |
        |                             |                                  |   name:"log_dose"}           |
        |                             |                                  |<-----------------------------|
        |                             |       hudTarget(null)            |                              |
        |                             |       -> hubs.get(latestId)      |                              |
        |                             |       live.handleEvent("log_dose"|                              |
        |                             |<---------------------------------|----------------------------->|
        |                             |  {type:"verdict", takenToday:1}  |  {type:"verdict",takenToday} |
```

**Key Code Invariants (`server/src/hub.ts`, `server/src/index.ts`, `web/src/hud/HudApp.tsx`)**:
- **Bench isolation when needed**: Passing `?session=<id>` on `/hud?session=<id>` or `holdupbridge://connect?server=...&session=<id>` pins that client to `getOrCreateHub(id)` (`hub.huds`) instead of `floatingHuds`, allowing multiple concurrent booth demos on one backend without cross-talk.
- **Middle-Tap OS Restart recovery**: If a wearer opens the Ray-Ban Display Universal Menu via temple middle-tap and selects **Restart**, `/hud` reloads, reconnects `/hud-ws`, and immediately receives `Hub.replay(ws)` (`lastStatus` -> `device` -> `lastCoach` -> `lastVerdict`) in a single round-trip.

---

### 2.2 Sequence 2: Dual-Tier Gemini Live + Schema-Locked Flash Verification Loop

HoldUp strictly separates **real-time physical alignment coaching** (`gemini-3.8-live`) from **high-stakes optical extraction and rule checking** (`gemini-3.8-flash` + `server/src/safety.ts`). Under `server/src/prompts/live.md`, the Live voice model is forbidden from reading drug names, strengths, expiries, or allergens from its own video stream.

```text
Wearer & Surfaces          Node LiveProxy & Hub        Gemini Live API         Gemini Flash API      Safety Engine
(Phone + Glasses + HUD)    (live.ts / verify.ts)      (gemini-3.8-live)       (gemini-3.8-flash)     (safety.ts)
         |                           |                        |                        |                  |
         | 1. Frame (~1 fps JPEG)    |                        |                        |                  |
         |    + 16kHz PCM16 voice    |                        |                        |                  |
         |    "Is this my evening    |                        |                        |                  |
         |     pill?"                |                        |                        |                  |
         |-------------------------->|                        |                        |                  |
         |    hub.ring.push(frame)   |                        |                        |                  |
         |    dt >= 900ms gate ----->| sendRealtimeInput      |                        |                  |
         |                           | (video + audio/pcm)    |                        |                  |
         |                           |----------------------->|                        |                  |
         |                           |                        |                        |                  |
         |                           | 2. Rear/blurry box:    |                        |                  |
         |                           | toolCall: show_cue     |                        |                  |
         |                           | (Behavior.NON_BLOCKING)|                        |                  |
         |                           |<-----------------------|                        |                  |
         |<--------------------------|                        |                        |                  |
         | {type:"coach",            | sendToolResponse       |                        |                  |
         |  cue:"other_side",        | (scheduling: SILENT)   |                        |                  |
         |  text:"Turn it around"}   |----------------------->|                        |                  |
         |<--------------------------|<-----------------------|                        |                  |
         | 24kHz PCM16 coaching      | modelTurn inlineData   |                        |                  |
         | "Turn it around..."       | (audio/pcm;rate=24000) |                        |                  |
         |                           |                        |                        |                  |
         | 3. Wearer barges in mid-  |                        |                        |                  |
         |    sentence + rotates box |                        |                        |                  |
         |-------------------------->|----------------------->|                        |                  |
         |                           | sc.interrupted = true  |                        |                  |
         |                           | (+ toolCallCancellation|                        |                  |
         |                           |    -> cancelled.add)   |                        |                  |
         |<--------------------------|<-----------------------|                        |                  |
         | {type:"interrupted"}      |                        |                        |                  |
         | flushPlayback() +         |                        |                        |                  |
         | cancelSpeech() (<50ms)    |                        |                        |                  |
         |                           |                        |                        |                  |
         |                           | 4. Front sharp frame:  |                        |                  |
         |                           | toolCall: verify_label |                        |                  |
         |                           | {question:"Is this my  |                        |                  |
         |                           |  evening pill?"}       |                        |                  |
         |                           |<-----------------------|                        |                  |
         |<--------------------------|                        |                        |                  |
         | {type:"checking",         |                        |                        |                  |
         |  phase:"start"} +         |                        |                        |                  |
         | {type:"coach",            |                        |                        |                  |
         |  cue:"hold_still"}        |                        |                        |                  |
         |                           |                        |                        |                  |
         |                           | 5. Sharpest-frame pick:|                        |                  |
         |                           | hub.ring.pick(2, 5000) |                        |                  |
         |                           | (0 KB client re-upload)|                        |                  |
         |                           |                        |                        |                  |
         |                           | 6. generateContent     |                        |                  |
         |                           | (1-3 JPEGs + question, |                        |                  |
         |                           |  LABEL_SCHEMA,         |                        |                  |
         |                           |  ThinkingLevel.LOW,    |                        |                  |
         |                           |  ZERO Profile data)    |                        |                  |
         |                           |------------------------------------------------>|                  |
         |                           |                        |   JSON LabelRead       |                  |
         |                           |                        |   {value, confidence}  |                  |
         |                           |<------------------------------------------------|                  |
         |                           | toLabelRead() clamps   |                        |                  |
         |                           | null<=0.30, 2,5->2.5   |                        |                  |
         |                           |                        |                        |                  |
         |                           | 7. checkLabel(read, hub.profile)                |                  |
         |                           |------------------------------------------------------------------->|
         |                           |   Gates: NAME_MIN_CONF=0.60, ALLERGEN_MIN_CONF=0.60,               |
         |                           |   EXPIRY_MIN_CONF=0.70, STRENGTH_MIN_CONF=0.80 (never guess!),     |
         |                           |   BRANDS + CLASSES + ALLERGENS (EN/FI/SV) + dosesToday()           |
         |                           |<-------------------------------------------------------------------|
         |                           |   Verdict {level, headline<=8w, speech<=2s, matchedMedId}          |
         |                           |                        |                        |                  |
         |<--------------------------|                        |                        |                  |
         | {type:"verdict", verdict} | 8. sendToolResponse    |                        |                  |
         | + {type:"checking","end"} | {speech, instruction:  |                        |                  |
         | HUD renders 4-channel card|  "Say speech word for  |                        |                  |
         | + earcon plays            |   word, add nothing"}  |                        |                  |
         |                           |----------------------->|                        |                  |
         |<--------------------------|<-----------------------|                        |                  |
         | 24kHz PCM16 verbatim      | Spoken verdict audio   |                        |                  |
         | "Yes, Amlodipine 5 mg..." |                        |                        |                  |
```

**Engineering Details of the Verification Loop**:
1. **Dual Sharpness Scoring (`web/src/camera/sharpness.ts`, `web/src/camera/multiFrameConsensus.ts`, `server/src/verify.ts`)**:
   - On the client (`computeSharpness`), canvas RGBA frames are scored via 2D discrete Laplacian + Sobel gradient energy (`lap = 4*center - left - right - up - down`, `sumSq += lap^2 + 0.25*(gx^2 + gy^2)`, stride `2` above `256x256`, normalized via `meanSq / (meanSq + 576)` into `[0, 1]`), with `selectBestFrames()` enforcing a `350 ms` minimum inter-frame gap across an `8000 ms` window so two picked frames capture distinct hand micro-angles.
   - On the server (`jpegSharpness` in `server/src/verify.ts`), raw DAT frames arriving over `POST /ingest/frame` without client canvas preprocessing parse the JPEG `SOF0..SOF15` marker (`jpegSize`) in zero-dependency TypeScript and compute `clamp01(buf.length / (w * h) / 0.35)` because high-frequency edge detail raises Huffman-coded JPEG byte density at fixed `quality = 78`. `FrameRing.pick(n = 2, windowMs = 5000)` (`FrameRing`'s sharpest-frame selector) filters the last `5000 ms` (falling back to `.slice(-3)` if sparse) and sorts descending by `b.sharpness - a.sharpness || b.ts - a.ts`.
2. **Schema Inlining (`inlineRefs` in `server/src/verify.ts`)**:
   - `shared/label_schema.json` uses `$defs/stringField` (`{ value: string | null, confidence: [0, 1] }`) as a single source of truth shared between TypeScript and Python evaluation scripts. At server startup, `inlineRefs(RAW_SCHEMA)` recursively resolves `$ref` pointers and strips `$defs` and `$comment` to produce `LABEL_SCHEMA` for `responseJsonSchema`.
3. **Barge-In Cancellation Safety (`LiveProxy.cancelled`)**:
   - If the wearer interrupts or re-asks while `verify_label` is awaiting `gemini-3.8-flash`, Gemini Live sends `m.toolCallCancellation.ids`. `LiveProxy` records those IDs in `this.cancelled` and suppresses both `this.send({ type: "verdict" })` and `session.sendToolResponse` when the superseded `verify()` promise settles, preventing stale verdicts from overwriting the new turn.

---

### 2.3 Sequence 3: 6-Tier Resilience State Machine

Every failure mode encountered in real kitchens, grocery aisles, and congested conference Wi-Fi is handled automatically by `HoldUpSessionManager` (`web/src/session/sessionManager.ts`), `useHoldUpController` (`web/src/session/useHoldUpController.ts`), `computeAdaptiveParams` (`web/src/camera/adaptive.ts`), `LiveProxy` (`server/src/live.ts`), and `readLabel` (`server/src/verify.ts`), and can be live-injected by judges from the **Device & Resilience Panel** (`ChaosConfig`).

```text
                       +-------------------------------------------------------+
                       | TIER 1: NOMINAL LIVE + GLASSES EYE                    |
                       | mode="live", liveState="open", source="glasses"       |
                       | RTT <= 250 ms -> 1.0 fps, 768 px, JPEG q=0.78-0.80    |
                       | Primary: gemini-3.8-live + gemini-3.8-flash           |
                       +-------+-------------------+-------------------+-------+
                               |                   |                   |
          5s ping/pong RTT     |   !connected OR   |   WS close/error  |   429 / 5xx / timeout
          250..650ms / >650ms  |   !worn OR        |   OR live=degraded|   OR >3 WS reconnects
                               v   battery < 15%   v                   v
        +--------------------------+       |   +---------------------------+   +-----------------------------+
        | TIER 2: RTT-ADAPTIVE     |       |   | TIER 3: HTTP SNAPSHOT     |   | TIER 6: 3-MODEL GEMINI      |
        | CAPTURE SCALING          |       |   | + FALLBACK TTS            |   | RETRY & FALLBACK CHAINS     |
        | 250-650ms: 0.75fps,640px |       |   | mode="snapshot"           |   | Live: 3.8-live -> 3.1-flash |
        |   q=0.64                 |       |   | POST /api/verify (2 frms) |   |   -live -> 2.5-native-audio |
        | >650ms: 0.50fps, 512px   |       |   | + POST /api/tts or local  |   | Verify: 3.8-flash -> 3.5-   |
        |   q=0.50 (-84% video BW) |       |   |   speechSynthesis         |   |   flash -> 3-flash-preview  |
        | >1200ms: 0.25fps, q=0.40 |       |   | BG WS reconnect 300-8000ms|   | Jittered backoff + Semaphore|
        +-------------+------------+       |   | + sessionResumption handle|   +--------------+--------------+
                      |                    |   +-------------+-------------+                  |
                      |                    v                 |                                |
                      |    +-------------------------------+ |    All 3 Live models           |
                      |    | TIER 5: DAT EYE HOT-SWAP      | |    exhausted -> status:degraded|
                      |    | reconcileDeviceState():       |<+--------------------------------+
                      |    | glasses -> phone getUserMedia | |
                      |    | (or Demo Props if cam denied) | |
                      |    | Keeps /live & Profile intact  | |
                      |    +---------------+---------------+ |
                      |                    |                 |
                      +--------------------+-----------------+
                                           |
                           navigator.onLine === false
                           (or chaos.forceOffline)
                                           v
                       +-------------------------------------------------------+
                       | TIER 4: ZERO-NETWORK ON-DEVICE BARCODE MODE           |
                       | mode="offline", liveState="closed" (0.0 KB network)   |
                       | BarcodeDetector (EAN-13/8, UPC-A/E, Code128, QR)      |
                       | Matches localStorage Profile.meds[].barcode + avoid   |
                       | + countDosesSinceMidnight() + local speechSynthesis   |
                       +-------------------------------------------------------+
```

| Tier | Trigger Condition | Exact Code Handler | Runtime Transition & User Feedback | Recovery Path |
|---|---|---|---|---|
| **1. Nominal Live** | `online === true`, WS `OPEN`, `rttMs < 250`, `glassesHealthy === true` | `HoldUpSessionManager.handleServerMessage("ready")`, `LiveProxy.connect()` | Full-duplex `16 kHz`/`24 kHz` voice + `~1 fps` coaching + `verify_label` tool loop. | Steady state; `45 s` idle frame timer (`IDLE_STOP_MS`). |
| **2. RTT-Adaptive Capture** | 5s WS `{ type: "ping", t }` -> `{ type: "pong", t }` measures `rttMs >= 250` | `computeAdaptiveParams()` (`web/src/camera/adaptive.ts`), `adaptNetworkQuality()` (`sessionManager.ts`) | Steps capture down (`1.0 fps / 768 px / q0.78` -> `0.75 fps / 640 px / q0.64` at `250-650 ms` -> `0.5 fps / 512 px / q0.50` above `650 ms` -> `0.25 fps / q0.40` above `1200 ms`). | Automatic upward step on next `pong` with `rttMs < 250 ms`. |
| **3. Snapshot HTTP Fallback** | WS `onclose`/`onerror`, `status.live === "degraded"`, `gemini_unavailable`, or mic denied | `HoldUpSessionManager.enterSnapshotFallback()`, `verifySnapshot()`, `POST /api/verify`, `POST /api/tts` | Announces *"Connection interrupted, switched to snapshot mode"*; checks run via `POST /api/verify` + `/api/tts` (or `speechSynthesis`) while WS retries (`300 ms` to `8000 ms` cap). | `LiveProxy` resumes via cached `hub.resume` (`< 10 min` handle) or `m.goAway` proactive handoff; announces *"Live connection restored"*. |
| **4. Offline Barcode Mode** | `window` `offline` event (`navigator.onLine === false`) or `chaos.forceOffline` | `HoldUpSessionManager.reconcileTransport()`, `detectBarcodeFromElement()`, `offlineBarcodeVerdict()` (`web/src/camera/barcode.ts`) | Tears down WS cleanly, announces *"Offline mode active. Saved medications can still be checked by barcode"*, matches EAN/UPC locally in `< 50 ms` (`0 KB` network), refuses unknown barcodes safely (`level: "unsure"`). | `window` `online` event triggers `reconcileTransport()` -> reconnects `/live` automatically. |
| **5. DAT Eye Hot-Swap** | `POST /ingest/state` reports `!connected`, `!worn`, `!streaming`, or `battery < 15` (or permission denied) | `HoldUpSessionManager.reconcileDeviceState()`, `useHoldUpController.ts` (`usePhoneEye`), `CameraController` | Announces exact cause (*"Glasses taken off, switching to phone camera"* / *"Glasses battery low..."*), starts phone `getUserMedia` mid-session without closing `/live`. Camera denial falls back to 7 Demo Prop Fixtures. | Re-donning charged glasses (`connected && worn && streaming && battery >= 15`) hot-swaps `source` back to `"glasses"`. |
| **6. 3-Model Gemini Chain** | HTTP `429` (`quota`), `5xx` (`server`), `404` (`not_found`), `8000 ms` `AbortController` timeout, `bad_json`, or WS close | `classify()`, `backoffMs()`, `unaryGate = Semaphore(4)` (`gemini.ts`); `LiveProxy.connect()` (`live.ts`); `readLabel()` (`verify.ts`) | `readLabel()` retries primary once on transient `timeout`/`server`/`network`/`empty`/`bad_json`, sleeps jittered `backoffMs` on `quota`, then walks `gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3-flash-preview` (max 4 attempts). `LiveProxy` walks `gemini-3.8-live` -> `gemini-3.1-flash-live-preview` -> `gemini-2.5-flash-native-audio-latest`. | Per-call recovery on `verify`; `LiveProxy` resets `reconnects = 0` after `30 s` stable uptime. |

---

## 3. Memory, Privacy, Latency, Bandwidth & Unit-Economics Budgets

### 3.1 Server & Client Memory and Payload Bounds

| Resource / Buffer | Hard Bound | Source File & Symbol | Eviction / Teardown Guarantee |
|---|---|---|---|
| **Server RAM Frame Ring** | `8` frames (`~483 KB` raw / `~644 KB` base64 at `60.39 KB` mean 768px JPEG) | `server/src/hub.ts` (`new FrameRing(8)`), `server/src/verify.ts` (`FrameRing`) | FIFO `.shift()` on `.push()`; immediate `hub.ring.clear()` when last `/live` socket closes (`hub.clients.size === 0`); `10 min` idle GC (`setInterval(..., 60_000).unref()`). |
| **Client Snapshot Ring** | `3` base64 frames (`MAX_BUFFERED_FRAMES = 3`) | `web/src/session/sessionManager.ts` | Cleared immediately in `stopSession()` and `wipeAllData()`. |
| **Client Transcript Ring** | `50` entries (`MAX_TRANSCRIPTS = 50`) | `web/src/session/sessionManager.ts` | `.slice(-50)` ring in React state only; never persisted to `localStorage`. |
| **Sanitized Profile Bounds** | `<= 50` `meds`, `<= 30` `allergies`, `<= 30` `avoid`, `<= 500` `doseLog` entries | `server/src/verify.ts` (`toProfile()`) | Truncates strings (`name`/`ingredient <= 120` chars, `strength <= 40`, `notes <= 200`); RAM-only on `Hub.profile`, dropped on `10 min` `hub.gc`. |
| **WebSocket Frame Caps** | `/live`: `4 MiB` (`MAX_WS_MSG`); `/hud-ws`: `64 KiB` | `server/src/index.ts` (`startServer`) | Rejects oversized frames at `ws` upgrade parser; non-`/live` and non-`/hud-ws` upgrades call `socket.destroy()`. |
| **HTTP Body Caps** | `/ingest/frame`: `6 mb`; `/ingest/state`: `16 kb`; `/api/verify`: `12 mb`; `/api/tts`: `64 kb` | `server/src/index.ts` (`createApp`) | Express body-parser hard limits; `/api/tts` slices input text to `<= 600` chars; `readLabel` slices `question` to `<= 300` chars. |
| **Gemini Unary Concurrency** | `4` concurrent requests (`GEMINI_MAX_CONCURRENCY = 4`) | `server/src/gemini.ts` (`unaryGate = new Semaphore(4)`) | Queues burst `/api/verify`, `verify_label`, and `/api/tts` calls cleanly instead of stampeding upstream quota. |
| **Active Camera Idle Cap** | `45,000 ms` (`45 s`, `IDLE_STOP_MS`) | `server/src/env.ts`, `live.ts`, `sessionManager.ts` | Auto-stops Live session and local camera tracks if `45 s` elapse without frames, playing `camera_off` earcon and emitting `"Camera stopped"`. |

### 3.2 Privacy & Zero-Retention Enforcement Budget

1. **Zero Disk Persistence of User Content**: Camera JPEGs, PCM16 audio chunks, transcripts, and `Profile` objects are never written to server disk. `server/logs/ledger.jsonl` (`server/src/ledger.ts`, gitignored) records operational counters (`ts`, `feature`, `model`, `in`, `out`, `thinking`, `cached`, `latency_s`, `ok`) and zero user strings or session IDs.
2. **Profile Isolation from Vision Extraction**: `readLabel()` (`server/src/verify.ts` lines 97-117) receives `frames: string[]` and optional `question` only. `Profile` (`meds`, `allergies`, `avoid`, `doseLog`) never enters the vision extraction request; matching runs deterministically in `checkLabel()` (`server/src/safety.ts`) inside server RAM (or in browser JS for `offlineBarcodeVerdict`).
3. **Structured Log Redaction (`server/src/log.ts`)**:
   - `DENY` key filter blocks `text`, `data`, `transcript`, `image`, `frame`, `frames`, `audio`, `profile`, `speech`, `headline`, `question`, `args`, `prompt`, `body`, `key`, `apikey`, `api_key`, and `value` -> `"[redacted]"`.
   - Any other string `> 48` characters (`> 160` for `err`) is replaced with `"[redacted:<N>ch]"`.
   - Google API keys matching `/AIza[0-9A-Za-z_-]{10,}/g` are scrubbed to `"[key]"` across all logs and uncaught error handlers, and session IDs truncate to `8` chars (`shortId`).
4. **Loaner Hardware Hygiene**: `/hud` (`web/src/hud/HudApp.tsx`) never touches `localStorage`, `sessionStorage`, or `IndexedDB`, leaving shared booth Ray-Ban Display glasses completely stateless. On the phone PWA, `wipeAllLocalData()` (`web/src/storage/profileStore.ts`) deletes every `holdup.*` key and rotates the ephemeral session ID in one tap.

### 3.3 Measured Latency Budget

All latency figures below come from committed live API benchmark runs in `eval/*.json` (zero mocked or extrapolated timings):

#### A. Gemini Live WebSocket Connect & First-Audio Latency (`eval/live_models_probe.json`)

| Live Model (`env.liveModels` order) | WebSocket Handshake (`connectMs`) | Time to First Audio Chunk (`firstAudioMs`) | Session Resumption Support | Role in HoldUp |
|---|---|---|---|---|
| `gemini-3.8-live` | **`706 ms`** | **`582 ms`** | `sessionResumptionUpdate` verified | Primary 2-way voice + ~1 fps coaching model |
| `gemini-3.1-flash-live-preview` | **`222 ms`** | **`489 ms`** | `sessionResumptionUpdate` verified | Tier-2 Live fallback on `429` or `> 3` drops |
| `gemini-2.5-flash-native-audio-latest` | **`244 ms`** | **`3126 ms`** | `sessionResumptionUpdate` verified | Tier-3 Live fallback for deep availability |

#### B. Schema-Locked Label Verification Latency & Accuracy Across Fallback Chain (`eval/model_comparison.json`, `n = 12` cards, `36` calls)

| Verify Model (`env.verifyModels` order) | Verdict Accuracy | Clean Field Accuracy | Occluded Dose Abstention | Confident-Wrong Doses (`>= 0.80`) | Latency `p50` | Latency `p95` | Latency `mean` | Mean Tokens (`in` / `out` / `think`) |
|---|---|---|---|---|---|---|---|---|
| `gemini-3.8-flash` (`ThinkingLevel.LOW`) | `12 / 12` (`100.0%`) | `26 / 26` (`100.0%`) | `5 / 5` (`100.0%`) | **`0`** | **`3530.9 ms`** | **`4527.1 ms`** | `3651.3 ms` | `2485` / `146.1` / `24.0` |
| `gemini-3.5-flash` (`ThinkingLevel.LOW`) | `12 / 12` (`100.0%`) | `26 / 26` (`100.0%`) | `5 / 5` (`100.0%`) | **`0`** | **`1946.0 ms`** | **`4094.2 ms`** | `2281.7 ms` | `2485` / `127.2` / `38.3` |
| `gemini-3-flash-preview` | `12 / 12` (`100.0%`) | `26 / 26` (`100.0%`) | `5 / 5` (`100.0%`) | **`0`** | **`1310.4 ms`** | **`1403.8 ms`** | `1308.8 ms` | `2485` / `126.6` / `0.0` |

*(Note: `eval/model_comparison.json` also probed `gemini-2.5-flash`, which returned HTTP `404` `not_found` in `235.2 ms` for new accounts and was replaced in `env.verifyModels` by `gemini-3-flash-preview`.)*

#### C. End-to-End Pipeline & Specialized Suite Latencies

| Benchmark Artifact | Pipeline Scope | Sample Size | Accuracy / Pass Rate | `p50` Latency | `p95` / `max` Latency | Mean Latency |
|---|---|---|---|---|---|---|
| `eval/combined_summary.json` | **Cross-suite 4-dataset label verification aggregate** (`batch1` + `batch2` + `demo_fixtures` + `nordic_stickers`) | **`53` cases** | **`52 / 53` (`98.1%`), `0` wrong doses, `0` false-safe allergens, `100.0%` clean fields** | **`3537.1 ms`** | **`5638.1 ms` (`p95`)** | `3657.8 ms` |
| `eval/demo_fixtures_results.json` | End-to-end Express `POST /api/verify` (`768x768` fixtures + `checkLabel`) | `7` fixtures | `7 / 7` (`100.0%`), `0` wrong doses | **`3817.2 ms`** (server `3794 ms`) | `4696.5 ms` (`p95`) | `3660.4 ms` |
| `eval/nordic_stickers_results.json` | Finnish/Swedish pharmacy dosing stickers & comma decimals (`2,5 mg` -> `2.5 mg`) | `10` cases | `10 / 10` (`100.0%`), `0` wrong doses | **`3660.5 ms`** | `n/a` | `n/a` |
| `eval/results_batch1.json` | Synthetic medication photography & occluded dose traps (`gemini-3.8-flash`) | `18` cases | `17 / 18` (`94.4%`), `0` wrong doses | **`3369.5 ms`** | `n/a` | `n/a` |
| `eval/results_batch2.json` | Multilingual (EN/FI/SV) food allergens & household packs (`gemini-3.8-flash`) | `18` items | `18 / 18` (`100.0%`), `7 / 7` allergen recall, `0` false-safe | **`3413.6 ms`** | `4379.3 ms` (`p95`) | `3447.9 ms` |
| `eval/calibration_curve.json` | 4-tier blur/glare/occlusion calibration sweep (`gemini-3.8-flash`) | `16` reads | `ECE = 0.0138`, `Brier = 0.0005`, `0` wrong doses | **`3424.9 ms`** | `5888.3 ms` (`max`) | `3718.5 ms` |
| `eval/coaching_eval.json` | Multi-turn Live prompt + tool call (`show_cue`, `verify_label`, `log_dose`) + speech | `8` scenarios | `8 / 8` (`100.0%`), judge score `5.0 / 5` | **`5118.3 ms`** | `10974.8 ms` (`max`) | `5446.2 ms` |

During the ~3.5-second `verify_label` read, `LiveProxy.onTool` immediately emits `{ type: "checking", phase: "start" }` (driving the soft Web Audio `startCheckingPulse()` earcon) and `{ type: "coach", cue: "hold_still", text: "Hold still, reading..." }` so blind and low-vision wearers have continuous non-visual feedback with zero dead air.

### 3.4 Measured Bandwidth & Token Unit-Economics Budget (`eval/unit_economics.json`)

Measured across all `7` production `768x768` fixtures in `web/public/fixtures/` (mean `60,386.71 B` = `60.39 KB`; min `54.09 KB` `blurry_amlodipine.jpg`, max `65.61 KB` `ibuprofen.jpg`) and their RTT-adaptive `512x512` `q = 0.50` counterparts (mean `19,337.43 B` = `19.34 KB`), plus static prompt/schema sizes (`live.md`: `3,563` chars / `~891` tokens; `verify_prompt.md`: `5,123` chars / `~1,281` tokens; `label_schema.json`: `1,362` chars / `~340` tokens):

| Transport Mode (12s Active Check) | Video Payload | Audio Payload (16k In + 5s 24k Out) | Total Raw Media (`WS Wire`) | Extra Client Upload on `verify_label` | Monthly Data (`120` checks) | Per-Check Gemini Cost (Standard Cached) |
|---|---|---|---|---|---|---|
| **Normal Live (`1.0 fps`, `768 px`, `q=0.78`)** | `724.64 KB` (`12` frames) | `384.0 KB` in + `240.0 KB` out | **`1,348.64 KB`** (`1,805.27 KB` wire, `899.1 kbps`) | **`0.0 KB`** (`Hub.ring` RAM reuse; `120.77 KB` server->Gemini) | `161.84 MB` raw (`216.63 MB` wire) | **`$0.00319` (`EUR 0.00294`)** (`7,488` tokens) |
| **Slow-Net Adaptive (`0.5 fps`, `512 px`, `q=0.50`, `RTT > 650 ms`)** | `116.02 KB` (`6` frames, **`-84.0%`**) | `384.0 KB` in + `240.0 KB` out | **`740.02 KB`** (`993.55 KB` wire, **`-45.1%`**) | **`0.0 KB`** (`38.67 KB` server->Gemini) | `88.80 MB` raw (`119.23 MB` wire) | **`$0.00273` (`EUR 0.00251`)** (`5,940` tokens) |
| **Snapshot HTTP Fallback (`POST /api/verify` + local TTS)** | `38.67 KB` (`2` adaptive frames) | `0.0 KB` (local `speechSynthesis`) | **`38.67 KB`** (`51.99 KB` JSON wire) | `38.67 KB` (single HTTP POST) | `6.24 MB` wire | **`$0.00088` (`EUR 0.00081`)** |
| **Offline Barcode Mode (`BarcodeDetector`)** | `0.0 KB` | `0.0 KB` (local `speechSynthesis`) | **`0.0 KB`** | `0.0 KB` | `0.00 MB` | **`EUR 0.00000`** |

At `4` checks/day (`1,440` checks/year), annual cloud inference costs **`EUR 2.48` to `EUR 4.23` per user/year** (`EUR 0.35/month` standard cached; `EUR 10.79/year` conservative zero-cache native-audio ceiling). Over 3 years (`4,320` checks), **HoldUp + consumer Ray-Ban Meta Gen 2** totals **`EUR 341.68` TCO** (`EUR 329.00` hardware + `EUR 12.68` cloud) versus **`EUR 4,150.00`** for dedicated assistive OCR eyewear (OrCam MyEye midpoint, **91.8% savings / 12.1x cost reduction**) and **`EUR 2,340.00`** for daily paid remote-agent plans (Aira 180-min tier, **85.4% savings**).
