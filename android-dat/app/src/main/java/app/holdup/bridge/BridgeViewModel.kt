package app.holdup.bridge

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.removeCamera
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamError
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.ChargingState
import com.meta.wearable.dat.core.types.Device
import com.meta.wearable.dat.core.types.DeviceCompatibility
import com.meta.wearable.dat.core.types.DeviceSessionError
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.types.ThermalLevel
import com.meta.wearable.dat.core.types.WearablesError
import java.net.URLEncoder
import kotlin.math.min
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class UiState(
    val serverUrl: String = "",
    val sessionCode: String = "",
    val btPermissionGranted: Boolean = false,
    val sdkReady: Boolean = false,
    val registration: RegistrationState = RegistrationState.UNAVAILABLE,
    val deviceName: String? = null,
    val linkState: LinkState? = null,
    val battery: Int? = null,
    val charging: Boolean = false,
    val donState: DonState = DonState.UNKNOWN,
    val thermal: ThermalLevel = ThermalLevel.UNKNOWN,
    val firmwareUpdateRequired: Boolean = false,
    val glassesAppUpdateRequired: Boolean = false,
    val sessionState: DeviceSessionState = DeviceSessionState.IDLE,
    val streamState: StreamState = StreamState.STOPPED,
    val wantConnected: Boolean = false,
    val wantStreaming: Boolean = false,
    val framesSent: Long = 0,
    val framesDropped: Long = 0,
    val lastFrameKb: Int = 0,
    val frameSize: String = "",
    val yuvLayout: String = "",
    val frameHttp: String = "–",
    val stateHttp: String = "–",
    val netOk: Boolean? = null,
    val status: String = "Waiting for Bluetooth permission",
    val error: String? = null,
) {
  val isRegistered: Boolean
    get() = registration == RegistrationState.REGISTERED
  val sessionActive: Boolean
    get() = sessionState == DeviceSessionState.STARTED
  val streaming: Boolean
    get() = streamState == StreamState.STREAMING

  internal fun toGlassesState(): GlassesState =
      GlassesState(
          connected = linkState == LinkState.CONNECTED && deviceName != null,
          worn =
              when (donState) {
                DonState.DONNED -> true
                DonState.DOFFED -> false
                else -> null
              },
          battery = battery,
          streaming = streaming,
      )

  internal fun resolveTarget(): Pair<String, String>? {
    val server = Uploader.normalizeServer(serverUrl)
    val code = sessionCode.trim()
    return if (server.isEmpty()) null else Pair(server, code)
  }

  internal fun talkBackGlassesSummary(): String {
    val labelName = deviceName?.ifBlank { "Glasses" } ?: return "No glasses found"
    val linkPhrase =
        when (linkState) {
          LinkState.CONNECTED -> "connected"
          LinkState.CONNECTING -> "connecting"
          LinkState.DISCONNECTED -> "disconnected"
          null -> "link status unknown"
        }
    val wearPhrase =
        when (donState) {
          DonState.DONNED -> "worn"
          DonState.DOFFED -> "not worn"
          else -> "wear state unknown"
        }
    val batteryPhrase =
        when {
          battery != null && charging -> "battery $battery percent, charging"
          battery != null -> "battery $battery percent"
          charging -> "battery level unknown, charging"
          else -> "battery level unknown"
        }
    val thermalPhrase =
        when {
          thermal >= ThermalLevel.SEVERE -> ", thermal warning ${thermal.name.lowercase()}"
          thermal != ThermalLevel.UNKNOWN && thermal != ThermalLevel.NONE ->
              ", thermal ${thermal.name.lowercase()}"
          else -> ""
        }
    return "$labelName, $linkPhrase, $wearPhrase, $batteryPhrase$thermalPhrase"
  }

  internal fun talkBackStreamSummary(): String {
    val streamPhrase =
        when (streamState) {
          StreamState.STREAMING -> {
            val detail =
                listOf(frameSize.trim(), yuvLayout.trim()).filter { it.isNotEmpty() }.joinToString(" ")
            if (detail.isEmpty()) "Camera streaming at 1 frame per second"
            else "Camera streaming at 1 frame per second, $detail"
          }
          StreamState.PAUSED -> "Stream paused"
          StreamState.STARTING -> "Stream starting"
          else -> "Stream ${streamState.name.lowercase()}"
        }
    val uploadPhrase =
        if (frameHttp.isBlank() || frameHttp == "\u2013" || frameHttp == "-") {
          "no frame upload yet"
        } else if (lastFrameKb > 0) {
          "last upload $frameHttp, $lastFrameKb kilobytes"
        } else {
          "last upload $frameHttp"
        }
    val netPhrase =
        when (netOk) {
          true -> "network ok"
          false -> "network failing, retrying with backoff"
          null -> "network idle"
        }
    return "$streamPhrase, sent $framesSent, dropped $framesDropped, $uploadPhrase, $netPhrase"
  }
}

