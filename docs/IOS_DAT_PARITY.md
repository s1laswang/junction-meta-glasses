# HoldUp iOS Meta Wearables DAT SDK 1.0.1 Parity & Wire-Contract Guide (`docs/IOS_DAT_PARITY.md`)

HoldUp decouples first-person glasses camera and sensor ingestion from Gemini Live coaching, deterministic medication/allergen verification (`server/src/safety.ts`), and Ray-Ban Display waveguide rendering (`/hud`) behind a **100% OS-agnostic HTTP + QR wire contract** (`server/src/index.ts`, `server/src/hub.ts`, `web/src/pairing/links.ts`).

An iOS Swift companion target built on Meta's Swift Package Manager **Device Access Toolkit (DAT) SDK `1.0.1`** (`MWDATCore` + `MWDATCamera`) plugs into the exact same HoldUp Node 24 backend as `android-dat/` (`com.meta.wearable:mwdat-core:1.0.1` + `mwdat-camera:1.0.1`) with **zero server, PWA, or `/hud` changes**. At the Junction 2026 Meta booth (`BRIEF.md`, `docs/HARDWARE_NOTES.md`), this gives HoldUp symmetric hardware coverage across both DAT tracks: **Amanda Le** (DAT Android) and **Dennis Punjabi** (DAT iOS), alongside the Ray-Ban Display Web Apps mentors.

---

## 1. OS-Agnostic Backend Wire Contract

Both `android-dat/` (`android-dat/app/src/main/java/app/holdup/bridge/IngestClient.kt`) and an iOS Swift companion bridge speak only three stateless surfaces:

| Surface | Transport & Format | HoldUp Server / PWA Behavior |
|---|---|---|
| `holdupbridge://connect?server=<url>&session=<code>` | Custom URL deep link encoded into an ISO/IEC 18004 QR SVG (`web/src/pairing/qrSvg.ts`, `web/src/pairing/links.ts`) inside the PWA **Device & Resilience Panel** | Scanning with the iOS Camera app or tapping **Launch DAT Bridge** in Safari opens the companion app and prefills the HTTPS server origin and session ID. When `session` is omitted, `resolveHub()` (`server/src/hub.ts`) attaches automatically to `latestHub()`. |
| `POST /ingest/frame?session=<code>` | Raw binary `Content-Type: image/jpeg` (`<= 6 MB` cap; `720x1280` JPEG at `0.78` quality, throttled to `>= 950 ms` interval with in-flight frame drop) | Computes or reads `sharpness`, pushes `{ data, sharpness, ts, bytes, source: "glasses" }` into the 8-slot RAM-only `FrameRing`, forwards `data` to active `LiveProxy.frame(data)`, and returns `204 No Content` (`server/src/index.ts`). |
| `POST /ingest/state?session=<code>` | `Content-Type: application/json; charset=utf-8` body `{"connected":bool,"worn":bool,"battery":int\|null,"streaming":bool}` | Calls `setDevice({ ..., source: "glasses" })`, fanning `{ type: "device", device }` out over `/live` and `/hud-ws` (`204 No Content`). Doffing (`!worn`), disconnect (`!connected`), or low battery (`< 15%`) triggers automatic phone-camera hot-swap. |

---

## 2. Side-by-Side Android vs. iOS DAT SDK `1.0.1` Lifecycle & API Mapping

