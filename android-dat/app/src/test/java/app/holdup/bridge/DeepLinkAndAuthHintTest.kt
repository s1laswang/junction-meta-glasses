package app.holdup.bridge

import app.holdup.bridge.BridgeViewModel.Companion.DeepLinkConfig
import java.io.File
import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkAndAuthHintTest {

  private fun parseQrUri(rawUri: String): DeepLinkConfig? {
    val uri = URI(rawUri)
    val params = LinkedHashMap<String, String>()
    val rawQuery = uri.rawQuery
    if (rawQuery != null && rawQuery.isNotEmpty()) {
      for (part in rawQuery.split('&')) {
        if (part.isEmpty()) continue
        val eq = part.indexOf('=')
        val rawKey = if (eq >= 0) part.substring(0, eq) else part
        val rawVal = if (eq >= 0) part.substring(eq + 1) else ""
        val decodedKey = URLDecoder.decode(rawKey, "UTF-8")
        if (!params.containsKey(decodedKey)) {
          params[decodedKey] = URLDecoder.decode(rawVal, "UTF-8")
        }
      }
    }
    return BridgeViewModel.parseDeepLink(
        scheme = uri.scheme,
        host = uri.host,
        server = params["server"],
        session = params["session"],
        key = params["key"],
    )
  }

  private fun resolveBridgeViewModelSource(
      dir: File = File(System.getProperty("user.dir") ?: "."),
  ): File =
      listOf(
              "src/main/java/app/holdup/bridge/BridgeViewModel.kt",
              "app/src/main/java/app/holdup/bridge/BridgeViewModel.kt",
              "android-dat/app/src/main/java/app/holdup/bridge/BridgeViewModel.kt",
          )
          .map { File(dir, it) }
          .firstOrNull { it.isFile }
          ?: error("BridgeViewModel.kt not found from ${dir.absolutePath}")

  @Test
  fun frameHttpHintCovers401And403AuthHintsAndAllTroubleshootingStatusCodes() {
    val authHint = " (access key missing or wrong: add ?key=... to Server URL)"
    assertEquals(authHint, BridgeViewModel.frameHttpHint(401))
    assertEquals(authHint, BridgeViewModel.frameHttpHint(403))
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
    assertEquals("", BridgeViewModel.frameHttpHint(500))
    assertEquals("", BridgeViewModel.frameHttpHint(0))

    val frameErr = "Server rejected frame: HTTP 401${BridgeViewModel.frameHttpHint(401)}"
    val stateErr = "Server rejected state: HTTP 403${BridgeViewModel.frameHttpHint(403)}"
    assertTrue(frameErr.startsWith("Server"))
    assertTrue(stateErr.startsWith("Server"))
    assertEquals(
        "Server rejected state: HTTP 401 (access key missing or wrong: add ?key=... to Server URL)",
        "Server rejected state: HTTP 401${BridgeViewModel.frameHttpHint(401)}",
    )
  }

  @Test
  fun parseDeepLinkRejectsNullAndInvalidSchemesOrHosts() {
    assertNull(BridgeViewModel.parseDeepLink(null, "connect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("holdupbridge", null, "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("", "connect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("https", "connect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("http", "connect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("HOLDUPBRIDGE", "connect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("holdupbridge", "", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("holdupbridge", "disconnect", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(BridgeViewModel.parseDeepLink("holdupbridge", "CONNECT", "https://x.trycloudflare.com", "S1", "K"))
    assertNull(parseQrUri("https://x.trycloudflare.com/connect?server=https://y.trycloudflare.com&key=K"))
  }

  @Test
  fun parseDeepLinkAppendsTopLevelKeyAndTrimsInputs() {
    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com?key=SECRET",
            session = "S1",
        ),
        parseQrUri("holdupbridge://connect?server=https://x.trycloudflare.com&key=SECRET&session=S1"),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?key=SECRET",
            session = "S1",
        ),
        BridgeViewModel.parseDeepLink(
            scheme = "holdupbridge",
            host = "connect",
            server = "  https://x.trycloudflare.com/  ",
            session = "  S1  ",
            key = "  SECRET  ",
        ),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?edge=hel1&key=SECRET",
            session = "S2",
        ),
        BridgeViewModel.parseDeepLink(
            scheme = "holdupbridge",
            host = "connect",
            server = "https://x.trycloudflare.com/?edge=hel1",
            session = "S2",
            key = "SECRET",
        ),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?monkey=1&key=SECRET",
            session = null,
        ),
        BridgeViewModel.parseDeepLink(
            scheme = "holdupbridge",
            host = "connect",
            server = "https://x.trycloudflare.com/?monkey=1",
            session = "   ",
            key = "SECRET",
        ),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?key=SECRET",
            session = null,
        ),
        BridgeViewModel.parseDeepLink(
            scheme = "holdupbridge",
            host = "connect",
            server = "https://x.trycloudflare.com/?",
            session = null,
            key = "SECRET",
        ),
    )
  }

  @Test
  fun parseDeepLinkPreservesEncodedServerKeyAndPreventsDuplicateKeyParam() {
    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?key=EMBEDDED_0630",
            session = "HUP-1",
        ),
        parseQrUri(
            "holdupbridge://connect?server=https%3A%2F%2Fx.trycloudflare.com%2F%3Fkey%3DEMBEDDED_0630&session=HUP-1",
        ),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?key=EXISTING_KEY",
            session = "HUP-2",
        ),
        parseQrUri(
            "holdupbridge://connect?server=https%3A%2F%2Fx.trycloudflare.com%2F%3Fkey%3DEXISTING_KEY&key=DUPLICATE_KEY&session=HUP-2",
        ),
    )

    assertEquals(
        DeepLinkConfig(
            server = "https://x.trycloudflare.com/?mode=stage&key=EXISTING_KEY",
            session = "HUP-3",
        ),
        BridgeViewModel.parseDeepLink(
            scheme = "holdupbridge",
            host = "connect",
            server = "https://x.trycloudflare.com/?mode=stage&key=EXISTING_KEY",
            session = "HUP-3",
            key = "SECOND_KEY",
        ),
    )
  }

  @Test
  fun parseDeepLinkEncodesSpecialCharactersInKeyAndHandlesBlankFieldsSafely() {
    val rawSecret = "hk+2026/a=b&c?d#e f"
    val cfg =
        checkNotNull(
            BridgeViewModel.parseDeepLink(
                scheme = "holdupbridge",
                host = "connect",
                server = "https://x.trycloudflare.com",
                session = "room 7/a",
                key = "  $rawSecret  ",
            ),
        )
    assertEquals("https://x.trycloudflare.com?key=hk%2B2026%2Fa%3Db%26c%3Fd%23e+f", cfg.server)
    assertEquals("room 7/a", cfg.session)

    val endpointUrl =
        Uploader.endpoint(checkNotNull(cfg.server), "/ingest/frame", checkNotNull(cfg.session))
    val parsedEndpoint = URI(endpointUrl)
    assertNull(parsedEndpoint.fragment)
    val queryParts = checkNotNull(parsedEndpoint.rawQuery).split('&')
    assertEquals(2, queryParts.size)
    assertEquals(rawSecret, URLDecoder.decode(queryParts[0].removePrefix("key="), "UTF-8"))
    assertEquals("room 7/a", URLDecoder.decode(queryParts[1].removePrefix("session="), "UTF-8"))

    assertEquals(
        DeepLinkConfig(server = null, session = "ONLY-SESSION"),
        BridgeViewModel.parseDeepLink("holdupbridge", "connect", "   ", "  ONLY-SESSION ", "SECRET"),
    )
    assertEquals(
        DeepLinkConfig(server = "https://x.trycloudflare.com", session = null),
        BridgeViewModel.parseDeepLink("holdupbridge", "connect", "https://x.trycloudflare.com", "", "   "),
    )
    assertEquals(
        DeepLinkConfig(server = null, session = null),
        BridgeViewModel.parseDeepLink("holdupbridge", "connect", null, null, null),
    )
  }

  @Test
  fun parseDeepLinkRoundTripsThroughUiStateResolveTargetAndUploaderEndpoint() {
    val topLevelQr =
        checkNotNull(
            parseQrUri("holdupbridge://connect?server=https://x.trycloudflare.com&key=K_0630&session=S9"),
        )
    val encodedServerQr =
        checkNotNull(
            parseQrUri(
                "holdupbridge://connect?server=https%3A%2F%2Fx.trycloudflare.com%2F%3Fkey%3DK_0630&session=S9",
            ),
        )

    val uiFromTopLevel =
        UiState(
            serverUrl = topLevelQr.server ?: "",
            sessionCode = topLevelQr.session ?: "",
        )
    val uiFromEncoded =
        UiState(
            serverUrl = encodedServerQr.server ?: "",
            sessionCode = encodedServerQr.session ?: "",
        )

    val (topServer, topSession) = checkNotNull(uiFromTopLevel.resolveTarget())
    val (encServer, encSession) = checkNotNull(uiFromEncoded.resolveTarget())

    val expectedFrame = "https://x.trycloudflare.com/ingest/frame?key=K_0630&session=S9"
    val expectedState = "https://x.trycloudflare.com/ingest/state?key=K_0630&session=S9"

    assertEquals(expectedFrame, Uploader.endpoint(topServer, "/ingest/frame", topSession))
    assertEquals(expectedFrame, Uploader.endpoint(encServer, "/ingest/frame", encSession))
    assertEquals(expectedState, Uploader.endpoint(topServer, "/ingest/state", topSession))
    assertEquals(expectedState, Uploader.endpoint(encServer, "/ingest/state", encSession))
  }

  @Test
  fun bridgeViewModelSourceWiresDeepLinkParserAndStateAuthErrorLifecycle() {
    val src = resolveBridgeViewModelSource().readText(Charsets.UTF_8)
    assertFalse(src.contains('\u2014'))
    assertTrue(src.contains("internal data class DeepLinkConfig(val server: String?, val session: String?)"))
    assertTrue(src.contains("uri.getQueryParameter(\"key\")"))
    assertTrue(src.contains("401, 403 -> \" (access key missing or wrong: add ?key=... to Server URL)\""))
    assertTrue(src.contains("Server rejected state: HTTP \${res.code}\${frameHttpHint(res.code)}"))
    assertTrue(src.contains("res.code == 401 || res.code == 403"))
  }
}