/**
 * Glasses -> server bridge. DAT lifecycle (register, session, camera stream) follows Meta's
 * CameraAccess sample (SDK 1.0.1); frames are rate-limited to ~1/s, JPEG-encoded and POSTed with
 * single-in-flight backpressure. Device state changes are POSTed to /ingest/state.
 */
class BridgeViewModel(application: Application) : AndroidViewModel(application) {

  companion object {
    private const val TAG = "HoldUpBridge"
    private const val PREFS = "holdup_bridge"
    // SDK accepts 2/7/15/24/30 fps; 2 is the lowest. We forward at most one frame per second.
    private const val STREAM_FPS = 2
    private const val FRAME_INTERVAL_MS = 1_000L
    private const val MAX_BACKOFF_MS = 8_000L
    private const val JPEG_QUALITY = 80
    private const val STATE_HEARTBEAT_MS = 10_000L

    internal fun normalizeBatteryLevel(rawLevel: Int): Int? = rawLevel.takeIf { it > 0 }

    internal fun reconnectDelayMs(attempt: Int): Long =
        min(15_000L, 2_000L shl min(attempt.coerceAtLeast(0), 3))

    internal fun streamRetryDelayMs(attempt: Int): Long =
        min(10_000L, 1_500L shl min(attempt.coerceAtLeast(0), 3))

    internal fun frameIntervalMs(netFailures: Int): Long =
        if (netFailures <= 0) FRAME_INTERVAL_MS
        else min(MAX_BACKOFF_MS, FRAME_INTERVAL_MS shl min(netFailures, 3))

    internal data class DeepLinkConfig(val server: String?, val session: String?)

    internal fun parseDeepLink(
        scheme: String?,
        host: String?,
        server: String?,
        session: String?,
        key: String?,
    ): DeepLinkConfig? {
      if (scheme != "holdupbridge" || host != "connect") return null
      val trimmedServer = server?.trim()?.takeIf { it.isNotEmpty() }
      val trimmedSession = session?.trim()?.takeIf { it.isNotEmpty() }
      val trimmedKey = key?.trim()?.takeIf { it.isNotEmpty() }
      val resolvedServer =
          if (trimmedServer != null && trimmedKey != null) {
            val q = trimmedServer.indexOf('?')
            val hasKey =
                q >= 0 &&
                    trimmedServer
                        .substring(q + 1)
                        .substringBefore('#')
                        .split('&')
                        .any { it == "key" || it.startsWith("key=") }
            if (hasKey) {
              trimmedServer
            } else {
              val sep =
                  when {
                    q < 0 -> "?"
                    trimmedServer.endsWith("?") || trimmedServer.endsWith("&") -> ""
                    else -> "&"
                  }
              "$trimmedServer${sep}key=${URLEncoder.encode(trimmedKey, "UTF-8")}"
            }
          } else {
            trimmedServer
          }
      return DeepLinkConfig(server = resolvedServer, session = trimmedSession)
    }

    internal fun frameHttpHint(code: Int): String =
        when (code) {
          401, 403 -> " (access key missing or wrong: add ?key=... to Server URL)"
          404 -> " (server has no /ingest/frame? check URL/branch)"
          400, 410 -> " (unknown session code?)"
          502, 503, 530 -> " (tunnel up but server down?)"
          else -> ""
        }
  }