| Capability / Stage | Android Bridge (`android-dat/`, Kotlin) | iOS Companion Target (Swift 6) |
|---|---|---|
| **SDK Distribution (`1.0.1`)** | Maven Central: `com.meta.wearable:mwdat-core:1.0.1`, `com.meta.wearable:mwdat-camera:1.0.1` (zero GitHub PAT) | Swift Package Manager (`https://github.com/facebook/meta-wearables-dat-ios`, tag `1.0.1`): `MWDATCore`, `MWDATCamera` (optional `MWDATMockDevice`) |
| **Toolchain & Minimum OS** | Android Studio Narwhal+, JDK 17, Kotlin `2.2.21`, `minSdk 31` (Android 12+), `compileSdk 36` | Xcode `26.4+`, Swift `6+`, iOS `17.2+` deployment target |
| **Companion App & Firmware** | Meta AI (`com.facebook.stella`) `V292+` + glasses firmware `V128+` (reboot after OTA; battery `> 10%`) | Meta AI iOS app `V292+` + glasses firmware `V128+` (reboot after OTA; battery `> 10%`) |
| **Developer Mode Credentials** | `AndroidManifest.xml` `<meta-data>` `com.meta.wearable.mwdat.APPLICATION_ID` = `0`, `CLIENT_TOKEN` = `0` | `Info.plist` `MWDAT` dictionary: `MetaAppID` = `0`, `ClientToken` = `0`, `AppLinkURLScheme` = `holdupbridge://`, `TeamID` = `$(DEVELOPMENT_TEAM)` |
| **Accessory & BT Declarations** | `BLUETOOTH`, `BLUETOOTH_CONNECT`, `INTERNET`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | `Info.plist` `UISupportedExternalAccessoryProtocols` (`com.meta.ar.wearable`), `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices` (`_bonjour._tcp`), `UIBackgroundModes` (`processing`, `bluetooth-central`, `bluetooth-peripheral`, `external-accessory`) |
| **Deep Link & Callback Scheme** | `<intent-filter>` for `holdupbridge://connect` on `singleTop` `MainActivity` (`onCreate` + `onNewIntent`) | `Info.plist` `CFBundleURLTypes` -> `CFBundleURLSchemes` (`holdupbridge`) + SwiftUI `.onOpenURL` routing `metaWearablesAction` to `Wearables.shared.handleUrl(_:)` and `holdupbridge://connect` to endpoint config |
| **SDK Initialization** | `Wearables.initialize(appContext)` | `try Wearables.configure()` in `@main App.init()`, then `Wearables.shared` |
| **Meta AI App Registration** | `Wearables.startRegistration(activity)` + `Wearables.registrationState` `StateFlow` | `try await Wearables.shared.startRegistration()` + `Wearables.shared.registrationStateStream()` `AsyncStream` |
| **Device Roster & Telemetry** | `Wearables.devices` + `Wearables.devicesMetadata[id]` (`linkState`, `donState`, `batteryLevel`, `thermalLevel`, `compatibility`) | `Wearables.shared.devicesStream()` -> `Wearables.shared.deviceForIdentifier(id)` + `addLinkStateListener`, `addDeviceStateListener`, `addCompatibilityListener` |
| **Camera Permission Gate** | `Wearables.checkPermissionStatus(Permission.CAMERA)` + `Wearables.RequestPermissionContract()` | `try await Wearables.shared.checkPermissionStatus(.camera)` + `try await Wearables.shared.requestPermission(.camera)` |
| **DeviceSession Creation** | `Wearables.createSession(AutoDeviceSelector())` -> `session.start()` -> await `DeviceSessionState.STARTED` | `try Wearables.shared.createSession(deviceSelector: AutoDeviceSelector(wearables: Wearables.shared))` -> `try session.start()` -> await `.started` on `session.stateStream()` |
| **Camera Stream (`720x1280 @ 2fps`)** | `session.addCamera(StreamConfiguration(videoQuality = VideoQuality.HIGH, frameRate = 2))` -> `camera.stream.start()` | `try session.addCamera(config: StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 2))` -> `camera.stream.start()` |
| **Frame Encode (`0.78` JPEG)** | `VideoFrame.buffer` (I420 `ByteBuffer`) -> NV21 -> `YuvImage.compressToJpeg(..., quality = 78)` | `CMSampleBufferGetImageBuffer(frame.sampleBuffer)` (`CVPixelBuffer`) -> `CIImage` -> `CIContext.jpegRepresentation(..., quality: 0.78)` |
| **HTTP Throttle & Drop Guard** | `IngestClient.submitFrameIfIdle`: `OkHttpClient`, `950 ms` min interval, `AtomicBoolean` in-flight drop | `HoldUpIngestClient.submitPixelBufferIfIdle`: `URLSession`, `950 ms` `ContinuousClock` interval, `OSAllocatedUnfairLock` in-flight drop |
| **Teardown & Capture LED Off** | `camera.stop()`, `camera.close()`, `session.stop()`, `StreamingForegroundService.stop()` | `camera.stop()`, `session.stop()`, cancel `ListenerTokenBag` tokens (turns off glasses front capture LED) |

---

## 3. Required `Info.plist` Configuration (Developer Mode `0` / `0`)

