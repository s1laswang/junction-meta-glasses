package app.holdup.bridge

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoFrame
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Device
import com.meta.wearable.dat.core.types.DeviceCompatibility
import com.meta.wearable.dat.core.types.DeviceIdentifier
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.types.ThermalLevel
import java.io.Closeable
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

data class BridgeUiState(
    val serverUrl: String = "",
    val sessionCode: String = "",
    val sdkReady: Boolean = false,
    val registrationStatus: String = "Unregistered",
    val deviceName: String? = null,
    val connected: Boolean = false,
    val worn: Boolean = false,
    val batteryPercent: Int? = null,
    val thermalStatus: String = "Normal",
    val streamStatus: String = "Idle",
    val streaming: Boolean = false,
    val framesSent: Long = 0,
    val framesDropped: Long = 0,
    val lastHttpCode: Int = 0,
    val lastError: String? = null,
)

object DatBridgeController {
    private const val STREAM_FPS = 2
    private const val MIN_ENCODE_INTERVAL_MS = 960L
    private const val SESSION_START_TIMEOUT_MS = 15_000L

    private val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
        setSdkError(throwable.message ?: "Unexpected DAT bridge error")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ingestClient = IngestClient()

    private val _uiState = MutableStateFlow(BridgeUiState())
    val uiState: StateFlow<BridgeUiState> = _uiState.asStateFlow()

    private val initialized = AtomicBoolean(false)
    private val observersStarted = AtomicBoolean(false)
    private val permissionRequestSeq = AtomicLong(0L)
    private val stateLock = Any()

    @Volatile
    private var sdkError: String? = null

    @Volatile
    private var lastActivityRef: WeakReference<ComponentActivity>? = null

    @Volatile
    private var appContextRef: Context? = null

    @Volatile
    private var lastEncodedFrameMs: Long = 0L

    private val deviceMetadataJobs = mutableMapOf<DeviceIdentifier, Job>()
    private val devicesSnapshot = mutableMapOf<DeviceIdentifier, Device>()
    private var lastPostedDeviceState: BridgeDeviceState? = null

    private var activeSession: DeviceSession? = null
    private var activeCamera: Camera? = null
    private var activeStream: Stream? = null

    private var sessionStateJob: Job? = null
    private var sessionErrorJob: Job? = null
    private var startStreamingJob: Job? = null
    private var videoJob: Job? = null
    private var streamStateJob: Job? = null
    private var streamErrorJob: Job? = null

    init {
        scope.launch(exceptionHandler) {
            ingestClient.metrics.collect { metrics ->
                _uiState.update { state ->
                    state.copy(
                        framesSent = metrics.framesSent,
                        framesDropped = metrics.framesDropped,
                        lastHttpCode = metrics.lastHttpCode,
                        lastError = metrics.lastError ?: sdkError,
                    )
                }
            }
        }
    }

    fun initialize(context: Context) {
        rememberActivity(context)
        val appContext = context.applicationContext
        appContextRef = appContext
        if (initialized.get()) {
            return
        }
        if (!initialized.compareAndSet(false, true)) {
            return
        }

        var ready = false
        runCatching {
            Wearables.initialize(appContext)
                .onSuccess {
                    ready = true
                }
                .onFailure { error, _ ->
                    if (error.toString().contains("ALREADY_INITIALIZED", ignoreCase = true)) {
                        ready = true
                    } else {
                        setSdkError(error.description)
                    }
                }
        }.onFailure { err ->
            setSdkError(err.message ?: "Failed to initialize Meta Wearables DAT SDK")
        }

        if (!ready) {
            initialized.set(false)
            return
        }

        clearSdkError()
        _uiState.update { it.copy(sdkReady = true) }
        startWearablesObservers()
    }

    fun updateEndpoint(serverUrl: String, sessionCode: String) {
        val cleanServer = serverUrl.trim().trimEnd('/')
        val cleanSession = sessionCode.trim()
        ingestClient.configure(cleanServer, cleanSession)
        synchronized(stateLock) {
            lastPostedDeviceState = null
        }
        _uiState.update {
            it.copy(
                serverUrl = cleanServer,
                sessionCode = cleanSession,
            )
        }
        publishDeviceState(force = true)
    }