  private val app = application
  private val prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val _ui =
      MutableStateFlow(
          UiState(
              serverUrl = prefs.getString("server", "") ?: "",
              sessionCode = prefs.getString("session", "") ?: "",
          ))
  val ui: StateFlow<UiState> = _ui.asStateFlow()

  /** Set by the Activity: launches the Meta AI camera-permission flow and suspends for the result. */
  var permissionRequester: (suspend (Permission) -> PermissionStatus)? = null

  private val uploader = Uploader()
  private val selector = AutoDeviceSelector()
  private val frameDispatcher = Dispatchers.Default.limitedParallelism(1)

  private var monitoringStarted = false
  private var session: DeviceSession? = null
  private var camera: Camera? = null
  private val sessionJobs = mutableListOf<Job>()
  private val streamJobs = mutableListOf<Job>()
  private var reconnectJob: Job? = null
  private var streamStartJob: Job? = null
  private var streamRetryJob: Job? = null
  private var reconnectAttempt = 0
  private var streamRetryAttempt = 0

  @Volatile private var lastFrameSentAt = 0L
  @Volatile private var netFailures = 0

  private val stateMutex = Mutex()
  @Volatile private var lastPostedState: GlassesState? = null
  @Volatile private var lastPostedAt = 0L

  // ---------------------------------------------------------------- inputs

  fun setServerUrl(v: String) {
    _ui.update { it.copy(serverUrl = v) }
    prefs.edit().putString("server", v.trim()).apply()
    lastPostedState = null
  }

  fun setSessionCode(v: String) {
    _ui.update { it.copy(sessionCode = v) }
    prefs.edit().putString("session", v.trim()).apply()
    lastPostedState = null
  }

  /** holdupbridge://connect?server=https://x.trycloudflare.com&session=ABC123 */
  fun handleDeepLink(uri: Uri?) {
    if (uri == null || uri.scheme != "holdupbridge" || uri.host != "connect") return
    val cfg =
        parseDeepLink(
            scheme = uri.scheme,
            host = uri.host,
            server = uri.getQueryParameter("server"),
            session = uri.getQueryParameter("session"),
            key = uri.getQueryParameter("key"),
        ) ?: return
    cfg.server?.let { setServerUrl(it) }
    cfg.session?.let { setSessionCode(it) }
    status("Server and session filled from link")
    pushState(force = true)
  }

  // ---------------------------------------------------------------- SDK init

  /** Called once Android Bluetooth permissions are resolved. Initializes DAT like the sample. */
  fun onBluetoothPermissions(granted: Boolean) {
    _ui.update { it.copy(btPermissionGranted = granted) }
    if (!granted) {
      setError("Bluetooth permission is needed to talk to the glasses. Tap \"Grant Bluetooth\".")
      return
    }
    if (_ui.value.sdkReady) return
    val initError = Wearables.initialize(app).errorOrNull()
    if (initError != null && initError != WearablesError.ALREADY_INITIALIZED) {
      setError("DAT init failed: ${initError.description}")
      return
    }
    _ui.update { it.copy(sdkReady = true, error = null) }
    status("Ready. Tap Connect glasses.")
    startMonitoring()
  }

