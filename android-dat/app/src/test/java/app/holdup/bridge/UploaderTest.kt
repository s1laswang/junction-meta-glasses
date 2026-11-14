package app.holdup.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class UploaderTest {

  @Test
  fun normalizeAddsHttpsAndTrimsSlash() {
    assertEquals("https://abc.trycloudflare.com", Uploader.normalizeServer(" abc.trycloudflare.com/ "))
    assertEquals("http://10.0.0.2:8787", Uploader.normalizeServer("http://10.0.0.2:8787/"))
    assertEquals("", Uploader.normalizeServer("  "))
  }

  @Test
  fun endpointWithoutSessionUsesLatest() {
    assertEquals(
        "https://abc.trycloudflare.com/ingest/frame",
        Uploader.endpoint("https://abc.trycloudflare.com/", "/ingest/frame", ""),
    )
  }

  @Test
  fun endpointEncodesSession() {
    assertEquals(
        "https://h.example/ingest/state?session=A+B%2F1",
        Uploader.endpoint("h.example", "/ingest/state", " A B/1 "),
    )
  }

  @Test
  fun endpointKeepsAccessKeyFromServerField() {
    assertEquals(
        "https://abc.trycloudflare.com/ingest/frame?key=XYZ12345",
        Uploader.endpoint("https://abc.trycloudflare.com/?key=XYZ12345", "/ingest/frame", ""),
    )
    assertEquals(
        "https://abc.trycloudflare.com/ingest/state?key=XYZ12345&session=s1",
        Uploader.endpoint("abc.trycloudflare.com?key=XYZ12345", "/ingest/state", "s1"),
    )
  }
}