Meta Wearables DAT iOS `1.0.1` validates `Info.plist` transport declarations before opening Bluetooth LE, Bluetooth Classic MFi (`com.meta.ar.wearable`, required for camera streaming), and local Wi-Fi links. In Developer Mode (`Meta AI -> Settings -> Your glasses -> Developer Mode`), setting `MetaAppID` and `ClientToken` to `0` skips Developer Center attestation just like `android-dat/app/build.gradle.kts`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleTypeRole</key>
    <string>Editor</string>
    <key>CFBundleURLName</key>
    <string>app.holdup.bridge.ios</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>holdupbridge</string>
    </array>
  </dict>
</array>
<key>MWDAT</key>
<dict>
  <key>AppLinkURLScheme</key>
  <string>holdupbridge://</string>
  <key>MetaAppID</key>
  <string>0</string>
  <key>ClientToken</key>
  <string>0</string>
  <key>TeamID</key>
  <string>$(DEVELOPMENT_TEAM)</string>
  <key>Analytics</key>
  <dict>
    <key>OptOut</key>
    <true/>
  </dict>
</dict>
<key>UISupportedExternalAccessoryProtocols</key>
<array>
  <string>com.meta.ar.wearable</string>
</array>
<key>NSBluetoothAlwaysUsageDescription</key>
<string>HoldUp connects to your Meta AI Glasses to stream active label checks.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>HoldUp uses local transport when linking with your Meta AI Glasses.</string>
<key>NSBonjourServices</key>
<array>
  <string>_bonjour._tcp</string>
</array>
<key>UIBackgroundModes</key>
<array>
  <string>processing</string>
  <string>bluetooth-central</string>
  <string>bluetooth-peripheral</string>
  <string>external-accessory</string>
</array>
```

---

## 4. Reference Swift 6 Implementation

### 4.1 Frame Encode (`CVPixelBuffer` -> `CIContext` JPEG `0.78`) & Non-Blocking `URLSession` Ingest (`950 ms` Gate)

`HoldUpIngestClient` mirrors `IngestClient.kt` + `YuvJpegEncoder.kt`: it guards `frameInFlight` and a `950 ms` minimum interval with `OSAllocatedUnfairLock` before touching Core Image, encodes `CVPixelBuffer` via a reusable `CIContext` at `0.78` JPEG quality, and uploads non-blockingly over `URLSession` to `POST /ingest/frame`. `BridgeDeviceState` explicitly encodes `nil` battery values as JSON `null` to match Android's wire payload byte-for-byte.

```swift
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import MWDATCamera
import os

struct BridgeDeviceState: Codable, Equatable, Sendable {
    var connected: Bool = false
    var worn: Bool = false
    var battery: Int? = nil
    var streaming: Bool = false

    enum CodingKeys: String, CodingKey {
        case connected
        case worn
        case battery
        case streaming
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(connected, forKey: .connected)
        try container.encode(worn, forKey: .worn)
        if let battery {
            try container.encode(battery, forKey: .battery)
        } else {
            try container.encodeNil(forKey: .battery)
        }
        try container.encode(streaming, forKey: .streaming)
    }
}

struct IngestMetrics: Equatable, Sendable {
    var framesSent: Int64 = 0
    var framesDropped: Int64 = 0
    var stateUpdatesSent: Int64 = 0
    var lastHttpCode: Int = 0
    var lastError: String? = nil
}

final class HoldUpIngestClient: @unchecked Sendable {
    private struct GateState: Sendable {
        var baseServerUrl: String = ""
        var activeSessionCode: String? = nil
        var frameInFlight: Bool = false
        var lastSentAt: ContinuousClock.Instant? = nil
        var metrics = IngestMetrics()
    }

