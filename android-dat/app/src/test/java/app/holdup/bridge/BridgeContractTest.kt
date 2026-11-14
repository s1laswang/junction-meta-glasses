package app.holdup.bridge

import java.lang.reflect.Method
import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.*
import org.junit.Test

class BridgeContractTest {

    private val buildEndpointUrlMethod: Method =
        IngestClient::class.java.getDeclaredMethod("buildEndpointUrl", String::class.java).apply {
            isAccessible = true
        }

    private val serializeStateMethod: Method =
        IngestClient::class.java.getDeclaredMethod("serializeState", BridgeDeviceState::class.java).apply {
            isAccessible = true
        }

    @Test
    fun i420ToNv21_4x4PlanarBuffer_copiesLumaAndInterleavesVBeforeU() {
        val width = 4
        val height = 4
        val yPlane = ByteArray(16) { idx -> (10 + idx).toByte() }
        val uPlane = byteArrayOf(0x41.toByte(), 0x42.toByte(), 0x43.toByte(), 0x44.toByte())
        val vPlane = byteArrayOf(0x71.toByte(), 0x72.toByte(), 0x73.toByte(), 0x74.toByte())

        val i420 = ByteBuffer.allocate(24).apply {
            put(yPlane)
            put(uPlane)
            put(vPlane)
            flip()
        }

        val nv21 = YuvJpegEncoder.i420ToNv21(i420, width, height)

        assertEquals(0, i420.position())
        assertEquals(24, nv21.size)

        val expectedChroma = byteArrayOf(
            0x71.toByte(), 0x41.toByte(),
            0x72.toByte(), 0x42.toByte(),
            0x73.toByte(), 0x43.toByte(),
            0x74.toByte(), 0x44.toByte(),
        )
        val expected = ByteArray(24).apply {
            System.arraycopy(yPlane, 0, this, 0, 16)
            System.arraycopy(expectedChroma, 0, this, 16, 8)
        }
        assertArrayEquals(expected, nv21)
    }

    @Test
    fun i420ToNv21_16x16DirectBuffer_preservesLumaAndInterleavesChromaPairs() {
        val width = 16
        val height = 16
        val ySize = width * height
        val uvSize = ySize / 4
        val totalBytes = ySize + uvSize * 2

        val expectedY = ByteArray(ySize) { idx -> ((idx * 3 + 7) and 0xFF).toByte() }
        val expectedU = ByteArray(uvSize) { idx -> ((0x20 + idx) and 0xFF).toByte() }
        val expectedV = ByteArray(uvSize) { idx -> ((0xA0 + idx) and 0xFF).toByte() }

        val directBuffer = ByteBuffer.allocateDirect(totalBytes).apply {
            put(expectedY)
            put(expectedU)
            put(expectedV)
            flip()
        }

        val nv21 = YuvJpegEncoder.i420ToNv21(directBuffer, width, height)

        assertEquals(0, directBuffer.position())
        assertEquals(totalBytes, nv21.size)

        for (i in 0 until ySize) {
            assertEquals(expectedY[i], nv21[i])
        }
        for (i in 0 until uvSize) {
            val vByte = nv21[ySize + i * 2]
            val uByte = nv21[ySize + i * 2 + 1]
            assertEquals(expectedV[i], vByte)
            assertEquals(expectedU[i], uByte)
            assertNotEquals(vByte, uByte)
        }
    }

