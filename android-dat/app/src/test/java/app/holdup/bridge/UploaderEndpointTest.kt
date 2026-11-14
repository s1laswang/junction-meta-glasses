package app.holdup.bridge

import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UploaderEndpointTest {

  @Test
  fun normalizeServerDefaultsBareHostsToHttpsAndPreservesExplicitSchemes() {
    assertEquals("", Uploader.normalizeServer(""))
    assertEquals("", Uploader.normalizeServer("   \t\n  "))
    assertEquals("", Uploader.normalizeServer(" / "))
    assertEquals(
        "https://demo.trycloudflare.com",
        Uploader.normalizeServer("  demo.trycloudflare.com  "),
    )
    assertEquals(
        "https://demo.trycloudflare.com",
        Uploader.normalizeServer("demo.trycloudflare.com/"),
    )
    assertEquals(
        "https://demo.trycloudflare.com",
        Uploader.normalizeServer("https://demo.trycloudflare.com/"),
    )
    assertEquals(
        "http://192.168.1.24:8787",
        Uploader.normalizeServer("  http://192.168.1.24:8787/  "),
    )
    assertEquals(
        "http://localhost:8787",
        Uploader.normalizeServer("http://localhost:8787"),
    )
  }

  @Test
  fun endpointBuildsIngestFrameAndStateRoutesWithoutSessionWhenBlank() {
    assertEquals(
        "https://demo.trycloudflare.com/ingest/frame",
        Uploader.endpoint("  demo.trycloudflare.com/ ", "/ingest/frame", ""),
    )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/state",
        Uploader.endpoint("https://demo.trycloudflare.com/", "/ingest/state", "   "),
    )
    assertEquals(
        "http://10.0.0.5:8787/ingest/frame",
        Uploader.endpoint("http://10.0.0.5:8787/", "/ingest/frame", "\t\n"),
    )
  }

  @Test
  fun endpointPreservesAccessKeyAndExistingQueryParamsBeforeSession() {
    assertEquals(
        "https://demo.trycloudflare.com/ingest/frame?key=K98765",
        Uploader.endpoint("https://demo.trycloudflare.com/?key=K98765", "/ingest/frame", ""),
    )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/state?key=K98765&session=ab12",
        Uploader.endpoint("demo.trycloudflare.com/?key=K98765", "/ingest/state", "  ab12  "),
    )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/frame?key=K1&region=eu&session=s9",
        Uploader.endpoint(
            "  demo.trycloudflare.com/?key=K1&&region=eu&  ",
            "/ingest/frame",
            "s9",
        ),
    )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/state",
        Uploader.endpoint("https://demo.trycloudflare.com/?", "/ingest/state", ""),
    )
  }

  @Test
  fun endpointPercentEncodesReservedAndNordicSessionCharactersSafely() {
    val injected =
        Uploader.endpoint(
            "https://demo.trycloudflare.com/?key=realKey",
            "/ingest/frame",
            "s1&key=override/2?x=1#frag",
        )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/frame?key=realKey&session=s1%26key%3Doverride%2F2%3Fx%3D1%23frag",
        injected,
    )
    val parsed = URI(injected)
    assertEquals("https", parsed.scheme)
    assertEquals("demo.trycloudflare.com", parsed.host)
    assertEquals("/ingest/frame", parsed.path)
    assertNull(parsed.fragment)

    val nordic =
        Uploader.endpoint(
            "demo.trycloudflare.com",
            "/ingest/state",
            "iltalaake äöå 5mg",
        )
    val nordicUri = URI(nordic)
    val rawQuery = checkNotNull(nordicUri.rawQuery)
    assertEquals("session=iltalaake+%C3%A4%C3%B6%C3%A5+5mg", rawQuery)
    val decodedValue = URLDecoder.decode(rawQuery.removePrefix("session="), "UTF-8")
    assertEquals("iltalaake äöå 5mg", decodedValue)
  }

  @Test
  fun resolveTargetFeedsEndpointCleanlyWithAndWithoutAccessKey() {
    val keyedUi =
        UiState(
            serverUrl = "  demo.trycloudflare.com/?key=HOLDUP42  ",
            sessionCode = "  HUP-7  ",
        )
    val (keyedServer, keyedCode) = checkNotNull(keyedUi.resolveTarget())
    assertEquals(
        "https://demo.trycloudflare.com/ingest/frame?key=HOLDUP42&session=HUP-7",
        Uploader.endpoint(keyedServer, "/ingest/frame", keyedCode),
    )
    assertEquals(
        "https://demo.trycloudflare.com/ingest/state?key=HOLDUP42&session=HUP-7",
        Uploader.endpoint(keyedServer, "/ingest/state", keyedCode),
    )

    val keylessUi = UiState(serverUrl = "http://10.0.0.2:8787/", sessionCode = "   ")
    val (localServer, localCode) = checkNotNull(keylessUi.resolveTarget())
    assertEquals(
        "http://10.0.0.2:8787/ingest/frame",
        Uploader.endpoint(localServer, "/ingest/frame", localCode),
    )
  }
}
