package app.holdup.bridge

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class UploaderHttpAndBackpressureTest {

  private class RecordedRequest(
      val method: String,
      val path: String,
      val rawQuery: String?,
      val contentType: String?,
      val body: ByteArray,
  )

  private var serverSocket: ServerSocket? = null
  private var acceptThread: Thread? = null
  private val recordedRequests = CopyOnWriteArrayList<RecordedRequest>()
  private val nextStatusCode = AtomicInteger(200)
  private val nextResponseBody = AtomicReference("ok".toByteArray(Charsets.UTF_8))

  @Before
  fun setUp() {
    recordedRequests.clear()
    nextStatusCode.set(200)
    nextResponseBody.set("ok".toByteArray(Charsets.UTF_8))
    val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    serverSocket = server
    val worker =
        Thread(
                {
                  while (!server.isClosed) {
                    val accepted =
                        try {
                          server.accept()
                        } catch (_: IOException) {
                          break
                        }
                    handleConnection(accepted)
                  }
                },
                "uploader-test-http",
            )
            .apply {
              isDaemon = true
              start()
            }
    acceptThread = worker
  }

  @After
  fun tearDown() {
    try {
      serverSocket?.close()
    } catch (_: IOException) {}
    acceptThread?.join(2_000)
    serverSocket = null
    acceptThread = null
  }

  private fun baseUrl(): String {
    val server = checkNotNull(serverSocket)
    return "http://127.0.0.1:${server.localPort}"
  }

  private fun handleConnection(socket: Socket) {
    try {
      socket.use { sock ->
        sock.soTimeout = 5_000
        val input = BufferedInputStream(sock.getInputStream())
        val requestLine = readAsciiLine(input) ?: return
        if (requestLine.isEmpty()) return
        val parts = requestLine.split(' ')
        val method = parts.getOrElse(0) { "" }
        val target = parts.getOrElse(1) { "/" }
        val qIndex = target.indexOf('?')
        val path = if (qIndex >= 0) target.substring(0, qIndex) else target
        val rawQuery = if (qIndex >= 0) target.substring(qIndex + 1) else null

        var contentType: String? = null
        var contentLength = 0
        while (true) {
          val headerLine = readAsciiLine(input) ?: break
          if (headerLine.isEmpty()) break
          val colon = headerLine.indexOf(':')
          if (colon > 0) {
            val name = headerLine.substring(0, colon).trim()
            val value = headerLine.substring(colon + 1).trim()
            if (name.equals("Content-Type", ignoreCase = true)) {
              contentType = value
            } else if (name.equals("Content-Length", ignoreCase = true)) {
              contentLength = value.toIntOrNull() ?: 0
            }
          }
        }

        val bodyBytes = readExactBytes(input, contentLength)
        recordedRequests.add(
            RecordedRequest(
                method = method,
                path = path,
                rawQuery = rawQuery,
                contentType = contentType,
                body = bodyBytes,
            ),
        )

        val code = nextStatusCode.get()
        val resp = nextResponseBody.get()
        val reason = statusReason(code)
        val out = sock.getOutputStream()
        if (code == 204) {
          out.write(
              "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
                  .toByteArray(Charsets.ISO_8859_1),
          )
        } else {
          val headers =
              "HTTP/1.1 $code $reason\r\n" +
                  "Content-Type: text/plain; charset=utf-8\r\n" +
                  "Content-Length: ${resp.size}\r\n" +
                  "Connection: close\r\n\r\n"
          out.write(headers.toByteArray(Charsets.ISO_8859_1))
          if (resp.isNotEmpty()) {
            out.write(resp)
          }
        }
        out.flush()
      }
    } catch (_: IOException) {}
  }

  private fun readAsciiLine(input: InputStream): String? {
    val buf = ByteArrayOutputStream()
    while (true) {
      val b = input.read()
      if (b == -1) {
        return if (buf.size() == 0) null else buf.toString("ISO-8859-1").trimEnd('\r')
      }
      if (b == '\n'.code) {
        return buf.toString("ISO-8859-1").trimEnd('\r')
      }
      buf.write(b)
    }
  }

  private fun readExactBytes(input: InputStream, count: Int): ByteArray {
    if (count <= 0) return ByteArray(0)
    val out = ByteArray(count)
    var offset = 0
    while (offset < count) {
      val read = input.read(out, offset, count - offset)
      if (read < 0) break
      offset += read
    }
    return if (offset == count) out else out.copyOf(offset)
  }

  private fun statusReason(code: Int): String =
      when (code) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        404 -> "Not Found"
        410 -> "Gone"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        else -> "Status"
      }

  @Test
  fun tryBeginFrameAndEndFrameEnforceSingleInFlightAcrossCycles() {
    val uploader = Uploader()
    val independent = Uploader()

    repeat(5) {
      assertTrue(uploader.tryBeginFrame())
      assertFalse(uploader.tryBeginFrame())
      assertFalse(uploader.tryBeginFrame())
      assertTrue(independent.tryBeginFrame())
      independent.endFrame()
      uploader.endFrame()
    }

    uploader.endFrame()
    assertTrue(uploader.tryBeginFrame())
    assertFalse(uploader.tryBeginFrame())
    uploader.endFrame()
  }

  @Test
  fun concurrentContentionAllowsAtMostOneThreadInFlightSimultaneously() {
    val uploader = Uploader()
    val threadCount = 8
    val pool = Executors.newFixedThreadPool(threadCount)
    try {
      val ready = CountDownLatch(threadCount)
      val start = CountDownLatch(1)
      val winnerEntered = CountDownLatch(1)
      val losersFinished = CountDownLatch(threadCount - 1)
      val releaseWinner = CountDownLatch(1)
      val allDone = CountDownLatch(threadCount)
      val activeInFlight = AtomicInteger(0)
      val maxSimultaneous = AtomicInteger(0)
      val acquiredCount = AtomicInteger(0)
      val rejectedCount = AtomicInteger(0)

      repeat(threadCount) {
        pool.execute {
          ready.countDown()
          try {
            if (start.await(5, TimeUnit.SECONDS)) {
              if (uploader.tryBeginFrame()) {
                try {
                  val cur = activeInFlight.incrementAndGet()
                  maxSimultaneous.accumulateAndGet(cur) { prev, now ->
                    if (now > prev) now else prev
                  }
                  acquiredCount.incrementAndGet()
                  winnerEntered.countDown()
                  releaseWinner.await(5, TimeUnit.SECONDS)
                } finally {
                  activeInFlight.decrementAndGet()
                  uploader.endFrame()
                }
              } else {
                rejectedCount.incrementAndGet()
                losersFinished.countDown()
              }
            }
          } finally {
            allDone.countDown()
          }
        }
      }

      assertTrue(ready.await(5, TimeUnit.SECONDS))
      start.countDown()
      assertTrue(winnerEntered.await(5, TimeUnit.SECONDS))
      assertTrue(losersFinished.await(5, TimeUnit.SECONDS))
      assertEquals(1, acquiredCount.get())
      assertEquals(threadCount - 1, rejectedCount.get())
      assertEquals(1, activeInFlight.get())

      releaseWinner.countDown()
      assertTrue(allDone.await(5, TimeUnit.SECONDS))
      assertEquals(1, maxSimultaneous.get())
      assertEquals(0, activeInFlight.get())

      val roundReady = CountDownLatch(threadCount)
      val roundStart = CountDownLatch(1)
      val roundDone = CountDownLatch(threadCount)
      val roundActive = AtomicInteger(0)
      val roundMax = AtomicInteger(0)
      val roundAcquired = AtomicInteger(0)

      repeat(threadCount) {
        pool.execute {
          roundReady.countDown()
          try {
            if (roundStart.await(5, TimeUnit.SECONDS)) {
              repeat(100) {
                if (uploader.tryBeginFrame()) {
                  try {
                    val cur = roundActive.incrementAndGet()
                    roundMax.accumulateAndGet(cur) { prev, now ->
                      if (now > prev) now else prev
                    }
                    roundAcquired.incrementAndGet()
                    Thread.yield()
                  } finally {
                    roundActive.decrementAndGet()
                    uploader.endFrame()
                  }
                }
              }
            }
          } finally {
            roundDone.countDown()
          }
        }
      }

      assertTrue(roundReady.await(5, TimeUnit.SECONDS))
      roundStart.countDown()
      assertTrue(roundDone.await(5, TimeUnit.SECONDS))
      assertEquals(1, roundMax.get())
      assertEquals(0, roundActive.get())
      assertTrue(roundAcquired.get() >= 1)
      assertTrue(uploader.tryBeginFrame())
      uploader.endFrame()
    } finally {
      pool.shutdownNow()
      pool.awaitTermination(5, TimeUnit.SECONDS)
    }
  }

  @Test
  fun postFrameSendsPostMethodPathQueryHeadersAndExactJpegBytes() {
    val uploader = Uploader()
    val jpegBytes =
        ByteArray(256) { i ->
          when (i) {
            0 -> 0xFF.toByte()
            1 -> 0xD8.toByte()
            254 -> 0xFF.toByte()
            255 -> 0xD9.toByte()
            else -> (i and 0xFF).toByte()
          }
        }

    val keyedResult =
        uploader.postFrame("${baseUrl()}/?key=HOLDUP_K9", "sess 42/a", jpegBytes)
    assertEquals(PostResult.Ok(200), keyedResult)
    assertEquals(1, recordedRequests.size)
    val keyedReq = recordedRequests[0]
    assertEquals("POST", keyedReq.method)
    assertEquals("/ingest/frame", keyedReq.path)
    assertEquals("key=HOLDUP_K9&session=sess+42%2Fa", keyedReq.rawQuery)
    assertEquals("image/jpeg", keyedReq.contentType)
    assertArrayEquals(jpegBytes, keyedReq.body)

    val minimalJpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
    val keylessResult = uploader.postFrame(baseUrl(), "", minimalJpeg)
    assertEquals(PostResult.Ok(200), keylessResult)
    assertEquals(2, recordedRequests.size)
    val keylessReq = recordedRequests[1]
    assertEquals("POST", keylessReq.method)
    assertEquals("/ingest/frame", keylessReq.path)
    assertNull(keylessReq.rawQuery)
    assertEquals("image/jpeg", keylessReq.contentType)
    assertArrayEquals(minimalJpeg, keylessReq.body)
  }

  @Test
  fun postFrameMapsSuccessAndErrorStatusCodes() {
    val uploader = Uploader()
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x00, 0xFF.toByte(), 0xD9.toByte())

    for (code in listOf(200, 204)) {
      nextStatusCode.set(code)
      nextResponseBody.set(if (code == 204) ByteArray(0) else "ok-$code".toByteArray(Charsets.UTF_8))
      assertEquals(PostResult.Ok(code), uploader.postFrame(baseUrl(), "s1", jpeg))
    }

    for (code in listOf(400, 404, 410, 502, 503)) {
      nextStatusCode.set(code)
      nextResponseBody.set("err-$code".toByteArray(Charsets.UTF_8))
      assertEquals(PostResult.HttpError(code), uploader.postFrame(baseUrl(), "s1", jpeg))
    }

    assertEquals(7, recordedRequests.size)
  }

  @Test
  fun postStateSendsPostMethodPathJsonHeaderAndExactUtf8Body() {
    val uploader = Uploader()
    val activeState = GlassesState(connected = true, worn = true, battery = 84, streaming = true)

    val res1 = uploader.postState("${baseUrl()}/?key=KEY77", "room-9", activeState)
    assertEquals(PostResult.Ok(200), res1)
    assertEquals(1, recordedRequests.size)
    val req1 = recordedRequests[0]
    assertEquals("POST", req1.method)
    assertEquals("/ingest/state", req1.path)
    assertEquals("key=KEY77&session=room-9", req1.rawQuery)
    assertEquals("application/json", req1.contentType)
    assertArrayEquals(activeState.toJson().toByteArray(Charsets.UTF_8), req1.body)
    assertEquals(activeState.toJson(), req1.body.toString(Charsets.UTF_8))

    nextStatusCode.set(204)
    val idleState = GlassesState(connected = false, worn = null, battery = null, streaming = false)
    val res2 = uploader.postState(baseUrl(), "", idleState)
    assertEquals(PostResult.Ok(204), res2)
    assertEquals(2, recordedRequests.size)
    val req2 = recordedRequests[1]
    assertEquals("POST", req2.method)
    assertEquals("/ingest/state", req2.path)
    assertNull(req2.rawQuery)
    assertEquals("application/json", req2.contentType)
    assertArrayEquals(idleState.toJson().toByteArray(Charsets.UTF_8), req2.body)
    assertEquals(idleState.toJson(), req2.body.toString(Charsets.UTF_8))
  }

  @Test
  fun postStateMapsSuccessAndErrorStatusCodes() {
    val uploader = Uploader()
    val state = GlassesState(connected = true, worn = false, battery = 62, streaming = false)

    for (code in listOf(200, 204)) {
      nextStatusCode.set(code)
      nextResponseBody.set(if (code == 204) ByteArray(0) else "ok-$code".toByteArray(Charsets.UTF_8))
      assertEquals(PostResult.Ok(code), uploader.postState(baseUrl(), "s2", state))
    }

    for (code in listOf(404, 500)) {
      nextStatusCode.set(code)
      nextResponseBody.set("err-$code".toByteArray(Charsets.UTF_8))
      assertEquals(PostResult.HttpError(code), uploader.postState(baseUrl(), "s2", state))
    }

    assertEquals(4, recordedRequests.size)
  }

  @Test
  fun unreachableClosedLoopbackPortReturnsNetworkErrorWithoutThrowing() {
    val uploader = Uploader()
    val closedPort = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
    val unreachableUrl = "http://127.0.0.1:$closedPort"
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
    val state = GlassesState(connected = true, worn = true, battery = 90, streaming = true)

    val frameResult = uploader.postFrame(unreachableUrl, "s1", jpeg)
    assertTrue(frameResult is PostResult.NetworkError)
    assertTrue((frameResult as PostResult.NetworkError).message.isNotBlank())

    val stateResult = uploader.postState(unreachableUrl, "s1", state)
    assertTrue(stateResult is PostResult.NetworkError)
    assertTrue((stateResult as PostResult.NetworkError).message.isNotBlank())
  }

  @Test
  fun invalidUrlSchemeAndMalformedTargetsReturnNetworkErrorWithoutThrowing() {
    val uploader = Uploader()
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
    val state = GlassesState(connected = false, worn = null, battery = null, streaming = false)
    val invalidServers =
        listOf(
            "",
            "   ",
            "ftp:127.0.0.1:21",
            "ws:127.0.0.1:8787",
            "file:127.0.0.1:80",
            "bad:scheme://127.0.0.1",
            "http://127.0.0.1:notaport",
            "http://127.0.0.1:70000",
        )

    for (badServer in invalidServers) {
      val frameResult = uploader.postFrame(badServer, "s1", jpeg)
      assertTrue(frameResult is PostResult.NetworkError)
      assertTrue((frameResult as PostResult.NetworkError).message.isNotBlank())

      val stateResult = uploader.postState(badServer, "s1", state)
      assertTrue(stateResult is PostResult.NetworkError)
      assertTrue((stateResult as PostResult.NetworkError).message.isNotBlank())
    }
  }
}
