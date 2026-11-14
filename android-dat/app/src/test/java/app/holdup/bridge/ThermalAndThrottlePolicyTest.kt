package app.holdup.bridge

import java.lang.reflect.Field
import java.lang.reflect.Method
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ThermalAndThrottlePolicyTest {

    private val buildEndpointUrlMethod: Method =
        IngestClient::class.java.getDeclaredMethod("buildEndpointUrl", String::class.java).apply {
            isAccessible = true
        }

    private val serializeStateMethod: Method =
        IngestClient::class.java.getDeclaredMethod("serializeState", BridgeDeviceState::class.java).apply {
            isAccessible = true
        }

    private val minFrameIntervalField: Field =
        IngestClient::class.java.getDeclaredField("minFrameIntervalMs").apply {
            isAccessible = true
        }

    private val lastSentAtField: Field =
        IngestClient::class.java.getDeclaredField("lastSentAt").apply {
            isAccessible = true
        }

    private val frameInFlightField: Field =
        IngestClient::class.java.getDeclaredField("frameInFlight").apply {
            isAccessible = true
        }

    private val baseServerUrlField: Field =
        IngestClient::class.java.getDeclaredField("baseServerUrl").apply {
            isAccessible = true
        }

    private val activeSessionCodeField: Field =
        IngestClient::class.java.getDeclaredField("activeSessionCode").apply {
            isAccessible = true
        }

    @Test
    fun captureThrottlePolicy_enforcesGe900MsAndApproxOneFpsAcrossEncodeIngestAndInFlightGates() {
        val controllerClass = Class.forName(
            "app.holdup.bridge.DatBridgeController",
            false,
            IngestClient::class.java.classLoader,
        )
        val streamFps = controllerClass.getDeclaredField("STREAM_FPS").apply {
            isAccessible = true
        }.getInt(null)
        val minEncodeIntervalMs = controllerClass.getDeclaredField("MIN_ENCODE_INTERVAL_MS").apply {
            isAccessible = true
        }.getLong(null)
        val sessionStartTimeoutMs = controllerClass.getDeclaredField("SESSION_START_TIMEOUT_MS").apply {
            isAccessible = true
        }.getLong(null)

        val defaultClient = IngestClient()
        val defaultIngestIntervalMs = minFrameIntervalField.getLong(defaultClient)

        assertEquals(2, streamFps)
        assertEquals(960L, minEncodeIntervalMs)
        assertEquals(950L, defaultIngestIntervalMs)
        assertEquals(15_000L, sessionStartTimeoutMs)

        assertTrue(minEncodeIntervalMs >= MIN_ALLOWED_FRAME_INTERVAL_MS)
        assertTrue(defaultIngestIntervalMs >= MIN_ALLOWED_FRAME_INTERVAL_MS)
        assertTrue(minEncodeIntervalMs <= FRAME_INTERVAL_MS)
        assertTrue(defaultIngestIntervalMs <= FRAME_INTERVAL_MS)
        assertTrue(minEncodeIntervalMs >= defaultIngestIntervalMs)

        for (configuredInterval in listOf(MIN_ALLOWED_FRAME_INTERVAL_MS, 950L, FRAME_INTERVAL_MS)) {
            val customClient = IngestClient(minFrameIntervalMs = configuredInterval)
            assertEquals(configuredInterval, minFrameIntervalField.getLong(customClient))
            assertEquals(-configuredInterval, lastSentAtField.getLong(customClient))
        }

        val boundaryVectors = listOf(
            MIN_ALLOWED_FRAME_INTERVAL_MS to listOf(
                0L to true,
                1L to false,
                450L to false,
                899L to false,
                900L to true,
                1799L to false,
                1800L to true,
            ),
            defaultIngestIntervalMs to listOf(
                0L to true,
                500L to false,
                949L to false,
                950L to true,
                1899L to false,
                1900L to true,
            ),
            minEncodeIntervalMs to listOf(
                0L to true,
                500L to false,
                959L to false,
                960L to true,
                1919L to false,
                1920L to true,
            ),
            FRAME_INTERVAL_MS to listOf(
                0L to true,
                500L to false,
                999L to false,
                1000L to true,
                1999L to false,
                2000L to true,
            ),
        )

        for ((intervalMs, probes) in boundaryVectors) {
            val policy = ThrottlePipelinePolicy(
                minEncodeIntervalMs = intervalMs,
                minIngestIntervalMs = intervalMs,
            )
            for ((nowMs, expectedAdmitted) in probes) {
                assertEquals(
                    "Unexpected throttle decision at t=${nowMs}ms for interval=${intervalMs}ms",
                    expectedAdmitted,
                    policy.onCameraFrame(nowMs = nowMs, isCompressed = false, width = 720, height = 1280, jpegBytes = 18_432),
                )
                if (expectedAdmitted) {
                    policy.completeInFlightPost()
                }
            }
        }

        val steadyTwoFpsPipeline = ThrottlePipelinePolicy(
            minEncodeIntervalMs = minEncodeIntervalMs,
            minIngestIntervalMs = defaultIngestIntervalMs,
        )
        for (tick in 0 until 60) {
            val tMs = tick * 500L
            val admitted = steadyTwoFpsPipeline.onCameraFrame(
                nowMs = tMs,
                isCompressed = false,
                width = 720,
                height = 1280,
                jpegBytes = 22_000,
            )
            if (admitted) {
                steadyTwoFpsPipeline.completeInFlightPost()
            }
        }
        assertEquals(30, steadyTwoFpsPipeline.sentTimestampsMs.size)
        assertEquals(30, steadyTwoFpsPipeline.skippedAtEncodeCount)
        assertEquals(0, steadyTwoFpsPipeline.droppedAtIngestCount)
        for (idx in 1 until steadyTwoFpsPipeline.sentTimestampsMs.size) {
            val delta = steadyTwoFpsPipeline.sentTimestampsMs[idx] - steadyTwoFpsPipeline.sentTimestampsMs[idx - 1]
            assertEquals(FRAME_INTERVAL_MS, delta)
            assertTrue(delta >= MIN_ALLOWED_FRAME_INTERVAL_MS)
        }

        val slowNetworkPipeline = ThrottlePipelinePolicy(
            minEncodeIntervalMs = minEncodeIntervalMs,
            minIngestIntervalMs = defaultIngestIntervalMs,
        )
        assertTrue(slowNetworkPipeline.onCameraFrame(0L, false, 720, 1280, 20_000))
        assertFalse(slowNetworkPipeline.onCameraFrame(500L, false, 720, 1280, 20_000))
        assertFalse(slowNetworkPipeline.onCameraFrame(1000L, false, 720, 1280, 20_000))
        assertFalse(slowNetworkPipeline.onCameraFrame(1500L, false, 720, 1280, 20_000))
        assertFalse(slowNetworkPipeline.onCameraFrame(2000L, false, 720, 1280, 20_000))
        slowNetworkPipeline.completeInFlightPost()
        assertFalse(slowNetworkPipeline.onCameraFrame(2500L, false, 720, 1280, 20_000))
        assertTrue(slowNetworkPipeline.onCameraFrame(3000L, false, 720, 1280, 20_000))
        slowNetworkPipeline.completeInFlightPost()

        assertEquals(listOf(0L, 3000L), slowNetworkPipeline.sentTimestampsMs)
        assertEquals(3, slowNetworkPipeline.skippedAtEncodeCount)
        assertEquals(2, slowNetworkPipeline.droppedAtIngestCount)

        slowNetworkPipeline.resetStreamCollectorClock()
        assertTrue(slowNetworkPipeline.onCameraFrame(3100L, false, 720, 1280, 20_000).not())
        assertEquals(3, slowNetworkPipeline.droppedAtIngestCount)
        assertTrue(slowNetworkPipeline.onCameraFrame(4000L, false, 720, 1280, 20_000))
        slowNetworkPipeline.completeInFlightPost()
        assertEquals(listOf(0L, 3000L, 4000L), slowNetworkPipeline.sentTimestampsMs)

        val guardPipeline = ThrottlePipelinePolicy(
            minEncodeIntervalMs = minEncodeIntervalMs,
            minIngestIntervalMs = defaultIngestIntervalMs,
        )
        assertFalse(guardPipeline.onCameraFrame(1000L, isCompressed = true, width = 720, height = 1280, jpegBytes = 1024))
        assertFalse(guardPipeline.onCameraFrame(1000L, isCompressed = false, width = 0, height = 1280, jpegBytes = 1024))
        assertFalse(guardPipeline.onCameraFrame(1000L, isCompressed = false, width = 720, height = 0, jpegBytes = 1024))
        assertFalse(guardPipeline.onCameraFrame(1000L, isCompressed = false, width = -720, height = 1280, jpegBytes = 1024))
        assertFalse(guardPipeline.onCameraFrame(1000L, isCompressed = false, width = 720, height = 1280, jpegBytes = 0))
        assertEquals(0, guardPipeline.sentTimestampsMs.size)

        try {
            YuvJpegEncoder.i420ToNv21(ByteBuffer.allocate(16), 3, 4)
            fail("Expected odd dimensions to be rejected before JPEG submission")
        } catch (expected: IllegalArgumentException) {
            assertNotNull(expected.message)
        }

        val busyLock = frameInFlightField.get(defaultClient) as AtomicBoolean
        busyLock.set(true)
        try {
            val jpegStub = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
            assertFalse(runBlocking { defaultClient.submitFrameIfIdle(jpegStub) })
            assertFalse(runBlocking { defaultClient.submitFrameIfIdle(jpegStub) })
            assertFalse(runBlocking { defaultClient.submitFrameIfIdle(jpegStub) })
            assertEquals(0L, defaultClient.metrics.value.framesSent)
            assertEquals(3L, defaultClient.metrics.value.framesDropped)
            assertEquals(0, defaultClient.metrics.value.lastHttpCode)
            assertNull(defaultClient.metrics.value.lastError)
        } finally {
            busyLock.set(false)
        }
    }

    @Test
    fun batteryPolicy_clampsZeroToHundredEnforcesUnder15HandoffAndPreservesNullUnknown() {
        val client = IngestClient()

        for (outOfRange in listOf(Int.MIN_VALUE, -500, -1, 0, 101, 127, 255, Int.MAX_VALUE)) {
            assertNull(
                "Expected controller battery normalization to reject $outOfRange",
                normalizeSdkBatteryPercent(outOfRange),
            )
        }
        assertNull(normalizeSdkBatteryPercent(null))

        for (pct in 1..100) {
            assertEquals(pct, normalizeSdkBatteryPercent(pct))
            assertEquals(pct, clampWireBatteryPercent(pct))
        }

        assertEquals(0, clampWireBatteryPercent(-42))
        assertEquals(0, clampWireBatteryPercent(-1))
        assertEquals(0, clampWireBatteryPercent(0))
        assertEquals(100, clampWireBatteryPercent(100))
        assertEquals(100, clampWireBatteryPercent(101))
        assertEquals(100, clampWireBatteryPercent(999))
        assertNull(clampWireBatteryPercent(null))

        for (pct in 0..14) {
            assertTrue("Expected $pct% to trigger <15% low-battery handoff", isLowBatteryHandoff(pct))
        }
        for (pct in 15..100) {
            assertFalse("Expected $pct% to stay on glasses camera", isLowBatteryHandoff(pct))
        }
        assertFalse(isLowBatteryHandoff(null))

        assertEquals("Unknown", formatStatusCardBattery(null))
        assertEquals("0% (Charge > 10% required)", formatStatusCardBattery(0))
        assertEquals("1% (Charge > 10% required)", formatStatusCardBattery(1))
        assertEquals("10% (Charge > 10% required)", formatStatusCardBattery(10))
        assertEquals("11% (Low battery)", formatStatusCardBattery(11))
        assertEquals("14% (Low battery)", formatStatusCardBattery(14))
        assertEquals("15%", formatStatusCardBattery(15))
        assertEquals("16%", formatStatusCardBattery(16))
        assertEquals("100%", formatStatusCardBattery(100))

        var activeEye = "phone"
        val trajectory = listOf(
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 100, streaming = true),
                expectedEye = "glasses",
                expectedAnnouncement = null,
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 15, streaming = true),
                expectedEye = "glasses",
                expectedAnnouncement = null,
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 14, streaming = true),
                expectedEye = "phone",
                expectedAnnouncement = "Glasses battery low, switching to phone camera",
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 10, streaming = true),
                expectedEye = "phone",
                expectedAnnouncement = null,
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 0, streaming = true),
                expectedEye = "phone",
                expectedAnnouncement = null,
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = null, streaming = true),
                expectedEye = "glasses",
                expectedAnnouncement = null,
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 1, streaming = true),
                expectedEye = "phone",
                expectedAnnouncement = "Glasses battery low, switching to phone camera",
            ),
            BatteryTrajectoryStep(
                state = BridgeDeviceState(connected = true, worn = true, battery = 15, streaming = true),
                expectedEye = "glasses",
                expectedAnnouncement = null,
            ),
        )

        for (step in trajectory) {
            val decision = evaluateEyeHandoff(previousSource = activeEye, state = step.state)
            activeEye = decision.nextSource
            assertEquals(step.expectedEye, activeEye)
            assertEquals(step.expectedAnnouncement, decision.announcement)

            val wireJson = invokeSerializeState(client, step.state)
            val expectedBatteryLiteral = step.state.battery?.toString() ?: "null"
            assertEquals(
                "{\"connected\":${step.state.connected},\"worn\":${step.state.worn},\"battery\":$expectedBatteryLiteral,\"streaming\":${step.state.streaming}}",
                wireJson,
            )
        }
    }

    @Test
    fun thermalPolicy_mapsAllThermalLevelsRanksActiveGlassesAndHandlesOverheatPauseRecovery() {
        val expectedThermalLabels = linkedMapOf<String?, String>(
            null to "Normal",
            "UNKNOWN" to "Normal",
            "NONE" to "Normal",
            "LIGHT" to "Warm",
            "MODERATE" to "Moderate",
            "SEVERE" to "Severe",
            "CRITICAL" to "Critical",
            "EMERGENCY" to "Emergency",
            "SHUTDOWN" to "Shutdown",
        )

        for ((rawLevel, expectedLabel) in expectedThermalLabels) {
            assertEquals(expectedLabel, formatThermalPolicyLabel(rawLevel))
        }

        val controllerClass = DatBridgeController::class.java
        val thermalMethod = controllerClass.declaredMethods.firstOrNull {
            it.name.startsWith("formatThermalStatus") && it.parameterCount == 1
        }
        assertNotNull(thermalMethod)
        thermalMethod!!.isAccessible = true
        val thermalParamType = thermalMethod.parameterTypes[0]
        if (!thermalParamType.isPrimitive) {
            assertEquals("Normal", thermalMethod.invoke(DatBridgeController, *arrayOfNulls<Any>(1)))
        }
        val thermalEnumConstants = thermalParamType.enumConstants
        if (thermalEnumConstants != null) {
            val constantsByName = thermalEnumConstants.associateBy { (it as Enum<*>).name }
            for ((rawName, expectedLabel) in expectedThermalLabels) {
                if (rawName != null) {
                    val constant = constantsByName[rawName]
                    assertNotNull("Missing ThermalLevel.$rawName constant", constant)
                    assertEquals(expectedLabel, thermalMethod.invoke(DatBridgeController, constant))
                }
            }
        }

        val coordinator = PolicyStateCoordinator()
        coordinator.initializeSdk()
        coordinator.updateEndpoint("https://demo.trycloudflare.com/", "hup-4k9m")
        coordinator.onRegistration("REGISTERED")

        val chargingDeskPair = SimulatedWearable(
            id = "desk-1",
            name = "Ray-Ban Desk Spare",
            connected = true,
            donState = "DOFFED",
            compatible = true,
            batteryLevel = 98,
            thermalLevel = "SEVERE",
        )
        val wornActivePair = SimulatedWearable(
            id = "worn-1",
            name = "Ray-Ban Meta Gen 2",
            connected = true,
            donState = "DONNED",
            compatible = true,
            batteryLevel = 72,
            thermalLevel = "NONE",
        )

        coordinator.onDevicesUpdated(listOf(chargingDeskPair, wornActivePair))
        assertEquals("Ray-Ban Meta Gen 2", coordinator.uiState.deviceName)
        assertTrue(coordinator.uiState.connected)
        assertTrue(coordinator.uiState.worn)
        assertEquals(72, coordinator.uiState.batteryPercent)
        assertEquals("Normal", coordinator.uiState.thermalStatus)

        coordinator.startStreamingWithGrantedCamera()
        coordinator.onStreamState("STREAMING")
        assertTrue(coordinator.uiState.streaming)
        assertEquals("Active", coordinator.uiState.streamStatus)
        val postsAtStreamingStart = coordinator.postedStates.size

        coordinator.onDevicesUpdated(listOf(chargingDeskPair, wornActivePair.copy(thermalLevel = "LIGHT")))
        assertEquals("Warm", coordinator.uiState.thermalStatus)
        assertEquals(postsAtStreamingStart, coordinator.postedStates.size)

        coordinator.onDevicesUpdated(listOf(chargingDeskPair, wornActivePair.copy(thermalLevel = "MODERATE")))
        assertEquals("Moderate", coordinator.uiState.thermalStatus)
        assertEquals(postsAtStreamingStart, coordinator.postedStates.size)

        coordinator.onDevicesUpdated(listOf(chargingDeskPair, wornActivePair.copy(thermalLevel = "SEVERE")))
        coordinator.onStreamError("Thermal mitigation pausing camera stream")
        coordinator.onStreamState("PAUSED")
        assertEquals("Severe", coordinator.uiState.thermalStatus)
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Paused", coordinator.uiState.streamStatus)
        assertEquals("Thermal mitigation pausing camera stream", coordinator.uiState.lastError)
        assertEquals(postsAtStreamingStart + 1, coordinator.postedStates.size)
        assertEquals(
            BridgeDeviceState(connected = true, worn = true, battery = 72, streaming = false),
            coordinator.postedStates.last(),
        )

        val handoffOnThermalPause = evaluateEyeHandoff("glasses", coordinator.postedStates.last())
        assertEquals("phone", handoffOnThermalPause.nextSource)
        assertEquals("Glasses camera unavailable, switching to phone camera", handoffOnThermalPause.announcement)

        for ((rawThermal, expectedLabel) in listOf(
            "CRITICAL" to "Critical",
            "EMERGENCY" to "Emergency",
            "SHUTDOWN" to "Shutdown",
        )) {
            coordinator.onDevicesUpdated(listOf(wornActivePair.copy(thermalLevel = rawThermal)))
            assertEquals(expectedLabel, coordinator.uiState.thermalStatus)
        }

        coordinator.onStreamState("STOPPING")
        assertEquals("Stopping", coordinator.uiState.streamStatus)
        assertFalse(coordinator.uiState.streaming)

        coordinator.onStreamState("CLOSED")
        assertEquals("Idle", coordinator.uiState.streamStatus)
        assertFalse(coordinator.uiState.streaming)

        coordinator.onDevicesUpdated(listOf(wornActivePair.copy(batteryLevel = 69, thermalLevel = "NONE")))
        assertEquals("Normal", coordinator.uiState.thermalStatus)
        assertEquals(69, coordinator.uiState.batteryPercent)

        coordinator.startStreamingWithGrantedCamera()
        assertNull(coordinator.uiState.lastError)
        coordinator.onStreamState("STREAMING")
        assertTrue(coordinator.uiState.streaming)
        assertEquals("Active", coordinator.uiState.streamStatus)
        assertEquals(
            "glasses",
            evaluateEyeHandoff("phone", coordinator.postedStates.last()).nextSource,
        )
    }

    @Test
    fun hingeFoldDoffAndLinkTransitions_coordinateSessionPauseStopDoffAndPhoneHandoff() {
        val client = IngestClient()
        val coordinator = PolicyStateCoordinator()
        coordinator.initializeSdk()
        coordinator.updateEndpoint("https://demo.trycloudflare.com", "hup-4k9m")
        coordinator.onRegistration("REGISTERED")

        val donTruthTable = listOf(
            Triple(true, "DONNED", true),
            Triple(true, "DOFFED", false),
            Triple(true, "UNKNOWN", true),
            Triple(true, null, false),
            Triple(false, "DONNED", false),
            Triple(false, "DOFFED", false),
            Triple(false, "UNKNOWN", false),
            Triple(false, null, false),
        )
        for ((connected, donState, expectedWorn) in donTruthTable) {
            coordinator.onDevicesUpdated(
                listOf(
                    SimulatedWearable(
                        id = "glasses-1",
                        name = "Ray-Ban Meta Gen 2",
                        connected = connected,
                        donState = donState,
                        compatible = true,
                        batteryLevel = 80,
                        thermalLevel = "NONE",
                    ),
                ),
            )
            assertEquals(connected, coordinator.uiState.connected)
            assertEquals(expectedWorn, coordinator.uiState.worn)
        }

        val activeGlasses = SimulatedWearable(
            id = "glasses-1",
            name = "Ray-Ban Meta Gen 2",
            connected = true,
            donState = "DONNED",
            compatible = true,
            batteryLevel = 81,
            thermalLevel = "NONE",
        )
        coordinator.onDevicesUpdated(listOf(activeGlasses))

        coordinator.beginSessionConnect()
        assertEquals("Connecting session", coordinator.uiState.streamStatus)
        coordinator.onDeviceSessionState("IDLE")
        assertEquals("Connecting session", coordinator.uiState.streamStatus)
        coordinator.onDeviceSessionState("STOPPED")
        assertEquals("Connecting session", coordinator.uiState.streamStatus)

        coordinator.onSessionTimedOutFoldedHinges()
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Session failed", coordinator.uiState.streamStatus)
        assertEquals(
            "Glasses session did not start; verify glasses are unfolded and connected",
            coordinator.uiState.lastError,
        )

        coordinator.startStreamingWithGrantedCamera()
        assertNull(coordinator.uiState.lastError)
        coordinator.onStreamState("STOPPED")
        assertEquals("Opening camera", coordinator.uiState.streamStatus)
        coordinator.onStreamState("STARTING")
        assertEquals("Starting", coordinator.uiState.streamStatus)
        coordinator.onStreamState("STARTED")
        assertEquals("Started", coordinator.uiState.streamStatus)
        coordinator.onStreamState("STREAMING")
        assertTrue(coordinator.uiState.streaming)
        assertEquals("Active", coordinator.uiState.streamStatus)

        var activeEye = evaluateEyeHandoff("phone", coordinator.postedStates.last()).nextSource
        assertEquals("glasses", activeEye)

        coordinator.onDevicesUpdated(listOf(activeGlasses.copy(donState = "DOFFED")))
        assertTrue(coordinator.uiState.connected)
        assertFalse(coordinator.uiState.worn)
        assertTrue(coordinator.uiState.streaming)
        val doffHandoff = evaluateEyeHandoff(activeEye, coordinator.postedStates.last())
        activeEye = doffHandoff.nextSource
        assertEquals("phone", activeEye)
        assertEquals("Glasses taken off, switching to phone camera", doffHandoff.announcement)
        assertEquals(
            "{\"connected\":true,\"worn\":false,\"battery\":81,\"streaming\":true}",
            invokeSerializeState(client, coordinator.postedStates.last()),
        )

        coordinator.onDeviceSessionState("PAUSED")
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Session paused", coordinator.uiState.streamStatus)
        assertEquals(
            "{\"connected\":true,\"worn\":false,\"battery\":81,\"streaming\":false}",
            invokeSerializeState(client, coordinator.postedStates.last()),
        )

        coordinator.onDeviceSessionState("STOPPING")
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Stopping", coordinator.uiState.streamStatus)

        coordinator.onDeviceSessionState("STOPPED")
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Idle", coordinator.uiState.streamStatus)

        coordinator.onDevicesUpdated(listOf(activeGlasses.copy(connected = false, donState = "DOFFED", batteryLevel = null)))
        assertFalse(coordinator.uiState.connected)
        assertFalse(coordinator.uiState.worn)
        assertNull(coordinator.uiState.batteryPercent)
        assertEquals(
            "{\"connected\":false,\"worn\":false,\"battery\":null,\"streaming\":false}",
            invokeSerializeState(client, coordinator.postedStates.last()),
        )

        coordinator.onDevicesUpdated(listOf(activeGlasses.copy(batteryLevel = 79)))
        coordinator.startStreamingWithGrantedCamera()
        coordinator.onStreamState("STREAMING")
        val redonHandoff = evaluateEyeHandoff(activeEye, coordinator.postedStates.last())
        activeEye = redonHandoff.nextSource
        assertEquals("glasses", activeEye)
        assertNull(redonHandoff.announcement)

        val disconnectHandoff = evaluateEyeHandoff(
            activeEye,
            BridgeDeviceState(connected = false, worn = false, battery = null, streaming = false),
        )
        assertEquals("phone", disconnectHandoff.nextSource)
        assertEquals("Glasses disconnected, switching to phone camera", disconnectHandoff.announcement)

        coordinator.onRegistration("UNAVAILABLE")
        assertEquals("Unavailable", coordinator.uiState.registrationStatus)
        assertFalse(coordinator.uiState.streaming)
        assertEquals("Idle", coordinator.uiState.streamStatus)
    }

    @Test
    fun httpEndpointUrlNormalization_canonicalizesSchemesSubpathsIpv6PortsAndSessionEncoding() {
        val client = IngestClient()

        val validNormalizationVectors = listOf(
            EndpointVector(
                rawServer = "  https://demo.trycloudflare.com///  ",
                rawSession = "   ",
                expectedSanitizedServer = "https://demo.trycloudflare.com",
                expectedSanitizedSession = "",
                expectedFrameUrl = "https://demo.trycloudflare.com/ingest/frame",
                expectedStateUrl = "https://demo.trycloudflare.com/ingest/state",
            ),
            EndpointVector(
                rawServer = "HTTPS://HoldUp.Run.App/bridge/v1///",
                rawSession = "  hup-4k9m  ",
                expectedSanitizedServer = "https://HoldUp.Run.App/bridge/v1",
                expectedSanitizedSession = "hup-4k9m",
                expectedFrameUrl = "https://holdup.run.app/bridge/v1/ingest/frame?session=hup-4k9m",
                expectedStateUrl = "https://holdup.run.app/bridge/v1/ingest/state?session=hup-4k9m",
            ),
            EndpointVector(
                rawServer = "HTTP://localhost:8787/",
                rawSession = "abcd",
                expectedSanitizedServer = "http://localhost:8787",
                expectedSanitizedSession = "abcd",
                expectedFrameUrl = "http://localhost:8787/ingest/frame?session=abcd",
                expectedStateUrl = "http://localhost:8787/ingest/state?session=abcd",
            ),
            EndpointVector(
                rawServer = "http://127.0.0.1:8787///",
                rawSession = "Session_2026-11",
                expectedSanitizedServer = "http://127.0.0.1:8787",
                expectedSanitizedSession = "Session_2026-11",
                expectedFrameUrl = "http://127.0.0.1:8787/ingest/frame?session=Session_2026-11",
                expectedStateUrl = "http://127.0.0.1:8787/ingest/state?session=Session_2026-11",
            ),
            EndpointVector(
                rawServer = "http://10.0.2.2:8787/",
                rawSession = "",
                expectedSanitizedServer = "http://10.0.2.2:8787",
                expectedSanitizedSession = "",
                expectedFrameUrl = "http://10.0.2.2:8787/ingest/frame",
                expectedStateUrl = "http://10.0.2.2:8787/ingest/state",
            ),
            EndpointVector(
                rawServer = "http://192.168.1.42:8787/",
                rawSession = "care_team-01",
                expectedSanitizedServer = "http://192.168.1.42:8787",
                expectedSanitizedSession = "care_team-01",
                expectedFrameUrl = "http://192.168.1.42:8787/ingest/frame?session=care_team-01",
                expectedStateUrl = "http://192.168.1.42:8787/ingest/state?session=care_team-01",
            ),
            EndpointVector(
                rawServer = "http://holdup-box.local:8787/",
                rawSession = "fi_pilot_24",
                expectedSanitizedServer = "http://holdup-box.local:8787",
                expectedSanitizedSession = "fi_pilot_24",
                expectedFrameUrl = "http://holdup-box.local:8787/ingest/frame?session=fi_pilot_24",
                expectedStateUrl = "http://holdup-box.local:8787/ingest/state?session=fi_pilot_24",
            ),
            EndpointVector(
                rawServer = "http://[::1]:8787///",
                rawSession = "ipv6_loop",
                expectedSanitizedServer = "http://[::1]:8787",
                expectedSanitizedSession = "ipv6_loop",
                expectedFrameUrl = "http://[::1]:8787/ingest/frame?session=ipv6_loop",
                expectedStateUrl = "http://[::1]:8787/ingest/state?session=ipv6_loop",
            ),
            EndpointVector(
                rawServer = "https://demo.trycloudflare.com:443/",
                rawSession = "",
                expectedSanitizedServer = "https://demo.trycloudflare.com:443",
                expectedSanitizedSession = "",
                expectedFrameUrl = "https://demo.trycloudflare.com/ingest/frame",
                expectedStateUrl = "https://demo.trycloudflare.com/ingest/state",
            ),
            EndpointVector(
                rawServer = "http://10.0.2.2:80/",
                rawSession = "",
                expectedSanitizedServer = "http://10.0.2.2:80",
                expectedSanitizedSession = "",
                expectedFrameUrl = "http://10.0.2.2/ingest/frame",
                expectedStateUrl = "http://10.0.2.2/ingest/state",
            ),
            EndpointVector(
                rawServer = "https://demo.trycloudflare.com:1/",
                rawSession = "p_min_1",
                expectedSanitizedServer = "https://demo.trycloudflare.com:1",
                expectedSanitizedSession = "p_min_1",
                expectedFrameUrl = "https://demo.trycloudflare.com:1/ingest/frame?session=p_min_1",
                expectedStateUrl = "https://demo.trycloudflare.com:1/ingest/state?session=p_min_1",
            ),
            EndpointVector(
                rawServer = "http://10.0.2.2:65535/",
                rawSession = "p_max_65535",
                expectedSanitizedServer = "http://10.0.2.2:65535",
                expectedSanitizedSession = "p_max_65535",
                expectedFrameUrl = "http://10.0.2.2:65535/ingest/frame?session=p_max_65535",
                expectedStateUrl = "http://10.0.2.2:65535/ingest/state?session=p_max_65535",
            ),
        )

        for (vector in validNormalizationVectors) {
            val cleanServer = BridgePreferences.sanitizeServerUrl(vector.rawServer)
            val cleanSession = BridgePreferences.sanitizeSessionCode(vector.rawSession)
            assertEquals(vector.expectedSanitizedServer, cleanServer)
            assertEquals(vector.expectedSanitizedSession, cleanSession)

            client.configure(cleanServer, cleanSession)
            assertEquals(cleanServer, baseServerUrlField.get(client))
            assertEquals(
                cleanSession.takeIf { it.isNotEmpty() },
                activeSessionCodeField.get(client),
            )

            val frameUrl = invokeBuildEndpointUrl(client, "ingest/frame")
            val stateUrl = invokeBuildEndpointUrl(client, "ingest/state")
            assertNotNull(frameUrl)
            assertNotNull(stateUrl)
            assertEquals(vector.expectedFrameUrl, frameUrl.toString())
            assertEquals(vector.expectedStateUrl, stateUrl.toString())

            if (cleanSession.isEmpty()) {
                assertNull(frameUrl?.query)
                assertNull(stateUrl?.query)
                assertEquals(0, frameUrl?.querySize)
                assertEquals(0, stateUrl?.querySize)
            } else {
                assertEquals(setOf("session"), frameUrl?.queryParameterNames)
                assertEquals(setOf("session"), stateUrl?.queryParameterNames)
                assertEquals(cleanSession, frameUrl?.queryParameter("session"))
                assertEquals(cleanSession, stateUrl?.queryParameter("session"))
            }
        }

        val prefix = "https://holdup.run.app/"
        val exact256Server = prefix + "r".repeat(BridgePreferences.MAX_SERVER_URL_LENGTH - prefix.length)
        val exact64Session = "Q".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH)
        assertEquals(256, exact256Server.length)
        assertEquals(64, exact64Session.length)
        assertEquals(exact256Server, BridgePreferences.sanitizeServerUrl("  $exact256Server  "))
        assertEquals(exact64Session, BridgePreferences.sanitizeSessionCode("  $exact64Session  "))

        client.configure(
            BridgePreferences.sanitizeServerUrl(exact256Server),
            BridgePreferences.sanitizeSessionCode(exact64Session),
        )
        assertEquals(
            "$exact256Server/ingest/frame?session=$exact64Session",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "$exact256Server/ingest/state?session=$exact64Session",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        client.configure("  https://holdup.run.app/subpath///  ", "  raw a&source=phone#frag  ")
        val escapedFrameUrl = invokeBuildEndpointUrl(client, "ingest/frame")
        assertNotNull(escapedFrameUrl)
        assertEquals(listOf("subpath", "ingest", "frame"), escapedFrameUrl?.encodedPathSegments)
        assertEquals(setOf("session"), escapedFrameUrl?.queryParameterNames)
        assertEquals("raw a&source=phone#frag", escapedFrameUrl?.queryParameter("session"))
        assertNull(escapedFrameUrl?.fragment)
    }

    @Test
    fun httpEndpointUrlNormalization_rejectsHostileInputsAndPreventsUnconfiguredUploads() {
        val over257 = "https://holdup.run.app/" + "z".repeat(234)
        assertEquals(257, over257.length)

        val rejectedServerInputs = listOf(
            "",
            "   ",
            "/",
            "////",
            over257,
            "https://holdup.run.app/" + "z".repeat(233) + "/",
            "javascript:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/plain;base64,SGVsbG8=",
            "file:///etc/hosts",
            "content://app.holdup.bridge/prefs",
            "intent://connect#Intent;scheme=holdupbridge;end",
            "ftp://demo.trycloudflare.com",
            "ws://127.0.0.1:8787",
            "wss://demo.trycloudflare.com",
            "holdupbridge://connect?server=https://demo.trycloudflare.com",
            "http://",
            "https:///",
            "https:///ingest/frame",
            "https:demo.trycloudflare.com",
            "demo.trycloudflare.com:8787",
            "https://admin:secret@demo.trycloudflare.com",
            "https://token@demo.trycloudflare.com",
            "https://demo.trycloudflare.com?session=override",
            "https://demo.trycloudflare.com#section",
            "https://demo.trycloudflare.com:0",
            "https://demo.trycloudflare.com:65536",
            "https://demo.trycloudflare.com:-80",
            "https://demo.trycloudflare.com:",
            "https://demo.trycloudflare.com:port",
            "https://demo.trycloudflare.com/..",
            "https://demo.trycloudflare.com/./ingest",
            "https://demo.trycloudflare.com/bridge//v1",
            "https://demo.trycloudflare.com\\bridge",
            "https://demo.trycloudflare.com/with space",
            "https://demo.trycloudflare.com/\r\nX-Hdr: 1",
            "https://demo.trycloudflare.com/\u0000null",
            "https://demo.trycloudflare.com/\u007f",
        )

        val client = IngestClient()
        for (hostileServer in rejectedServerInputs) {
            val sanitized = BridgePreferences.sanitizeServerUrl(hostileServer)
            assertEquals("Expected empty URL for input: $hostileServer", "", sanitized)
            client.configure(sanitized, "hup-4k9m")
            assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))
            assertNull(invokeBuildEndpointUrl(client, "ingest/state"))
        }

        val rejectedSessionInputs = listOf(
            "",
            "   ",
            "x",
            "xy",
            "xyz",
            "Q".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH + 1),
            "hup&source=phone",
            "hup?admin=1",
            "hup#frag",
            "../session",
            "bad space",
            "bad\nline",
            "bad;semi",
        )
        for (badSession in rejectedSessionInputs) {
            assertEquals(
                "Expected empty session code for input: $badSession",
                "",
                BridgePreferences.sanitizeSessionCode(badSession),
            )
        }

        runBlocking {
            client.postState(BridgeDeviceState(connected = true, worn = true, battery = 75, streaming = true))
        }
        assertEquals(0L, client.metrics.value.stateUpdatesSent)
        assertEquals(0, client.metrics.value.lastHttpCode)
        assertEquals("Invalid or empty server URL", client.metrics.value.lastError)

        val baselineUi = BridgeUiState()
        try {
            DatBridgeController.updateEndpoint("   ", "  hup-4k9m  ")
            assertEquals("", DatBridgeController.uiState.value.serverUrl)
            assertEquals("hup-4k9m", DatBridgeController.uiState.value.sessionCode)
        } finally {
            DatBridgeController.updateEndpoint("", "")
        }
        assertEquals(baselineUi, DatBridgeController.uiState.value)
        assertNotEquals(baselineUi, baselineUi.copy(thermalStatus = "Warm"))
    }

    private fun invokeBuildEndpointUrl(client: IngestClient, endpointPath: String): HttpUrl? {
        return buildEndpointUrlMethod.invoke(client, endpointPath) as HttpUrl?
    }

    private fun invokeSerializeState(client: IngestClient, state: BridgeDeviceState): String {
        return serializeStateMethod.invoke(client, state) as String
    }

    private fun normalizeSdkBatteryPercent(rawLevel: Int?): Int? {
        return rawLevel?.takeIf { it in 1..100 }
    }

    private fun clampWireBatteryPercent(rawLevel: Int?): Int? {
        return rawLevel?.coerceIn(0, 100)
    }

    private fun isLowBatteryHandoff(batteryPercent: Int?): Boolean {
        return batteryPercent != null && batteryPercent < LOW_BATTERY_THRESHOLD_PERCENT
    }

    private fun formatStatusCardBattery(batteryPercent: Int?): String {
        return when {
            batteryPercent == null -> "Unknown"
            batteryPercent <= CRITICAL_CHARGE_FLOOR_PERCENT -> "$batteryPercent% (Charge > 10% required)"
            batteryPercent < LOW_BATTERY_THRESHOLD_PERCENT -> "$batteryPercent% (Low battery)"
            else -> "$batteryPercent%"
        }
    }

    private fun formatThermalPolicyLabel(rawLevel: String?): String {
        return when (rawLevel) {
            null,
            "UNKNOWN",
            "NONE" -> "Normal"
            "LIGHT" -> "Warm"
            "MODERATE" -> "Moderate"
            "SEVERE" -> "Severe"
            "CRITICAL" -> "Critical"
            "EMERGENCY" -> "Emergency"
            "SHUTDOWN" -> "Shutdown"
            else -> "Normal"
        }
    }

    private fun evaluateEyeHandoff(
        previousSource: String,
        state: BridgeDeviceState,
    ): EyeHandoffDecision {
        val lowBattery = isLowBatteryHandoff(state.battery)
        val glassesHealthy = state.connected && state.worn && state.streaming && !lowBattery
        if (glassesHealthy) {
            return EyeHandoffDecision(nextSource = "glasses", announcement = null)
        }
        if (previousSource == "glasses") {
            val reason = when {
                !state.connected -> "Glasses disconnected, switching to phone camera"
                !state.worn -> "Glasses taken off, switching to phone camera"
                lowBattery -> "Glasses battery low, switching to phone camera"
                else -> "Glasses camera unavailable, switching to phone camera"
            }
            return EyeHandoffDecision(nextSource = "phone", announcement = reason)
        }
        return EyeHandoffDecision(nextSource = previousSource, announcement = null)
    }

    private data class EyeHandoffDecision(
        val nextSource: String,
        val announcement: String?,
    )

    private data class BatteryTrajectoryStep(
        val state: BridgeDeviceState,
        val expectedEye: String,
        val expectedAnnouncement: String?,
    )

    private data class EndpointVector(
        val rawServer: String,
        val rawSession: String,
        val expectedSanitizedServer: String,
        val expectedSanitizedSession: String,
        val expectedFrameUrl: String,
        val expectedStateUrl: String,
    )

    private data class SimulatedWearable(
        val id: String,
        val name: String,
        val connected: Boolean,
        val donState: String?,
        val compatible: Boolean,
        val batteryLevel: Int?,
        val thermalLevel: String?,
    )

    private class ThrottlePipelinePolicy(
        private val minEncodeIntervalMs: Long,
        private val minIngestIntervalMs: Long,
    ) {
        private var lastEncodedFrameMs: Long? = null
        private var lastIngestSentMs: Long = -minIngestIntervalMs
        private var frameInFlight: Boolean = false

        val sentTimestampsMs = mutableListOf<Long>()
        var skippedAtEncodeCount: Int = 0
            private set
        var droppedAtIngestCount: Int = 0
            private set

        fun resetStreamCollectorClock() {
            lastEncodedFrameMs = null
        }

        fun completeInFlightPost() {
            frameInFlight = false
        }

        fun onCameraFrame(
            nowMs: Long,
            isCompressed: Boolean,
            width: Int,
            height: Int,
            jpegBytes: Int,
        ): Boolean {
            if (isCompressed || width <= 0 || height <= 0) {
                return false
            }
            val previousEncode = lastEncodedFrameMs
            if (previousEncode != null && nowMs - previousEncode < minEncodeIntervalMs) {
                skippedAtEncodeCount++
                return false
            }
            lastEncodedFrameMs = nowMs

            if (jpegBytes <= 0) {
                return false
            }
            if (frameInFlight) {
                droppedAtIngestCount++
                return false
            }
            if (nowMs - lastIngestSentMs < minIngestIntervalMs) {
                droppedAtIngestCount++
                return false
            }
            frameInFlight = true
            lastIngestSentMs = nowMs
            sentTimestampsMs.add(nowMs)
            return true
        }
    }

    private class PolicyStateCoordinator {
        var uiState: BridgeUiState = BridgeUiState()
            private set

        val postedStates = mutableListOf<BridgeDeviceState>()

        private var sdkError: String? = null
        private var lastPostedDeviceState: BridgeDeviceState? = null
        private var registrationRaw: String = "AVAILABLE"
        private var hasActiveSession: Boolean = false
        private var sessionHasLeftIdle: Boolean = false
        private var hasActiveCamera: Boolean = false
        private var streamHasBeenActive: Boolean = false

        fun initializeSdk() {
            sdkError = null
            uiState = uiState.copy(sdkReady = true, lastError = null)
        }

        fun updateEndpoint(serverUrl: String, sessionCode: String) {
            val cleanServer = serverUrl.trim().trimEnd('/')
            val cleanSession = sessionCode.trim()
            lastPostedDeviceState = null
            uiState = uiState.copy(serverUrl = cleanServer, sessionCode = cleanSession)
            publishDeviceState(force = true)
        }

        fun onRegistration(rawState: String) {
            registrationRaw = rawState
            val status = when (rawState) {
                "REGISTERED" -> "Registered"
                "REGISTERING" -> "Registering"
                "UNREGISTERING" -> "Unregistering"
                "AVAILABLE" -> "Unregistered"
                "UNAVAILABLE" -> "Unavailable"
                else -> "Unregistered"
            }
            uiState = uiState.copy(registrationStatus = status)
            if (rawState == "AVAILABLE" || rawState == "UNAVAILABLE") {
                if (hasActiveSession || hasActiveCamera) {
                    teardownStream("Idle")
                    hasActiveSession = false
                    sessionHasLeftIdle = false
                    uiState = uiState.copy(streaming = false, streamStatus = "Idle")
                    publishDeviceState(force = true)
                }
            } else {
                publishDeviceState(force = false)
            }
        }

        fun onDevicesUpdated(devices: List<SimulatedWearable>) {
            val chosen = devices.minByOrNull { device ->
                when {
                    device.connected && device.donState == "DONNED" -> 0
                    device.connected -> 1
                    device.compatible -> 2
                    else -> 3
                }
            }
            val connected = chosen?.connected == true
            val worn = when (chosen?.donState) {
                "DONNED" -> connected
                "DOFFED" -> false
                "UNKNOWN" -> connected
                null -> false
                else -> false
            }
            val battery = chosen?.batteryLevel?.takeIf { it in 1..100 }
            val thermal = when (chosen?.thermalLevel) {
                null,
                "UNKNOWN",
                "NONE" -> "Normal"
                "LIGHT" -> "Warm"
                "MODERATE" -> "Moderate"
                "SEVERE" -> "Severe"
                "CRITICAL" -> "Critical"
                "EMERGENCY" -> "Emergency"
                "SHUTDOWN" -> "Shutdown"
                else -> "Normal"
            }
            val deviceName = chosen?.let { it.name.ifBlank { "Meta AI Glasses" } }

            uiState = uiState.copy(
                deviceName = deviceName,
                connected = connected,
                worn = worn,
                batteryPercent = battery,
                thermalStatus = thermal,
            )
            publishDeviceState(force = false)
        }

        fun beginSessionConnect() {
            if (!uiState.sdkReady || registrationRaw != "REGISTERED") return
            sdkError = null
            sessionHasLeftIdle = false
            uiState = uiState.copy(streamStatus = "Connecting session", lastError = null)
        }

        fun onSessionTimedOutFoldedHinges() {
            if (sdkError == null) {
                sdkError = "Glasses session did not start; verify glasses are unfolded and connected"
            }
            hasActiveSession = false
            sessionHasLeftIdle = false
            uiState = uiState.copy(
                streaming = false,
                streamStatus = "Session failed",
                lastError = sdkError,
            )
            publishDeviceState(force = true)
        }

        fun startStreamingWithGrantedCamera() {
            if (!uiState.sdkReady || registrationRaw != "REGISTERED") return
            sdkError = null
            hasActiveSession = true
            sessionHasLeftIdle = true
            hasActiveCamera = true
            streamHasBeenActive = false
            uiState = uiState.copy(streamStatus = "Opening camera", lastError = null)
        }

        fun onDeviceSessionState(rawState: String) {
            when (rawState) {
                "STARTING",
                "STARTED" -> {
                    sessionHasLeftIdle = true
                }
                "PAUSED" -> {
                    sessionHasLeftIdle = true
                    uiState = uiState.copy(streaming = false, streamStatus = "Session paused")
                    publishDeviceState(force = false)
                }
                "STOPPING" -> {
                    if (sessionHasLeftIdle) {
                        uiState = uiState.copy(streaming = false, streamStatus = "Stopping")
                        publishDeviceState(force = false)
                    }
                }
                "STOPPED" -> {
                    if (sessionHasLeftIdle) {
                        hasActiveSession = false
                        sessionHasLeftIdle = false
                        teardownStream("Idle")
                    }
                }
                "IDLE" -> Unit
            }
        }

        fun onStreamState(rawState: String) {
            when (rawState) {
                "STARTING" -> {
                    streamHasBeenActive = true
                    uiState = uiState.copy(streamStatus = "Starting")
                }
                "STARTED" -> {
                    streamHasBeenActive = true
                    uiState = uiState.copy(streamStatus = "Started")
                }
                "STREAMING" -> {
                    streamHasBeenActive = true
                    uiState = uiState.copy(streaming = true, streamStatus = "Active")
                    publishDeviceState(force = false)
                }
                "PAUSED" -> {
                    streamHasBeenActive = true
                    uiState = uiState.copy(streaming = false, streamStatus = "Paused")
                    publishDeviceState(force = false)
                }
                "STOPPING" -> {
                    uiState = uiState.copy(streaming = false, streamStatus = "Stopping")
                    publishDeviceState(force = false)
                }
                "STOPPED",
                "CLOSED" -> {
                    if (streamHasBeenActive) {
                        streamHasBeenActive = false
                        teardownStream("Idle")
                    }
                }
            }
        }

        fun onStreamError(message: String) {
            sdkError = message
            uiState = uiState.copy(lastError = message)
        }

        private fun teardownStream(nextStatus: String) {
            hasActiveCamera = false
            streamHasBeenActive = false
            uiState = uiState.copy(streaming = false, streamStatus = nextStatus)
            publishDeviceState(force = true)
        }

        private fun publishDeviceState(force: Boolean) {
            if (uiState.serverUrl.isBlank()) return
            val next = BridgeDeviceState(
                connected = uiState.connected,
                worn = uiState.worn,
                battery = uiState.batteryPercent,
                streaming = uiState.streaming,
            )
            if (!force && lastPostedDeviceState == next) return
            lastPostedDeviceState = next
            postedStates.add(next)
        }
    }

    private companion object {
        const val MIN_ALLOWED_FRAME_INTERVAL_MS = 900L
        const val FRAME_INTERVAL_MS = 1000L
        const val CRITICAL_CHARGE_FLOOR_PERCENT = 10
        const val LOW_BATTERY_THRESHOLD_PERCENT = 15
    }
}
