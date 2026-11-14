package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import java.io.File
import java.net.URI
import java.net.URLDecoder
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node

class TunnelAuthAndParityTest {

  private fun resolveResDir(dir: File = File(System.getProperty("user.dir") ?: ".")): File =
      listOf("src/main/res", "app/src/main/res", "android-dat/app/src/main/res")
          .map { File(dir, it) }
          .firstOrNull { File(it, "values/strings.xml").isFile }
          ?: error("res directory not found from ${dir.absolutePath}")

  private fun parseXml(file: File): Document =
      DocumentBuilderFactory.newInstance()
          .apply {
            isNamespaceAware = true
            isIgnoringComments = false
          }
          .newDocumentBuilder()
          .parse(file)

  private fun readStringsMap(file: File): Map<String, String> {
    assertTrue("Missing strings resource file: ${file.path}", file.isFile)
    val root = parseXml(file).documentElement
    assertEquals("resources", root.tagName)
    val nodes = root.childNodes
    val result = LinkedHashMap<String, String>()
    for (i in 0 until nodes.length) {
      val node = nodes.item(i)
      if (node.nodeType == Node.ELEMENT_NODE && node is Element && node.tagName == "string") {
        val name = node.getAttribute("name")
        val value = node.textContent
        assertTrue("Blank string name in ${file.path}", name.isNotBlank())
        assertTrue("Blank string value for $name in ${file.path}", value.isNotBlank())
        assertEquals("Untrimmed string value for $name in ${file.path}", value.trim(), value)
        assertFalse("Duplicate string key $name in ${file.path}", result.containsKey(name))
        result[name] = value
      }
    }
    return result
  }

  private fun formatPlaceholders(text: String): List<String> =
      Regex("%(\\d+\\x24)?[-#+ 0,]*\\d*(\\.\\d+)?[a-zA-Z]")
          .findAll(text)
          .map { it.value }
          .toList()

  @Test
  fun endpointPreservesTunnelAccessKeyAcrossTrailingSlashesSpecialCharsAndMultipleQueryParams() {
    assertEquals(
        "https://x.trycloudflare.com/ingest/frame?key=hk_2026-AbC.9~z",
        Uploader.endpoint("https://x.trycloudflare.com/?key=hk_2026-AbC.9~z", "/ingest/frame", ""),
    )
    assertEquals(
        "https://x.trycloudflare.com/ingest/state?key=hk_2026-AbC.9~z&session=sess-01",
        Uploader.endpoint(
            "  x.trycloudflare.com///?key=hk_2026-AbC.9~z  ",
            "/ingest/state",
            "  sess-01  ",
        ),
    )
    assertEquals(
        "http://127.0.0.1:8787/ingest/frame?key=local_k1",
        Uploader.endpoint("http://127.0.0.1:8787//?key=local_k1", "/ingest/frame", " \t\n "),
    )
    assertEquals(
        "https://x.trycloudflare.com/ingest/state?key=K9&edge=hel1&trace=1&session=s42",
        Uploader.endpoint(
            "https://x.trycloudflare.com/?key=K9&&edge=hel1&trace=1&",
            "/ingest/state",
            "s42",
        ),
    )
    assertEquals(
        "https://x.trycloudflare.com/ingest/state?key=K9&edge=hel1",
        Uploader.endpoint("https://x.trycloudflare.com/?key=K9&&edge=hel1&", "/ingest/state", ""),
    )

    val specialUrl =
        Uploader.endpoint(
            "https://x.trycloudflare.com/?key=tok%2B1%2F2%3D",
            "/ingest/frame",
            "room 7/a&key=evil?x=1#f",
        )
    assertEquals(
        "https://x.trycloudflare.com/ingest/frame?key=tok%2B1%2F2%3D&session=room+7%2Fa%26key%3Devil%3Fx%3D1%23f",
        specialUrl,
    )
    val parsed = URI(specialUrl)
    assertEquals("https", parsed.scheme)
    assertEquals("x.trycloudflare.com", parsed.host)
    assertEquals("/ingest/frame", parsed.path)
    assertNull(parsed.fragment)
    val queryParts = checkNotNull(parsed.rawQuery).split('&')
    assertEquals(2, queryParts.size)
    assertEquals("tok+1/2=", URLDecoder.decode(queryParts[0].removePrefix("key="), "UTF-8"))
    assertEquals(
        "room 7/a&key=evil?x=1#f",
        URLDecoder.decode(queryParts[1].removePrefix("session="), "UTF-8"),
    )
  }

