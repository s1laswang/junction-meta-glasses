package app.holdup.bridge

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class YuvJpegTest {

  @Before
  fun setUp() {
    YuvJpeg.reset()
  }

  @After
  fun tearDown() {
    YuvJpeg.reset()
  }

  @Test
  fun inferStrideExactUnpadded420() {
    assertEquals(Pair(720, 1280), YuvJpeg.inferStride(720 * 1280 * 3 / 2, 720, 1280))
    assertEquals(Pair(1920, 1080), YuvJpeg.inferStride(1920 * 1080 * 3 / 2, 1920, 1080))
    assertEquals(Pair(640, 480), YuvJpeg.inferStride(640 * 480 * 3 / 2, 640, 480))
  }

  @Test
  fun inferStrideAlignedRowStridesAndSliceHeights() {
    val w = 770
    val h = 1282
    val expectedStrides = listOf(770, 784, 800, 832, 896, 1024)
    val expectedSliceHeights = listOf(1282, 1296, 1312, 1344)

    for (stride in expectedStrides) {
      for (sliceHeight in expectedSliceHeights) {
        val frameBytes = stride * sliceHeight * 3 / 2
        assertEquals(Pair(stride, sliceHeight), YuvJpeg.inferStride(frameBytes, w, h))
      }
    }

    assertEquals(Pair(736, 1280), YuvJpeg.inferStride(736 * 1280 * 3 / 2, 720, 1280))
    assertEquals(Pair(768, 1280), YuvJpeg.inferStride(768 * 1280 * 3 / 2, 720, 1280))
    assertEquals(Pair(1920, 1088), YuvJpeg.inferStride(1920 * 1088 * 3 / 2, 1920, 1080))
  }

  @Test
  fun inferStrideNonMatchingSizesReturnNull() {
    val exact720p = 720 * 1280 * 3 / 2
    assertNull(YuvJpeg.inferStride(0, 720, 1280))
    assertNull(YuvJpeg.inferStride(-1, 720, 1280))
    assertNull(YuvJpeg.inferStride(720 * 1280, 720, 1280))
    assertNull(YuvJpeg.inferStride(exact720p - 1, 720, 1280))
    assertNull(YuvJpeg.inferStride(exact720p + 1, 720, 1280))
    assertNull(YuvJpeg.inferStride(720 * 1280 * 2, 720, 1280))
    assertNull(YuvJpeg.inferStride(750 * 1280 * 3 / 2, 720, 1280))
  }

  @Test
  fun detectLayoutRecognizesSmoothPlanarI420() {
    val src64 = buildPlanarI420Frame(64, 64, 64, 64)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(src64, 64, 64, 64, 64))

    val srcTall = buildPlanarI420Frame(128, 256, 128, 256)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(srcTall, 128, 256, 128, 256))
  }

  @Test
  fun detectLayoutRecognizesPaddedSmoothPlanarI420() {
    val src50 = buildPlanarI420Frame(50, 50, 64, 64)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(src50, 50, 50, 64, 64))

    val src120 = buildPlanarI420Frame(120, 80, 128, 96)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(src120, 120, 80, 128, 96))
  }

  @Test
  fun detectLayoutRecognizesInterleavedNv12() {
    val src64 = buildInterleavedNv12Frame(64, 64, 64, 64)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(src64, 64, 64, 64, 64))

    val srcTall = buildInterleavedNv12Frame(128, 256, 128, 256)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(srcTall, 128, 256, 128, 256))
  }

  @Test
  fun detectLayoutRecognizesPaddedInterleavedNv12() {
    val src50 = buildInterleavedNv12Frame(50, 50, 64, 64)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(src50, 50, 50, 64, 64))

    val src120 = buildInterleavedNv12Frame(120, 80, 128, 96)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(src120, 120, 80, 128, 96))
  }

  @Test
  fun detectLayoutRemembersLearnedLayoutOnFlatSceneUntilReset() {
    val w = 64
    val h = 64
    val flat = ByteArray(w * h * 3 / 2) { 128.toByte() }
    val nv12 = buildInterleavedNv12Frame(w, h, w, h)
    val i420 = buildPlanarI420Frame(w, h, w, h)

    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(flat, w, h, w, h))

    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(nv12, w, h, w, h))
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(flat, w, h, w, h))

    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(i420, w, h, w, h))
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(flat, w, h, w, h))

    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(nv12, w, h, w, h))
    YuvJpeg.reset()
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(flat, w, h, w, h))
  }

  @Test
  fun detectLayoutZeroSampleChromaUsesLearnedOrDefaultsAfterReset() {
    val nv12 = buildInterleavedNv12Frame(64, 64, 64, 64)
    val tiny = ByteArray(4 * 4 * 3 / 2) { 128.toByte() }

    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(tiny, 4, 4, 4, 4))
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(nv12, 64, 64, 64, 64))
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(tiny, 4, 4, 4, 4))

    YuvJpeg.reset()
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.detectLayout(tiny, 4, 4, 4, 4))
  }

  @Test
  fun encodeFallsBackToGrayWhenChromaMissingOrIncompleteAndPreservesLearnedLayout() {
    val nv12 = buildInterleavedNv12Frame(64, 64, 64, 64)
    runEncodeUpToCompress(nv12, 64, 64)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)

    val lumaOnly = ByteArray(64 * 48) { 90.toByte() }
    runEncodeUpToCompress(lumaOnly, 64, 48)
    assertEquals(YuvJpeg.Layout.GRAY, YuvJpeg.lastLayout)

    val incompleteChroma = ByteArray(64 * 48 * 3 / 2 - 1) { 90.toByte() }
    runEncodeUpToCompress(incompleteChroma, 64, 48)
    assertEquals(YuvJpeg.Layout.GRAY, YuvJpeg.lastLayout)

    val flat = ByteArray(64 * 64 * 3 / 2) { 128.toByte() }
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.detectLayout(flat, 64, 64, 64, 64))
  }

  @Test
  fun encodePacksUnpaddedAndPaddedI420AndNv12FramesWithoutBoundsError() {
    runEncodeUpToCompress(buildPlanarI420Frame(64, 48, 64, 48), 64, 48)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.lastLayout)

    runEncodeUpToCompress(buildPlanarI420Frame(120, 80, 128, 96), 120, 80)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.lastLayout)

    runEncodeUpToCompress(buildInterleavedNv12Frame(64, 48, 64, 48), 64, 48)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)

    runEncodeUpToCompress(buildInterleavedNv12Frame(120, 80, 128, 96), 120, 80)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)

    val i420WithTrailingBytes = buildPlanarI420Frame(64, 48, 64, 48) + ByteArray(16)
    runEncodeUpToCompress(i420WithTrailingBytes, 64, 48)
    assertEquals(YuvJpeg.Layout.I420, YuvJpeg.lastLayout)
  }

  @Test
  fun encodeRejectsNonPositiveDimensions() {
    val before = YuvJpeg.lastLayout
    val buf = ByteArray(64)
    assertNull(YuvJpeg.encode(buf, 0, 4, 80))
    assertNull(YuvJpeg.encode(buf, -2, 4, 80))
    assertNull(YuvJpeg.encode(buf, -1, 4, 80))
    assertNull(YuvJpeg.encode(buf, 4, 0, 80))
    assertNull(YuvJpeg.encode(buf, 4, -2, 80))
    assertNull(YuvJpeg.encode(buf, 4, -1, 80))
    assertNull(YuvJpeg.encode(buf, 0, 0, 80))
    assertEquals(before, YuvJpeg.lastLayout)
  }

  @Test
  fun encodeRejectsOddWidthOrOddHeight() {
    val before = YuvJpeg.lastLayout
    val buf = ByteArray(256)
    assertNull(YuvJpeg.encode(buf, 1, 4, 80))
    assertNull(YuvJpeg.encode(buf, 3, 4, 80))
    assertNull(YuvJpeg.encode(buf, 4, 1, 80))
    assertNull(YuvJpeg.encode(buf, 4, 3, 80))
    assertNull(YuvJpeg.encode(buf, 5, 5, 80))
    assertEquals(before, YuvJpeg.lastLayout)
  }

  @Test
  fun encodeRejectsEmptyOrUndersizedBuffer() {
    val before = YuvJpeg.lastLayout
    assertNull(YuvJpeg.encode(ByteArray(0), 4, 4, 80))
    assertNull(YuvJpeg.encode(ByteArray(15), 4, 4, 80))
    assertNull(YuvJpeg.encode(ByteArray(720 * 1280 - 1), 720, 1280, 80))
    assertEquals(before, YuvJpeg.lastLayout)
  }

  private fun runEncodeUpToCompress(
      src: ByteArray,
      width: Int,
      height: Int,
      quality: Int = 80,
  ) {
    try {
      YuvJpeg.encode(src, width, height, quality)
    } catch (e: RuntimeException) {
      val fromAndroidStub =
          e.javaClass == RuntimeException::class.java &&
              (e.message?.contains("not mocked") == true ||
                  e.message?.contains("Stub!") == true ||
                  e.stackTrace.any { it.className.startsWith("android.graphics.") })
      if (!fromAndroidStub) throw e
    }
  }

  private fun buildPlanarI420Frame(w: Int, h: Int, stride: Int, sliceHeight: Int): ByteArray {
    val out = ByteArray(stride * sliceHeight * 3 / 2) { 128.toByte() }
    val uStart = stride * sliceHeight
    val cStride = stride / 2
    val vStart = uStart + cStride * (sliceHeight / 2)
    for (r in 0 until h / 2) {
      for (c in 0 until w / 2) {
        out[uStart + r * cStride + c] = (20 + c * 4).coerceIn(0, 255).toByte()
        out[vStart + r * cStride + c] = (220 - c * 4).coerceIn(0, 255).toByte()
      }
    }
    return out
  }

  private fun buildInterleavedNv12Frame(w: Int, h: Int, stride: Int, sliceHeight: Int): ByteArray {
    val out = ByteArray(stride * sliceHeight * 3 / 2) { 128.toByte() }
    val chromaStart = stride * sliceHeight
    for (r in 0 until h / 2) {
      val rowStart = chromaStart + r * stride
      for (c in 0 until w / 2) {
        out[rowStart + 2 * c] = (50 + (c % 8)).toByte()
        out[rowStart + 2 * c + 1] = (200 + (c % 8)).toByte()
      }
    }
    return out
  }
}
