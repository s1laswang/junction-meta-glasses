package app.holdup.bridge

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PostResultAndForegroundContractTest {

  private fun resolveSource(relFromAppMain: String, dir: File = File(System.getProperty("user.dir") ?: ".")): File =
      listOf(
              "src/main/$relFromAppMain",
              "app/src/main/$relFromAppMain",
              "android-dat/app/src/main/$relFromAppMain",
          )
          .map { File(dir, it) }
          .firstOrNull { it.isFile } ?: error("Source $relFromAppMain not found from ${dir.absolutePath}")

  private fun describeResult(result: PostResult): String =
      when (result) {
        is PostResult.Ok -> "ok:${result.code}"
        is PostResult.HttpError -> "http:${result.code}"
        is PostResult.NetworkError -> "net:${result.message}"
      }

  @Test
  fun postResultSubtypesPreserveEqualityAndExhaustiveDispatch() {
    val ok200 = PostResult.Ok(200)
    val ok204 = PostResult.Ok(204)
    val err404 = PostResult.HttpError(404)
    val err503 = PostResult.HttpError(503)
    val netTimeout = PostResult.NetworkError("SocketTimeoutException: timeout")

    assertEquals(PostResult.Ok(204), ok204)
    assertNotEquals(ok200, ok204)
    assertEquals(PostResult.HttpError(404), err404)
    assertNotEquals(err404, err503)
    assertEquals(PostResult.NetworkError("SocketTimeoutException: timeout"), netTimeout)
    assertNotEquals(ok200 as PostResult, err404 as PostResult)
    assertNotEquals(err404 as PostResult, netTimeout as PostResult)

    assertEquals("ok:200", describeResult(ok200))
    assertEquals("ok:204", describeResult(ok204))
    assertEquals("http:404", describeResult(err404))
    assertEquals("http:503", describeResult(err503))
    assertEquals("net:SocketTimeoutException: timeout", describeResult(netTimeout))
  }

  @Test
  fun streamingServiceEnforcesConnectedDeviceForegroundAndWakeLockSafety() {
    val src = resolveSource("java/app/holdup/bridge/StreamingService.kt").readText()
    assertTrue(src.contains("CHANNEL_ID = \"holdup_streaming\""))
    assertTrue(src.contains("ACTION_STOP = \"app.holdup.bridge.STOP\""))
    assertTrue(src.contains("WAKELOCK_TIMEOUT_MS"))
    assertTrue(src.contains("ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE"))
    assertTrue(src.contains("NotificationManager.IMPORTANCE_LOW"))
    assertTrue(src.contains("PowerManager.PARTIAL_WAKE_LOCK"))
    assertTrue(src.contains("STOP_FOREGROUND_REMOVE"))
    assertTrue(src.contains("PendingIntent.FLAG_IMMUTABLE"))
    assertTrue(src.contains("START_NOT_STICKY"))
  }

  @Test
  fun mainActivityClearsPermissionRequesterAndKeepsScreenAwakeOnlyWhileStreaming() {
    val src = resolveSource("java/app/holdup/bridge/MainActivity.kt").readText()
    assertTrue(src.contains("viewModel.permissionRequester = null"))
    assertTrue(src.contains("FLAG_KEEP_SCREEN_ON"))
    assertTrue(src.contains("Wearables.RequestPermissionContract()"))
    assertTrue(src.contains("BLUETOOTH"))
    assertTrue(src.contains("BLUETOOTH_CONNECT"))
    assertTrue(src.contains("INTERNET"))
    assertTrue(src.contains("POST_NOTIFICATIONS"))
    assertFalse(src.contains("android.Manifest.permission.CAMERA"))
  }

  @Test
  fun bridgeViewModelValidatesDeepLinkSchemeAndDatStreamParameters() {
    val src = resolveSource("java/app/holdup/bridge/BridgeViewModel.kt").readText()
    assertTrue(src.contains("uri.scheme != \"holdupbridge\""))
    assertTrue(src.contains("uri.host != \"connect\""))
    assertTrue(src.contains("STREAM_FPS = 2"))
    assertTrue(src.contains("FRAME_INTERVAL_MS = 1_000L"))
    assertTrue(src.contains("MAX_BACKOFF_MS = 8_000L"))
    assertTrue(src.contains("JPEG_QUALITY = 80"))
    assertTrue(src.contains("STATE_HEARTBEAT_MS = 10_000L"))
  }
}
