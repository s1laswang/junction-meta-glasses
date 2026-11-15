package app.holdup.bridge

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import java.io.ByteArrayOutputStream
import kotlin.math.abs

/**
 * Converts a DAT `VideoFrame` YUV 4:2:0 buffer (compressVideo = false) to JPEG.
 *
 * The SDK decodes HEVC with MediaCodec and hands us the raw decoder output buffer. It asks the
 * decoder for COLOR_FormatYUV420Planar (I420), but some phone decoders emit semi-planar (NV12)
 * and/or pad rows. So we infer stride and slice height from the buffer size, detect planar vs
 * semi-planar from the chroma statistics, and fall back to grayscale if the layout is unclear.
 * Grayscale is still fine for reading labels.
 */
object YuvJpeg {

  enum class Layout { I420, NV12, GRAY }

  /** Last confidently detected layout. Decoders don't change layout mid-stream. */
  @Volatile private var learned: Layout? = null

  @Volatile var lastLayout: Layout = Layout.I420
    private set

  fun reset() {
    learned = null
  }

  fun encode(src: ByteArray, width: Int, height: Int, quality: Int): ByteArray? {
    if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) return null
    val ySize = width * height
    if (src.size < ySize) return null

    val (stride, sliceHeight) = inferStride(src.size, width, height) ?: Pair(width, height)
    val hasChroma = src.size >= stride * sliceHeight + (stride / 2) * (height / 2) * 2
    val layout =
        when {
          !hasChroma -> Layout.GRAY
          else -> detectLayout(src, width, height, stride, sliceHeight)
        }
    lastLayout = layout

    val nv21 = ByteArray(ySize + ySize / 2)
    // Luma, row by row (handles stride padding).
    for (row in 0 until height) {
      System.arraycopy(src, row * stride, nv21, row * width, width)
    }
    val cw = width / 2
    val ch = height / 2
    var o = ySize
    val chromaStart = stride * sliceHeight
    when (layout) {
      Layout.I420 -> {
        val cStride = stride / 2
        val uStart = chromaStart
        val vStart = uStart + cStride * (sliceHeight / 2)
        if (vStart + cStride * (ch - 1) + cw > src.size) return grayscale(nv21, width, height, quality)
        for (r in 0 until ch) {
          val ur = uStart + r * cStride
          val vr = vStart + r * cStride
          for (c in 0 until cw) {
            nv21[o++] = src[vr + c]
            nv21[o++] = src[ur + c]
          }
        }
      }
      Layout.NV12 -> {
        if (chromaStart + stride * (ch - 1) + width > src.size) return grayscale(nv21, width, height, quality)
        for (r in 0 until ch) {
          val rowStart = chromaStart + r * stride
          for (c in 0 until cw) {
            nv21[o++] = src[rowStart + 2 * c + 1] // V
            nv21[o++] = src[rowStart + 2 * c] // U
          }
        }
      }
      Layout.GRAY -> return grayscale(nv21, width, height, quality)
    }
    return compress(nv21, width, height, quality)
  }

  private fun grayscale(nv21: ByteArray, w: Int, h: Int, quality: Int): ByteArray? {
    java.util.Arrays.fill(nv21, w * h, nv21.size, 128.toByte())
    return compress(nv21, w, h, quality)
  }

  private fun compress(nv21: ByteArray, w: Int, h: Int, quality: Int): ByteArray? {
    val out = ByteArrayOutputStream(w * h / 4)
    val ok = YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), quality, out)
    return if (ok) out.toByteArray() else null
  }

  /** Finds (stride, sliceHeight) such that the buffer is exactly one padded 4:2:0 frame. */
  internal fun inferStride(size: Int, w: Int, h: Int): Pair<Int, Int>? {
    fun align(v: Int, a: Int) = (v + a - 1) / a * a
    val strides = listOf(w, align(w, 16), align(w, 32), align(w, 64), align(w, 128), align(w, 256)).distinct()
    val heights = listOf(h, align(h, 16), align(h, 32), align(h, 64)).distinct()
    for (s in strides) for (sh in heights) {
      if (s * sh * 3 / 2 == size) return Pair(s, sh)
    }
    for (s in strides) for (sh in heights) {
      if (sh > h && s * sh + s * (h / 2) == size) return Pair(s, sh)
    }
    val guardHeights = listOf(align(h + 1, 16), align(h + 1, 32), align(h + 1, 64)).distinct()
    for (s in strides) for (sh in guardHeights) {
      if (sh > h && s * sh + s * (h / 2) == size) return Pair(s, sh)
    }
    return null
  }

  /**
   * Interleaved chroma (UVUV…) has big differences between neighbouring bytes (U vs V) but small
   * differences two bytes apart (U vs U). A planar U plane is smooth at lag 1.
   */
  internal fun detectLayout(src: ByteArray, w: Int, h: Int, stride: Int, sliceHeight: Int): Layout {
    val start = stride * sliceHeight
    var lag1 = 0L
    var lag2 = 0L
    var n = 0
    val rows = minOf(h / 2, 64)
    val step = maxOf(1, (h / 2) / rows)
    var r = 0
    while (r < h / 2 && n < 40_000) {
      // Look at the first half-width bytes of each chroma row; valid for both layouts.
      val base = start + r * (stride / 2)
      val end = minOf(base + w / 2 - 2, src.size - 2)
      var i = base
      while (i < end) {
        val a = src[i].toInt() and 0xFF
        lag1 += abs(a - (src[i + 1].toInt() and 0xFF))
        lag2 += abs(a - (src[i + 2].toInt() and 0xFF))
        n++
        i += 2
      }
      r += step
    }
    if (n == 0) return learned ?: Layout.I420
    val m1 = lag1.toDouble() / n
    val m2 = lag2.toDouble() / n
    val decided =
        when {
          m1 > m2 * 1.5 + 1.0 -> Layout.NV12
          m2 > m1 * 1.2 + 0.5 || (m1 < m2 && m2 > 2.0) -> Layout.I420
          else -> null // flat scene, can't tell
        }
    if (decided != null) learned = decided
    return decided ?: learned ?: Layout.I420
  }
}