    fun connectGlasses(activity: Activity) {
        rememberActivity(activity)
        initialize(activity.applicationContext)
        if (!_uiState.value.sdkReady) {
            return
        }
        clearSdkError()
        runCatching {
            Wearables.startRegistration(activity)
        }.onFailure { err ->
            setSdkError(err.message ?: "Unable to start Meta AI glasses registration")
        }
    }

    fun startStreaming(context: Context) {
        rememberActivity(context)
        val appContext = context.applicationContext
        initialize(appContext)
        if (!_uiState.value.sdkReady) {
            return
        }
        if (Wearables.registrationState.value != RegistrationState.REGISTERED) {
            _uiState.update { it.copy(streamStatus = "Unregistered") }
            setSdkError("Connect glasses in Meta AI before starting camera stream")
            return
        }

        val alreadyBusy = synchronized(stateLock) {
            startStreamingJob?.isActive == true || activeCamera != null || _uiState.value.streaming
        }
        if (alreadyBusy) {
            return
        }

        val activityForPermission = findComponentActivity(context)
            ?: lastActivityRef?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

        clearSdkError()
        StreamingForegroundService.start(appContext)
        _uiState.update { it.copy(streamStatus = "Starting") }

        val launched = scope.launch(exceptionHandler) {
            val granted = ensureCameraPermission(appContext, activityForPermission)
            if (!granted) {
                StreamingForegroundService.stop(appContext)
                _uiState.update { it.copy(streaming = false, streamStatus = "Permission required") }
                publishDeviceState(force = true)
                return@launch
            }

            ensureActive()
            val session = ensureStartedSession(appContext)
            if (session == null) {
                StreamingForegroundService.stop(appContext)
                _uiState.update { it.copy(streaming = false, streamStatus = "Session failed") }
                publishDeviceState(force = true)
                return@launch
            }

            ensureActive()
            attachAndStartCamera(appContext, session)
        }

        synchronized(stateLock) {
            startStreamingJob = launched
        }
    }

    fun stopStreaming(context: Context) {
        val appContext = context.applicationContext
        val jobToCancel = synchronized(stateLock) {
            val job = startStreamingJob
            startStreamingJob = null
            job
        }
        jobToCancel?.cancel()
        teardownStreamInternal(appContext, nextStatus = "Idle")
    }

    fun disconnect(context: Context) {
        stopStreaming(context)
        val sessionToStop: DeviceSession?
        synchronized(stateLock) {
            sessionStateJob?.cancel()
            sessionStateJob = null
            sessionErrorJob?.cancel()
            sessionErrorJob = null
            sessionToStop = activeSession
            activeSession = null
        }
        runCatching { sessionToStop?.stop() }
        _uiState.update { it.copy(streaming = false, streamStatus = "Idle") }
        publishDeviceState(force = true)
    }

    fun openFirmwareUpdate(activity: Activity) {
        rememberActivity(activity)
        initialize(activity.applicationContext)
        if (!_uiState.value.sdkReady) {
            return
        }
        clearSdkError()
        runCatching {
            Wearables.openFirmwareUpdate(activity).onFailure { error, _ ->
                setSdkError(error.description)
            }
        }.onFailure { err ->
            setSdkError(err.message ?: "Unable to open firmware update")
        }
    }

    fun openGlassesAppUpdate(activity: Activity) {
        rememberActivity(activity)
        initialize(activity.applicationContext)
        if (!_uiState.value.sdkReady) {
            return
        }
        clearSdkError()
        runCatching {
            Wearables.openDATGlassesAppUpdate(activity).onFailure { error, _ ->
                setSdkError(error.description)
            }
        }.onFailure { err ->
            setSdkError(err.message ?: "Unable to open glasses app update")
        }
    }

