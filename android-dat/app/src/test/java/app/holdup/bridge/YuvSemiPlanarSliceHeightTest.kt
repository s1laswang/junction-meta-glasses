package app.holdup.bridge

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class YuvSemiPlanarSliceHeightTest {

  @Before
  fun setUp() {
    YuvJpeg.reset()
  }

  @After
  fun tearDown() {
    YuvJpeg.reset()
  }

  @Test
  fun inferStrideMatchesPaddedLumaWithUnpaddedUvSemiPlanarBuffers() {
    val size1080p = 1920 * 1088 + 1920 * (1080 / 2)
    assertEquals(Pair(1920, 1088), YuvJpeg.inferStride(size1080p, 1920, 1080))

    val size1080pWideStride = 2048 * 1088 + 2048 * (1080 / 2)
    assertEquals(Pair(2048, 1088), YuvJpeg.inferStride(size1080pWideStride, 1920, 1080))

    val size720x1280 = 768 * 1312 + 768 * (1280 / 2)
    assertEquals(Pair(768, 1312), YuvJpeg.inferStride(size720x1280, 720, 1280))
    assertEquals(Pair(736, 1296), YuvJpeg.inferStride(736 * 1296 + 736 * (1280 / 2), 720, 1280))
    assertEquals(Pair(720, 1312), YuvJpeg.inferStride(720 * 1312 + 720 * (1280 / 2), 720, 1280))

    val size770x1282 = 800 * 1312 + 800 * (1282 / 2)
    assertEquals(Pair(800, 1312), YuvJpeg.inferStride(size770x1282, 770, 1282))

    val strides770 = listOf(770, 784, 800, 832, 896, 1024)
    val paddedSliceHeights1282 = listOf(1296, 1312, 1344)
    for (stride in strides770) {
      for (sliceHeight in paddedSliceHeights1282) {
        val bytes = stride * sliceHeight + stride * (1282 / 2)
        assertEquals(Pair(stride, sliceHeight), YuvJpeg.inferStride(bytes, 770, 1282))
      }
    }
  }

  @Test
  fun inferStridePreservesFirstPassPriorityForFullSliceHeightChroma() {
    assertEquals(Pair(1920, 1080), YuvJpeg.inferStride(1920 * 1080 * 3 / 2, 1920, 1080))
    assertEquals(Pair(1920, 1088), YuvJpeg.inferStride(1920 * 1088 * 3 / 2, 1920, 1080))
    assertEquals(Pair(720, 1280), YuvJpeg.inferStride(720 * 1280 * 3 / 2, 720, 1280))
    assertEquals(Pair(768, 1280), YuvJpeg.inferStride(768 * 1280 * 3 / 2, 720, 1280))
    assertEquals(Pair(800, 1312), YuvJpeg.inferStride(800 * 1312 * 3 / 2, 770, 1282))
  }

  @Test
  fun inferStrideRejectsArbitraryInvalidBufferSizes() {
    val valid1080 = 1920 * 1088 + 1920 * 540
    val valid720 = 768 * 1312 + 768 * 640
    val valid770 = 800 * 1312 + 800 * 641

    assertNull(YuvJpeg.inferStride(0, 1920, 1080))
    assertNull(YuvJpeg.inferStride(-1, 1920, 1080))
    assertNull(YuvJpeg.inferStride(1920 * 1088, 1920, 1080))
    assertNull(YuvJpeg.inferStride(valid1080 - 1, 1920, 1080))
    assertNull(YuvJpeg.inferStride(valid1080 + 1, 1920, 1080))
    assertNull(YuvJpeg.inferStride(1930 * 1088 + 1930 * 540, 1920, 1080))
    assertNull(YuvJpeg.inferStride(1920 * 1080 * 2, 1920, 1080))

    assertNull(YuvJpeg.inferStride(0, 720, 1280))
    assertNull(YuvJpeg.inferStride(-1, 720, 1280))
    assertNull(YuvJpeg.inferStride(768 * 1312, 720, 1280))
    assertNull(YuvJpeg.inferStride(valid720 - 1, 720, 1280))
    assertNull(YuvJpeg.inferStride(valid720 + 1, 720, 1280))
    assertNull(YuvJpeg.inferStride(750 * 1312 + 750 * 640, 720, 1280))
    assertNull(YuvJpeg.inferStride(720 * 1280 * 2, 720, 1280))

    assertNull(YuvJpeg.inferStride(0, 770, 1282))
    assertNull(YuvJpeg.inferStride(-1, 770, 1282))
    assertNull(YuvJpeg.inferStride(800 * 1312, 770, 1282))
    assertNull(YuvJpeg.inferStride(valid770 - 1, 770, 1282))
    assertNull(YuvJpeg.inferStride(valid770 + 1, 770, 1282))
    assertNull(YuvJpeg.inferStride(810 * 1312 + 810 * 641, 770, 1282))
    assertNull(YuvJpeg.inferStride(770 * 1282 * 2, 770, 1282))
  }

  @Test
  fun encodeDetectsAndPacksSemiPlanarPaddedYUnpaddedUvNv12WithoutBoundsError() {
    YuvJpeg.reset()
    val frame1080p = buildSemiPlanarUnpaddedUvNv12Frame(1920, 1080, 1920, 1088)
    runEncodeUpToCompress(frame1080p, 1920, 1080)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)

    YuvJpeg.reset()
    val frame720x1280 = buildSemiPlanarUnpaddedUvNv12Frame(720, 1280, 768, 1312)
    runEncodeUpToCompress(frame720x1280, 720, 1280)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)

    YuvJpeg.reset()
    val frame770x1282 = buildSemiPlanarUnpaddedUvNv12Frame(770, 1282, 800, 1312)
    runEncodeUpToCompress(frame770x1282, 770, 1282)
    assertEquals(YuvJpeg.Layout.NV12, YuvJpeg.lastLayout)
  }

  @Test
  fun encodeFallsBackToGrayWhenPaddedLumaHasNoUvPlaneWithoutBoundsError() {
    runEncodeUpToCompress(ByteArray(1920 * 1088) { 96.toByte() }, 1920, 1080)
    assertEquals(YuvJpeg.Layout.GRAY, YuvJpeg.lastLayout)

    runEncodeUpToCompress(ByteArray(768 * 1312) { 96.toByte() }, 720, 1280)
    assertEquals(YuvJpeg.Layout.GRAY, YuvJpeg.lastLayout)

    runEncodeUpToCompress(ByteArray(800 * 1312) { 96.toByte() }, 770, 1282)
    assertEquals(YuvJpeg.Layout.GRAY, YuvJpeg.lastLayout)
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

  private fun buildSemiPlanarUnpaddedUvNv12Frame(
      w: Int,
      h: Int,
      stride: Int,
      sliceHeight: Int,
  ): ByteArray {
    val chromaStart = stride * sliceHeight
    val out = ByteArray(chromaStart + stride * (h / 2))
    for (r in 0 until h) {
      val yRow = r * stride
      for (c in 0 until w) {
        out[yRow + c] = 96.toByte()
      }
    }
    for (r in 0 until h / 2) {
      val rowStart = chromaStart + r * stride
      for (c in 0 until w / 2) {
        out[rowStart + 2 * c] = (48 + (c % 8)).toByte()
        out[rowStart + 2 * c + 1] = (204 + (c % 8)).toByte()
      }
    }
    return out
  }
}
