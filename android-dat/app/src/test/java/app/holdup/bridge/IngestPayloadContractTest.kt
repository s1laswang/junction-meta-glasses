package app.holdup.bridge

import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.MediaType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IngestPayloadContractTest {

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

    @Test
    fun endpointUrlBuilders_constructSessionlessAndSessionBoundFrameAndStateUrls() {
        val client = IngestClient()
        assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))
        assertNull(invokeBuildEndpointUrl(client, "ingest/state"))

        val rejectedServers = listOf(
            "",
            "   ",
            "ftp://demo.trycloudflare.com",
            "ws://localhost:8787",
            "wss://demo.trycloudflare.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
        )
        for (badServer in rejectedServers) {
            client.configure(badServer, "hup-4k9m")
            assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))
            assertNull(invokeBuildEndpointUrl(client, "ingest/state"))
        }

        val localAndTunnelOrigins = listOf(
            "  https://demo.trycloudflare.com///  " to "https://demo.trycloudflare.com",
            "https://holdup.run.app/bridge/" to "https://holdup.run.app/bridge",
            "http://localhost:8787/" to "http://localhost:8787",
            "http://127.0.0.1:8787/" to "http://127.0.0.1:8787",
            "http://10.0.2.2:8787/" to "http://10.0.2.2:8787",
            "http://192.168.1.20:8787/" to "http://192.168.1.20:8787",
        )
        for ((rawOrigin, normalizedOrigin) in localAndTunnelOrigins) {
            client.configure(rawOrigin, "   ")
            val frameUrl = invokeBuildEndpointUrl(client, "ingest/frame")
            val stateUrl = invokeBuildEndpointUrl(client, "ingest/state")
            assertNotNull(frameUrl)
            assertNotNull(stateUrl)
            assertEquals("$normalizedOrigin/ingest/frame", frameUrl.toString())
            assertEquals("$normalizedOrigin/ingest/state", stateUrl.toString())
            assertNull(frameUrl?.query)
            assertNull(stateUrl?.query)
            assertEquals(0, frameUrl?.querySize)
            assertEquals(0, stateUrl?.querySize)
        }

        val sanitizedServer = BridgePreferences.sanitizeServerUrl("  https://demo.trycloudflare.com/// ")
        val sanitizedSession = BridgePreferences.sanitizeSessionCode("  hup-4k9m  ")
        client.configure(sanitizedServer, sanitizedSession)

        val boundFrame = invokeBuildEndpointUrl(client, "ingest/frame")
        val boundState = invokeBuildEndpointUrl(client, "ingest/state")
        assertNotNull(boundFrame)
        assertNotNull(boundState)
        assertEquals("https", boundFrame?.scheme)
        assertEquals("demo.trycloudflare.com", boundFrame?.host)
        assertEquals("/ingest/frame", boundFrame?.encodedPath)
        assertEquals("/ingest/state", boundState?.encodedPath)
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame?session=hup-4k9m",
            boundFrame.toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state?session=hup-4k9m",
            boundState.toString(),
        )
        assertEquals(setOf("session"), boundFrame?.queryParameterNames)
        assertEquals(setOf("session"), boundState?.queryParameterNames)
        assertEquals("hup-4k9m", boundFrame?.queryParameter("session"))
        assertEquals("hup-4k9m", boundState?.queryParameter("session"))

        val maxSession = "S".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH)
        client.configure(sanitizedServer, BridgePreferences.sanitizeSessionCode(maxSession))
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame?session=$maxSession",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state?session=$maxSession",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        client.configure(sanitizedServer, "")
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        client.configure("https://demo.trycloudflare.com", "hup&source=phone")
        val escapedFrame = invokeBuildEndpointUrl(client, "ingest/frame")
        val escapedState = invokeBuildEndpointUrl(client, "ingest/state")
        assertEquals(setOf("session"), escapedFrame?.queryParameterNames)
        assertEquals(setOf("session"), escapedState?.queryParameterNames)
        assertEquals("hup&source=phone", escapedFrame?.queryParameter("session"))
        assertEquals("hup&source=phone", escapedState?.queryParameter("session"))
    }

    @Test
    fun deviceStateJsonPayload_serializesExactFourWireFieldsAndTypes() {
        val client = IngestClient()
        val expectedWireKeys = setOf("connected", "worn", "battery", "streaming")

        val vectors = listOf(
            BridgeDeviceState() to
                "{\"connected\":false,\"worn\":false,\"battery\":null,\"streaming\":false}",
            BridgeDeviceState(connected = true, worn = true, battery = 84, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":84,\"streaming\":true}",
            BridgeDeviceState(connected = true, worn = true, battery = 72, streaming = false) to
                "{\"connected\":true,\"worn\":true,\"battery\":72,\"streaming\":false}",
            BridgeDeviceState(connected = true, worn = false, battery = 72, streaming = false) to
                "{\"connected\":true,\"worn\":false,\"battery\":72,\"streaming\":false}",
            BridgeDeviceState(connected = true, worn = true, battery = 15, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":15,\"streaming\":true}",
            BridgeDeviceState(connected = true, worn = true, battery = 14, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":14,\"streaming\":true}",
            BridgeDeviceState(connected = true, worn = true, battery = 1, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":1,\"streaming\":true}",
            BridgeDeviceState(connected = true, worn = true, battery = 100, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":100,\"streaming\":true}",
            BridgeDeviceState(connected = true, worn = true, battery = null, streaming = true) to
                "{\"connected\":true,\"worn\":true,\"battery\":null,\"streaming\":true}",
        )

        for ((state, expectedJson) in vectors) {
            val actualJson = invokeSerializeState(client, state)
            assertEquals(expectedJson, actualJson)

            val parsed = parseFlatJsonObject(actualJson)
            assertEquals(expectedWireKeys, parsed.keys)
            assertFalse(parsed.containsKey("source"))
            assertFalse(parsed.containsKey("deviceName"))
            assertFalse(parsed.containsKey("session"))

            assertEquals(state.connected.toString(), parsed["connected"])
            assertEquals(state.worn.toString(), parsed["worn"])
            assertEquals(state.streaming.toString(), parsed["streaming"])

            val rawBattery = parsed["battery"]
            if (state.battery == null) {
                assertEquals("null", rawBattery)
            } else {
                assertEquals(state.battery.toString(), rawBattery)
                assertEquals(state.battery, rawBattery?.toIntOrNull())
            }
        }

        val jsonMediaTypeField = IngestClient::class.java.getDeclaredField("JSON_MEDIA_TYPE").apply {
            isAccessible = true
        }
        val mediaType = jsonMediaTypeField.get(null) as MediaType
        assertEquals("application", mediaType.type)
        assertEquals("json", mediaType.subtype)

        runBlocking {
            client.postState(BridgeDeviceState(connected = true, worn = true, battery = 80, streaming = true))
        }
        assertEquals(0L, client.metrics.value.stateUpdatesSent)
        assertEquals(0, client.metrics.value.lastHttpCode)
        assertEquals("Invalid or empty server URL", client.metrics.value.lastError)
    }

    @Test
    fun frameThrottleGate_enforcesAtMostOneFpsCadenceAndDropsInFlightFrames() {
        val defaultClient = IngestClient()
        val defaultMinIntervalMs = minFrameIntervalField.getLong(defaultClient)
        assertTrue(defaultMinIntervalMs in 950L..1000L)
        assertEquals(950L, defaultMinIntervalMs)
        assertEquals(-defaultMinIntervalMs, lastSentAtField.getLong(defaultClient))

        val strictOneFpsClient = IngestClient(minFrameIntervalMs = 1000L)
        assertEquals(1000L, minFrameIntervalField.getLong(strictOneFpsClient))
        assertEquals(-1000L, lastSentAtField.getLong(strictOneFpsClient))

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
        val sessionTimeoutMs = controllerClass.getDeclaredField("SESSION_START_TIMEOUT_MS").apply {
            isAccessible = true
        }.getLong(null)

        assertEquals(2, streamFps)
        assertTrue(minEncodeIntervalMs in 950L..1000L)
        assertEquals(960L, minEncodeIntervalMs)
        assertEquals(15_000L, sessionTimeoutMs)

        val gate950 = FrameThrottleSimulator(minIntervalMs = defaultMinIntervalMs)
        assertTrue(gate950.tryAdmit(nowMs = 0L, payloadBytes = 1024))
        assertFalse(gate950.tryAdmit(nowMs = 1L, payloadBytes = 1024))
        assertFalse(gate950.tryAdmit(nowMs = 500L, payloadBytes = 1024))
        assertFalse(gate950.tryAdmit(nowMs = 949L, payloadBytes = 1024))
        assertTrue(gate950.tryAdmit(nowMs = 950L, payloadBytes = 1024))
        assertFalse(gate950.tryAdmit(nowMs = 2000L, payloadBytes = 0))
        assertTrue(gate950.tryAdmit(nowMs = 2000L, payloadBytes = 512))
        assertEquals(3, gate950.acceptedTimestamps.size)
        assertEquals(4, gate950.droppedCount)

        val gate1000 = FrameThrottleSimulator(minIntervalMs = 1000L)
        assertTrue(gate1000.tryAdmit(nowMs = 0L, payloadBytes = 1024))
        assertFalse(gate1000.tryAdmit(nowMs = 999L, payloadBytes = 1024))
        assertTrue(gate1000.tryAdmit(nowMs = 1000L, payloadBytes = 1024))

        val twoFpsArrivalTimestamps = (0 until 20).map { tick -> tick * 500L }
        val encodedTimestamps = simulateControllerEncodeGate(
            arrivalsMs = twoFpsArrivalTimestamps,
            minEncodeIntervalMs = minEncodeIntervalMs,
        )
        assertEquals(10, encodedTimestamps.size)
        for (idx in 1 until encodedTimestamps.size) {
            val deltaMs = encodedTimestamps[idx] - encodedTimestamps[idx - 1]
            assertTrue(deltaMs >= minEncodeIntervalMs)
            assertEquals(1000L, deltaMs)
        }

        val ingestSimulator = FrameThrottleSimulator(minIntervalMs = defaultMinIntervalMs)
        for (timestampMs in twoFpsArrivalTimestamps) {
            ingestSimulator.tryAdmit(nowMs = timestampMs, payloadBytes = 24_000)
        }
        assertEquals(10, ingestSimulator.acceptedTimestamps.size)
        assertEquals(10, ingestSimulator.droppedCount)
        for (idx in 1 until ingestSimulator.acceptedTimestamps.size) {
            assertTrue(
                ingestSimulator.acceptedTimestamps[idx] - ingestSimulator.acceptedTimestamps[idx - 1] >= defaultMinIntervalMs,
            )
        }

        assertFalse(shouldEncodeFrame(isCompressed = true, width = 720, height = 1280))
        assertFalse(shouldEncodeFrame(isCompressed = false, width = 0, height = 1280))
        assertFalse(shouldEncodeFrame(isCompressed = false, width = 720, height = 0))
        assertFalse(shouldEncodeFrame(isCompressed = false, width = -720, height = 1280))
        assertTrue(shouldEncodeFrame(isCompressed = false, width = 720, height = 1280))

        val inFlightLock = frameInFlightField.get(defaultClient) as AtomicBoolean
        inFlightLock.set(true)
        val sampleJpeg = byteArrayOf(
            0xFF.toByte(),
            0xD8.toByte(),
            0xFF.toByte(),
            0xD9.toByte(),
        )
        val firstWhileBusy = runBlocking { defaultClient.submitFrameIfIdle(sampleJpeg) }
        val secondWhileBusy = runBlocking { defaultClient.submitFrameIfIdle(sampleJpeg) }
        assertFalse(firstWhileBusy)
        assertFalse(secondWhileBusy)
        assertTrue(inFlightLock.get())
        assertEquals(0L, defaultClient.metrics.value.framesSent)
        assertEquals(2L, defaultClient.metrics.value.framesDropped)
        inFlightLock.set(false)
    }

    @Test
    fun lowBatteryAndDoffedTransitions_updateTelemetryDeduplicateAndTriggerFallbackContract() {
        assertNull(normalizeBatteryPercent(null))
        assertNull(normalizeBatteryPercent(-5))
        assertNull(normalizeBatteryPercent(0))
        assertNull(normalizeBatteryPercent(101))
        assertEquals(1, normalizeBatteryPercent(1))
        assertEquals(14, normalizeBatteryPercent(14))
        assertEquals(15, normalizeBatteryPercent(15))
        assertEquals(100, normalizeBatteryPercent(100))

        assertTrue(resolveWornFlag(connected = true, donKind = "DONNED"))
        assertFalse(resolveWornFlag(connected = true, donKind = "DOFFED"))
        assertTrue(resolveWornFlag(connected = true, donKind = "UNKNOWN"))
        assertFalse(resolveWornFlag(connected = true, donKind = null))
        assertFalse(resolveWornFlag(connected = false, donKind = "DONNED"))
        assertFalse(resolveWornFlag(connected = false, donKind = "UNKNOWN"))

        val client = IngestClient()
        val dedupTracker = StatePublishTracker()
        var activeSource = "phone"

        val nominal = BridgeDeviceState(connected = true, worn = true, battery = 86, streaming = true)
        assertTrue(dedupTracker.shouldPublish(nominal, force = false))
        assertFalse(dedupTracker.shouldPublish(nominal, force = false))
        assertTrue(dedupTracker.shouldPublish(nominal, force = true))
        val step1 = evaluateCameraFallback(previousSource = activeSource, state = nominal)
        activeSource = step1.nextSource
        assertEquals("glasses", activeSource)
        assertNull(step1.announcement)
        assertFalse(isLowBattery(nominal.battery))
        assertEquals("86%", formatBridgeBatteryLabel(nominal.battery))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":86,\"streaming\":true}",
            invokeSerializeState(client, nominal),
        )

        val doffed = nominal.copy(worn = false, battery = 85, streaming = false)
        assertNotEquals(nominal, doffed)
        assertTrue(dedupTracker.shouldPublish(doffed, force = false))
        val step2 = evaluateCameraFallback(previousSource = activeSource, state = doffed)
        activeSource = step2.nextSource
        assertEquals("phone", activeSource)
        assertEquals("Glasses taken off, switching to phone camera", step2.announcement)
        assertEquals(
            "{\"connected\":true,\"worn\":false,\"battery\":85,\"streaming\":false}",
            invokeSerializeState(client, doffed),
        )

        val redonnedAtBoundary = BridgeDeviceState(connected = true, worn = true, battery = 15, streaming = true)
        assertTrue(dedupTracker.shouldPublish(redonnedAtBoundary, force = false))
        val step3 = evaluateCameraFallback(previousSource = activeSource, state = redonnedAtBoundary)
        activeSource = step3.nextSource
        assertEquals("glasses", activeSource)
        assertNull(step3.announcement)
        assertFalse(isLowBattery(redonnedAtBoundary.battery))
        assertEquals("15%", formatBridgeBatteryLabel(redonnedAtBoundary.battery))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":15,\"streaming\":true}",
            invokeSerializeState(client, redonnedAtBoundary),
        )

        val lowBattery14 = redonnedAtBoundary.copy(battery = 14)
        assertTrue(dedupTracker.shouldPublish(lowBattery14, force = false))
        val step4 = evaluateCameraFallback(previousSource = activeSource, state = lowBattery14)
        activeSource = step4.nextSource
        assertEquals("phone", activeSource)
        assertEquals("Glasses battery low, switching to phone camera", step4.announcement)
        assertTrue(isLowBattery(lowBattery14.battery))
        assertEquals("14% (Low battery)", formatBridgeBatteryLabel(lowBattery14.battery))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":14,\"streaming\":true}",
            invokeSerializeState(client, lowBattery14),
        )

        val criticalBattery9 = lowBattery14.copy(battery = 9)
        assertTrue(dedupTracker.shouldPublish(criticalBattery9, force = false))
        val step5 = evaluateCameraFallback(previousSource = activeSource, state = criticalBattery9)
        activeSource = step5.nextSource
        assertEquals("phone", activeSource)
        assertNull(step5.announcement)
        assertTrue(isLowBattery(criticalBattery9.battery))
        assertEquals("9% (Charge > 10% required)", formatBridgeBatteryLabel(criticalBattery9.battery))
        assertEquals("10% (Charge > 10% required)", formatBridgeBatteryLabel(10))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":9,\"streaming\":true}",
            invokeSerializeState(client, criticalBattery9),
        )

        val unknownBatteryStreaming = BridgeDeviceState(connected = true, worn = true, battery = null, streaming = true)
        assertTrue(dedupTracker.shouldPublish(unknownBatteryStreaming, force = false))
        val step6 = evaluateCameraFallback(previousSource = activeSource, state = unknownBatteryStreaming)
        activeSource = step6.nextSource
        assertEquals("glasses", activeSource)
        assertFalse(isLowBattery(unknownBatteryStreaming.battery))
        assertEquals("Unknown", formatBridgeBatteryLabel(unknownBatteryStreaming.battery))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":null,\"streaming\":true}",
            invokeSerializeState(client, unknownBatteryStreaming),
        )

        val disconnected = BridgeDeviceState(connected = false, worn = false, battery = null, streaming = false)
        assertTrue(dedupTracker.shouldPublish(disconnected, force = false))
        val step7 = evaluateCameraFallback(previousSource = activeSource, state = disconnected)
        activeSource = step7.nextSource
        assertEquals("phone", activeSource)
        assertEquals("Glasses disconnected, switching to phone camera", step7.announcement)
        assertEquals(
            "{\"connected\":false,\"worn\":false,\"battery\":null,\"streaming\":false}",
            invokeSerializeState(client, disconnected),
        )
    }

    private fun invokeBuildEndpointUrl(client: IngestClient, endpointPath: String): HttpUrl? {
        return buildEndpointUrlMethod.invoke(client, endpointPath) as HttpUrl?
    }

    private fun invokeSerializeState(client: IngestClient, state: BridgeDeviceState): String {
        return serializeStateMethod.invoke(client, state) as String
    }

    private fun parseFlatJsonObject(json: String): Map<String, String> {
        assertTrue(json.startsWith("{") && json.endsWith("}"))
        val body = json.substring(1, json.length - 1)
        if (body.isEmpty()) return emptyMap()
        val entries = LinkedHashMap<String, String>()
        for (pair in body.split(',')) {
            val colonIdx = pair.indexOf(':')
            assertTrue(colonIdx > 1)
            val rawKey = pair.substring(0, colonIdx)
            val rawValue = pair.substring(colonIdx + 1)
            assertTrue(rawKey.startsWith("\"") && rawKey.endsWith("\"") && rawKey.length >= 3)
            val key = rawKey.substring(1, rawKey.length - 1)
            assertFalse(entries.containsKey(key))
            entries[key] = rawValue
        }
        return entries
    }

    private fun shouldEncodeFrame(isCompressed: Boolean, width: Int, height: Int): Boolean {
        return !isCompressed && width > 0 && height > 0
    }

    private fun simulateControllerEncodeGate(
        arrivalsMs: List<Long>,
        minEncodeIntervalMs: Long,
    ): List<Long> {
        var lastEncodedMs: Long? = null
        val accepted = mutableListOf<Long>()
        for (nowMs in arrivalsMs) {
            val prev = lastEncodedMs
            if (prev != null && nowMs - prev < minEncodeIntervalMs) {
                continue
            }
            lastEncodedMs = nowMs
            accepted.add(nowMs)
        }
        return accepted
    }

    private fun normalizeBatteryPercent(rawLevel: Int?): Int? {
        return rawLevel?.takeIf { it in 1..100 }
    }

    private fun resolveWornFlag(connected: Boolean, donKind: String?): Boolean {
        return when (donKind) {
            "DONNED" -> connected
            "DOFFED" -> false
            "UNKNOWN" -> connected
            null -> false
            else -> false
        }
    }

    private fun isLowBattery(batteryPercent: Int?): Boolean {
        return batteryPercent != null && batteryPercent < LOW_BATTERY_THRESHOLD_PERCENT
    }

    private fun formatBridgeBatteryLabel(batteryPercent: Int?): String {
        return when {
            batteryPercent == null -> "Unknown"
            batteryPercent <= MIN_GLASSES_CHARGE_PERCENT -> "$batteryPercent% (Charge > 10% required)"
            batteryPercent < LOW_BATTERY_THRESHOLD_PERCENT -> "$batteryPercent% (Low battery)"
            else -> "$batteryPercent%"
        }
    }

    private fun evaluateCameraFallback(
        previousSource: String,
        state: BridgeDeviceState,
    ): FallbackOutcome {
        val lowBattery = isLowBattery(state.battery)
        val healthy = state.connected && state.worn && state.streaming && !lowBattery
        if (healthy) {
            return FallbackOutcome(nextSource = "glasses", announcement = null)
        }
        if (previousSource == "glasses") {
            val message = when {
                !state.connected -> "Glasses disconnected, switching to phone camera"
                !state.worn -> "Glasses taken off, switching to phone camera"
                lowBattery -> "Glasses battery low, switching to phone camera"
                else -> "Glasses camera unavailable, switching to phone camera"
            }
            return FallbackOutcome(nextSource = "phone", announcement = message)
        }
        return FallbackOutcome(nextSource = previousSource, announcement = null)
    }

    private data class FallbackOutcome(
        val nextSource: String,
        val announcement: String?,
    )

    private class FrameThrottleSimulator(
        private val minIntervalMs: Long,
    ) {
        private var lastSentAtMs: Long = -minIntervalMs
        val acceptedTimestamps = mutableListOf<Long>()
        var droppedCount: Int = 0
            private set

        fun tryAdmit(nowMs: Long, payloadBytes: Int): Boolean {
            if (nowMs - lastSentAtMs < minIntervalMs || payloadBytes <= 0) {
                droppedCount++
                return false
            }
            lastSentAtMs = nowMs
            acceptedTimestamps.add(nowMs)
            return true
        }
    }

    private class StatePublishTracker {
        private var lastPosted: BridgeDeviceState? = null

        fun shouldPublish(next: BridgeDeviceState, force: Boolean): Boolean {
            if (!force && lastPosted == next) {
                return false
            }
            lastPosted = next
            return true
        }
    }

    private companion object {
        const val MIN_GLASSES_CHARGE_PERCENT = 10
        const val LOW_BATTERY_THRESHOLD_PERCENT = 15
    }
}
