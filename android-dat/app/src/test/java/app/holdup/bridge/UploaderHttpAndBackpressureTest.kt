package app.holdup.bridge

import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
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

  private var httpServer: HttpServer? = null
  private val recordedRequests = CopyOnWriteArrayList<RecordedRequest>()
  private val nextStatusCode = AtomicInteger(200)
  private val nextResponseBody = AtomicReference("ok".toByteArray(Charsets.UTF_8))

  @Before
  fun setUp() {
    recordedRequests.clear()
    nextStatusCode.set(200)
    nextResponseBody.set("ok".toByteArray(Charsets.UTF_8))
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/") { exchange ->
      try {
        val bodyBytes = exchange.requestBody.use { it.readBytes() }
        recordedRequests.add(
            RecordedRequest(
                method = exchange.requestMethod,
                path = exchange.requestURI.path,
                rawQuery = exchange.requestURI.rawQuery,
                contentType = exchange.requestHeaders.getFirst("Content-Type"),
                body = bodyBytes,
            ),
        )
        val code = nextStatusCode.get()
        val resp = nextResponseBody.get()
        if (code == 204 || resp.isEmpty()) {
          exchange.sendResponseHeaders(code, -1L)
        } else {
          exchange.sendResponseHeaders(code, resp.size.toLong())
          exchange.responseBody.use { it.write(resp) }
        }
      } finally {
        exchange.close()
      }
    }
    server.start()
    httpServer = server
  }

  @After
  fun tearDown() {
    httpServer?.stop(0)
    httpServer = null
  }

  private fun baseUrl(): String {
    val server = checkNotNull(httpServer)
    return "http://127.0.0.1:${server.address.port}"
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