    private let minFrameInterval: Duration = .milliseconds(950)
    private let jpegQuality: CGFloat = 0.78
    private let gate = OSAllocatedUnfairLock(initialState: GateState())
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let urlSession: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)
    }

    func configure(serverUrl: String, sessionCode: String = "") {
        let cleanServer = serverUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let cleanSession = sessionCode.trimmingCharacters(in: .whitespacesAndNewlines)
        gate.withLock { state in
            state.baseServerUrl = cleanServer
            state.activeSessionCode = cleanSession.isEmpty ? nil : cleanSession
        }
    }

    func metricsSnapshot() -> IngestMetrics {
        gate.withLock { $0.metrics }
    }

    func submitVideoFrameIfIdle(_ frame: VideoFrame) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.sampleBuffer) else {
            return
        }
        submitPixelBufferIfIdle(pixelBuffer)
    }

    func submitPixelBufferIfIdle(_ pixelBuffer: CVPixelBuffer) {
        let now = ContinuousClock.now
        let endpointUrl: URL? = gate.withLock { state in
            if state.frameInFlight {
                state.metrics.framesDropped += 1
                return nil
            }
            if let last = state.lastSentAt, now - last < minFrameInterval {
                state.metrics.framesDropped += 1
                return nil
            }
            guard let url = Self.buildEndpointUrl(
                base: state.baseServerUrl,
                path: "ingest/frame",
                session: state.activeSessionCode
            ) else {
                state.metrics.framesDropped += 1
                state.metrics.lastHttpCode = 0
                state.metrics.lastError = "Invalid or empty server URL"
                return nil
            }
            state.frameInFlight = true
            state.lastSentAt = now
            return url
        }

        guard let endpointUrl else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let jpegOptions: [CIImageRepresentationOption: Any] = [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality
        ]
        guard let jpegData = ciContext.jpegRepresentation(
            of: ciImage,
            colorSpace: colorSpace,
            options: jpegOptions
        ), !jpegData.isEmpty else {
            gate.withLock { state in
                state.frameInFlight = false
                state.metrics.framesDropped += 1
                state.metrics.lastError = "JPEG encoding failed"
            }
            return
        }

        let session = urlSession
        let lock = gate
        Task.detached(priority: .utility) {
            defer {
                lock.withLock { $0.frameInFlight = false }
            }
            var request = URLRequest(url: endpointUrl)
            request.httpMethod = "POST"
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            do {
                let (_, response) = try await session.upload(for: request, from: jpegData)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                let ok = (200...299).contains(code)
                lock.withLock { state in
                    state.metrics.lastHttpCode = code
                    if ok {
                        state.metrics.framesSent += 1
                        state.metrics.lastError = nil
                    } else {
                        state.metrics.lastError = "HTTP \(code)"
                    }
                }
            } catch {
                lock.withLock { state in
                    state.metrics.lastHttpCode = 0
                    state.metrics.lastError = error.localizedDescription
                }
            }
        }
    }

    func postState(_ deviceState: BridgeDeviceState) async {
        let endpointUrl: URL? = gate.withLock { state in
            Self.buildEndpointUrl(
                base: state.baseServerUrl,
                path: "ingest/state",
                session: state.activeSessionCode
            )
        }
        guard let endpointUrl, let payload = try? JSONEncoder().encode(deviceState) else {
            gate.withLock { state in
                state.metrics.lastHttpCode = 0
                state.metrics.lastError = "Invalid or empty server URL"
            }
            return
        }
        var request = URLRequest(url: endpointUrl)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        do {
            let (_, response) = try await urlSession.upload(for: request, from: payload)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ok = (200...299).contains(code)
            gate.withLock { state in
                state.metrics.lastHttpCode = code
                if ok {
                    state.metrics.stateUpdatesSent += 1
                    state.metrics.lastError = nil
                } else {
                    state.metrics.lastError = "HTTP \(code)"
                }
            }
        } catch {
            gate.withLock { state in
                state.metrics.lastHttpCode = 0
                state.metrics.lastError = error.localizedDescription
            }
        }
    }

    private static func buildEndpointUrl(
        base: String,
        path: String,
        session: String?
    ) -> URL? {
        guard !base.isEmpty, var components = URLComponents(string: "\(base)/\(path)") else {
            return nil
        }
        guard let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return nil
        }
        if let session, !session.isEmpty {
            var query = components.queryItems ?? []
            query.append(URLQueryItem(name: "session", value: session))
            components.queryItems = query
        }
        return components.url
    }
}
```

### 4.2 `Wearables` Device Metadata -> `POST /ingest/state` & `720x1280 @ 2 fps` Stream Coordinator

`HoldUpDatBridgeModel` mirrors `DatBridgeController.kt`: it observes `devicesStream()`, attaches link, wear/battery (`addDeviceStateListener`), and compatibility listeners to every paired `Device`, prioritizes connected + donned glasses, filters `batteryLevel == 0` (control-channel warmup) to `nil`, deduplicates state snapshots before calling `POST /ingest/state`, and opens a `720x1280` (`.high`) @ `2 fps` raw camera stream with `audioCodec` omitted so iOS Safari retains Bluetooth HFP audio.

```swift
import Foundation
import MWDATCamera
import MWDATCore