  private fun startMonitoring() {
    if (monitoringStarted) return
    monitoringStarted = true

    viewModelScope.launch {
      Wearables.registrationState.collect { st ->
        _ui.update { it.copy(registration = st) }
        if (st == RegistrationState.REGISTERED && _ui.value.wantConnected && session == null) {
          startSession()
        }
      }
    }
    viewModelScope.launch {
      Wearables.registrationErrorStream.collect { e ->
        setError("Meta AI connection failed: ${e.description}")
      }
    }
    // Follow the active glasses and their metadata (battery, worn, thermal, link).
    viewModelScope.launch {
      selector.activeDeviceFlow().collectLatest { id ->
        if (id == null) {
          _ui.update { it.copy(deviceName = null, linkState = null) }
          pushState()
          return@collectLatest
        }
        val flow =
            Wearables.devicesMetadata[id]
                ?: run {
                  // Metadata map can lag the selector; wait until the device is listed.
                  Wearables.devices.first { id in it }
                  Wearables.devicesMetadata[id]
                }
        if (flow == null) {
          _ui.update { it.copy(deviceName = id.toString(), linkState = null) }
          pushState()
          return@collectLatest
        }
        flow.collect { onDevice(it) }
      }
    }
    // Heartbeat: re-send state so the server learns we're alive after it restarts.
    viewModelScope.launch {
      while (isActive) {
        delay(STATE_HEARTBEAT_MS)
        if (SystemClock.elapsedRealtime() - lastPostedAt >= STATE_HEARTBEAT_MS) pushState(force = true)
      }
    }
  }

  private fun onDevice(d: Device) {
    _ui.update {
      it.copy(
          deviceName = d.name.ifEmpty { "Glasses" },
          linkState = d.linkState,
          battery = normalizeBatteryLevel(d.batteryLevel),
          charging = d.chargingState == ChargingState.CHARGING,
          donState = d.donState,
          thermal = d.thermalLevel,
          firmwareUpdateRequired = d.compatibility == DeviceCompatibility.DEVICE_UPDATE_REQUIRED,
      )
    }
    if (d.compatibility == DeviceCompatibility.SDK_UPDATE_REQUIRED) {
      setError("Glasses need a newer DAT SDK: bump mwdat in gradle/libs.versions.toml")
    }
    if (d.thermalLevel >= ThermalLevel.SEVERE) {
      status("Glasses are hot (${d.thermalLevel.name.lowercase()}); stream may be throttled")
    }
    pushState()
  }

  // ---------------------------------------------------------------- connect / session

  fun connect(activity: Activity) {
    if (!_ui.value.sdkReady) {
      setError("Grant Bluetooth permission first")
      return
    }
    _ui.update { it.copy(wantConnected = true, error = null) }
    when (_ui.value.registration) {
      RegistrationState.REGISTERED -> startSession()
      RegistrationState.REGISTERING -> status("Finish connecting in the Meta AI app")
      else -> {
        status("Opening Meta AI to connect HoldUp Bridge…")
        Wearables.startRegistration(activity)
      }
    }
  }

  fun disconnect() {
    _ui.update { it.copy(wantConnected = false, wantStreaming = false) }
    reconnectJob?.cancel()
    streamRetryJob?.cancel()
    teardownStream()
    val s = session
    if (s != null) {
      status("Disconnecting…")
      s.stop()
    } else {
      status("Disconnected")
    }
  }

  fun unregister(activity: Activity) {
    disconnect()
    Wearables.startUnregistration(activity)
  }

  fun openFirmwareUpdate(activity: Activity) {
    Wearables.openFirmwareUpdate(activity).onFailure { e, _ -> setError(e.description) }
  }

  fun openGlassesAppUpdate(activity: Activity) {
    Wearables.openDATGlassesAppUpdate(activity).onFailure { e, _ -> setError(e.description) }
  }

  private fun startSession() {
    if (session != null) return
    reconnectJob?.cancel()
    Wearables.createSession(selector)
        .onSuccess { s ->
          session = s
          // Subscribe before start() so no transition is missed (sample + docs).
          sessionJobs += viewModelScope.launch { s.state.collect { onSessionState(s, it) } }
          sessionJobs += viewModelScope.launch { s.errors.collect { onSessionError(it) } }
          _ui.update { it.copy(sessionState = DeviceSessionState.STARTING) }
          status("Connecting to glasses…")
          s.start()
        }
        .onFailure { e, _ ->
          setError("Can't start glasses session: ${e.description}")
          scheduleReconnect()
        }
  }

