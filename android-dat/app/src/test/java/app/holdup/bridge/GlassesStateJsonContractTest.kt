package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassesStateJsonContractTest {

  private fun parseFlatJsonObject(json: String): LinkedHashMap<String, Any?> {
    assertTrue(json.startsWith("{") && json.endsWith("}"))
    val body = json.substring(1, json.length - 1)
    val result = LinkedHashMap<String, Any?>()
    if (body.isEmpty()) return result
    for (entry in body.split(",")) {
      val colon = entry.indexOf(':')
      assertTrue(colon > 1)
      val rawKey = entry.substring(0, colon)
      assertTrue(rawKey.startsWith("\"") && rawKey.endsWith("\"") && rawKey.length >= 3)
      val key = rawKey.substring(1, rawKey.length - 1)
      assertFalse(result.containsKey(key))
      val rawVal = entry.substring(colon + 1)
      val parsed: Any? =
          when {
            rawVal == "true" -> true
            rawVal == "false" -> false
            rawVal == "null" -> null
            rawVal.matches(Regex("0|-?[1-9][0-9]*")) -> rawVal.toInt()
            else -> throw AssertionError("Unexpected JSON token for $key: $rawVal")
          }
      result[key] = parsed
    }
    return result
  }

  @Test
  fun serializesDisconnectedUnknownDefaultsWithExplicitNulls() {
    val state = GlassesState(connected = false, worn = null, battery = null, streaming = false)
    assertEquals(
        "{\"connected\":false,\"worn\":null,\"battery\":null,\"streaming\":false}",
        state.toJson(),
    )
  }

  @Test
  fun serializesConnectedWornStreamingWithBatteryPercentage() {
    val state = GlassesState(connected = true, worn = true, battery = 85, streaming = true)
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":85,\"streaming\":true}",
        state.toJson(),
    )
  }

  @Test
  fun serializesDoffedAndIdleStateDistinctFromUnknownWorn() {
    val unknownWorn = GlassesState(connected = true, worn = null, battery = 42, streaming = false)
    val doffed = GlassesState(connected = true, worn = false, battery = 42, streaming = false)
    val donned = GlassesState(connected = true, worn = true, battery = 42, streaming = false)

    assertEquals(
        "{\"connected\":true,\"worn\":null,\"battery\":42,\"streaming\":false}",
        unknownWorn.toJson(),
    )
    assertEquals(
        "{\"connected\":true,\"worn\":false,\"battery\":42,\"streaming\":false}",
        doffed.toJson(),
    )
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":42,\"streaming\":false}",
        donned.toJson(),
    )
    assertNotEquals(unknownWorn.toJson(), doffed.toJson())
    assertNotEquals(unknownWorn.toJson(), donned.toJson())
    assertNotEquals(doffed.toJson(), donned.toJson())

    assertNull(parseFlatJsonObject(unknownWorn.toJson())["worn"])
    assertEquals(false, parseFlatJsonObject(doffed.toJson())["worn"])
    assertEquals(true, parseFlatJsonObject(donned.toJson())["worn"])
  }

  @Test
  fun neverQuotesPrimitivesOrNullTokensInWirePayload() {
    val withNulls = GlassesState(connected = true, worn = null, battery = null, streaming = false).toJson()
    val withValues = GlassesState(connected = false, worn = true, battery = 19, streaming = true).toJson()

    for (json in listOf(withNulls, withValues)) {
      assertFalse(json.contains("\"true\""))
      assertFalse(json.contains("\"false\""))
      assertFalse(json.contains("\"null\""))
      assertFalse(json.contains("\"19\""))
      assertTrue(json.none { it.isWhitespace() })
    }
  }

  @Test
  fun preservesExactFieldOrderSchemaAndUtf8SizeAcrossAllStateCombinations() {
    val booleans = listOf(false, true)
    val wornStates = listOf(null, false, true)
    val batteries = listOf(null, 0, 1, 15, 73, 100)

    for (connected in booleans) {
      for (worn in wornStates) {
        for (battery in batteries) {
          for (streaming in booleans) {
            val state =
                GlassesState(
                    connected = connected,
                    worn = worn,
                    battery = battery,
                    streaming = streaming,
                )
            val json = state.toJson()
            val utf8 = json.toByteArray(Charsets.UTF_8)
            assertTrue(utf8.size in 45..96)

            val fields = parseFlatJsonObject(json)
            assertEquals(
                listOf("connected", "worn", "battery", "streaming"),
                fields.keys.toList(),
            )
            assertFalse(fields.containsKey("source"))

            val roundTripped =
                GlassesState(
                    connected = fields["connected"] as Boolean,
                    worn = fields["worn"] as Boolean?,
                    battery = fields["battery"] as Int?,
                    streaming = fields["streaming"] as Boolean,
                )
            assertEquals(state, roundTripped)
          }
        }
      }
    }
  }

  @Test
  fun handlesBoundaryIntegerBatteryValuesAsValidJsonNumbers() {
    val boundaries = listOf(0, 1, 99, 100, -1, Int.MIN_VALUE, Int.MAX_VALUE)
    for (level in boundaries) {
      val json =
          GlassesState(connected = true, worn = true, battery = level, streaming = false).toJson()
      val fields = parseFlatJsonObject(json)
      assertEquals(level, fields["battery"])
    }
  }

  @Test
  fun dataClassEqualityCopyAndDestructuringSupportDeduplication() {
    val a = GlassesState(connected = true, worn = null, battery = 50, streaming = false)
    val b = GlassesState(connected = true, worn = null, battery = 50, streaming = false)
    assertEquals(a, b)
    assertEquals(a.hashCode(), b.hashCode())
    assertEquals(a.toJson(), b.toJson())

    val mutations =
        listOf(
            a.copy(connected = false),
            a.copy(worn = false),
            a.copy(worn = true),
            a.copy(battery = null),
            a.copy(battery = 51),
            a.copy(streaming = true),
        )
    for (mutated in mutations) {
      assertNotEquals(a, mutated)
      assertNotEquals(a.toJson(), mutated.toJson())
    }

    val (connected, worn, battery, streaming) = a
    assertTrue(connected)
    assertNull(worn)
    assertEquals(50, battery)
    assertFalse(streaming)
  }

  @Test
  fun uiStateToGlassesStateProducesValidJsonEvenWithSpecialDeviceNames() {
    assertEquals(
        "{\"connected\":false,\"worn\":null,\"battery\":null,\"streaming\":false}",
        UiState().toGlassesState().toJson(),
    )

    val active =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.DONNED,
            battery = BridgeViewModel.normalizeBatteryLevel(64),
            streamState = StreamState.STREAMING,
        )
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":64,\"streaming\":true}",
        active.toGlassesState().toJson(),
    )

    val doffedUnknownBattery =
        active.copy(
            donState = DonState.DOFFED,
            battery = BridgeViewModel.normalizeBatteryLevel(0),
            streamState = StreamState.PAUSED,
        )
    assertEquals(
        "{\"connected\":true,\"worn\":false,\"battery\":null,\"streaming\":false}",
        doffedUnknownBattery.toGlassesState().toJson(),
    )

    val trickyDeviceName =
        UiState(
            deviceName = "Ray-Ban \"Meta\" \\ \n\t Glasses",
            linkState = LinkState.CONNECTED,
            donState = DonState.UNKNOWN,
            battery = null,
            streamState = StreamState.STOPPED,
        )
    val trickyJson = trickyDeviceName.toGlassesState().toJson()
    assertEquals(
        "{\"connected\":true,\"worn\":null,\"battery\":null,\"streaming\":false}",
        trickyJson,
    )
    assertEquals(true, parseFlatJsonObject(trickyJson)["connected"])
  }
}