@MainActor
final class HoldUpDatBridgeModel: ObservableObject {
    @Published private(set) var serverUrl: String = ""
    @Published private(set) var sessionCode: String = ""
    @Published private(set) var registrationState: RegistrationState = Wearables.shared.registrationState
    @Published private(set) var deviceState = BridgeDeviceState()
    @Published private(set) var lastError: String? = nil

    private let wearables = Wearables.shared
    private let ingestClient = HoldUpIngestClient()
    private var lastPostedState: BridgeDeviceState? = nil
    private var observerTasks: [Task<Void, Never>] = []
    private var deviceTokens: [any AnyListenerToken] = []
    private var streamTokens: [any AnyListenerToken] = []
    private var activeSession: DeviceSession? = nil
    private var activeCamera: Camera? = nil

    func startObservers() {
        guard observerTasks.isEmpty else { return }

        observerTasks.append(Task { [weak self] in
            guard let self else { return }
            for await state in self.wearables.registrationStateStream() {
                self.registrationState = state
                if state == .available || state == .unavailable {
                    await self.disconnect()
                } else {
                    self.publishStateIfNeeded(force: false)
                }
            }
        })

        observerTasks.append(Task { [weak self] in
            guard let self else { return }
            for await identifiers in self.wearables.devicesStream() {
                for token in self.deviceTokens {
                    await token.cancel()
                }
                self.deviceTokens.removeAll()

                let devices = identifiers.compactMap { self.wearables.deviceForIdentifier($0) }
                self.recomputeTelemetry(from: devices)

                for device in devices {
                    self.deviceTokens.append(device.addLinkStateListener { [weak self] _ in
                        Task { @MainActor in self?.recomputeTelemetry(from: devices) }
                    })
                    self.deviceTokens.append(device.addDeviceStateListener { [weak self] _ in
                        Task { @MainActor in self?.recomputeTelemetry(from: devices) }
                    })
                    self.deviceTokens.append(device.addCompatibilityListener { [weak self] _ in
                        Task { @MainActor in self?.recomputeTelemetry(from: devices) }
                    })
                }
            }
        })
    }

    func updateEndpoint(serverUrl: String, sessionCode: String) {
        let cleanServer = serverUrl
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let cleanSession = sessionCode.trimmingCharacters(in: .whitespacesAndNewlines)
        self.serverUrl = cleanServer
        self.sessionCode = cleanSession
        self.lastPostedState = nil
        ingestClient.configure(serverUrl: cleanServer, sessionCode: cleanSession)
        publishStateIfNeeded(force: true)
    }