  private fun onSessionState(s: DeviceSession, st: DeviceSessionState) {
    if (s !== session) return
    _ui.update { it.copy(sessionState = st) }
    when (st) {
      DeviceSessionState.STARTED -> {
        reconnectAttempt = 0
        status("Glasses connected")
        if (_ui.value.wantStreaming) startStreamingFlow()
      }
      DeviceSessionState.PAUSED -> status("Session paused by the glasses (removed, folded or busy). Waiting…")
      DeviceSessionState.STOPPED -> {
        teardownStream()
        sessionJobs.forEach { it.cancel() }
        sessionJobs.clear()
        session = null
        pushState()
        if (_ui.value.wantConnected) scheduleReconnect() else status("Disconnected")
      }
      else -> Unit
    }
  }

  private fun onSessionError(e: DeviceSessionError) {
    Log.w(TAG, "Session error: ${e.description}")
    when (e) {
      DeviceSessionError.DWA_OUT_OF_STU_RANGE ->
          status("Note: glasses/app versions are outside the recommended range; continuing")
      DeviceSessionError.DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED -> {
        _ui.update { it.copy(glassesAppUpdateRequired = true) }
        setError("Update the DAT app on the glasses (button below), then Connect again")
      }
      DeviceSessionError.INSUFFICIENT_SDK_VERSION -> {
        _ui.update { it.copy(wantConnected = false, wantStreaming = false) }
        setError("Glasses need a newer DAT SDK: bump mwdat in gradle/libs.versions.toml and rebuild")
      }
      DeviceSessionError.CAPABILITY_DENIED -> {
        _ui.update { it.copy(wantStreaming = false) }
        setError("Camera capability denied for this account/device (ask Meta). Use phone camera.")
      }
      else -> setError("Glasses session: ${e.description}")
    }
  }

  private fun scheduleReconnect() {
    if (!_ui.value.wantConnected || reconnectJob?.isActive == true) return
    val delayMs = reconnectDelayMs(reconnectAttempt)
    reconnectAttempt++
    status("Glasses not reachable. Retrying in ${delayMs / 1000}s…")
    reconnectJob =
        viewModelScope.launch {
          delay(delayMs)
          if (_ui.value.wantConnected && session == null && _ui.value.isRegistered) startSession()
        }
  }

  // ---------------------------------------------------------------- streaming

  fun startStreaming(activity: Activity) {
    if (target() == null) {
      setError("Enter the server URL first")
      return
    }
    _ui.update { it.copy(wantStreaming = true, error = null) }
    netFailures = 0
    pushState(force = true)
    if (session == null || !_ui.value.sessionActive) {
      // Stream starts automatically once the session reaches STARTED.
      connect(activity)
      return
    }
    startStreamingFlow()
  }

  fun stopStreaming() {
    _ui.update { it.copy(wantStreaming = false) }
    streamRetryJob?.cancel()
    streamStartJob?.cancel()
    teardownStream()
    status(if (_ui.value.sessionActive) "Streaming stopped (glasses still connected)" else "Streaming stopped")
  }

  private fun startStreamingFlow() {
    if (camera != null || streamStartJob?.isActive == true) return
    streamStartJob =
        viewModelScope.launch {
          val check = Wearables.checkPermissionStatus(Permission.CAMERA)
          if (check.isFailure) {
            setError("Camera permission check failed: ${check.errorOrNull()?.description}")
            scheduleStreamRetry()
            return@launch
          }
          var granted = check.getOrNull() == PermissionStatus.Granted
          if (!granted) {
            val request = permissionRequester
            if (request == null) {
              setError("Open the app to grant camera access")
              return@launch
            }
            status("Approve camera access in the Meta AI app (choose Allow always)")
            granted = request(Permission.CAMERA) == PermissionStatus.Granted
          }
          if (!granted) {
            _ui.update { it.copy(wantStreaming = false) }
            setError(
                "Camera permission denied. Tap Start streaming to ask again, or allow it in " +
                    "Meta AI → App connections → HoldUp Bridge.")
            return@launch
          }
          beginStream()
        }
  }

