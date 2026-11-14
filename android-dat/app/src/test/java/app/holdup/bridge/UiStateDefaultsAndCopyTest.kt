package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.types.ThermalLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiStateDefaultsAndCopyTest {

  @Test
  fun coldStartDefaultsAreDisconnectedAndIdle() {
    val s = UiState()
    assertEquals("", s.serverUrl)
    assertEquals("", s.sessionCode)
    assertFalse(s.btPermissionGranted)
    assertFalse(s.sdkReady)
    assertEquals(RegistrationState.UNAVAILABLE, s.registration)
    assertNull(s.deviceName)
    assertNull(s.linkState)
    assertNull(s.battery)
    assertFalse(s.charging)
    assertEquals(DonState.UNKNOWN, s.donState)
    assertEquals(ThermalLevel.UNKNOWN, s.thermal)
    assertFalse(s.firmwareUpdateRequired)
    assertFalse(s.glassesAppUpdateRequired)
    assertEquals(DeviceSessionState.IDLE, s.sessionState)
    assertEquals(StreamState.STOPPED, s.streamState)
    assertFalse(s.wantConnected)
    assertFalse(s.wantStreaming)
    assertEquals(0L, s.framesSent)
    assertEquals(0L, s.framesDropped)
    assertEquals(0, s.lastFrameKb)
    assertEquals("", s.frameSize)
    assertEquals("", s.yuvLayout)
    assertEquals("\u2013", s.frameHttp)
    assertEquals("\u2013", s.stateHttp)
    assertNull(s.netOk)
    assertEquals("Waiting for Bluetooth permission", s.status)
    assertNull(s.error)
    assertFalse(s.isRegistered)
    assertFalse(s.sessionActive)
    assertFalse(s.streaming)
    assertNull(s.resolveTarget())
    assertEquals(GlassesState(false, null, null, false), s.toGlassesState())
    assertEquals(
        "{\"connected\":false,\"worn\":null,\"battery\":null,\"streaming\":false}",
        s.toGlassesState().toJson(),
    )
  }

  @Test
  fun copyIsImmutableAndPreservesUnmodifiedTelemetryFields() {
    val base =
        UiState(
            serverUrl = "demo.trycloudflare.com",
            sessionCode = "HUP99",
            btPermissionGranted = true,
            sdkReady = true,
            registration = RegistrationState.REGISTERED,
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            battery = 74,
            charging = true,
            donState = DonState.DONNED,
            thermal = ThermalLevel.LIGHT,
            firmwareUpdateRequired = true,
            glassesAppUpdateRequired = true,
            sessionState = DeviceSessionState.STARTED,
            streamState = StreamState.STREAMING,
            wantConnected = true,
            wantStreaming = true,
            framesSent = 12L,
            framesDropped = 1L,
            lastFrameKb = 48,
            frameSize = "1280x720",
            yuvLayout = "NV12",
            frameHttp = "HTTP 200",
            stateHttp = "HTTP 200",
            netOk = true,
            status = "Streaming glasses camera",
            error = null,
        )
    val exactCopy = base.copy()
    assertEquals(base, exactCopy)
    assertEquals(base.hashCode(), exactCopy.hashCode())

    val updated = base.copy(framesDropped = 2L, error = "Server unreachable")
    assertNotEquals(base, updated)
    assertEquals(1L, base.framesDropped)
    assertNull(base.error)

    assertEquals("demo.trycloudflare.com", updated.serverUrl)
    assertEquals("HUP99", updated.sessionCode)
    assertTrue(updated.btPermissionGranted)
    assertTrue(updated.sdkReady)
    assertEquals(RegistrationState.REGISTERED, updated.registration)
    assertEquals("Ray-Ban Meta", updated.deviceName)
    assertEquals(LinkState.CONNECTED, updated.linkState)
    assertEquals(74, updated.battery)
    assertTrue(updated.charging)
    assertEquals(DonState.DONNED, updated.donState)
    assertEquals(ThermalLevel.LIGHT, updated.thermal)
    assertTrue(updated.firmwareUpdateRequired)
    assertTrue(updated.glassesAppUpdateRequired)
    assertEquals(DeviceSessionState.STARTED, updated.sessionState)
    assertEquals(StreamState.STREAMING, updated.streamState)
    assertTrue(updated.wantConnected)
    assertTrue(updated.wantStreaming)
    assertEquals(12L, updated.framesSent)
    assertEquals(2L, updated.framesDropped)
    assertEquals(48, updated.lastFrameKb)
    assertEquals("1280x720", updated.frameSize)
    assertEquals("NV12", updated.yuvLayout)
    assertEquals("HTTP 200", updated.frameHttp)
    assertEquals("HTTP 200", updated.stateHttp)
    assertEquals(true, updated.netOk)
    assertEquals("Streaming glasses camera", updated.status)
    assertEquals("Server unreachable", updated.error)
  }

  @Test
  fun everyConstructorFieldParticipatesInEqualityAndCopy() {
    val d = UiState()
    val variants =
        listOf(
            d.copy(serverUrl = "demo.trycloudflare.com"),
            d.copy(sessionCode = "S1"),
            d.copy(btPermissionGranted = true),
            d.copy(sdkReady = true),
            d.copy(registration = RegistrationState.REGISTERED),
            d.copy(deviceName = "Ray-Ban Meta"),
            d.copy(linkState = LinkState.CONNECTED),
            d.copy(battery = 50),
            d.copy(charging = true),
            d.copy(donState = DonState.DONNED),
            d.copy(thermal = ThermalLevel.MODERATE),
            d.copy(firmwareUpdateRequired = true),
            d.copy(glassesAppUpdateRequired = true),
            d.copy(sessionState = DeviceSessionState.STARTED),
            d.copy(streamState = StreamState.STREAMING),
            d.copy(wantConnected = true),
            d.copy(wantStreaming = true),
            d.copy(framesSent = 1L),
            d.copy(framesDropped = 1L),
            d.copy(lastFrameKb = 32),
            d.copy(frameSize = "720x1280"),
            d.copy(yuvLayout = "I420"),
            d.copy(frameHttp = "HTTP 200"),
            d.copy(stateHttp = "HTTP 200"),
            d.copy(netOk = true),
            d.copy(status = "Ready"),
            d.copy(error = "Timeout"),
        )
    assertEquals(27, variants.size)
    for (v in variants) {
      assertNotEquals(d, v)
      assertEquals(v, v.copy())
      assertEquals(v.hashCode(), v.copy().hashCode())
    }
    assertEquals(27, variants.toSet().size)
  }

  @Test
  fun copyCanResetNullableFieldsBackToNull() {
    val populated =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            battery = 65,
            netOk = false,
            error = "Glasses battery low. Charge them.",
        )
    val clearedError = populated.copy(error = null)
    assertNull(clearedError.error)
    assertEquals("Ray-Ban Meta", clearedError.deviceName)
    assertEquals(LinkState.CONNECTED, clearedError.linkState)
    assertEquals(65, clearedError.battery)
    assertEquals(false, clearedError.netOk)

    val clearedDevice =
        clearedError.copy(
            deviceName = null,
            linkState = null,
            battery = null,
            netOk = null,
        )
    assertNull(clearedDevice.deviceName)
    assertNull(clearedDevice.linkState)
    assertNull(clearedDevice.battery)
    assertNull(clearedDevice.netOk)
    assertEquals(GlassesState(false, null, null, false), clearedDevice.toGlassesState())
  }

  @Test
  fun copyOfUiOnlyFieldsPreservesGlassesStateForPushDeduplication() {
    val active =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.DONNED,
            battery = 78,
            streamState = StreamState.STREAMING,
        )
    val expected = GlassesState(connected = true, worn = true, battery = 78, streaming = true)
    assertEquals(expected, active.toGlassesState())

    val uiOnlyUpdated =
        active.copy(
            serverUrl = "demo.trycloudflare.com",
            sessionCode = "ABC",
            btPermissionGranted = true,
            sdkReady = true,
            registration = RegistrationState.REGISTERED,
            deviceName = "Glasses",
            charging = true,
            thermal = ThermalLevel.SEVERE,
            firmwareUpdateRequired = true,
            glassesAppUpdateRequired = true,
            sessionState = DeviceSessionState.STARTED,
            wantConnected = true,
            wantStreaming = true,
            framesSent = 99L,
            framesDropped = 4L,
            lastFrameKb = 52,
            frameSize = "720x1280",
            yuvLayout = "NV12",
            frameHttp = "HTTP 200",
            stateHttp = "HTTP 200",
            netOk = true,
            status = "Streaming",
            error = "Glasses are hot",
        )
    assertEquals(expected, uiOnlyUpdated.toGlassesState())

    assertNotEquals(expected, active.copy(linkState = LinkState.DISCONNECTED).toGlassesState())
    assertNotEquals(expected, active.copy(deviceName = null).toGlassesState())
    assertNotEquals(expected, active.copy(donState = DonState.DOFFED).toGlassesState())
    assertNotEquals(expected, active.copy(battery = 77).toGlassesState())
    assertNotEquals(expected, active.copy(streamState = StreamState.PAUSED).toGlassesState())
  }

  @Test
  fun copyUpdatesDerivedFlagsAndTargetResolutionDynamically() {
    var ui = UiState()
    assertFalse(ui.isRegistered)
    assertFalse(ui.sessionActive)
    assertFalse(ui.streaming)
    assertNull(ui.resolveTarget())

    ui = ui.copy(registration = RegistrationState.REGISTERING)
    assertFalse(ui.isRegistered)
    ui = ui.copy(registration = RegistrationState.REGISTERED)
    assertTrue(ui.isRegistered)

    ui = ui.copy(sessionState = DeviceSessionState.STARTING)
    assertFalse(ui.sessionActive)
    ui = ui.copy(sessionState = DeviceSessionState.STARTED)
    assertTrue(ui.sessionActive)

    ui = ui.copy(streamState = StreamState.STARTING)
    assertFalse(ui.streaming)
    ui = ui.copy(streamState = StreamState.STREAMING)
    assertTrue(ui.streaming)

    ui = ui.copy(serverUrl = "  demo.trycloudflare.com/  ")
    assertEquals(Pair("https://demo.trycloudflare.com", ""), ui.resolveTarget())

    ui = ui.copy(sessionCode = "  HUP99  ")
    assertEquals(Pair("https://demo.trycloudflare.com", "HUP99"), ui.resolveTarget())

    ui = ui.copy(serverUrl = "   ")
    assertNull(ui.resolveTarget())
  }

  @Test
  fun serverErrorClearPatternPreservesHardwareErrors() {
    fun clearServerErrorOnSuccess(ui: UiState): UiState =
        ui.copy(
            netOk = true,
            error = if (ui.error?.startsWith("Server") == true) null else ui.error,
        )

    val serverErr = UiState(netOk = false, error = "Server rejected frame: HTTP 503")
    val clearedServerErr = clearServerErrorOnSuccess(serverErr)
    assertEquals(true, clearedServerErr.netOk)
    assertNull(clearedServerErr.error)

    val netErr = UiState(netOk = false, error = "Server unreachable (IOException). Retrying...")
    assertNull(clearServerErrorOnSuccess(netErr).error)

    val hardwareErr = UiState(netOk = false, error = "Glasses are folded. Unfold them to continue.")
    val preserved = clearServerErrorOnSuccess(hardwareErr)
    assertEquals(true, preserved.netOk)
    assertEquals("Glasses are folded. Unfold them to continue.", preserved.error)

    val noErr = UiState(netOk = null, error = null)
    assertNull(clearServerErrorOnSuccess(noErr).error)
  }

  @Test
  fun thermalThresholdOrderingMatchesSevereGuard() {
    assertTrue(ThermalLevel.UNKNOWN < ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.NONE < ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.LIGHT < ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.MODERATE < ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.SEVERE >= ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.CRITICAL >= ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.EMERGENCY >= ThermalLevel.SEVERE)
    assertTrue(ThermalLevel.SHUTDOWN >= ThermalLevel.SEVERE)
    assertEquals(ThermalLevel.CRITICAL, UiState().copy(thermal = ThermalLevel.CRITICAL).thermal)
  }

  @Test
  fun multiStepCopyLifecycleKeepsGlassesStateConsistent() {
    val connected =
        UiState().copy(
            registration = RegistrationState.REGISTERED,
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            battery = 82,
            donState = DonState.DONNED,
            sessionState = DeviceSessionState.STARTED,
            wantConnected = true,
        )
    assertTrue(connected.isRegistered && connected.sessionActive && !connected.streaming)
    assertFalse(connected.copy(deviceName = null).toGlassesState().connected)
    assertEquals(GlassesState(true, true, 82, false), connected.toGlassesState())

    val streaming =
        connected.copy(
            wantStreaming = true,
            streamState = StreamState.STREAMING,
            framesSent = 3L,
        )
    assertEquals(GlassesState(true, true, 82, true), streaming.toGlassesState())

    val paused = streaming.copy(streamState = StreamState.PAUSED)
    assertFalse(paused.streaming)
    assertEquals(GlassesState(true, true, 82, false), paused.toGlassesState())

    val disconnected =
        paused.copy(
            sessionState = DeviceSessionState.STOPPED,
            streamState = StreamState.STOPPED,
            linkState = LinkState.DISCONNECTED,
            donState = DonState.UNKNOWN,
        )
    assertFalse(disconnected.sessionActive || disconnected.streaming)
    assertEquals(GlassesState(false, null, 82, false), disconnected.toGlassesState())
    assertEquals(false, disconnected.copy(donState = DonState.DOFFED).toGlassesState().worn)
  }
}
