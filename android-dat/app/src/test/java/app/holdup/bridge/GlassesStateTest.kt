package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GlassesStateTest {

  private fun parseFlatJsonObject(json: String): List<Pair<String, String>> {
    assertTrue(json.startsWith("{") && json.endsWith("}"))
    val body = json.substring(1, json.length - 1)
    if (body.isEmpty()) return emptyList()
    return body.split(",").map { entry ->
      val colon = entry.indexOf(':')
      assertTrue(colon > 1)
      val rawKey = entry.substring(0, colon)
      assertTrue(rawKey.startsWith("\"") && rawKey.endsWith("\""))
      val key = rawKey.substring(1, rawKey.length - 1)
      val value = entry.substring(colon + 1)
      key to value
    }
  }

  @Test
  fun toJsonSerializesAllPopulatedFieldsWithExactContractOrder() {
    val active = GlassesState(connected = true, worn = true, battery = 84, streaming = true)
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":84,\"streaming\":true}",
        active.toJson(),
    )

    val idleDoffed = GlassesState(connected = true, worn = false, battery = 15, streaming = false)
    assertEquals(
        "{\"connected\":true,\"worn\":false,\"battery\":15,\"streaming\":false}",
        idleDoffed.toJson(),
    )
  }

  @Test
  fun toJsonPreservesNullWornAndNullBatteryWithoutQuotingNullLiterals() {
    val disconnected =
        GlassesState(connected = false, worn = null, battery = null, streaming = false)
    val json = disconnected.toJson()
    assertEquals(
        "{\"connected\":false,\"worn\":null,\"battery\":null,\"streaming\":false}",
        json,
    )
    assertFalse(json.contains("\"null\""))

    val unknownWornKnownBattery =
        GlassesState(connected = true, worn = null, battery = 62, streaming = false)
    assertEquals(
        "{\"connected\":true,\"worn\":null,\"battery\":62,\"streaming\":false}",
        unknownWornKnownBattery.toJson(),
    )

    val knownWornUnknownBattery =
        GlassesState(connected = true, worn = true, battery = null, streaming = true)
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":null,\"streaming\":true}",
        knownWornUnknownBattery.toJson(),
    )
  }

  @Test
  fun toJsonExhaustivelyCoversBooleanAndNullablePermutationsWithinIngestLimit() {
    val booleans = listOf(false, true)
    val wornValues = listOf(null, false, true)
    val batteryValues = listOf(null, 1, 50, 100)

    for (connected in booleans) {
      for (worn in wornValues) {
        for (battery in batteryValues) {
          for (streaming in booleans) {
            val state =
                GlassesState(
                    connected = connected,
                    worn = worn,
                    battery = battery,
                    streaming = streaming,
                )
            val json = state.toJson()
            val bytes = json.toByteArray(Charsets.UTF_8)
            assertTrue(bytes.isNotEmpty() && bytes.size < 128)
            val entries = parseFlatJsonObject(json)
            assertEquals(
                listOf("connected", "worn", "battery", "streaming"),
                entries.map { it.first },
            )
            val map = entries.toMap()
            assertEquals(connected.toString(), map["connected"])
            assertEquals(worn?.toString() ?: "null", map["worn"])
            assertEquals(battery?.toString() ?: "null", map["battery"])
            assertEquals(streaming.toString(), map["streaming"])
          }
        }
      }
    }
  }

  @Test
  fun dataClassEqualityDistinguishesUnknownWornFromDoffedForPushDeduplication() {
    val unknownWorn = GlassesState(connected = true, worn = null, battery = 50, streaming = false)
    val doffed = GlassesState(connected = true, worn = false, battery = 50, streaming = false)
    val donned = GlassesState(connected = true, worn = true, battery = 50, streaming = false)
    val unknownBattery =
        GlassesState(connected = true, worn = true, battery = null, streaming = false)

    assertNotEquals(unknownWorn, doffed)
    assertNotEquals(doffed, donned)
    assertNotEquals(unknownWorn, donned)
    assertNotEquals(donned, unknownBattery)
    assertEquals(unknownWorn, unknownWorn.copy())
    assertEquals(unknownWorn.hashCode(), unknownWorn.copy().hashCode())
  }

  @Test
  fun uiStateToGlassesStateSerializesExpectedIngestPayloadsAcrossLifecycle() {
    assertEquals(
        "{\"connected\":false,\"worn\":null,\"battery\":null,\"streaming\":false}",
        UiState().toGlassesState().toJson(),
    )

    val zeroBatteryConnected =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.DONNED,
            battery = BridgeViewModel.normalizeBatteryLevel(0),
            streamState = StreamState.STREAMING,
        )
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":null,\"streaming\":true}",
        zeroBatteryConnected.toGlassesState().toJson(),
    )

    val pausedLowBatteryDoffed =
        UiState(
            deviceName = "Glasses",
            linkState = LinkState.CONNECTED,
            donState = DonState.DOFFED,
            battery = BridgeViewModel.normalizeBatteryLevel(12),
            streamState = StreamState.PAUSED,
        )
    assertEquals(
        "{\"connected\":true,\"worn\":false,\"battery\":12,\"streaming\":false}",
        pausedLowBatteryDoffed.toGlassesState().toJson(),
    )
  }
}