  @Test
  fun resolveTargetPreservesTunnelAccessKeyInServerUrlAndFeedsUploaderEndpoint() {
    assertNull(UiState(serverUrl = "", sessionCode = "S1").resolveTarget())
    assertNull(UiState(serverUrl = "   ///  ", sessionCode = "S1").resolveTarget())

    val tunnelUi =
        UiState(
            serverUrl = "  x.trycloudflare.com/?key=HOLDUP_SECRET_99  ",
            sessionCode = "  HUP-4  ",
        )
    val (tunnelServer, tunnelSession) = checkNotNull(tunnelUi.resolveTarget())
    assertEquals("https://x.trycloudflare.com/?key=HOLDUP_SECRET_99", tunnelServer)
    assertEquals("HUP-4", tunnelSession)
    assertEquals(
        "https://x.trycloudflare.com/ingest/frame?key=HOLDUP_SECRET_99&session=HUP-4",
        Uploader.endpoint(tunnelServer, "/ingest/frame", tunnelSession),
    )
    assertEquals(
        "https://x.trycloudflare.com/ingest/state?key=HOLDUP_SECRET_99&session=HUP-4",
        Uploader.endpoint(tunnelServer, "/ingest/state", tunnelSession),
    )

    val multiParamUi =
        UiState(
            serverUrl = "https://x.trycloudflare.com/?key=K_77&mode=booth",
            sessionCode = "   ",
        )
    val (multiServer, multiSession) = checkNotNull(multiParamUi.resolveTarget())
    assertEquals("https://x.trycloudflare.com/?key=K_77&mode=booth", multiServer)
    assertEquals("", multiSession)
    assertEquals(
        "https://x.trycloudflare.com/ingest/frame?key=K_77&mode=booth",
        Uploader.endpoint(multiServer, "/ingest/frame", multiSession),
    )
  }

  @Test
  fun glassesStateToJsonPreservesNullableWornAndBatteryWithoutFalseOrZeroCoercion() {
    val unknown = GlassesState(connected = true, worn = null, battery = null, streaming = true)
    val doffed = GlassesState(connected = true, worn = false, battery = null, streaming = false)
    val donned = GlassesState(connected = true, worn = true, battery = 84, streaming = true)

    assertEquals(
        "{\"connected\":true,\"worn\":null,\"battery\":null,\"streaming\":true}",
        unknown.toJson(),
    )
    assertEquals(
        "{\"connected\":true,\"worn\":false,\"battery\":null,\"streaming\":false}",
        doffed.toJson(),
    )
    assertEquals(
        "{\"connected\":true,\"worn\":true,\"battery\":84,\"streaming\":true}",
        donned.toJson(),
    )
    assertNotEquals(unknown.toJson(), doffed.toJson())
    assertFalse(unknown.toJson().contains("\"null\""))

    val uiWithUnknownSensors =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.UNKNOWN,
            battery = BridgeViewModel.normalizeBatteryLevel(0),
            streamState = StreamState.STREAMING,
        )
    assertNull(uiWithUnknownSensors.battery)
    assertNull(uiWithUnknownSensors.toGlassesState().worn)
    assertEquals(
        "{\"connected\":true,\"worn\":null,\"battery\":null,\"streaming\":true}",
        uiWithUnknownSensors.toGlassesState().toJson(),
    )
  }

  @Test
  fun frameIntervalMsFollowsExponentialBackoffAcrossZeroThroughTenAndCapsAtEightSeconds() {
    assertEquals(1_000L, BridgeViewModel.frameIntervalMs(-5))
    assertEquals(1_000L, BridgeViewModel.frameIntervalMs(-1))

    val expectedZeroToTen =
        listOf(
            1_000L,
            2_000L,
            4_000L,
            8_000L,
            8_000L,
            8_000L,
            8_000L,
            8_000L,
            8_000L,
            8_000L,
            8_000L,
        )
    assertEquals(expectedZeroToTen, (0..10).map { BridgeViewModel.frameIntervalMs(it) })

    assertEquals(
        listOf(2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L),
        (0..5).map { BridgeViewModel.reconnectDelayMs(it) },
    )
    assertEquals(
        listOf(1_500L, 3_000L, 6_000L, 10_000L, 10_000L, 10_000L),
        (0..5).map { BridgeViewModel.streamRetryDelayMs(it) },
    )
    assertNull(BridgeViewModel.normalizeBatteryLevel(0))
    assertNull(BridgeViewModel.normalizeBatteryLevel(-1))
    assertEquals(73, BridgeViewModel.normalizeBatteryLevel(73))
  }

  @Test
  fun englishFinnishAndSwedishStringsMaintainKeyAndPlaceholderParity() {
    val resDir = resolveResDir()
    val en = readStringsMap(File(resDir, "values/strings.xml"))
    val fi = readStringsMap(File(resDir, "values-fi/strings.xml"))
    val sv = readStringsMap(File(resDir, "values-sv/strings.xml"))

    assertEquals(en.keys, fi.keys)
    assertEquals(en.keys, sv.keys)
    assertEquals("HoldUp Bridge", en["app_name"])
    assertEquals("HoldUp Bridge", fi["app_name"])
    assertEquals("HoldUp Bridge", sv["app_name"])

    for ((key, enVal) in en) {
      val fiVal = checkNotNull(fi[key])
      val svVal = checkNotNull(sv[key])
      assertEquals(formatPlaceholders(enVal), formatPlaceholders(fiVal))
      assertEquals(formatPlaceholders(enVal), formatPlaceholders(svVal))
      assertFalse(enVal.contains('\u2014'))
      assertFalse(fiVal.contains('\u2014'))
      assertFalse(svVal.contains('\u2014'))
      if (key != "app_name") {
        assertNotEquals(enVal, fiVal)
        assertNotEquals(enVal, svVal)
        assertNotEquals(fiVal, svVal)
      }
    }
  }
}