    private fun startWearablesObservers() {
        if (!observersStarted.compareAndSet(false, true)) {
            return
        }

        scope.launch(exceptionHandler) {
            Wearables.registrationState.collect { regState ->
                val statusLabel = formatRegistrationStatus(regState)
                _uiState.update { it.copy(registrationStatus = statusLabel) }
                if (
                    regState == RegistrationState.AVAILABLE ||
                    regState == RegistrationState.UNAVAILABLE
                ) {
                    val ctx = appContextRef
                    val hasActiveResources = synchronized(stateLock) {
                        activeSession != null || activeCamera != null
                    }
                    if (ctx != null && hasActiveResources) {
                        disconnect(ctx)
                    }
                } else {
                    publishDeviceState(force = false)
                }
            }
        }

        scope.launch(exceptionHandler) {
            Wearables.registrationErrorStream.collect { error ->
                setSdkError(error.description)
            }
        }

        scope.launch(exceptionHandler) {
            Wearables.devices.collect { identifiers ->
                onDevicesUpdated(identifiers)
            }
        }
    }

    private fun onDevicesUpdated(identifiers: Set<DeviceIdentifier>) {
        synchronized(stateLock) {
            val removedIds = deviceMetadataJobs.keys - identifiers
            for (removedId in removedIds) {
                deviceMetadataJobs.remove(removedId)?.cancel()
                devicesSnapshot.remove(removedId)
            }
            val addedIds = identifiers - deviceMetadataJobs.keys
            for (deviceId in addedIds) {
                deviceMetadataJobs[deviceId] = launchDeviceMetadataObserver(deviceId)
            }
        }
        recomputeDeviceTelemetry()
    }

    private fun launchDeviceMetadataObserver(deviceId: DeviceIdentifier): Job =
        scope.launch(exceptionHandler) {
            Wearables.devicesMetadata[deviceId]?.collect { device ->
                synchronized(stateLock) {
                    devicesSnapshot[deviceId] = device
                }
                when (device.compatibility) {
                    DeviceCompatibility.DEVICE_UPDATE_REQUIRED -> {
                        val label = device.name.ifBlank { "Meta AI Glasses" }
                        setSdkError("Firmware update required for $label")
                    }
                    DeviceCompatibility.SDK_UPDATE_REQUIRED -> {
                        setSdkError("SDK update required for connected glasses")
                    }
                    else -> Unit
                }
                recomputeDeviceTelemetry()
            }
        }

    private fun recomputeDeviceTelemetry() {
        val devices = synchronized(stateLock) { devicesSnapshot.values.toList() }
        val chosen = devices.minByOrNull(::rankDevice)
        val connected = chosen?.linkState == LinkState.CONNECTED
        val worn = when (chosen?.donState) {
            DonState.DONNED -> connected
            DonState.DOFFED -> false
            DonState.UNKNOWN -> connected
            null -> false
        }
        val battery = chosen?.batteryLevel?.takeIf { it in 1..100 }
        val thermal = formatThermalStatus(chosen?.thermalLevel)
        val name = chosen?.let { it.name.ifBlank { "Meta AI Glasses" } }

        _uiState.update { state ->
            state.copy(
                deviceName = name,
                connected = connected,
                worn = worn,
                batteryPercent = battery,
                thermalStatus = thermal,
            )
        }
        publishDeviceState(force = false)
    }

    private suspend fun ensureCameraPermission(
        appContext: Context,
        activity: ComponentActivity?,
    ): Boolean {
        var currentStatus: PermissionStatus = PermissionStatus.Denied
        var checkFailed = false
        Wearables.checkPermissionStatus(Permission.CAMERA)
            .onSuccess { status ->
                currentStatus = status
            }
            .onFailure { error, _ ->
                checkFailed = true
                setSdkError(error.description)
            }
        if (checkFailed) {
            return false
        }
        if (currentStatus == PermissionStatus.Granted) {
            return true
        }
        if (activity == null) {
            runCatching {
                val intent = Wearables.RequestPermissionContract()
                    .createIntent(appContext, Permission.CAMERA)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                appContext.startActivity(intent)
            }
            setSdkError("Approve camera permission in Meta AI, then tap Start Streaming")
            return false
        }
        _uiState.update { it.copy(streamStatus = "Requesting permission") }
        val requestedStatus = requestCameraPermission(activity)
        if (requestedStatus != PermissionStatus.Granted) {
            if (sdkError == null) {
                setSdkError("Camera permission denied in Meta AI app")
            }
            return false
        }
        return true
    }