  private fun beginStream() {
    val s = session ?: return
    if (!_ui.value.sessionActive || camera != null || !_ui.value.wantStreaming) return
    StreamingService.start(app)
    YuvJpeg.reset()
    s.addCamera(StreamConfiguration(videoQuality = VideoQuality.HIGH, frameRate = STREAM_FPS))
        .onSuccess { cam ->
          camera = cam
          val stream = cam.stream
          streamJobs += viewModelScope.launch(frameDispatcher) { stream.videoStream.collect { onFrame(it) } }
          streamJobs +=
              viewModelScope.launch {
                // state replays STOPPED on subscribe; only react to a terminal state after activity.
                var wasActive = false
                stream.state.collect { st ->
                  _ui.update { it.copy(streamState = st) }
                  pushState()
                  when {
                    st == StreamState.STREAMING -> {
                      streamRetryAttempt = 0
                      status("Streaming glasses camera → server")
                    }
                    st == StreamState.PAUSED -> status("Stream paused by the glasses (temple tap); resumes on its own")
                    (st == StreamState.STOPPED || st == StreamState.CLOSED) && wasActive -> onStreamEnded()
                  }
                  if (st != StreamState.STOPPED && st != StreamState.CLOSED) wasActive = true
                }
              }
          streamJobs += viewModelScope.launch { stream.errorStream.collect { onStreamError(it) } }
          _ui.update { it.copy(streamState = StreamState.STARTING) }
          status("Starting camera stream…")
          stream.start().onFailure { e, _ ->
            setError("Stream start failed: ${e.description}")
            teardownStream()
            scheduleStreamRetry()
          }
        }
        .onFailure { e, _ ->
          setError("Can't add camera: ${e.description}")
          if (e == DeviceSessionError.CAPABILITY_ALREADY_ADDED) runCatching { s.removeCamera() }
          StreamingService.stop(app)
          if (e == DeviceSessionError.CAPABILITY_DENIED) {
            _ui.update { it.copy(wantStreaming = false) }
          } else {
            scheduleStreamRetry()
          }
        }
  }

  private fun onStreamError(e: StreamError) {
    Log.w(TAG, "Stream error: ${e.description}")
    when (e) {
      StreamError.STREAM_ERROR -> status("Stream hiccup (${e.description}); continuing")
      StreamError.PERMISSIONS_DENIED -> {
        _ui.update { it.copy(wantStreaming = false) }
        setError("Camera permission denied by the glasses. Tap Start streaming to ask again.")
        teardownStream()
      }
      StreamError.HINGE_CLOSED -> setError("Glasses are folded. Unfold them to continue.")
      StreamError.THERMAL_HOT -> setError("Glasses are too hot. Let them cool for a minute.")
      StreamError.BATTERY_LOW -> setError("Glasses battery low. Charge them.")
      StreamError.CRITICAL_STREAM_ERROR -> {
        setError("Stream failed (${e.description}). Restarting…")
        teardownStream()
        scheduleStreamRetry()
      }
      else -> setError("Stream: ${e.description}")
    }
  }

  private fun onStreamEnded() {
    teardownStream()
    if (_ui.value.wantStreaming && _ui.value.sessionActive) scheduleStreamRetry()
  }

  private fun scheduleStreamRetry() {
    if (!_ui.value.wantStreaming || streamRetryJob?.isActive == true) return
    val delayMs = streamRetryDelayMs(streamRetryAttempt)
    streamRetryAttempt++
    status("Stream stopped. Retrying in ${delayMs / 1000}s…")
    streamRetryJob =
        viewModelScope.launch {
          delay(delayMs)
          if (_ui.value.wantStreaming && _ui.value.sessionActive) startStreamingFlow()
        }
  }

  /** Detach the camera so a later addCamera() on the same session succeeds (see sample). */
  private fun teardownStream() {
    streamJobs.forEach { it.cancel() }
    streamJobs.clear()
    val cam = camera
    camera = null
    if (cam != null) {
      runCatching { cam.stop() }
      runCatching { cam.close() }
      session?.let { s -> runCatching { s.removeCamera() } }
    }
    StreamingService.stop(app)
    _ui.update { it.copy(streamState = StreamState.STOPPED) }
    pushState()
  }

  // ---------------------------------------------------------------- frames → server

