package app.holdup.bridge

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

object YuvJpegEncoder {
    fun i420ToNv21(buffer: ByteBuffer, width: Int, height: Int): ByteArray {
        require(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0) {
            "I420 dimensions must be positive even integers, got ${width}x${height}"
        }
        val ySize = width * height
        val uvSize = ySize / 4
        val totalBytes = ySize + uvSize * 2

        val src = buffer.duplicate()
        if (src.remaining() < totalBytes && src.position() > 0 && src.limit() >= totalBytes) {
            src.rewind()
        }
        require(src.remaining() >= totalBytes) {
            "I420 buffer too small: expected at least $totalBytes bytes, got ${src.remaining()}"
        }

        val nv21 = ByteArray(totalBytes)
        src.get(nv21, 0, ySize)

        val uPlane = ByteArray(uvSize)
        val vPlane = ByteArray(uvSize)
        src.get(uPlane, 0, uvSize)
        src.get(vPlane, 0, uvSize)

        var outOffset = ySize
        for (i in 0 until uvSize) {
            nv21[outOffset++] = vPlane[i]
            nv21[outOffset++] = uPlane[i]
        }
        return nv21
    }

    fun encodeNv21ToJpeg(
        nv21: ByteArray,
        width: Int,
        height: Int,
        rotationDegrees: Int = 0,
        quality: Int = 78,
    ): ByteArray {
        require(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0) {
            "NV21 dimensions must be positive even integers, got ${width}x${height}"
        }
        val expectedBytes = width * height + (width * height) / 2
        require(nv21.size >= expectedBytes) {
            "NV21 array too small: expected at least $expectedBytes bytes, got ${nv21.size}"
        }

        val clampedQuality = quality.coerceIn(1, 100)
        val rawOutput = ByteArrayOutputStream(expectedBytes / 8)
        val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
        val compressed = yuvImage.compressToJpeg(Rect(0, 0, width, height), clampedQuality, rawOutput)
        check(compressed) { "YuvImage.compressToJpeg failed for ${width}x${height}" }
        val jpegBytes = rawOutput.toByteArray()

        val normalizedRotation = ((rotationDegrees % 360) + 360) % 360
        if (normalizedRotation == 0) {
            return jpegBytes
        }

        val decoded = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size)
            ?: error("BitmapFactory.decodeByteArray returned null")
        val rotated = try {
            val matrix = Matrix().apply { postRotate(normalizedRotation.toFloat()) }
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        } catch (t: Throwable) {
            decoded.recycle()
            throw t
        }

        try {
            val rotatedOutput = ByteArrayOutputStream(jpegBytes.size)
            val rotatedOk = rotated.compress(Bitmap.CompressFormat.JPEG, clampedQuality, rotatedOutput)
            check(rotatedOk) { "Bitmap.compress failed after rotating by $normalizedRotation degrees" }
            return rotatedOutput.toByteArray()
        } finally {
            if (rotated !== decoded) {
                rotated.recycle()
            }
            decoded.recycle()
        }
    }

    fun encodeBufferToJpeg(
        buffer: ByteBuffer,
        width: Int,
        height: Int,
        rotationDegrees: Int = 0,
        quality: Int = 78,
    ): ByteArray {
        val nv21 = i420ToNv21(buffer, width, height)
        return encodeNv21ToJpeg(
            nv21 = nv21,
            width = width,
            height = height,
            rotationDegrees = rotationDegrees,
            quality = quality,
        )
    }
}
