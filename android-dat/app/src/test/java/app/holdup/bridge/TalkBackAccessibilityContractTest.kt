package app.holdup.bridge

import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.ThermalLevel
import java.io.File
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

class TalkBackAccessibilityContractTest {

  private fun resolveMainDir(dir: File = File(System.getProperty("user.dir") ?: ".")): File =
      listOf("src/main", "app/src/main", "android-dat/app/src/main")
          .map { File(dir, it) }
          .firstOrNull { File(it, "res/values/strings.xml").isFile }
          ?: error("main directory not found from ${dir.absolutePath}")

  private fun parseXml(file: File): Document =
      DocumentBuilderFactory.newInstance()
          .apply {
            isNamespaceAware = true
            isIgnoringComments = false
          }
          .newDocumentBuilder()
          .parse(file)

  private fun hasXmlComment(node: Node): Boolean {
    if (node.nodeType == Node.COMMENT_NODE) return true
    val children = node.childNodes
    for (i in 0 until children.length) {
      if (hasXmlComment(children.item(i))) return true
    }
    return false
  }

  private fun readStringsMap(file: File): Map<String, String> {
    assertTrue("Missing strings file: ${file.path}", file.isFile)
    val doc = parseXml(file)
    assertFalse("XML comments forbidden in ${file.path}", hasXmlComment(doc))
    val root = doc.documentElement
    assertEquals("resources", root.tagName)
    val nodes = root.childNodes
    val out = LinkedHashMap<String, String>()
    for (i in 0 until nodes.length) {
      val node = nodes.item(i)
      if (node.nodeType == Node.ELEMENT_NODE && node is Element && node.tagName == "string") {
        val key = node.getAttribute("name")
        val value = node.textContent
        assertTrue("Blank string key in ${file.path}", key.isNotBlank())
        assertTrue("Blank string value for $key in ${file.path}", value.isNotBlank())
        assertEquals("Untrimmed string value for $key in ${file.path}", value.trim(), value)
        assertFalse("Duplicate string key $key in ${file.path}", out.containsKey(key))
        out[key] = value
      }
    }
    return out
  }

  private fun formatPlaceholders(text: String): List<String> =
      Regex("%(\\d+\\x24)?[-#+ 0,]*\\d*(\\.\\d+)?[a-zA-Z]")
          .findAll(text)
          .map { it.value }
          .toList()

  private fun assertNoRawTelemetryPunctuation(spoken: String) {
    assertFalse("Unexpected en dash in spoken text: $spoken", spoken.contains('\u2013'))
    assertFalse("Unexpected em dash in spoken text: $spoken", spoken.contains('\u2014'))
    assertFalse("Unexpected middle dot in spoken text: $spoken", spoken.contains('\u00b7'))
    assertFalse("Unexpected question mark in spoken text: $spoken", spoken.contains('?'))
  }

  private fun assertBalancedKotlinDelimiters(name: String, source: String) {
    val stack = ArrayDeque<Char>()
    var i = 0
    val slash = '/'
    val star = '*'
    while (i < source.length) {
      val ch = source[i]
      val next = if (i + 1 < source.length) source[i + 1] else '\u0000'
      if (ch == slash && next == slash) {
        while (i < source.length && source[i] != '\n') i += 1
        continue
      }
      if (ch == slash && next == star) {
        i += 2
        while (i + 1 < source.length && !(source[i] == star && source[i + 1] == slash)) i += 1
        i += 2
        continue
      }
      if (ch == '"') {
        i += 1
        while (i < source.length && source[i] != '"') {
          if (source[i] == '\\') i += 2 else i += 1
        }
        i += 1
        continue
      }
      if (ch == '\'') {
        i += 1
        while (i < source.length && source[i] != '\'') {
          if (source[i] == '\\') i += 2 else i += 1
        }
        i += 1
        continue
      }
      when (ch) {
        '{', '(', '[' -> stack.addLast(ch)
        '}', ')', ']' -> {
          assertFalse("Unmatched closing '$ch' in $name", stack.isEmpty())
          val open = stack.removeLast()
          val expected =
              when (open) {
                '{' -> '}'
                '(' -> ')'
                else -> ']'
              }
          assertEquals("Mismatched delimiter in $name", expected, ch)
        }
      }
      i += 1
    }
    assertTrue("Unclosed delimiters in $name: $stack", stack.isEmpty())
  }

  @Test
  fun talkBackGlassesSummaryCoversColdStartConnectedUnknownDoffedChargingAndThermal() {
    val cold = UiState()
    assertEquals("No glasses found", cold.talkBackGlassesSummary())
    assertNoRawTelemetryPunctuation(cold.talkBackGlassesSummary())

    val connectedWornCharging =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.DONNED,
            battery = 84,
            charging = true,
        )
    assertEquals(
        "Ray-Ban Meta, connected, worn, battery 84 percent, charging",
        connectedWornCharging.talkBackGlassesSummary(),
    )
    assertNoRawTelemetryPunctuation(connectedWornCharging.talkBackGlassesSummary())