    @Test
    fun i420ToNv21_rewindsConsumedBufferAndRejectsInvalidDimensionsOrShortInput() {
        val valid = ByteBuffer.allocate(24)
        for (i in 0 until 24) {
            valid.put((i + 1).toByte())
        }
        valid.flip()
        val firstPass = YuvJpegEncoder.i420ToNv21(valid, 4, 4)

        valid.position(24)
        assertEquals(0, valid.remaining())
        val rewoundPass = YuvJpegEncoder.i420ToNv21(valid, 4, 4)
        assertArrayEquals(firstPass, rewoundPass)

        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(valid, 0, 4) }
        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(valid, 4, 0) }
        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(valid, -4, 4) }
        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(valid, 3, 4) }
        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(valid, 4, 5) }
        assertRejectsIllegalArgument { YuvJpegEncoder.i420ToNv21(ByteBuffer.allocate(23), 4, 4) }
    }

    @Test
    fun bridgeDeviceStateAndIngestMetrics_defaultsEqualityAndJsonSerialization() {
        val defaultState = BridgeDeviceState()
        assertFalse(defaultState.connected)
        assertFalse(defaultState.worn)
        assertNull(defaultState.battery)
        assertFalse(defaultState.streaming)
        assertEquals(BridgeDeviceState(false, false, null, false), defaultState)
        assertEquals(BridgeDeviceState().hashCode(), defaultState.hashCode())

        val streamingState = BridgeDeviceState(
            connected = true,
            worn = true,
            battery = 84,
            streaming = true,
        )
        assertEquals(
            streamingState,
            defaultState.copy(connected = true, worn = true, battery = 84, streaming = true),
        )
        assertNotEquals(streamingState, streamingState.copy(worn = false))
        assertNotEquals(streamingState, streamingState.copy(battery = null))
        assertNotEquals(streamingState, streamingState.copy(battery = 14))

        val defaultMetrics = IngestMetrics()
        assertEquals(0L, defaultMetrics.framesSent)
        assertEquals(0L, defaultMetrics.framesDropped)
        assertEquals(0L, defaultMetrics.stateUpdatesSent)
        assertEquals(0, defaultMetrics.lastHttpCode)
        assertNull(defaultMetrics.lastError)
        assertEquals(IngestMetrics(0L, 0L, 0L, 0, null), defaultMetrics)
        assertEquals(IngestMetrics().hashCode(), defaultMetrics.hashCode())

        val updatedMetrics = defaultMetrics.copy(
            framesSent = 18L,
            framesDropped = 2L,
            stateUpdatesSent = 5L,
            lastHttpCode = 204,
        )
        assertEquals(IngestMetrics(18L, 2L, 5L, 204, null), updatedMetrics)
        assertNotEquals(updatedMetrics, updatedMetrics.copy(lastError = "HTTP 503"))

        val defaultUiState = BridgeUiState()
        assertEquals("", defaultUiState.serverUrl)
        assertEquals("", defaultUiState.sessionCode)
        assertFalse(defaultUiState.sdkReady)
        assertEquals("Unregistered", defaultUiState.registrationStatus)
        assertNull(defaultUiState.deviceName)
        assertEquals("Normal", defaultUiState.thermalStatus)
        assertEquals("Idle", defaultUiState.streamStatus)
        assertEquals(defaultUiState, BridgeUiState().copy())
        assertNotEquals(defaultUiState, defaultUiState.copy(serverUrl = "https://demo.trycloudflare.com"))

        val client = IngestClient()
        assertEquals(defaultMetrics, client.metrics.value)
        assertEquals(
            "{\"connected\":false,\"worn\":false,\"battery\":null,\"streaming\":false}",
            invokeSerializeState(client, defaultState),
        )
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":84,\"streaming\":true}",
            invokeSerializeState(client, streamingState),
        )
    }

    @Test
    fun ingestClient_sessionlessAndSessionBoundEndpointUrlConstruction() {
        val client = IngestClient()
        assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))
        assertNull(invokeBuildEndpointUrl(client, "ingest/state"))

        client.configure("   ", "hup-4k9m")
        assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))
        assertNull(invokeBuildEndpointUrl(client, "ingest/state"))

        client.configure("ftp://demo.trycloudflare.com", "hup-4k9m")
        assertNull(invokeBuildEndpointUrl(client, "ingest/frame"))

        client.configure("  https://demo.trycloudflare.com///  ", "   ")
        val sessionlessFrame = invokeBuildEndpointUrl(client, "ingest/frame")
        val sessionlessState = invokeBuildEndpointUrl(client, "ingest/state")
        assertNotNull(sessionlessFrame)
        assertNotNull(sessionlessState)
        assertEquals("https://demo.trycloudflare.com/ingest/frame", sessionlessFrame.toString())
        assertEquals("https://demo.trycloudflare.com/ingest/state", sessionlessState.toString())
        assertNull(sessionlessFrame?.query)
        assertNull(sessionlessState?.query)

        client.configure("https://demo.trycloudflare.com/", "  hup-4k9m  ")
        val boundFrame = invokeBuildEndpointUrl(client, "ingest/frame")
        val boundState = invokeBuildEndpointUrl(client, "ingest/state")
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame?session=hup-4k9m",
            boundFrame.toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state?session=hup-4k9m",
            boundState.toString(),
        )
        assertEquals("hup-4k9m", boundFrame?.queryParameter("session"))
        assertEquals("hup-4k9m", boundState?.queryParameter("session"))

        client.configure("http://192.168.1.20:8787/", "")
        assertEquals(
            "http://192.168.1.20:8787/ingest/frame",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "http://192.168.1.20:8787/ingest/state",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        client.configure("https://demo.trycloudflare.com", "a b&inject=1")
        val encodedUrl = invokeBuildEndpointUrl(client, "ingest/frame")
        assertNotNull(encodedUrl)
        assertEquals(setOf("session"), encodedUrl?.queryParameterNames)
        assertEquals("a b&inject=1", encodedUrl?.queryParameter("session"))
    }

    @Test
    fun deepLinkParameterSafety_normalizesValidPairsAndRejectsHostileParameters() {
        val client = IngestClient()

        val paired = resolveDeepLinkEndpoint(
            rawDeepLink = "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com%2F&session=hup-4k9m",
        )
        assertEquals("https://demo.trycloudflare.com" to "hup-4k9m", paired)
        client.configure(paired!!.first, paired.second)
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame?session=hup-4k9m",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state?session=hup-4k9m",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        val switchedServerWithoutSession = resolveDeepLinkEndpoint(
            rawDeepLink = "HOLDUPBRIDGE://CONNECT/?server=https%3A%2F%2Fnext.trycloudflare.com%2F%2F",
            currentServerUrl = paired.first,
            currentSessionCode = paired.second,
        )
        assertEquals("https://next.trycloudflare.com" to "", switchedServerWithoutSession)
        client.configure(
            switchedServerWithoutSession!!.first,
            switchedServerWithoutSession.second,
        )
        assertEquals(
            "https://next.trycloudflare.com/ingest/frame",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )

        val sessionOnlyUpdate = resolveDeepLinkEndpoint(
            rawDeepLink = "holdupbridge://connect?session=Session_64-OK",
            currentServerUrl = "https://next.trycloudflare.com",
            currentSessionCode = "",
        )
        assertEquals("https://next.trycloudflare.com" to "Session_64-OK", sessionOnlyUpdate)

        val maxLenId = "A".repeat(64)
        assertEquals(
            "https://demo.trycloudflare.com" to maxLenId,
            resolveDeepLinkEndpoint(
                "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=$maxLenId",
            ),
        )

        assertNull(resolveDeepLinkEndpoint("https://connect?server=https%3A%2F%2Fdemo.trycloudflare.com"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://wronghost?server=https%3A%2F%2Fdemo.trycloudflare.com"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect/extra?server=https%3A%2F%2Fdemo.trycloudflare.com"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect?server=javascript%3Aalert(1)"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect?server=file%3A%2F%2F%2Fetc%2Fpasswd"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect?server=ftp%3A%2F%2Fdemo.trycloudflare.com"))
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect?server=https%3A%2F%2F&session=hup-4k9m"))
        assertNull(
            resolveDeepLinkEndpoint(
                "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=bad%20space",
            ),
        )
        assertNull(
            resolveDeepLinkEndpoint(
                "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup%26admin%3D1",
            ),
        )
        assertNull(
            resolveDeepLinkEndpoint(
                "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=..%2Fetc",
            ),
        )
        assertNull(
            resolveDeepLinkEndpoint(
                "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=${"B".repeat(65)}",
            ),
        )
        assertNull(resolveDeepLinkEndpoint("holdupbridge://connect"))
    }

    private fun invokeBuildEndpointUrl(client: IngestClient, endpointPath: String): HttpUrl? {
        return buildEndpointUrlMethod.invoke(client, endpointPath) as HttpUrl?
    }

    private fun invokeSerializeState(client: IngestClient, state: BridgeDeviceState): String {
        return serializeStateMethod.invoke(client, state) as String
    }

    private fun assertRejectsIllegalArgument(block: () -> Unit) {
        try {
            block()
            fail("Expected IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            assertNotNull(expected.message)
        }
    }

    private fun resolveDeepLinkEndpoint(
        rawDeepLink: String,
        currentServerUrl: String = "",
        currentSessionCode: String = "",
    ): Pair<String, String>? {
        val uri = runCatching { URI(rawDeepLink) }.getOrNull() ?: return null
        if (uri.isOpaque) return null
        if (uri.scheme?.equals(DEEP_LINK_SCHEME, ignoreCase = true) != true) return null
        if (uri.host?.equals(DEEP_LINK_HOST, ignoreCase = true) != true) return null
        val path = uri.rawPath
        if (!path.isNullOrEmpty() && path != "/") return null

        val params = decodeQueryParameters(uri.rawQuery)
        val rawServer = params["server"]?.trim()?.trimEnd('/')
        val resolvedServer = if (!rawServer.isNullOrEmpty()) {
            val parsedServer = runCatching { URI(rawServer) }.getOrNull() ?: return null
            val serverScheme = parsedServer.scheme?.lowercase()
            if (serverScheme != "https" && serverScheme != "http") return null
            if (rawServer.toHttpUrlOrNull() == null) return null
            rawServer
        } else {
            currentServerUrl
        }

        val rawSession = params["session"]?.trim()
        val resolvedSession = when {
            rawSession == null -> if (!rawServer.isNullOrEmpty()) "" else currentSessionCode
            rawSession.isEmpty() -> ""
            SESSION_CODE_PATTERN.matches(rawSession) -> rawSession
            else -> return null
        }

        if (resolvedServer.isEmpty() && resolvedSession.isEmpty()) return null
        return resolvedServer to resolvedSession
    }

    private fun decodeQueryParameters(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (segment in rawQuery.split('&')) {
            if (segment.isEmpty()) continue
            val eqIndex = segment.indexOf('=')
            val rawKey = if (eqIndex >= 0) segment.substring(0, eqIndex) else segment
            val rawValue = if (eqIndex >= 0) segment.substring(eqIndex + 1) else ""
            val key = URLDecoder.decode(rawKey, "UTF-8")
            if (!result.containsKey(key)) {
                result[key] = URLDecoder.decode(rawValue, "UTF-8")
            }
        }
        return result
    }

    private companion object {
        const val DEEP_LINK_SCHEME = "holdupbridge"
        const val DEEP_LINK_HOST = "connect"
        val SESSION_CODE_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
    }
}
