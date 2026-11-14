package app.holdup.bridge

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/** What we report to `POST /ingest/state` (contract in docs/TEAM.md). */
data class GlassesState(
    val connected: Boolean,
    val worn: Boolean?, // null = unknown (DonState.UNKNOWN)
    val battery: Int?, // null = unknown (Device.batteryLevel == 0 on Android)
    val streaming: Boolean,
) {
  fun toJson(): String =
      "{\"connected\":$connected,\"worn\":${worn ?: "null"},\"battery\":${battery ?: "null"},\"streaming\":$streaming}"
}

sealed interface PostResult {
  data class Ok(val code: Int) : PostResult

  data class HttpError(val code: Int) : PostResult

  data class NetworkError(val message: String) : PostResult
}

/**
 * Blocking HTTP calls to the HoldUp server. Call from Dispatchers.IO.
 *
 * Backpressure: [tryBeginFrame] lets at most one frame POST be in flight. Callers drop frames
 * while it returns false.
 */
class Uploader {
  private val frameInFlight = AtomicBoolean(false)

  fun tryBeginFrame(): Boolean = frameInFlight.compareAndSet(false, true)

  fun endFrame() = frameInFlight.set(false)

  fun postFrame(server: String, session: String, jpeg: ByteArray): PostResult =
      post(endpoint(server, "/ingest/frame", session), "image/jpeg", jpeg)

  fun postState(server: String, session: String, state: GlassesState): PostResult =
      post(
          endpoint(server, "/ingest/state", session),
          "application/json",
          state.toJson().toByteArray(Charsets.UTF_8),
      )

  private fun post(url: String, contentType: String, body: ByteArray): PostResult {
    val conn: HttpURLConnection =
        try {
          URL(url).openConnection() as HttpURLConnection
        } catch (e: Exception) {
          return PostResult.NetworkError("bad URL")
        }
    return try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 5_000
      conn.readTimeout = 10_000
      conn.doOutput = true
      conn.useCaches = false
      conn.setFixedLengthStreamingMode(body.size)
      conn.setRequestProperty("Content-Type", contentType)
      conn.outputStream.use { it.write(body) }
      val code = conn.responseCode
      // Drain the body so the keep-alive pool can reuse the connection.
      try {
        (if (code >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() }
      } catch (ignored: IOException) {
        // Body not needed.
      }
      if (code in 200..299) PostResult.Ok(code) else PostResult.HttpError(code)
    } catch (e: IOException) {
      conn.disconnect()
      PostResult.NetworkError(e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""))
    } catch (e: RuntimeException) {
      conn.disconnect()
      PostResult.NetworkError(e.javaClass.simpleName)
    }
    // On success the connection is not disconnected, so HttpURLConnection can reuse the TLS
    // connection for the next frame (saves a handshake per frame through the tunnel).
  }

  companion object {
    /** "abc.trycloudflare.com/" -> "https://abc.trycloudflare.com" */
    fun normalizeServer(raw: String): String {
      var s = raw.trim().trimEnd('/')
      if (s.isEmpty()) return s
      if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
      return s
    }

    /**
     * Session is optional: without it the server uses the most recent live session.
     * The server field may carry a query, e.g. "https://abc.trycloudflare.com/?key=XYZ" when the server
     * runs with HOLDUP_KEY; that query is kept on every request.
     */
    fun endpoint(server: String, path: String, session: String): String {
      val raw = server.trim()
      val q = raw.indexOf('?')
      val host = if (q >= 0) raw.substring(0, q) else raw
      val params = mutableListOf<String>()
      if (q >= 0) raw.substring(q + 1).split('&').filter { it.isNotBlank() }.forEach { params.add(it) }
      val s = session.trim()
      if (s.isNotEmpty()) params.add("session=" + URLEncoder.encode(s, "UTF-8"))
      val base = normalizeServer(host) + path
      return if (params.isEmpty()) base else base + "?" + params.joinToString("&")
    }
  }
}