    val unknownSensors =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.UNKNOWN,
            battery = BridgeViewModel.normalizeBatteryLevel(0),
            charging = false,
        )
    assertNull(unknownSensors.toGlassesState().worn)
    assertNull(unknownSensors.battery)
    assertEquals(
        "Ray-Ban Meta, connected, wear state unknown, battery level unknown",
        unknownSensors.talkBackGlassesSummary(),
    )
    assertNoRawTelemetryPunctuation(unknownSensors.talkBackGlassesSummary())

    val doffed =
        UiState(
            deviceName = "Ray-Ban Meta",
            linkState = LinkState.CONNECTED,
            donState = DonState.DOFFED,
            battery = 42,
            charging = false,
        )
    assertEquals(false, doffed.toGlassesState().worn)
    assertEquals(
        "Ray-Ban Meta, connected, not worn, battery 42 percent",
        doffed.talkBackGlassesSummary(),
    )
    assertNoRawTelemetryPunctuation(doffed.talkBackGlassesSummary())

    val severeThermal =
        doffed.copy(
            donState = DonState.DONNED,
            thermal = ThermalLevel.SEVERE,
        )
    assertEquals(
        "Ray-Ban Meta, connected, worn, battery 42 percent, thermal warning severe",
        severeThermal.talkBackGlassesSummary(),
    )
    assertNoRawTelemetryPunctuation(severeThermal.talkBackGlassesSummary())

    val moderateThermal = severeThermal.copy(thermal = ThermalLevel.MODERATE)
    assertEquals(
        "Ray-Ban Meta, connected, worn, battery 42 percent, thermal moderate",
        moderateThermal.talkBackGlassesSummary(),
    )

    val blankNameUnknownLink =
        UiState(
            deviceName = "   ",
            linkState = null,
            donState = DonState.UNKNOWN,
            battery = null,
            charging = true,
        )
    assertEquals(
        "Glasses, link status unknown, wear state unknown, battery level unknown, charging",
        blankNameUnknownLink.talkBackGlassesSummary(),
    )
    assertNoRawTelemetryPunctuation(blankNameUnknownLink.talkBackGlassesSummary())
  }

  @Test
  fun talkBackStreamSummaryCoversColdStartStreamingFrameLayoutPausedAndNetworkRetry() {
    val cold = UiState()
    assertEquals(
        "Stream stopped, sent 0, dropped 0, no frame upload yet, network idle",
        cold.talkBackStreamSummary(),
    )
    assertNoRawTelemetryPunctuation(cold.talkBackStreamSummary())

    val activeStreaming =
        UiState(
            streamState = StreamState.STREAMING,
            frameSize = "720x1280",
            yuvLayout = "NV12",
            framesSent = 18L,
            framesDropped = 1L,
            lastFrameKb = 46,
            frameHttp = "HTTP 204",
            netOk = true,
        )
    assertEquals(
        "Camera streaming at 1 frame per second, 720x1280 NV12, sent 18, dropped 1, last upload HTTP 204, 46 kilobytes, network ok",
        activeStreaming.talkBackStreamSummary(),
    )
    assertNoRawTelemetryPunctuation(activeStreaming.talkBackStreamSummary())

    val networkRetry =
        UiState(
            streamState = StreamState.STREAMING,
            framesSent = 6L,
            framesDropped = 2L,
            lastFrameKb = 0,
            frameHttp = "network error",
            netOk = false,
        )
    assertEquals(
        "Camera streaming at 1 frame per second, sent 6, dropped 2, last upload network error, network failing, retrying with backoff",
        networkRetry.talkBackStreamSummary(),
    )
    assertNoRawTelemetryPunctuation(networkRetry.talkBackStreamSummary())

    val paused = UiState(streamState = StreamState.PAUSED, framesSent = 3L, frameHttp = "HTTP 204", netOk = true)
    assertTrue(paused.talkBackStreamSummary().startsWith("Stream paused, sent 3,"))
    assertNoRawTelemetryPunctuation(paused.talkBackStreamSummary())

    val starting = UiState(streamState = StreamState.STARTING)
    assertTrue(starting.talkBackStreamSummary().startsWith("Stream starting,"))
    assertNoRawTelemetryPunctuation(starting.talkBackStreamSummary())
  }

  @Test
  fun mainActivityDeclaresHeadingLiveRegionsMergedRowsStateDescriptionsAnd48dpTargets() {
    val mainDir = resolveMainDir()
    val activitySrc = File(mainDir, "java/app/holdup/bridge/MainActivity.kt").readText(Charsets.UTF_8)
    val vmSrc = File(mainDir, "java/app/holdup/bridge/BridgeViewModel.kt").readText(Charsets.UTF_8)

    assertFalse(activitySrc.contains('\u2014'))
    assertFalse(vmSrc.contains('\u2014'))
    assertBalancedKotlinDelimiters("MainActivity.kt", activitySrc)
    assertBalancedKotlinDelimiters("BridgeViewModel.kt", vmSrc)

    val requiredImports =
        listOf(
            "import androidx.compose.foundation.layout.heightIn",
            "import androidx.compose.ui.res.stringResource",
            "import androidx.compose.ui.semantics.LiveRegionMode",
            "import androidx.compose.ui.semantics.contentDescription",
            "import androidx.compose.ui.semantics.heading",
            "import androidx.compose.ui.semantics.liveRegion",
            "import androidx.compose.ui.semantics.semantics",
            "import androidx.compose.ui.semantics.stateDescription",
        )
    for (imp in requiredImports) {
      assertTrue("Missing import in MainActivity.kt: $imp", activitySrc.contains(imp))
    }

    assertTrue(activitySrc.contains("heading()"))
    assertTrue(activitySrc.contains("liveRegion = LiveRegionMode.Polite"))
    assertTrue(activitySrc.contains("liveRegion = LiveRegionMode.Assertive"))
    assertTrue(activitySrc.contains("Modifier.semantics(mergeDescendants = true)"))
    assertTrue(activitySrc.contains("spokenValue: String = value"))
    assertTrue(activitySrc.contains("stateDescription = stateLabel"))
    assertTrue(activitySrc.contains("ui.talkBackGlassesSummary()"))
    assertTrue(activitySrc.contains("ui.talkBackStreamSummary()"))

    val minTouchTargets = Regex("heightIn\\(min\\s*=\\s*48\\.dp\\)").findAll(activitySrc).count()
    assertTrue("Expected >= 7 48.dp minimum touch targets, got $minTouchTargets", minTouchTargets >= 7)

    for (buttonLabel in
        listOf(
            "Grant Bluetooth",
            "App settings",
            "Update glasses firmware",
            "Update glasses app",
            "Unlink from Meta AI (troubleshooting)",
            "Dismiss",
        )) {
      assertTrue("Missing button label $buttonLabel in MainActivity.kt", activitySrc.contains(buttonLabel))
    }
  }

  @Test
  fun localizedTalkBackStringsMaintainExactEnFiSvKeyPlaceholderAndDistinctValueParity() {
    val mainDir = resolveMainDir()
    val resDir = File(mainDir, "res")
    val en = readStringsMap(File(resDir, "values/strings.xml"))
    val fi = readStringsMap(File(resDir, "values-fi/strings.xml"))
    val sv = readStringsMap(File(resDir, "values-sv/strings.xml"))

    assertEquals(en.keys, fi.keys)
    assertEquals(en.keys, sv.keys)

    val expectedA11yKeys =
        setOf(
            "a11y_bridge_heading",
            "a11y_glasses_none",
            "a11y_state_post_idle",
            "a11y_network_ok",
            "a11y_network_retrying",
            "a11y_network_idle",
            "a11y_dismiss_error",
            "a11y_state_glasses_connected",
            "a11y_state_glasses_connecting",
            "a11y_state_glasses_disconnected",
            "a11y_state_stream_active",
            "a11y_state_stream_starting",
            "a11y_state_stream_stopped",
        )
    assertTrue("Missing a11y string keys: ${expectedA11yKeys - en.keys}", en.keys.containsAll(expectedA11yKeys))

    val activitySrc = File(mainDir, "java/app/holdup/bridge/MainActivity.kt").readText(Charsets.UTF_8)
    for (a11yKey in expectedA11yKeys) {
      assertTrue("Expected MainActivity.kt to reference R.string.$a11yKey", activitySrc.contains("R.string.$a11yKey"))
    }

    for ((key, enVal) in en) {
      val fiVal = checkNotNull(fi[key])
      val svVal = checkNotNull(sv[key])
      assertEquals("Placeholder mismatch in fi for $key", formatPlaceholders(enVal), formatPlaceholders(fiVal))
      assertEquals("Placeholder mismatch in sv for $key", formatPlaceholders(enVal), formatPlaceholders(svVal))
      assertFalse(enVal.contains('\u2014'))
      assertFalse(fiVal.contains('\u2014'))
      assertFalse(svVal.contains('\u2014'))
      if (key != "app_name") {
        assertNotEquals("fi must differ from en for $key", enVal, fiVal)
        assertNotEquals("sv must differ from en for $key", enVal, svVal)
        assertNotEquals("fi and sv must differ for $key", fiVal, svVal)
      }
    }
  }
}