    private suspend fun requestCameraPermission(activity: ComponentActivity): PermissionStatus =
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine { continuation ->
                val key = "holdup_dat_camera_perm_${permissionRequestSeq.incrementAndGet()}"
                var launcherRef: ActivityResultLauncher<Permission>? = null
                val registeredLauncher = activity.activityResultRegistry.register(
                    key,
                    Wearables.RequestPermissionContract(),
                ) { result ->
                    runCatching { launcherRef?.unregister() }
                    val status = result.fold(
                        onSuccess = { it },
                        onFailure = { error, _ ->
                            setSdkError(error.description)
                            PermissionStatus.Denied
                        },
                    )
                    if (continuation.isActive) {
                        continuation.resume(status)
                    }
                }
                launcherRef = registeredLauncher
                continuation.invokeOnCancellation {
                    runCatching { registeredLauncher.unregister() }
                }
                runCatching {
                    registeredLauncher.launch(Permission.CAMERA)
                }.onFailure { err ->
                    runCatching { registeredLauncher.unregister() }
                    setSdkError(err.message ?: "Unable to request Meta AI camera permission")
                    if (continuation.isActive) {
                        continuation.resume(PermissionStatus.Denied)
                    }
                }
            }
        }

    private suspend fun ensureStartedSession(appContext: Context): DeviceSession? {
        val existing = synchronized(stateLock) { activeSession }
        val candidate = if (
            existing != null &&
            existing.state.value != DeviceSessionState.STOPPED &&
            existing.state.value != DeviceSessionState.STOPPING
        ) {
            existing
        } else {
            createAndStartNewSession(appContext) ?: return null
        }

        if (candidate.state.value == DeviceSessionState.STARTED) {
            return candidate
        }

        _uiState.update { it.copy(streamStatus = "Connecting session") }
        val settled = withTimeoutOrNull(SESSION_START_TIMEOUT_MS) {
            candidate.state.first {
                it == DeviceSessionState.STARTED || it == DeviceSessionState.STOPPED
            }
        }
        if (settled != DeviceSessionState.STARTED) {
            if (sdkError == null) {
                setSdkError("Glasses session did not start; verify glasses are unfolded and connected")
            }
            synchronized(stateLock) {
                if (activeSession === candidate) {
                    sessionStateJob?.cancel()
                    sessionStateJob = null
                    sessionErrorJob?.cancel()
                    sessionErrorJob = null
                    activeSession = null
                }
            }
            runCatching { candidate.stop() }
            return null
        }
        return candidate
    }

    private fun createAndStartNewSession(appContext: Context): DeviceSession? {
        var createdSession: DeviceSession? = null
        Wearables.createSession(AutoDeviceSelector()).fold(
            onSuccess = { session ->
                createdSession = session
                observeSession(appContext, session)
                session.start()
            },
            onFailure = { error, _ ->
                setSdkError(error.description)
            },
        )
        return createdSession
    }

    private fun observeSession(appContext: Context, session: DeviceSession) {
        val nextStateJob = scope.launch(exceptionHandler) {
            var hasLeftIdle = false
            session.state.collect { state ->
                when (state) {
                    DeviceSessionState.STARTING,
                    DeviceSessionState.STARTED -> {
                        hasLeftIdle = true
                    }
                    DeviceSessionState.PAUSED -> {
                        hasLeftIdle = true
                        _uiState.update { it.copy(streaming = false, streamStatus = "Session paused") }
                        publishDeviceState(force = false)
                    }
                    DeviceSessionState.STOPPING -> {
                        if (hasLeftIdle) {
                            _uiState.update { it.copy(streaming = false, streamStatus = "Stopping") }
                            publishDeviceState(force = false)
                        }
                    }
                    DeviceSessionState.STOPPED -> {
                        if (hasLeftIdle) {
                            val isCurrent = synchronized(stateLock) {
                                if (activeSession === session) {
                                    activeSession = null
                                    true
                                } else {
                                    false
                                }
                            }
                            if (isCurrent) {
                                teardownStreamInternal(appContext, nextStatus = "Idle")
                            }
                        }
                    }
                    DeviceSessionState.IDLE -> Unit
                }
            }
        }
        val nextErrorJob = scope.launch(exceptionHandler) {
            session.errors.collect { error ->
                setSdkError(error.description)
            }
        }
        synchronized(stateLock) {
            sessionStateJob?.cancel()
            sessionErrorJob?.cancel()
            activeSession = session
            sessionStateJob = nextStateJob
            sessionErrorJob = nextErrorJob
        }
    }

    private fun attachAndStartCamera(appContext: Context, session: DeviceSession) {
        _uiState.update { it.copy(streamStatus = "Opening camera") }
        session.addCamera(
            StreamConfiguration(
                videoQuality = VideoQuality.HIGH,
                frameRate = STREAM_FPS,
            ),
        ).fold(
            onSuccess = { camera ->
                val stream = camera.stream
                synchronized(stateLock) {
                    activeCamera = camera
                    activeStream = stream
                }
                setupStreamCollectors(appContext, camera, stream)
                stream.start().onFailure { error, _ ->
                    setSdkError(error.description)
                    teardownStreamInternal(appContext, nextStatus = "Error")
                }
            },
            onFailure = { error, _ ->
                setSdkError(error.description)
                StreamingForegroundService.stop(appContext)
                _uiState.update { it.copy(streaming = false, streamStatus = "Error") }
                publishDeviceState(force = true)
            },
        )
    }

    private fun setupStreamCollectors(appContext: Context, camera: Camera, stream: Stream) {
        lastEncodedFrameMs = 0L
        val nextVideoJob = scope.launch(exceptionHandler) {
            stream.videoStream.collect { frame ->
                handleVideoFrame(frame)
            }
        }
        val nextStateJob = scope.launch(exceptionHandler) {
            var hasBeenActive = false
            stream.state.collect { state ->
                when (state) {
                    StreamState.STARTING -> {
                        hasBeenActive = true
                        _uiState.update { it.copy(streamStatus = "Starting") }
                    }
                    StreamState.STARTED -> {
                        hasBeenActive = true
                        _uiState.update { it.copy(streamStatus = "Started") }
                    }
                    StreamState.STREAMING -> {
                        hasBeenActive = true
                        _uiState.update { it.copy(streaming = true, streamStatus = "Active") }
                        publishDeviceState(force = false)
                    }
                    StreamState.PAUSED -> {
                        hasBeenActive = true
                        _uiState.update { it.copy(streaming = false, streamStatus = "Paused") }
                        publishDeviceState(force = false)
                    }
                    StreamState.STOPPING -> {
                        _uiState.update { it.copy(streaming = false, streamStatus = "Stopping") }
                        publishDeviceState(force = false)
                    }
                    StreamState.STOPPED,
                    StreamState.CLOSED -> {
                        if (hasBeenActive) {
                            hasBeenActive = false
                            val stillCurrent = synchronized(stateLock) { activeCamera === camera }
                            if (stillCurrent) {
                                teardownStreamInternal(appContext, nextStatus = "Idle")
                            }
                        }
                    }
                }
            }
        }
        val nextErrorJob = scope.launch(exceptionHandler) {
            stream.errorStream.collect { error ->
                setSdkError(error.description)
            }
        }
        synchronized(stateLock) {
            videoJob?.cancel()
            streamStateJob?.cancel()
            streamErrorJob?.cancel()
            videoJob = nextVideoJob
            streamStateJob = nextStateJob
            streamErrorJob = nextErrorJob
        }
    }

    private fun handleVideoFrame(frame: VideoFrame) {
        if (frame.isCompressed || frame.width <= 0 || frame.height <= 0) {
            return
        }
        val nowMs = SystemClock.elapsedRealtime()
        if (nowMs - lastEncodedFrameMs < MIN_ENCODE_INTERVAL_MS) {
            return
        }
        lastEncodedFrameMs = nowMs

        val jpegBytes = try {
            YuvJpegEncoder.encodeBufferToJpeg(
                frame.buffer,
                frame.width,
                frame.height,
            )
        } catch (ce: CancellationException) {
            throw ce
        } catch (err: Exception) {
            setSdkError(err.message ?: "YUV to JPEG encoding failed")
            return
        }

        if (jpegBytes.isNotEmpty()) {
            scope.launch(exceptionHandler) {
                ingestClient.submitFrameIfIdle(jpegBytes)
            }
        }
    }

    private fun teardownStreamInternal(appContext: Context, nextStatus: String) {
        val cameraToStop: Camera?
        synchronized(stateLock) {
            videoJob?.cancel()
            videoJob = null
            streamStateJob?.cancel()
            streamStateJob = null
            streamErrorJob?.cancel()
            streamErrorJob = null
            cameraToStop = activeCamera
            activeCamera = null
            activeStream = null
        }
        runCatching { cameraToStop?.stop() }
        runCatching { closeCapability(cameraToStop) }
        StreamingForegroundService.stop(appContext)
        _uiState.update { it.copy(streaming = false, streamStatus = nextStatus) }
        publishDeviceState(force = true)
    }

    private fun closeCapability(capability: Closeable?) {
        capability?.close()
    }

    private fun publishDeviceState(force: Boolean) {
        val current = _uiState.value
        if (current.serverUrl.isBlank()) {
            return
        }
        val nextState = BridgeDeviceState(
            connected = current.connected,
            worn = current.worn,
            battery = current.batteryPercent,
            streaming = current.streaming,
        )
        val shouldPost = synchronized(stateLock) {
            if (!force && lastPostedDeviceState == nextState) {
                false
            } else {
                lastPostedDeviceState = nextState
                true
            }
        }
        if (shouldPost) {
            scope.launch(exceptionHandler) {
                ingestClient.postState(nextState)
            }
        }
    }

    private fun setSdkError(message: String) {
        sdkError = message
        _uiState.update { it.copy(lastError = message) }
    }

    private fun clearSdkError() {
        sdkError = null
        val metricError = ingestClient.metrics.value.lastError
        _uiState.update { it.copy(lastError = metricError) }
    }

    private fun rememberActivity(context: Context) {
        val componentActivity = findComponentActivity(context)
        if (componentActivity != null) {
            lastActivityRef = WeakReference(componentActivity)
        }
    }

    private fun findComponentActivity(context: Context): ComponentActivity? {
        var current: Context? = context
        while (current != null) {
            if (current is ComponentActivity) {
                return current
            }
            current = (current as? ContextWrapper)?.baseContext
        }
        return null
    }

    private fun rankDevice(device: Device): Int =
        when {
            device.linkState == LinkState.CONNECTED && device.donState == DonState.DONNED -> 0
            device.linkState == LinkState.CONNECTED -> 1
            device.compatibility == DeviceCompatibility.COMPATIBLE -> 2
            else -> 3
        }

    private fun formatRegistrationStatus(state: RegistrationState): String =
        when (state) {
            RegistrationState.REGISTERED -> "Registered"
            RegistrationState.REGISTERING -> "Registering"
            RegistrationState.UNREGISTERING -> "Unregistering"
            RegistrationState.AVAILABLE -> "Unregistered"
            RegistrationState.UNAVAILABLE -> "Unavailable"
        }

    private fun formatThermalStatus(level: ThermalLevel?): String =
        when (level) {
            null,
            ThermalLevel.UNKNOWN,
            ThermalLevel.NONE -> "Normal"
            ThermalLevel.LIGHT -> "Warm"
            ThermalLevel.MODERATE -> "Moderate"
            ThermalLevel.SEVERE -> "Severe"
            ThermalLevel.CRITICAL -> "Critical"
            ThermalLevel.EMERGENCY -> "Emergency"
            ThermalLevel.SHUTDOWN -> "Shutdown"
        }
}
