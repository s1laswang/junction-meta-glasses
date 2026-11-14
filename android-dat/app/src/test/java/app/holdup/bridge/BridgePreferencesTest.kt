package app.holdup.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class BridgePreferencesTest {

    @Test
    fun sanitizeServerUrl_acceptsAndNormalizesValidHttpsAndLocalEndpoints() {
        assertEquals(
            "https://demo.trycloudflare.com",
            BridgePreferences.sanitizeServerUrl("https://demo.trycloudflare.com/"),
        )
        assertEquals(
            "https://demo.trycloudflare.com",
            BridgePreferences.sanitizeServerUrl("  https://demo.trycloudflare.com///  "),
        )
        assertEquals(
            "http://10.0.2.2:8787",
            BridgePreferences.sanitizeServerUrl("http://10.0.2.2:8787"),
        )
        assertEquals(
            "http://10.0.2.2:8787",
            BridgePreferences.sanitizeServerUrl("http://10.0.2.2:8787/"),
        )
        assertEquals(
            "http://192.168.1.20:8787",
            BridgePreferences.sanitizeServerUrl("http://192.168.1.20:8787/"),
        )
        assertEquals(
            "http://127.0.0.1:8787",
            BridgePreferences.sanitizeServerUrl("http://127.0.0.1:8787/"),
        )
        assertEquals(
            "http://localhost:8787",
            BridgePreferences.sanitizeServerUrl("http://localhost:8787"),
        )
        assertEquals(
            "http://[::1]:8787",
            BridgePreferences.sanitizeServerUrl("http://[::1]:8787/"),
        )
        assertEquals(
            "https://HoldUp.Run.App/bridge",
            BridgePreferences.sanitizeServerUrl("HTTPS://HoldUp.Run.App/bridge///"),
        )
        assertEquals(
            "https://demo.trycloudflare.com:1",
            BridgePreferences.sanitizeServerUrl("https://demo.trycloudflare.com:1/"),
        )
        assertEquals(
            "http://10.0.2.2:65535",
            BridgePreferences.sanitizeServerUrl("http://10.0.2.2:65535/"),
        )
    }

    @Test
    fun sanitizeServerUrl_enforces256CharMaximumLengthBoundary() {
        assertEquals(256, BridgePreferences.MAX_SERVER_URL_LENGTH)

        val prefix = "https://demo.trycloudflare.com/"
        val exact256 = prefix + "a".repeat(BridgePreferences.MAX_SERVER_URL_LENGTH - prefix.length)
        val over257 = exact256 + "a"
        val over257TrailingSlash = exact256 + "/"
        val over512 = prefix + "b".repeat(512)

        assertEquals(256, exact256.length)
        assertEquals(257, over257.length)
        assertEquals(exact256, BridgePreferences.sanitizeServerUrl(exact256))
        assertEquals(exact256, BridgePreferences.sanitizeServerUrl("  $exact256  "))
        assertEquals("", BridgePreferences.sanitizeServerUrl(over257))
        assertEquals("", BridgePreferences.sanitizeServerUrl(over257TrailingSlash))
        assertEquals("", BridgePreferences.sanitizeServerUrl(over512))
    }

    @Test
    fun sanitizeServerUrl_rejectsHostileSchemesCredentialsInvalidPortsAndTraversal() {
        val hostileUrls = listOf(
            "",
            "   ",
            "/",
            "///",
            "javascript:alert(1)",
            "JAVASCRIPT://alert(1)",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "file://localhost/etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "content://com.android.providers.downloads/documents/1",
            "intent://connect#Intent;scheme=holdupbridge;end",
            "ftp://evil.example/payload",
            "ws://10.0.2.2:8787",
            "wss://demo.trycloudflare.com",
            "holdupbridge://connect?server=https://demo.trycloudflare.com",
            "http://",
            "https:///",
            "https:///etc/passwd",
            "http:demo.trycloudflare.com",
            "demo.trycloudflare.com",
            "https://user:pass@evil.example",
            "https://token@evil.example/ingest",
            "http://user:pass@192.168.1.20:8787",
            "http://10.0.2.2:0",
            "https://demo.trycloudflare.com:0",
            "http://10.0.2.2:70000",
            "https://demo.trycloudflare.com:70000",
            "https://demo.trycloudflare.com:65536",
            "https://demo.trycloudflare.com:-1",
            "https://demo.trycloudflare.com:",
            "https://demo.trycloudflare.com:abc",
            "https://demo.trycloudflare.com?session=injected",
            "https://demo.trycloudflare.com#fragment",
            "https://demo.trycloudflare.com/../etc/passwd",
            "https://demo.trycloudflare.com/bridge/..",
            "https://demo.trycloudflare.com/./bridge",
            "https://demo.trycloudflare.com/a//b",
            "https://demo.trycloudflare.com\\evil",
            "https://demo.trycloudflare.com/bad path",
            "https://demo.trycloudflare.com/\r\nX-Injected: 1",
            "https://demo.trycloudflare.com/\u007f",
        )

        for (candidate in hostileUrls) {
            assertEquals(
                "Expected empty result for hostile URL: $candidate",
                "",
                BridgePreferences.sanitizeServerUrl(candidate),
            )
        }
    }

    @Test
    fun sanitizeSessionCode_acceptsValidCodesWithinLengthBounds() {
        assertEquals(4, BridgePreferences.MIN_SESSION_CODE_LENGTH)
        assertEquals(64, BridgePreferences.MAX_SESSION_CODE_LENGTH)

        assertEquals("abcd", BridgePreferences.sanitizeSessionCode("abcd"))
        assertEquals("A1_-", BridgePreferences.sanitizeSessionCode("  A1_-  "))
        assertEquals("hup-4k9m", BridgePreferences.sanitizeSessionCode("hup-4k9m"))
        assertEquals("hup-4k9m", BridgePreferences.sanitizeSessionCode("  hup-4k9m  "))
        assertEquals("Session_2026-11", BridgePreferences.sanitizeSessionCode("Session_2026-11"))
        assertEquals(
            "550e8400-e29b-41d4-a716-446655440000",
            BridgePreferences.sanitizeSessionCode("550e8400-e29b-41d4-a716-446655440000"),
        )

        val maxSession = "S".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH)
        assertEquals(64, maxSession.length)
        assertEquals(maxSession, BridgePreferences.sanitizeSessionCode(maxSession))
        assertEquals(maxSession, BridgePreferences.sanitizeSessionCode("  $maxSession  "))
    }

    @Test
    fun sanitizeSessionCode_rejectsShortOverlongAndInjectionCodes() {
        val invalidSessionCodes = listOf(
            "",
            "   ",
            "a",
            "ab",
            "abc",
            "  abc  ",
            "S".repeat(BridgePreferences.MAX_SESSION_CODE_LENGTH + 1),
            "S".repeat(128),
            "hup&inject=1",
            "hup?server=https://evil.example",
            "hup#fragment",
            "../etc/passwd",
            "../../secret",
            "a/b/c/d",
            "a\\b\\c\\d",
            "<script>alert(1)</script>",
            "hup session",
            "hup\ninjected",
            "hup\r\nX-Injected: 1",
            "hup;drop",
            "hup'OR'1'='1",
            "user@evil.example",
        )

        for (candidate in invalidSessionCodes) {
            assertEquals(
                "Expected empty result for hostile session code: $candidate",
                "",
                BridgePreferences.sanitizeSessionCode(candidate),
            )
        }
    }

    @Test
    fun savedBridgeEndpointAndConstants_exposeExpectedDefaultsAndKeys() {
        val empty = SavedBridgeEndpoint()
        assertEquals("", empty.serverUrl)
        assertEquals("", empty.sessionCode)
        assertEquals(SavedBridgeEndpoint("", ""), empty)
        assertEquals(SavedBridgeEndpoint().hashCode(), empty.hashCode())

        val configured = SavedBridgeEndpoint(
            serverUrl = BridgePreferences.sanitizeServerUrl("https://demo.trycloudflare.com/"),
            sessionCode = BridgePreferences.sanitizeSessionCode("  hup-4k9m  "),
        )
        assertEquals("https://demo.trycloudflare.com", configured.serverUrl)
        assertEquals("hup-4k9m", configured.sessionCode)
        assertNotEquals(empty, configured)

        assertEquals("holdup_bridge_prefs", BridgePreferences.PREFS_NAME)
        assertEquals("server_url", BridgePreferences.KEY_SERVER_URL)
        assertEquals("session_code", BridgePreferences.KEY_SESSION_CODE)
        assertNotEquals(BridgePreferences.KEY_SERVER_URL, BridgePreferences.KEY_SESSION_CODE)
    }
}
