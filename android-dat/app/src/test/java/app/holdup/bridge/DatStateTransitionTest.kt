package app.holdup.bridge

import java.lang.reflect.Method
import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import okhttp3.HttpUrl
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DatStateTransitionTest {

    private val buildEndpointUrlMethod: Method =
        IngestClient::class.java.getDeclaredMethod("buildEndpointUrl", String::class.java).apply {
            isAccessible = true
        }

    private val serializeStateMethod: Method =
        IngestClient::class.java.getDeclaredMethod("serializeState", BridgeDeviceState::class.java).apply {
            isAccessible = true
        }

    private val setSdkErrorMethod: Method =
        DatBridgeController::class.java.getDeclaredMethod("setSdkError", String::class.java).apply {
            isAccessible = true
        }

    private val clearSdkErrorMethod: Method =
        DatBridgeController::class.java.getDeclaredMethod("clearSdkError").apply {
            isAccessible = true
        }

    @Test
    fun i420ToNv21_chromaInterleavingAcrossMinimalPortraitLandscapeAnd720x1280Frames() {
        val minimalI420 = ByteBuffer.allocate(6).apply {
            put(byteArrayOf(0x11, 0x22, 0x33, 0x44))
            put(0x55.toByte())
            put(0xAA.toByte())
            flip()
        }
        val minimalNv21 = YuvJpegEncoder.i420ToNv21(minimalI420, 2, 2)
        assertEquals(0, minimalI420.position())
        assertEquals(6, minimalI420.limit())
        assertArrayEquals(
            byteArrayOf(0x11, 0x22, 0x33, 0x44, 0xAA.toByte(), 0x55.toByte()),
            minimalNv21,
        )

        val geometries = listOf(
            6 to 8,
            8 to 6,
            18 to 32,
            32 to 18,
        )
        for ((width, height) in geometries) {
            val ySize = width * height
            val uvWidth = width / 2
            val uvHeight = height / 2
            val uvSize = uvWidth * uvHeight
            val totalBytes = ySize + uvSize * 2

            val expectedY = ByteArray(ySize) { idx -> ((idx * 5 + 13) and 0xFF).toByte() }
            val expectedU = ByteArray(uvSize) { idx -> ((0x10 + (idx * 3) % 97) and 0xFF).toByte() }
            val expectedV = ByteArray(uvSize) { idx -> ((0x90 + (idx * 7) % 89) and 0xFF).toByte() }

            val planar = ByteBuffer.allocate(totalBytes).apply {
                put(expectedY)
                put(expectedU)
                put(expectedV)
                flip()
            }

            val nv21 = YuvJpegEncoder.i420ToNv21(planar, width, height)
            assertEquals(totalBytes, nv21.size)
            assertEquals(0, planar.position())
            assertEquals(totalBytes, planar.limit())

            for (yIdx in 0 until ySize) {
                assertEquals(expectedY[yIdx], nv21[yIdx])
            }

            for (row in 0 until height) {
                for (col in 0 until width) {
                    val uvIndex = (row / 2) * uvWidth + (col / 2)
                    val crByte = nv21[ySize + uvIndex * 2]
                    val cbByte = nv21[ySize + uvIndex * 2 + 1]
                    assertEquals(expectedV[uvIndex], crByte)
                    assertEquals(expectedU[uvIndex], cbByte)
                    assertNotEquals(crByte, cbByte)
                }
            }
        }

        val hdWidth = 720
        val hdHeight = 1280
        val hdYSize = hdWidth * hdHeight
        val hdUvSize = hdYSize / 4
        val hdTotalBytes = hdYSize + hdUvSize * 2
        assertEquals(1_382_400, hdTotalBytes)

        val hdY = ByteArray(hdYSize) { idx -> ((idx * 17 + 3) and 0xFF).toByte() }
        val hdU = ByteArray(hdUvSize) { idx -> (0x20 + (idx % 64)).toByte() }
        val hdV = ByteArray(hdUvSize) { idx -> (0xA0 + (idx % 64)).toByte() }

        val hdDirect = ByteBuffer.allocateDirect(hdTotalBytes).apply {
            put(hdY)
            put(hdU)
            put(hdV)
            flip()
        }

        val hdNv21 = YuvJpegEncoder.i420ToNv21(hdDirect, hdWidth, hdHeight)
        assertEquals(hdTotalBytes, hdNv21.size)
        assertEquals(0, hdDirect.position())
        assertEquals(hdTotalBytes, hdDirect.limit())

        for (probeY in listOf(0, 1, 719, 720, 460_800, hdYSize - 2, hdYSize - 1)) {
            assertEquals(hdY[probeY], hdNv21[probeY])
        }
        for (probeUv in listOf(0, 1, 359, 360, 115_200, hdUvSize - 2, hdUvSize - 1)) {
            val vOut = hdNv21[hdYSize + probeUv * 2]
            val uOut = hdNv21[hdYSize + probeUv * 2 + 1]
            assertEquals(hdV[probeUv], vOut)
            assertEquals(hdU[probeUv], uOut)
            assertNotEquals(vOut, uOut)
        }
    }

    @Test
    fun i420ToNv21_bufferSliceReadOnlyRewindPaddingAndDimensionGuards() {
        val width = 4
        val height = 4
        val yPlane = ByteArray(16) { idx -> (0x30 + idx).toByte() }
        val uPlane = byteArrayOf(0x12, 0x13, 0x14, 0x15)
        val vPlane = byteArrayOf(0x62, 0x63, 0x64, 0x65)

        val framedPacket = ByteBuffer.allocate(64)
        repeat(16) { framedPacket.put(0xEE.toByte()) }
        framedPacket.put(yPlane)
        framedPacket.put(uPlane)
        framedPacket.put(vPlane)
        repeat(24) { framedPacket.put(0xDD.toByte()) }
        framedPacket.position(16)
        framedPacket.limit(40)

        val fromOffset = YuvJpegEncoder.i420ToNv21(framedPacket, width, height)
        assertEquals(16, framedPacket.position())
        assertEquals(40, framedPacket.limit())
        assertEquals(24, fromOffset.size)
        assertEquals(0x30.toByte(), fromOffset[0])
        assertEquals(0x62.toByte(), fromOffset[16])
        assertEquals(0x12.toByte(), fromOffset[17])
        assertEquals(0x65.toByte(), fromOffset[22])
        assertEquals(0x15.toByte(), fromOffset[23])

        val sliced = framedPacket.slice()
        val readOnly = sliced.asReadOnlyBuffer()
        assertArrayEquals(fromOffset, YuvJpegEncoder.i420ToNv21(sliced, width, height))
        assertArrayEquals(fromOffset, YuvJpegEncoder.i420ToNv21(readOnly, width, height))
        assertEquals(0, sliced.position())
        assertEquals(0, readOnly.position())

        val padded = ByteBuffer.allocate(56).apply {
            put(yPlane)
            put(uPlane)
            put(vPlane)
            repeat(32) { put(0x7F.toByte()) }
            flip()
        }
        assertArrayEquals(fromOffset, YuvJpegEncoder.i420ToNv21(padded, width, height))
        assertEquals(0, padded.position())
        assertEquals(56, padded.limit())

        val consumed = ByteBuffer.allocate(24).apply {
            put(yPlane)
            put(uPlane)
            put(vPlane)
            position(24)
            limit(24)
        }
        assertEquals(0, consumed.remaining())
        assertArrayEquals(fromOffset, YuvJpegEncoder.i420ToNv21(consumed, width, height))
        assertEquals(24, consumed.position())

        val truncatedLimit = ByteBuffer.allocate(32).apply {
            position(8)
            limit(23)
        }
        assertThrowsIllegalArgument {
            YuvJpegEncoder.i420ToNv21(truncatedLimit, width, height)
        }

        val invalidDimensions = listOf(
            0 to 0,
            0 to 4,
            4 to 0,
            -2 to 4,
            4 to -2,
            1 to 2,
            2 to 1,
            3 to 5,
            719 to 1280,
            720 to 1279,
        )
        for ((badW, badH) in invalidDimensions) {
            assertThrowsIllegalArgument {
                YuvJpegEncoder.i420ToNv21(ByteBuffer.allocate(2_000_000), badW, badH)
            }
        }
    }

    @Test
    fun i420ToNv21_signedByteExtremesBijectiveRoundTripAndEncoderPreconditions() {
        val signedBoundaryY = byteArrayOf(
            0x00, 0x01, 0x7E, 0x7F,
            0x80.toByte(), 0x81.toByte(), 0xFE.toByte(), 0xFF.toByte(),
            0x10, 0x20, 0xD0.toByte(), 0xE0.toByte(),
            0x7F, 0x80.toByte(), 0x00, 0xFF.toByte(),
        )
        val signedBoundaryU = byteArrayOf(0x00, 0x7F, 0x80.toByte(), 0xFF.toByte())
        val signedBoundaryV = byteArrayOf(0xFF.toByte(), 0x80.toByte(), 0x7F, 0x00)

        val boundaryBuf = ByteBuffer.allocateDirect(24).apply {
            put(signedBoundaryY)
            put(signedBoundaryU)
            put(signedBoundaryV)
            flip()
        }
        val firstPass = YuvJpegEncoder.i420ToNv21(boundaryBuf, 4, 4)
        val secondPass = YuvJpegEncoder.i420ToNv21(boundaryBuf, 4, 4)
        val thirdPass = YuvJpegEncoder.i420ToNv21(boundaryBuf, 4, 4)
        assertEquals(0, boundaryBuf.position())
        assertEquals(24, boundaryBuf.limit())
        assertArrayEquals(firstPass, secondPass)
        assertArrayEquals(secondPass, thirdPass)

        val expectedTail = byteArrayOf(
            0xFF.toByte(), 0x00,
            0x80.toByte(), 0x7F,
            0x7F, 0x80.toByte(),
            0x00, 0xFF.toByte(),
        )
        assertArrayEquals(signedBoundaryY, firstPass.copyOfRange(0, 16))
        assertArrayEquals(expectedTail, firstPass.copyOfRange(16, 24))

        val roundTripGeometries = listOf(
            2 to 4,
            4 to 2,
            10 to 14,
            14 to 10,
            64 to 36,
        )
        for ((width, height) in roundTripGeometries) {
            val yLen = width * height
            val uvLen = yLen / 4
            val srcY = ByteArray(yLen) { idx -> ((idx * 31 + 0x7D) and 0xFF).toByte() }
            val srcU = ByteArray(uvLen) { idx -> ((idx * 53 + 0x80) and 0xFF).toByte() }
            val srcV = ByteArray(uvLen) { idx -> ((idx * 97 + 0x01) and 0xFF).toByte() }
            val i420Bytes = ByteArray(yLen + uvLen * 2).apply {
                System.arraycopy(srcY, 0, this, 0, yLen)
                System.arraycopy(srcU, 0, this, yLen, uvLen)
                System.arraycopy(srcV, 0, this, yLen + uvLen, uvLen)
            }
            val nv21 = YuvJpegEncoder.i420ToNv21(ByteBuffer.wrap(i420Bytes), width, height)
            val reconstructedI420 = deinterleaveNv21ToI420(nv21, width, height)
            assertArrayEquals(i420Bytes, reconstructedI420)
        }

        for ((badW, badH) in listOf(0 to 4, 4 to 0, -4 to 4, 4 to -4, 3 to 4, 4 to 5)) {
            assertThrowsIllegalArgument {
                YuvJpegEncoder.encodeNv21ToJpeg(ByteArray(64), badW, badH)
            }
            assertThrowsIllegalArgument {
                YuvJpegEncoder.encodeBufferToJpeg(ByteBuffer.allocate(64), badW, badH)
            }
        }

        assertThrowsIllegalArgument {
            YuvJpegEncoder.encodeNv21ToJpeg(ByteArray(0), 4, 4)
        }
        assertThrowsIllegalArgument {
            YuvJpegEncoder.encodeNv21ToJpeg(ByteArray(23), 4, 4)
        }
        assertThrowsIllegalArgument {
            YuvJpegEncoder.encodeBufferToJpeg(ByteBuffer.allocate(23), 4, 4)
        }
    }

    @Test
    fun bridgeUiState_registrationAndDeviceTelemetryTransitions() {
        val initial = BridgeUiState()
        assertEquals("", initial.serverUrl)
        assertEquals("", initial.sessionCode)
        assertFalse(initial.sdkReady)
        assertEquals("Unregistered", initial.registrationStatus)
        assertNull(initial.deviceName)
        assertFalse(initial.connected)
        assertFalse(initial.worn)
        assertNull(initial.batteryPercent)
        assertEquals("Normal", initial.thermalStatus)
        assertEquals("Idle", initial.streamStatus)
        assertFalse(initial.streaming)
        assertEquals(0L, initial.framesSent)
        assertEquals(0L, initial.framesDropped)
        assertEquals(0, initial.lastHttpCode)
        assertNull(initial.lastError)
        assertEquals("Unregistered (SDK initializing)", formatRegistrationCardValue(initial))

        val controllerClass = Class.forName(
            "app.holdup.bridge.DatBridgeController",
            false,
            BridgeUiState::class.java.classLoader,
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
        assertEquals(960L, minEncodeIntervalMs)
        assertEquals(15_000L, sessionTimeoutMs)

        val methodNames = controllerClass.declaredMethods.map { it.name }.toSet()
        for (expectedMethod in listOf(
            "initialize",
            "updateEndpoint",
            "connectGlasses",
            "startStreaming",
            "stopStreaming",
            "disconnect",
            "openFirmwareUpdate",
            "openGlassesAppUpdate",
        )) {
            assertTrue(methodNames.contains(expectedMethod))
        }

        try {
            DatBridgeController.updateEndpoint("   ", "  hup-4k9m  ")
            assertEquals("", DatBridgeController.uiState.value.serverUrl)
            assertEquals("hup-4k9m", DatBridgeController.uiState.value.sessionCode)
            setSdkErrorMethod.invoke(DatBridgeController, "Registration handshake stalled")
            assertEquals("Registration handshake stalled", DatBridgeController.uiState.value.lastError)
            clearSdkErrorMethod.invoke(DatBridgeController)
            assertNull(DatBridgeController.uiState.value.lastError)
        } finally {
            DatBridgeController.updateEndpoint("", "")
            clearSdkErrorMethod.invoke(DatBridgeController)
        }
        assertEquals(initial, DatBridgeController.uiState.value)
        assertEquals(initial.hashCode(), DatBridgeController.uiState.value.hashCode())

        val machine = BridgeStateMachine()
        machine.updateEndpoint("  https://demo.trycloudflare.com///  ", "  hup-4k9m  ")
        assertEquals("https://demo.trycloudflare.com", machine.uiState.serverUrl)
        assertEquals("hup-4k9m", machine.uiState.sessionCode)
        assertEquals(1, machine.publishedDeviceStates.size)
        assertEquals(BridgeDeviceState(false, false, null, false), machine.publishedDeviceStates.last())

        machine.requestStartStreaming()
        assertEquals("Idle", machine.uiState.streamStatus)
        assertFalse(machine.uiState.streaming)

        machine.onInitializeFailure("Failed to initialize Meta Wearables DAT SDK")
        assertFalse(machine.uiState.sdkReady)
        assertEquals("Failed to initialize Meta Wearables DAT SDK", machine.uiState.lastError)

        machine.onInitializeOutcome(alreadyInitialized = true)
        assertTrue(machine.uiState.sdkReady)
        assertNull(machine.uiState.lastError)
        assertEquals("Unregistered", formatRegistrationCardValue(machine.uiState))

        machine.requestStartStreaming()
        assertEquals("Unregistered", machine.uiState.streamStatus)
        assertFalse(machine.uiState.streaming)
        assertEquals(
            "Connect glasses in Meta AI before starting camera stream",
            machine.uiState.lastError,
        )

        machine.onRegistrationState("REGISTERING")
        assertEquals("Registering", machine.uiState.registrationStatus)
        machine.onRegistrationState("REGISTERED")
        assertEquals("Registered", machine.uiState.registrationStatus)

        val spareGlasses = SimulatedDevice(
            id = "dev-spare",
            name = "Ray-Ban Spare",
            connected = false,
            donState = "DOFFED",
            compatible = true,
            batteryLevel = 95,
            thermalLevel = "NONE",
        )
        val deskGlasses = SimulatedDevice(
            id = "dev-desk",
            name = "   ",
            connected = true,
            donState = "DOFFED",
            compatible = true,
            batteryLevel = 0,
            thermalLevel = "LIGHT",
        )
        val wornGlasses = SimulatedDevice(
            id = "dev-worn",
            name = "Ray-Ban Meta Gen 2",
            connected = true,
            donState = "DONNED",
            compatible = true,
            batteryLevel = 76,
            thermalLevel = "MODERATE",
        )

        machine.onDevicesMetadata(listOf(spareGlasses, deskGlasses))
        assertEquals("Meta AI Glasses", machine.uiState.deviceName)
        assertTrue(machine.uiState.connected)
        assertFalse(machine.uiState.worn)
        assertNull(machine.uiState.batteryPercent)
        assertEquals("Warm", machine.uiState.thermalStatus)
        assertEquals("Connected / Doffed", formatConnectionWornCardValue(machine.uiState))

        machine.onDevicesMetadata(listOf(spareGlasses, deskGlasses, wornGlasses))
        assertEquals("Ray-Ban Meta Gen 2", machine.uiState.deviceName)
        assertTrue(machine.uiState.connected)
        assertTrue(machine.uiState.worn)
        assertEquals(76, machine.uiState.batteryPercent)
        assertEquals("Moderate", machine.uiState.thermalStatus)
        assertEquals("Connected / Worn", formatConnectionWornCardValue(machine.uiState))

        machine.onDevicesMetadata(
            listOf(
                wornGlasses.copy(
                    name = "",
                    compatibility = "DEVICE_UPDATE_REQUIRED",
                    batteryLevel = 101,
                    thermalLevel = "SEVERE",
                ),
            ),
        )
        assertEquals("Firmware update required for Meta AI Glasses", machine.uiState.lastError)
        assertNull(machine.uiState.batteryPercent)
        assertEquals("Severe", machine.uiState.thermalStatus)

        machine.onDevicesMetadata(
            listOf(
                wornGlasses.copy(
                    compatibility = "SDK_UPDATE_REQUIRED",
                    donState = "UNKNOWN",
                    batteryLevel = 64,
                    thermalLevel = "CRITICAL",
                ),
            ),
        )
        assertEquals("SDK update required for connected glasses", machine.uiState.lastError)
        assertTrue(machine.uiState.worn)
        assertEquals(64, machine.uiState.batteryPercent)
        assertEquals("Critical", machine.uiState.thermalStatus)

        assertEquals("Normal", mapThermalLabel(null))
        assertEquals("Normal", mapThermalLabel("UNKNOWN"))
        assertEquals("Normal", mapThermalLabel("NONE"))
        assertEquals("Warm", mapThermalLabel("LIGHT"))
        assertEquals("Moderate", mapThermalLabel("MODERATE"))
        assertEquals("Severe", mapThermalLabel("SEVERE"))
        assertEquals("Critical", mapThermalLabel("CRITICAL"))
        assertEquals("Emergency", mapThermalLabel("EMERGENCY"))
        assertEquals("Shutdown", mapThermalLabel("SHUTDOWN"))

        machine.onRegistrationState("UNREGISTERING")
        assertEquals("Unregistering", machine.uiState.registrationStatus)
        machine.onRegistrationState("UNAVAILABLE")
        assertEquals("Unavailable", machine.uiState.registrationStatus)
        machine.onDevicesMetadata(emptyList())
        assertNull(machine.uiState.deviceName)
        assertFalse(machine.uiState.connected)
        assertFalse(machine.uiState.worn)
        assertEquals("Disconnected / Not worn", formatConnectionWornCardValue(machine.uiState))
    }

    @Test
    fun bridgeUiState_permissionSessionAndStreamingLifecycleTransitions() {
        val client = IngestClient()
        val machine = BridgeStateMachine()
        machine.onInitializeOutcome(alreadyInitialized = false)
        machine.updateEndpoint("https://demo.trycloudflare.com", "hup-4k9m")
        machine.onRegistrationState("REGISTERED")
        machine.onDevicesMetadata(
            listOf(
                SimulatedDevice(
                    id = "dev-1",
                    name = "Ray-Ban Meta",
                    connected = true,
                    donState = "DONNED",
                    compatible = true,
                    batteryLevel = 82,
                    thermalLevel = "NONE",
                ),
            ),
        )

        machine.requestStartStreaming()
        assertEquals("Starting", machine.uiState.streamStatus)
        assertFalse(machine.uiState.streaming)
        assertNull(machine.uiState.lastError)

        machine.onCameraPermissionCheckFailed("Meta AI permission service unreachable")
        assertFalse(machine.uiState.streaming)
        assertEquals("Permission required", machine.uiState.streamStatus)
        assertEquals("Meta AI permission service unreachable", machine.uiState.lastError)

        machine.requestStartStreaming()
        assertEquals("Starting", machine.uiState.streamStatus)
        assertNull(machine.uiState.lastError)
        machine.onCameraPermissionMissingWithoutActivity()
        assertFalse(machine.uiState.streaming)
        assertEquals("Permission required", machine.uiState.streamStatus)
        assertEquals(
            "Approve camera permission in Meta AI, then tap Start Streaming",
            machine.uiState.lastError,
        )

        machine.requestStartStreaming()
        machine.onRequestingCameraPermission()
        assertEquals("Requesting permission", machine.uiState.streamStatus)
        machine.onCameraPermissionResult(granted = false)
        assertFalse(machine.uiState.streaming)
        assertEquals("Permission required", machine.uiState.streamStatus)
        assertEquals("Camera permission denied in Meta AI app", machine.uiState.lastError)

        machine.requestStartStreaming()
        machine.onRequestingCameraPermission()
        machine.onCameraPermissionResult(granted = true)
        machine.onSessionConnecting()
        assertEquals("Connecting session", machine.uiState.streamStatus)
        machine.onSessionStartFailed()
        assertFalse(machine.uiState.streaming)
        assertEquals("Session failed", machine.uiState.streamStatus)
        assertEquals(
            "Glasses session did not start; verify glasses are unfolded and connected",
            machine.uiState.lastError,
        )

        machine.requestStartStreaming()
        machine.onCameraPermissionResult(granted = true)
        machine.onSessionConnecting()
        machine.onDeviceSessionState("IDLE")
        assertEquals("Connecting session", machine.uiState.streamStatus)
        machine.onDeviceSessionState("STOPPED")
        assertEquals("Connecting session", machine.uiState.streamStatus)
        machine.onCameraOpening()
        assertEquals("Opening camera", machine.uiState.streamStatus)
        machine.onCameraAttachFailed("Camera busy in another app")
        assertFalse(machine.uiState.streaming)
        assertEquals("Error", machine.uiState.streamStatus)
        assertEquals("Camera busy in another app", machine.uiState.lastError)

        machine.requestStartStreaming()
        machine.onCameraPermissionResult(granted = true)
        machine.onCameraOpening()
        machine.onCameraStreamStartFailed("Glasses camera start rejected")
        assertFalse(machine.uiState.streaming)
        assertEquals("Error", machine.uiState.streamStatus)
        assertEquals("Glasses camera start rejected", machine.uiState.lastError)

        machine.requestStartStreaming()
        machine.onCameraPermissionResult(granted = true)
        machine.onCameraOpening()
        machine.onStreamState("STOPPED")
        assertEquals("Opening camera", machine.uiState.streamStatus)

        machine.onStreamState("STARTING")
        assertEquals("Starting", machine.uiState.streamStatus)
        assertFalse(machine.uiState.streaming)

        machine.onStreamState("STARTED")
        assertEquals("Started", machine.uiState.streamStatus)
        assertFalse(machine.uiState.streaming)

        machine.onStreamState("STREAMING")
        assertTrue(machine.uiState.streaming)
        assertEquals("Active", machine.uiState.streamStatus)
        assertEquals("Streaming (Active)", formatStreamCardValue(machine.uiState))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":82,\"streaming\":true}",
            invokeSerializeState(client, machine.publishedDeviceStates.last()),
        )

        machine.onStreamState("PAUSED")
        assertFalse(machine.uiState.streaming)
        assertEquals("Paused", machine.uiState.streamStatus)
        assertEquals("Paused", formatStreamCardValue(machine.uiState))
        assertEquals(
            "{\"connected\":true,\"worn\":true,\"battery\":82,\"streaming\":false}",
            invokeSerializeState(client, machine.publishedDeviceStates.last()),
        )

        machine.onStreamState("STREAMING")
        assertTrue(machine.uiState.streaming)
        assertEquals("Active", machine.uiState.streamStatus)

        machine.onDeviceSessionState("PAUSED")
        assertFalse(machine.uiState.streaming)
        assertEquals("Session paused", machine.uiState.streamStatus)

        machine.onStreamState("STREAMING")
        assertTrue(machine.uiState.streaming)
        machine.onStreamState("STOPPING")
        assertFalse(machine.uiState.streaming)
        assertEquals("Stopping", machine.uiState.streamStatus)

        machine.onStreamState("CLOSED")
        assertFalse(machine.uiState.streaming)
        assertEquals("Idle", machine.uiState.streamStatus)

        machine.requestStartStreaming()
        machine.onCameraPermissionResult(granted = true)
        machine.onCameraOpening()
        machine.onStreamState("STREAMING")
        assertTrue(machine.uiState.streaming)

        machine.onRegistrationState("AVAILABLE")
        assertEquals("Unregistered", machine.uiState.registrationStatus)
        assertFalse(machine.uiState.streaming)
        assertEquals("Idle", machine.uiState.streamStatus)
        assertEquals(
            BridgeDeviceState(connected = true, worn = true, battery = 82, streaming = false),
            machine.publishedDeviceStates.last(),
        )
    }

    @Test
    fun bridgeUiState_ingestMetricsAndSdkErrorPrecedenceRecovery() {
        val machine = BridgeStateMachine()
        machine.onInitializeOutcome(alreadyInitialized = false)
        machine.updateEndpoint("https://demo.trycloudflare.com", "hup-4k9m")
        machine.onRegistrationState("REGISTERED")
        machine.onDevicesMetadata(
            listOf(
                SimulatedDevice(
                    id = "dev-1",
                    name = "Ray-Ban Meta",
                    connected = true,
                    donState = "DONNED",
                    compatible = true,
                    batteryLevel = 74,
                    thermalLevel = "NONE",
                ),
            ),
        )
        machine.requestStartStreaming()
        machine.onCameraPermissionResult(granted = true)
        machine.onCameraOpening()
        machine.onStreamState("STREAMING")

        assertEquals("None", formatHttpCardValue(machine.uiState.lastHttpCode))
        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 1L,
                framesDropped = 0L,
                stateUpdatesSent = 2L,
                lastHttpCode = 204,
                lastError = null,
            ),
        )
        assertEquals(1L, machine.uiState.framesSent)
        assertEquals(0L, machine.uiState.framesDropped)
        assertEquals(204, machine.uiState.lastHttpCode)
        assertEquals("204 OK", formatHttpCardValue(machine.uiState.lastHttpCode))
        assertNull(machine.uiState.lastError)

        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 1L,
                framesDropped = 2L,
                stateUpdatesSent = 2L,
                lastHttpCode = 503,
                lastError = "HTTP 503",
            ),
        )
        assertEquals(2L, machine.uiState.framesDropped)
        assertEquals(503, machine.uiState.lastHttpCode)
        assertEquals("503", formatHttpCardValue(machine.uiState.lastHttpCode))
        assertEquals("HTTP 503", machine.uiState.lastError)

        machine.onStreamError("Camera thermal throttle warning")
        assertEquals("Camera thermal throttle warning", machine.uiState.lastError)

        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 1L,
                framesDropped = 3L,
                stateUpdatesSent = 2L,
                lastHttpCode = 502,
                lastError = "HTTP 502",
            ),
        )
        assertEquals("HTTP 502", machine.uiState.lastError)

        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 2L,
                framesDropped = 3L,
                stateUpdatesSent = 2L,
                lastHttpCode = 204,
                lastError = null,
            ),
        )
        assertEquals(204, machine.uiState.lastHttpCode)
        assertEquals("Camera thermal throttle warning", machine.uiState.lastError)

        machine.stopStreaming()
        machine.requestStartStreaming()
        assertNull(machine.uiState.lastError)

        machine.stopStreaming()
        val publishCountBeforeWipe = machine.publishedDeviceStates.size
        machine.updateEndpoint("", "")
        assertEquals("", machine.uiState.serverUrl)
        assertEquals("", machine.uiState.sessionCode)
        assertEquals(publishCountBeforeWipe, machine.publishedDeviceStates.size)

        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 2L,
                framesDropped = 4L,
                stateUpdatesSent = 2L,
                lastHttpCode = 0,
                lastError = "Invalid or empty server URL",
            ),
        )
        machine.onStreamError("Transient SDK warning")
        assertEquals("Transient SDK warning", machine.uiState.lastError)

        machine.clearSdkError()
        assertEquals("Invalid or empty server URL", machine.uiState.lastError)

        machine.updateEndpoint("https://demo.trycloudflare.com/", "hup-4k9m")
        machine.onIngestMetrics(
            IngestMetrics(
                framesSent = 3L,
                framesDropped = 4L,
                stateUpdatesSent = 3L,
                lastHttpCode = 204,
                lastError = null,
            ),
        )
        assertNull(machine.uiState.lastError)
        assertEquals("204 OK", formatHttpCardValue(machine.uiState.lastHttpCode))
    }

    @Test
    fun deepLinkConnect_handlesPairedStatefulAndHostileParameterEdgeCases() {
        val client = IngestClient()
        val coordinator = DeepLinkCoordinator(client)

        val initialIntent = SimulatedIntent(
            "holdupbridge://connect?server=https%3A%2F%2Fdemo.trycloudflare.com%2F%2F%2F&session=hup-4k9m",
        )
        assertTrue(coordinator.handleDeepLink(initialIntent))
        assertNull(initialIntent.dataUri)
        assertEquals("https://demo.trycloudflare.com", coordinator.uiState.serverUrl)
        assertEquals("hup-4k9m", coordinator.uiState.sessionCode)
        assertEquals(
            SavedBridgeEndpoint("https://demo.trycloudflare.com", "hup-4k9m"),
            coordinator.savedEndpoint,
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/frame?session=hup-4k9m",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )
        assertEquals(
            "https://demo.trycloudflare.com/ingest/state?session=hup-4k9m",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        coordinator.forgetSavedServer()
        assertEquals("", coordinator.uiState.serverUrl)
        assertEquals("", coordinator.uiState.sessionCode)
        assertFalse(coordinator.handleDeepLink(initialIntent))
        assertEquals("", coordinator.uiState.serverUrl)

        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent(
                    "HOLDUPBRIDGE://CONNECT/?server=http%3A%2F%2F%5B%3A%3A1%5D%3A8787%2F&session=abcd",
                ),
            ),
        )
        assertEquals("http://[::1]:8787", coordinator.uiState.serverUrl)
        assertEquals("abcd", coordinator.uiState.sessionCode)
        assertEquals(
            "http://[::1]:8787/ingest/frame?session=abcd",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )

        val duplicateParams = SimulatedIntent(
            "HoldUpBridge://Connect?server=https%3A%2F%2Ffirst.trycloudflare.com%2F&server=https%3A%2F%2Fsecond.trycloudflare.com%2F&session=first_01&session=second_02",
        )
        assertTrue(coordinator.handleDeepLink(duplicateParams))
        assertEquals("https://first.trycloudflare.com", coordinator.uiState.serverUrl)
        assertEquals("first_01", coordinator.uiState.sessionCode)

        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent("holdupbridge://connect?server=https%3A%2F%2Fnext.trycloudflare.com%2F"),
            ),
        )
        assertEquals("https://next.trycloudflare.com", coordinator.uiState.serverUrl)
        assertEquals("", coordinator.uiState.sessionCode)
        assertEquals(
            "https://next.trycloudflare.com/ingest/frame",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )

        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent("holdupbridge://connect?session=Session_2026-11"),
            ),
        )
        assertEquals("https://next.trycloudflare.com", coordinator.uiState.serverUrl)
        assertEquals("Session_2026-11", coordinator.uiState.sessionCode)
        assertEquals(
            "https://next.trycloudflare.com/ingest/state?session=Session_2026-11",
            invokeBuildEndpointUrl(client, "ingest/state").toString(),
        )

        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent("holdupbridge://connect?server=&session=%20%20%20"),
            ),
        )
        assertEquals("https://next.trycloudflare.com", coordinator.uiState.serverUrl)
        assertEquals("", coordinator.uiState.sessionCode)

        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent(
                    "holdupbridge://connect?server=https%3A%2F%2Fholdup.run.app%2Fbridge%2Bv1%2F&session=A1_-",
                ),
            ),
        )
        assertEquals("https://holdup.run.app/bridge+v1", coordinator.uiState.serverUrl)
        assertEquals("A1_-", coordinator.uiState.sessionCode)
        assertEquals(
            "https://holdup.run.app/bridge+v1/ingest/frame?session=A1_-",
            invokeBuildEndpointUrl(client, "ingest/frame").toString(),
        )

        val maxSession = "M".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH)
        val urlPrefix = "https://holdup.run.app/"
        val exact256Server = urlPrefix + "p".repeat(BridgePreferences.MAX_SERVER_URL_LENGTH - urlPrefix.length)
        assertEquals(256, exact256Server.length)
        val encoded256Server = exact256Server.replace(":", "%3A").replace("/", "%2F")
        assertTrue(
            coordinator.handleDeepLink(
                SimulatedIntent("holdupbridge://connect?server=$encoded256Server&session=$maxSession"),
            ),
        )
        assertEquals(exact256Server, coordinator.uiState.serverUrl)
        assertEquals(maxSession, coordinator.uiState.sessionCode)

        val snapshotBeforeHostile = coordinator.uiState
        val over257Server = (exact256Server + "x").replace(":", "%3A").replace("/", "%2F")
        val rejectedLinks = listOf(
            "",
            "https://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "fb-viewapp://connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "intent://connect#Intent;scheme=holdupbridge;end",
            "holdupbridge:connect?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://wronghost?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect/v1?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect//?server=https%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect",
            "holdupbridge://connect?unrelated=1",
            "holdupbridge://connect?server=javascript%3Aalert(1)&session=hup-4k9m",
            "holdupbridge://connect?server=file%3A%2F%2F%2Fetc%2Fpasswd&session=hup-4k9m",
            "holdupbridge://connect?server=ftp%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect?server=wss%3A%2F%2Fdemo.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fuser%3Apass%40evil.example&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%3Fextra%3D1&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%23frag&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%2F..%2Fetc&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%5Cadmin&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%00.trycloudflare.com&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%0D%0AX-Test%3A1&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%3A0&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fevil.example%3A65536&session=hup-4k9m",
            "holdupbridge://connect?server=$over257Server&session=hup-4k9m",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=abc",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=${"X".repeat(65)}",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=bad+space",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=bad%20space",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=hup%00null",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=hup%0D%0Ainj",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=hup%26inject%3D1",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=..%2Fetc",
            "holdupbridge://connect?server=https%3A%2F%2Fvalid.trycloudflare.com&session=hup%3Bdrop",
            "holdupbridge://connect?server=%ZZ&session=hup-4k9m",
        )

        for (badLink in rejectedLinks) {
            val intent = SimulatedIntent(badLink)
            assertFalse("Expected rejection for deep link: $badLink", coordinator.handleDeepLink(intent))
            assertEquals(snapshotBeforeHostile, coordinator.uiState)
            assertEquals(
                SavedBridgeEndpoint(exact256Server, maxSession),
                coordinator.savedEndpoint,
            )
        }

        val coldCoordinator = DeepLinkCoordinator(IngestClient())
        assertFalse(coldCoordinator.handleDeepLink(SimulatedIntent("holdupbridge://connect?server=&session=")))
        assertEquals(BridgeUiState(), coldCoordinator.uiState)
        assertTrue(coldCoordinator.handleDeepLink(SimulatedIntent("holdupbridge://connect?session=cold_01")))
        assertEquals("", coldCoordinator.uiState.serverUrl)
        assertEquals("cold_01", coldCoordinator.uiState.sessionCode)
    }

    private fun invokeBuildEndpointUrl(client: IngestClient, endpointPath: String): HttpUrl? {
        return buildEndpointUrlMethod.invoke(client, endpointPath) as HttpUrl?
    }

    private fun invokeSerializeState(client: IngestClient, state: BridgeDeviceState): String {
        return serializeStateMethod.invoke(client, state) as String
    }

    private fun assertThrowsIllegalArgument(block: () -> Unit) {
        try {
            block()
            fail("Expected IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            assertNotNull(expected.message)
        }
    }

    private fun deinterleaveNv21ToI420(nv21: ByteArray, width: Int, height: Int): ByteArray {
        val ySize = width * height
        val uvSize = ySize / 4
        val out = ByteArray(ySize + uvSize * 2)
        System.arraycopy(nv21, 0, out, 0, ySize)
        var inOffset = ySize
        for (i in 0 until uvSize) {
            val vByte = nv21[inOffset++]
            val uByte = nv21[inOffset++]
            out[ySize + i] = uByte
            out[ySize + uvSize + i] = vByte
        }
        return out
    }

    private fun formatRegistrationCardValue(uiState: BridgeUiState): String {
        return if (uiState.sdkReady) {
            uiState.registrationStatus
        } else {
            "${uiState.registrationStatus} (SDK initializing)"
        }
    }

    private fun formatConnectionWornCardValue(uiState: BridgeUiState): String {
        val conn = if (uiState.connected) "Connected" else "Disconnected"
        val worn = when {
            !uiState.connected -> "Not worn"
            uiState.worn -> "Worn"
            else -> "Doffed"
        }
        return "$conn / $worn"
    }

    private fun formatStreamCardValue(uiState: BridgeUiState): String {
        return if (uiState.streaming) {
            "Streaming (${uiState.streamStatus})"
        } else {
            uiState.streamStatus
        }
    }

    private fun formatHttpCardValue(code: Int): String {
        return when {
            code == 204 -> "204 OK"
            code > 0 -> "$code"
            else -> "None"
        }
    }

    private data class SimulatedDevice(
        val id: String,
        val name: String,
        val connected: Boolean,
        val donState: String?,
        val compatible: Boolean = true,
        val compatibility: String = if (compatible) "COMPATIBLE" else "INCOMPATIBLE",
        val batteryLevel: Int? = null,
        val thermalLevel: String? = "NONE",
    )

    private class BridgeStateMachine {
        var uiState: BridgeUiState = BridgeUiState()
            private set

        val publishedDeviceStates = mutableListOf<BridgeDeviceState>()

        private var sdkError: String? = null
        private var metricError: String? = null
        private var lastPostedDeviceState: BridgeDeviceState? = null
        private var registrationRaw: String = "AVAILABLE"
        private var hasActiveSession: Boolean = false
        private var sessionHasLeftIdle: Boolean = false
        private var hasActiveCamera: Boolean = false
        private var streamHasBeenActive: Boolean = false

        fun onInitializeOutcome(alreadyInitialized: Boolean) {
            clearSdkError()
            if (alreadyInitialized || !uiState.sdkReady) {
                uiState = uiState.copy(sdkReady = true)
            }
        }

        fun onInitializeFailure(message: String) {
            uiState = uiState.copy(sdkReady = false)
            setSdkError(message)
        }

        fun updateEndpoint(serverUrl: String, sessionCode: String) {
            val cleanServer = serverUrl.trim().trimEnd('/')
            val cleanSession = sessionCode.trim()
            lastPostedDeviceState = null
            uiState = uiState.copy(
                serverUrl = cleanServer,
                sessionCode = cleanSession,
            )
            publishDeviceState(force = true)
        }

        fun onRegistrationState(rawState: String) {
            registrationRaw = rawState
            val label = when (rawState) {
                "REGISTERED" -> "Registered"
                "REGISTERING" -> "Registering"
                "UNREGISTERING" -> "Unregistering"
                "AVAILABLE" -> "Unregistered"
                "UNAVAILABLE" -> "Unavailable"
                else -> "Unregistered"
            }
            uiState = uiState.copy(registrationStatus = label)
            if (rawState == "AVAILABLE" || rawState == "UNAVAILABLE") {
                if (hasActiveSession || hasActiveCamera) {
                    disconnect()
                }
            } else {
                publishDeviceState(force = false)
            }
        }

        fun onDevicesMetadata(devices: List<SimulatedDevice>) {
            for (device in devices) {
                when (device.compatibility) {
                    "DEVICE_UPDATE_REQUIRED" -> {
                        val label = device.name.ifBlank { "Meta AI Glasses" }
                        setSdkError("Firmware update required for $label")
                    }
                    "SDK_UPDATE_REQUIRED" -> {
                        setSdkError("SDK update required for connected glasses")
                    }
                }
            }

            val chosen = devices.minByOrNull(::rankDevice)
            val connected = chosen?.connected == true
            val worn = when (chosen?.donState) {
                "DONNED" -> connected
                "DOFFED" -> false
                "UNKNOWN" -> connected
                null -> false
                else -> false
            }
            val battery = chosen?.batteryLevel?.takeIf { it in 1..100 }
            val thermal = mapThermalLabel(chosen?.thermalLevel)
            val name = chosen?.let { it.name.ifBlank { "Meta AI Glasses" } }

            uiState = uiState.copy(
                deviceName = name,
                connected = connected,
                worn = worn,
                batteryPercent = battery,
                thermalStatus = thermal,
            )
            publishDeviceState(force = false)
        }

        fun requestStartStreaming() {
            if (!uiState.sdkReady) return
            if (registrationRaw != "REGISTERED") {
                uiState = uiState.copy(streamStatus = "Unregistered")
                setSdkError("Connect glasses in Meta AI before starting camera stream")
                return
            }
            if (hasActiveCamera || uiState.streaming) return
            clearSdkError()
            uiState = uiState.copy(streamStatus = "Starting")
        }

        fun onCameraPermissionCheckFailed(description: String) {
            setSdkError(description)
            uiState = uiState.copy(streaming = false, streamStatus = "Permission required")
            publishDeviceState(force = true)
        }

        fun onCameraPermissionMissingWithoutActivity() {
            setSdkError("Approve camera permission in Meta AI, then tap Start Streaming")
            uiState = uiState.copy(streaming = false, streamStatus = "Permission required")
            publishDeviceState(force = true)
        }

        fun onRequestingCameraPermission() {
            uiState = uiState.copy(streamStatus = "Requesting permission")
        }

        fun onCameraPermissionResult(granted: Boolean) {
            if (!granted) {
                if (sdkError == null) {
                    setSdkError("Camera permission denied in Meta AI app")
                }
                uiState = uiState.copy(streaming = false, streamStatus = "Permission required")
                publishDeviceState(force = true)
            }
        }

        fun onSessionConnecting() {
            sessionHasLeftIdle = false
            uiState = uiState.copy(streamStatus = "Connecting session")
        }

        fun onSessionStartFailed() {
            if (sdkError == null) {
                setSdkError("Glasses session did not start; verify glasses are unfolded and connected")
            }
            hasActiveSession = false
            sessionHasLeftIdle = false
            uiState = uiState.copy(streaming = false, streamStatus = "Session failed")
            publishDeviceState(force = true)
        }

        fun onCameraOpening() {
            hasActiveSession = true
            sessionHasLeftIdle = true
            hasActiveCamera = true
            streamHasBeenActive = false
            uiState = uiState.copy(streamStatus = "Opening camera")
        }

        fun onCameraAttachFailed(description: String) {
            hasActiveCamera = false
            setSdkError(description)
            uiState = uiState.copy(streaming = false, streamStatus = "Error")
            publishDeviceState(force = true)
        }

        fun onCameraStreamStartFailed(description: String) {
            setSdkError(description)
            teardownStream("Error")
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

        fun onStreamError(description: String) {
            setSdkError(description)
        }

        fun onIngestMetrics(metrics: IngestMetrics) {
            metricError = metrics.lastError
            uiState = uiState.copy(
                framesSent = metrics.framesSent,
                framesDropped = metrics.framesDropped,
                lastHttpCode = metrics.lastHttpCode,
                lastError = metrics.lastError ?: sdkError,
            )
        }

        fun stopStreaming() {
            teardownStream("Idle")
        }

        fun disconnect() {
            teardownStream("Idle")
            hasActiveSession = false
            sessionHasLeftIdle = false
            uiState = uiState.copy(streaming = false, streamStatus = "Idle")
            publishDeviceState(force = true)
        }

        fun clearSdkError() {
            sdkError = null
            uiState = uiState.copy(lastError = metricError)
        }

        private fun setSdkError(message: String) {
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
            publishedDeviceStates.add(next)
        }

        private fun rankDevice(device: SimulatedDevice): Int {
            return when {
                device.connected && device.donState == "DONNED" -> 0
                device.connected -> 1
                device.compatibility == "COMPATIBLE" -> 2
                else -> 3
            }
        }
    }

    private data class SimulatedIntent(
        var dataUri: String?,
    )

    private class DeepLinkCoordinator(
        private val ingestClient: IngestClient,
    ) {
        var uiState: BridgeUiState = BridgeUiState()
            private set

        var savedEndpoint: SavedBridgeEndpoint = SavedBridgeEndpoint()
            private set

        fun forgetSavedServer() {
            savedEndpoint = SavedBridgeEndpoint()
            ingestClient.configure("", "")
            uiState = uiState.copy(serverUrl = "", sessionCode = "")
        }

        fun handleDeepLink(incomingIntent: SimulatedIntent?): Boolean {
            val rawData = incomingIntent?.dataUri?.takeIf { it.isNotEmpty() } ?: return false
            val parsedUri = runCatching { URI(rawData) }.getOrNull() ?: return false
            if (parsedUri.isOpaque) return false
            if (!DEEP_LINK_SCHEME.equals(parsedUri.scheme, ignoreCase = true)) return false
            if (!DEEP_LINK_HOST.equals(parsedUri.host, ignoreCase = true)) return false
            val path = parsedUri.rawPath
            if (!path.isNullOrEmpty() && path != "/") return false

            val queryParams = decodeFirstQueryParameters(parsedUri.rawQuery) ?: return false
            val rawServer = queryParams["server"]?.trim()
            val resolvedServer = if (!rawServer.isNullOrEmpty()) {
                val cleanServer = BridgePreferences.sanitizeServerUrl(rawServer)
                if (cleanServer.isEmpty()) return false
                cleanServer
            } else {
                BridgePreferences.sanitizeServerUrl(uiState.serverUrl)
            }

            val rawSession = queryParams["session"]?.trim()
            val resolvedSession = when {
                rawSession == null -> {
                    if (!rawServer.isNullOrEmpty()) {
                        ""
                    } else {
                        BridgePreferences.sanitizeSessionCode(uiState.sessionCode)
                    }
                }
                rawSession.isEmpty() -> ""
                else -> {
                    val cleanSession = BridgePreferences.sanitizeSessionCode(rawSession)
                    if (cleanSession.isEmpty()) return false
                    cleanSession
                }
            }

            if (resolvedServer.isEmpty() && resolvedSession.isEmpty()) return false
            savedEndpoint = SavedBridgeEndpoint(
                serverUrl = BridgePreferences.sanitizeServerUrl(resolvedServer),
                sessionCode = BridgePreferences.sanitizeSessionCode(resolvedSession),
            )
            ingestClient.configure(savedEndpoint.serverUrl, savedEndpoint.sessionCode)
            uiState = uiState.copy(
                serverUrl = savedEndpoint.serverUrl,
                sessionCode = savedEndpoint.sessionCode,
            )
            incomingIntent.dataUri = null
            return true
        }

        private fun decodeFirstQueryParameters(rawQuery: String?): Map<String, String>? {
            if (rawQuery.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (segment in rawQuery.split('&')) {
                if (segment.isEmpty()) continue
                val eqIdx = segment.indexOf('=')
                val rawKey = if (eqIdx >= 0) segment.substring(0, eqIdx) else segment
                val rawVal = if (eqIdx >= 0) segment.substring(eqIdx + 1) else ""
                val key = runCatching {
                    URLDecoder.decode(rawKey, StandardCharsets.UTF_8.name())
                }.getOrNull() ?: return null
                val value = runCatching {
                    URLDecoder.decode(rawVal, StandardCharsets.UTF_8.name())
                }.getOrNull() ?: return null
                if (!out.containsKey(key)) {
                    out[key] = value
                }
            }
            return out
        }
    }

    private companion object {
        const val DEEP_LINK_SCHEME = "holdupbridge"
        const val DEEP_LINK_HOST = "connect"

        fun mapThermalLabel(level: String?): String {
            return when (level) {
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
    }
}