  private fun onFrame(frame: VideoFrame) {
    if (frame.isCompressed) return
    val now = SystemClock.elapsedRealtime()
    val interval = frameIntervalMs(netFailures)
    if (now - lastFrameSentAt < interval) return // rate limit, not a drop
    val (server, code) = target() ?: return
    if (!uploader.tryBeginFrame()) {
      // Backpressure: previous POST still in flight.
      _ui.update { it.copy(framesDropped = it.framesDropped + 1) }
      return
    }
    lastFrameSentAt = now
    // Copy now: the SDK may reuse the buffer after collect returns.
    val bytes =
        try {
          val buf = frame.buffer.duplicate()
          ByteArray(buf.remaining()).also { buf.get(it) }
        } catch (t: Throwable) {
          uploader.endFrame()
          setError("Frame copy failed: ${t.javaClass.simpleName}")
          return
        }
    val w = frame.width
    val h = frame.height
    viewModelScope.launch(Dispatchers.IO) {
      try {
        val jpeg = YuvJpeg.encode(bytes, w, h, JPEG_QUALITY)
        if (jpeg == null) {
          setError("Frame conversion failed (${bytes.size} B for ${w}x$h)")
          return@launch
        }
        val res = uploader.postFrame(server, code, jpeg)
        when (res) {
          is PostResult.Ok -> {
            netFailures = 0
            _ui.update {
              it.copy(
                  framesSent = it.framesSent + 1,
                  netOk = true,
                  frameHttp = "HTTP ${res.code}",
                  lastFrameKb = jpeg.size / 1024,
                  frameSize = "${w}x$h",
                  yuvLayout = YuvJpeg.lastLayout.name,
                  error = if (it.error?.startsWith("Server") == true) null else it.error,
              )
            }
          }
          is PostResult.HttpError -> {
            netFailures++
            val hint = frameHttpHint(res.code)
            _ui.update { it.copy(netOk = false, frameHttp = "HTTP ${res.code}") }
            setError("Server rejected frame: HTTP ${res.code}$hint")
          }
          is PostResult.NetworkError -> {
            netFailures++
            _ui.update { it.copy(netOk = false, frameHttp = "network error") }
            setError("Server unreachable (${res.message}). Retrying with backoff…")
          }
        }
      } finally {
        uploader.endFrame()
      }
    }
  }

  // ---------------------------------------------------------------- state → server

  private fun currentGlassesState(): GlassesState = _ui.value.toGlassesState()

  private fun pushState(force: Boolean = false) {
    val st = currentGlassesState()
    if (!force && st == lastPostedState) return
    val (server, code) = target() ?: return
    viewModelScope.launch(Dispatchers.IO) {
      stateMutex.withLock {
        val res = uploader.postState(server, code, st)
        lastPostedAt = SystemClock.elapsedRealtime()
        lastPostedState = if (res is PostResult.Ok) st else null
        when (res) {
          is PostResult.Ok ->
              _ui.update {
                it.copy(
                    stateHttp = "HTTP ${res.code}",
                    error = if (it.error?.startsWith("Server") == true) null else it.error,
                )
              }
          is PostResult.HttpError -> {
            _ui.update { it.copy(stateHttp = "HTTP ${res.code}") }
            if (res.code == 401 || res.code == 403) {
              setError("Server rejected state: HTTP ${res.code}${frameHttpHint(res.code)}")
            }
          }
          is PostResult.NetworkError -> _ui.update { it.copy(stateHttp = "network error") }
        }
      }
    }
  }

  private fun target(): Pair<String, String>? = _ui.value.resolveTarget()

  // ---------------------------------------------------------------- status helpers

  private fun status(msg: String) {
    Log.i(TAG, msg)
    _ui.update { it.copy(status = msg) }
  }

  fun setError(msg: String) {
    Log.w(TAG, msg)
    _ui.update { it.copy(error = msg) }
  }

  fun clearError() = _ui.update { it.copy(error = null) }

  override fun onCleared() {
    super.onCleared()
    teardownStream()
    session?.stop()
  }
}