    func connectGlasses() async {
        do {
            try await wearables.startRegistration()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func startStreaming() async {
        guard activeCamera == nil else { return }
        do {
            if try await wearables.checkPermissionStatus(.camera) != .granted {
                guard try await wearables.requestPermission(.camera) == .granted else {
                    lastError = "Camera permission denied in Meta AI"
                    return
                }
            }

            let selector = AutoDeviceSelector(wearables: wearables)
            let session = try wearables.createSession(deviceSelector: selector)
            activeSession = session
            try session.start()

            for await state in session.stateStream() {
                if state == .started { break }
                if state == .stopped {
                    lastError = "Glasses session stopped before reaching started"
                    return
                }
            }

            let config = StreamConfiguration(
                videoCodec: .raw,
                resolution: .high,
                frameRate: 2
            )
            guard let camera = try session.addCamera(config: config) else {
                lastError = "Unable to attach camera capability"
                return
            }
            activeCamera = camera
            let stream = camera.stream
            let client = ingestClient

            streamTokens.append(stream.statePublisher.listen { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    let isStreaming = (state == .streaming)
                    if self.deviceState.streaming != isStreaming {
                        self.deviceState.streaming = isStreaming
                        self.publishStateIfNeeded(force: false)
                    }
                }
            })

            streamTokens.append(stream.videoFramePublisher.listen { frame in
                client.submitVideoFrameIfIdle(frame)
            })

            streamTokens.append(stream.errorPublisher.listen { [weak self] error in
                Task { @MainActor in
                    self?.lastError = error.localizedDescription
                }
            })

            stream.start()
        } catch {
            lastError = error.localizedDescription
            await stopStreaming()
        }
    }

    func stopStreaming() async {
        for token in streamTokens {
            await token.cancel()
        }
        streamTokens.removeAll()
        activeCamera?.stop()
        activeCamera = nil
        deviceState.streaming = false
        publishStateIfNeeded(force: true)
    }

    func disconnect() async {
        await stopStreaming()
        activeSession?.stop()
        activeSession = nil
    }

    private func recomputeTelemetry(from devices: [Device]) {
        let chosen = devices.min { Self.rank($0) < Self.rank($1) }
        let connected = (chosen?.linkState == .connected)
        let worn: Bool
        switch chosen?.donState {
        case .donned:
            worn = connected
        case .doffed:
            worn = false
        case .unknown:
            worn = connected
        case nil:
            worn = false
        @unknown default:
            worn = connected
        }
        let battery = chosen?.batteryLevel.flatMap { (1...100).contains($0) ? $0 : nil }

        if let chosen, chosen.compatibility() == .deviceUpdateRequired {
            lastError = "Glasses firmware update required in Meta AI"
        }

        deviceState = BridgeDeviceState(
            connected: connected,
            worn: worn,
            battery: battery,
            streaming: deviceState.streaming
        )
        publishStateIfNeeded(force: false)
    }

    private func publishStateIfNeeded(force: Bool) {
        guard !serverUrl.isEmpty else { return }
        if !force, lastPostedState == deviceState { return }
        let snapshot = deviceState
        lastPostedState = snapshot
        let client = ingestClient
        Task {
            await client.postState(snapshot)
        }
    }

    private static func rank(_ device: Device) -> Int {
        if device.linkState == .connected && device.donState == .donned { return 0 }
        if device.linkState == .connected { return 1 }
        if device.compatibility() == .compatible { return 2 }
        return 3
    }
}
```

### 4.3 `.onOpenURL` Handler for HoldUp PWA ISO 18004 QR Deep Links & Meta AI Callbacks

HoldUp's **Device & Resilience Panel** (`web/src/components/DeviceResiliencePanel.tsx`) renders `holdupbridge://connect?server=<url>&session=<code>` (`web/src/pairing/links.ts`) as a standalone ISO/IEC 18004 QR SVG (`web/src/pairing/qrSvg.ts`). Scanning that QR with the native iPhone Camera app (or tapping **Launch DAT Bridge** in iOS Safari) opens `HoldUpBridgeApp`. The single `.onOpenURL` modifier discriminates between Meta AI's `metaWearablesAction` OAuth/permission return URLs and HoldUp's `holdupbridge://connect` pairing links using the exact validation rules from `MainActivity.kt`:

```swift
import MWDATCore
import SwiftUI

@main
struct HoldUpBridgeApp: App {
    @StateObject private var bridgeModel = HoldUpDatBridgeModel()

    init() {
        try? Wearables.configure()
    }

    var body: some Scene {
        WindowGroup {
            HoldUpBridgeRootView(model: bridgeModel)
                .task {
                    bridgeModel.startObservers()
                }
                .onOpenURL { url in
                    handleIncomingURL(url)
                }
        }
    }

    @MainActor
    private func handleIncomingURL(_ url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return
        }

        if components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true {
            Task {
                _ = try? await Wearables.shared.handleUrl(url)
            }
            return
        }

        guard components.scheme?.lowercased() == "holdupbridge",
              components.host?.lowercased() == "connect",
              components.path.isEmpty || components.path == "/" else {
            return
        }

        let queryItems = components.queryItems ?? []
        let rawServer = queryItems
            .first(where: { $0.name == "server" })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)

        let resolvedServer: String
        if let rawServer, !rawServer.isEmpty {
            guard let serverComponents = URLComponents(string: rawServer),
                  let serverScheme = serverComponents.scheme?.lowercased(),
                  (serverScheme == "https" || serverScheme == "http"),
                  serverComponents.host != nil else {
                return
            }
            resolvedServer = rawServer
        } else {
            resolvedServer = bridgeModel.serverUrl
        }

        let rawSession = queryItems
            .first(where: { $0.name == "session" })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let resolvedSession: String
        if let rawSession {
            if rawSession.isEmpty {
                resolvedSession = ""
            } else if rawSession.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil {
                resolvedSession = rawSession
            } else {
                return
            }
        } else {
            resolvedSession = (rawServer?.isEmpty == false) ? "" : bridgeModel.sessionCode
        }

        guard !resolvedServer.isEmpty || !resolvedSession.isEmpty else { return }
        bridgeModel.updateEndpoint(serverUrl: resolvedServer, sessionCode: resolvedSession)
    }
}
```

---

## 5. Bluetooth HFP Open-Ear Audio & iOS Safari Web Audio Unlock (`Start Check`)

Pairing Meta AI Glasses with an iPhone establishes two parallel transports: the MFi External Accessory link (`com.meta.ar.wearable`) used by `MWDATCamera` for `720x1280 @ 2 fps` video frames, and the standard **Bluetooth Hands-Free Profile (HFP)** / A2DP audio route used by iOS for the glasses open-ear speakers and temple microphone array.

1. **Keep the Native DAT Bridge Silent to Prevent `AVAudioSession` Preemption**:
   - `HoldUpBridgeApp` deliberately omits `audio` from `UIBackgroundModes`, never activates `AVAudioSession.sharedInstance()`, and leaves `StreamConfiguration.audioCodec` set to `nil`.
   - Because the backgrounded Swift bridge holds zero iOS audio session category, foreground **iOS Safari** owns the Bluetooth HFP route exclusively without route thrashing or ducking when switching apps.
2. **Synchronous Web Audio Unlock on the `Start Check` User Gesture**:
   - iOS Safari maps Web Audio (`window.AudioContext ?? window.webkitAudioContext`) and `getUserMedia` onto WebKit's internal `AVAudioSession` (`playAndRecord` once microphone capture starts). WebKit starts every `AudioContext` in `"suspended"` state and blocks Gemini Live `24 kHz` PCM playback (`web/src/audio/player.ts`), earcons (`web/src/audio/earcons.ts`), and `/api/tts` buffers (`web/src/audio/tts.ts`) until resumed inside a direct tap gesture.
   - In `web/src/session/useHoldUpController.ts`, tapping **Start Check** (`startCheck`, and `snapshotVerify` in fallback mode) immediately invokes `audioBridgeRef.current?.resumePlayback()` (`PcmPlayer.resume()` calling `ctx.resume()`), plays the `camera_on` earcon, and requests `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` (`web/src/audio/micCapture.ts`).
   - Once unlocked by **Start Check**, iOS routes both `16 kHz` uplink speech (temple microphones) and `24 kHz` Gemini Live open-ear coaching + safety verdicts through the Ray-Ban Meta HFP headset while `HoldUpBridgeApp` continues posting `~1 fps` JPEG frames in the background via `external-accessory` + `bluetooth-central`.
3. **iOS 26 / iPhone 17 HFP Mic Quirk & Background Codec Fallback**:
   - Per `docs/HARDWARE_NOTES.md`, if testing on iPhone 17 / iOS 26 where Bluetooth HFP microphone input appears silent in Safari, verify in iOS Control Center that the audio input/output route points to Ray-Ban Meta, or let HoldUp degrade automatically to **Snapshot Mode** (`POST /api/verify` + spoken TTS).
   - If iOS suspends `.raw` camera frames while `HoldUpBridgeApp` is backgrounded for extended periods, switch `StreamConfiguration.videoCodec` from `.raw` to `.hvc1` (which DAT `1.0.1` keeps active while locked/backgrounded) and decode `frame.sampleBuffer` via VideoToolbox, or consult Meta DAT iOS booth mentor **Dennis Punjabi**.

---

## 6. Simulator & Endpoint Verification Without Hardware

- **Xcode Simulator (`MWDATMockDevice`)**: Add `MWDATMockDevice` from the same `1.0.1` Swift Package, call `MockDeviceKit.shared.enable()`, pair a simulated device via `try MockDeviceKit.shared.pairGlasses(model: .rayBanMeta)`, call `powerOn()`, `unfold()`, `don()`, and attach a sample label MP4 with `device.services.camera.setCameraFeed(fileURL:)` to exercise `HoldUpDatBridgeModel` -> `HoldUpIngestClient` end-to-end in iOS Simulator.
- **Wire-Contract Smoke Check**: Confirm `204 No Content` parity against a running HoldUp server or Cloudflare/Cloud Run HTTPS origin:

```bash
curl -i -X POST -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"connected":true,"worn":true,"battery":84,"streaming":true}' \
  "$TUNNEL/ingest/state?session=IOS_PARITY_TEST"
```
