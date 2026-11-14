package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.RegistrationState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DatStateTransitionTest {

  @Test
  fun toGlassesStateRequiresBothConnectedLinkAndNonNullDeviceName() {
    assertFalse(
        UiState(linkState = null, deviceName = null).toGlassesState().connected,
    )
    assertFalse(
        UiState(linkState = null, deviceName = "Ray-Ban Meta").toGlassesState().connected,
    )
    assertFalse(
        UiState(linkState = LinkState.DISCONNECTED, deviceName = null).toGlassesState().connected,
    )
    assertFalse(
        UiState(linkState = LinkState.DISCONNECTED, deviceName = "Ray-Ban Meta")
            .toGlassesState()
            .connected,
    )
    assertFalse(
        UiState(linkState = LinkState.CONNECTING, deviceName = null).toGlassesState().connected,
    )
    assertFalse(
        UiState(linkState = LinkState.CONNECTING, deviceName = "Ray-Ban Meta")
            .toGlassesState()
            .connected,
    )
    assertFalse(
        UiState(linkState = LinkState.CONNECTED, deviceName = null).toGlassesState().connected,
    )
    assertTrue(
        UiState(linkState = LinkState.CONNECTED, deviceName = "Ray-Ban Meta")
            .toGlassesState()
            .connected,
    )
  }

  @Test
  fun toGlassesStateMapsDonStateToNullableWornFlag() {
    assertEquals(true, UiState(donState = DonState.DONNED).toGlassesState().worn)
    assertEquals(false, UiState(donState = DonState.DOFFED).toGlassesState().worn)
    assertNull(UiState(donState = DonState.UNKNOWN).toGlassesState().worn)
  }

  @Test
  fun toGlassesStateAndStreamingFlagOnlyReportTrueWhenStreaming() {
    assertTrue(UiState(streamState = StreamState.STREAMING).streaming)
    assertTrue(UiState(streamState = StreamState.STREAMING).toGlassesState().streaming)

    val nonStreamingStates =
        listOf(
            StreamState.STOPPED,
            StreamState.PAUSED,
            StreamState.STARTING,
            StreamState.STARTED,
            StreamState.STOPPING,
            StreamState.CLOSED,
        )
    for (state in nonStreamingStates) {
      val ui = UiState(streamState = state)
      assertFalse("Expected streaming=false for $state", ui.streaming)
      assertFalse("Expected GlassesState.streaming=false for $state", ui.toGlassesState().streaming)
    }
  }

  @Test
  fun isRegisteredIsTrueOnlyForRegisteredState() {
    assertTrue(UiState(registration = RegistrationState.REGISTERED).isRegistered)

    val unreadyStates =
        listOf(
            RegistrationState.UNAVAILABLE,
            RegistrationState.AVAILABLE,
            RegistrationState.REGISTERING,
            RegistrationState.UNREGISTERING,
        )
    for (state in unreadyStates) {
      assertFalse("Expected isRegistered=false for $state", UiState(registration = state).isRegistered)
    }
  }

  @Test
  fun sessionActiveIsTrueOnlyWhenSessionStarted() {
    assertTrue(UiState(sessionState = DeviceSessionState.STARTED).sessionActive)

    val inactiveStates =
        listOf(
            DeviceSessionState.IDLE,
            DeviceSessionState.STARTING,
            DeviceSessionState.PAUSED,
            DeviceSessionState.STOPPING,
            DeviceSessionState.STOPPED,
        )
    for (state in inactiveStates) {
      assertFalse(
          "Expected sessionActive=false for $state",
          UiState(sessionState = state).sessionActive,
      )
    }
  }

  @Test
  fun endToEndDatLifecycleTransitionsProduceExpectedGlassesStates() {
    var ui = UiState()
    assertFalse(ui.isRegistered)
    assertFalse(ui.sessionActive)
    assertEquals(
        GlassesState(connected = false, worn = null, battery = null, streaming = false),
        ui.toGlassesState(),
    )

    ui =
        ui.copy(
            registration = RegistrationState.REGISTERED,
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTING,
        )
    assertTrue(ui.isRegistered)
    assertFalse(ui.toGlassesState().connected)

    ui =
        ui.copy(
            linkState = LinkState.CONNECTED,
            donState = DonState.DONNED,
            battery = BridgeViewModel.normalizeBatteryLevel(82),
            sessionState = DeviceSessionState.STARTED,
            streamState = StreamState.STARTING,
        )
    assertTrue(ui.sessionActive)
    assertEquals(
        GlassesState(connected = true, worn = true, battery = 82, streaming = false),
        ui.toGlassesState(),
    )

    ui = ui.copy(streamState = StreamState.STREAMING)
    assertEquals(
        GlassesState(connected = true, worn = true, battery = 82, streaming = true),
        ui.toGlassesState(),
    )

    ui =
        ui.copy(
            donState = DonState.DOFFED,
            sessionState = DeviceSessionState.PAUSED,
            streamState = StreamState.PAUSED,
        )
    assertFalse(ui.sessionActive)
    assertEquals(
        GlassesState(connected = true, worn = false, battery = 82, streaming = false),
        ui.toGlassesState(),
    )

    ui =
        ui.copy(
            deviceName = null,
            linkState = null,
            donState = DonState.UNKNOWN,
            battery = BridgeViewModel.normalizeBatteryLevel(0),
            sessionState = DeviceSessionState.STOPPED,
            streamState = StreamState.STOPPED,
        )
    assertFalse(ui.sessionActive)
    assertEquals(
        GlassesState(connected = false, worn = null, battery = null, streaming = false),
        ui.toGlassesState(),
    )
  }

  @Test
  fun resolveTargetNormalizesServerTrimsSessionAndRejectsBlankServers() {
    assertNull(UiState().resolveTarget())
    assertNull(UiState(serverUrl = "   ", sessionCode = "ABC123").resolveTarget())
    assertNull(UiState(serverUrl = " /// ", sessionCode = "ABC123").resolveTarget())

    assertEquals(
        Pair("https://demo.trycloudflare.com", "HUP42"),
        UiState(serverUrl = "  demo.trycloudflare.com/  ", sessionCode = "  HUP42  ")
            .resolveTarget(),
    )
    assertEquals(
        Pair("http://10.0.0.2:8787", ""),
        UiState(serverUrl = "http://10.0.0.2:8787/", sessionCode = "   ").resolveTarget(),
    )
    assertEquals(
        Pair("https://abc.trycloudflare.com/?key=XYZ", "s1"),
        UiState(serverUrl = "https://abc.trycloudflare.com/?key=XYZ", sessionCode = "s1")
            .resolveTarget(),
    )
  }

  @Test
  fun normalizeBatteryLevelTreatsZeroAndNegativeAsUnknown() {
    assertNull(BridgeViewModel.normalizeBatteryLevel(0))
    assertNull(BridgeViewModel.normalizeBatteryLevel(-1))
    assertNull(BridgeViewModel.normalizeBatteryLevel(-100))
    assertNull(BridgeViewModel.normalizeBatteryLevel(Int.MIN_VALUE))
    assertEquals(1, BridgeViewModel.normalizeBatteryLevel(1))
    assertEquals(47, BridgeViewModel.normalizeBatteryLevel(47))
    assertEquals(100, BridgeViewModel.normalizeBatteryLevel(100))
  }

  @Test
  fun reconnectDelayMsDoublesFromTwoSecondsAndCapsAtFifteenSeconds() {
    assertEquals(2_000L, BridgeViewModel.reconnectDelayMs(-1))
    assertEquals(2_000L, BridgeViewModel.reconnectDelayMs(0))
    assertEquals(4_000L, BridgeViewModel.reconnectDelayMs(1))
    assertEquals(8_000L, BridgeViewModel.reconnectDelayMs(2))
    assertEquals(15_000L, BridgeViewModel.reconnectDelayMs(3))
    assertEquals(15_000L, BridgeViewModel.reconnectDelayMs(4))
    assertEquals(15_000L, BridgeViewModel.reconnectDelayMs(5))
    assertEquals(15_000L, BridgeViewModel.reconnectDelayMs(40))
  }

  @Test
  fun streamRetryDelayMsDoublesFromOnePointFiveSecondsAndCapsAtTenSeconds() {
    assertEquals(1_500L, BridgeViewModel.streamRetryDelayMs(-1))
    assertEquals(1_500L, BridgeViewModel.streamRetryDelayMs(0))
    assertEquals(3_000L, BridgeViewModel.streamRetryDelayMs(1))
    assertEquals(6_000L, BridgeViewModel.streamRetryDelayMs(2))
    assertEquals(10_000L, BridgeViewModel.streamRetryDelayMs(3))
    assertEquals(10_000L, BridgeViewModel.streamRetryDelayMs(4))
    assertEquals(10_000L, BridgeViewModel.streamRetryDelayMs(5))
    assertEquals(10_000L, BridgeViewModel.streamRetryDelayMs(40))
  }

  @Test
  fun frameIntervalMsStartsAtOneSecondAndCapsBackoffAtEightSeconds() {
    assertEquals(1_000L, BridgeViewModel.frameIntervalMs(-1))
    assertEquals(1_000L, BridgeViewModel.frameIntervalMs(0))
    assertEquals(2_000L, BridgeViewModel.frameIntervalMs(1))
    assertEquals(4_000L, BridgeViewModel.frameIntervalMs(2))
    assertEquals(8_000L, BridgeViewModel.frameIntervalMs(3))
    assertEquals(8_000L, BridgeViewModel.frameIntervalMs(4))
    assertEquals(8_000L, BridgeViewModel.frameIntervalMs(5))
    assertEquals(8_000L, BridgeViewModel.frameIntervalMs(40))
  }

  @Test
  fun frameHttpHintMapsTroubleshootingCodesAndLeavesOthersEmpty() {
    assertEquals(
        " (server has no /ingest/frame? check URL/branch)",
        BridgeViewModel.frameHttpHint(404),
    )
    assertEquals(" (unknown session code?)", BridgeViewModel.frameHttpHint(400))
    assertEquals(" (unknown session code?)", BridgeViewModel.frameHttpHint(410))
    assertEquals(" (tunnel up but server down?)", BridgeViewModel.frameHttpHint(502))
    assertEquals(" (tunnel up but server down?)", BridgeViewModel.frameHttpHint(503))
    assertEquals(" (tunnel up but server down?)", BridgeViewModel.frameHttpHint(530))
    assertEquals("", BridgeViewModel.frameHttpHint(200))
    assertEquals("", BridgeViewModel.frameHttpHint(204))
    assertEquals("", BridgeViewModel.frameHttpHint(401))
    assertEquals("", BridgeViewModel.frameHttpHint(500))
  }
}
