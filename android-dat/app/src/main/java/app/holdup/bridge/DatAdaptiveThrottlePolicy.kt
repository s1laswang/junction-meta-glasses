package app.holdup.bridge

import java.util.Locale

data class AdaptiveCaptureDecision(
    val allowCapture: Boolean,
    val minIntervalMs: Long,
    val jpegQuality: Int,
    val fallbackToPhoneEye: Boolean,
    val reasonCode: String,
)

object DatAdaptiveThrottlePolicy {
    const val NOMINAL_INTERVAL_MS = 960L
    const val MODERATE_INTERVAL_MS = 1500L
    const val SEVERE_INTERVAL_MS = 2500L
    const val MAX_BACKOFF_INTERVAL_MS = 5000L

    const val NOMINAL_JPEG_QUALITY = 78
    const val MODERATE_JPEG_QUALITY = 66
    const val SEVERE_JPEG_QUALITY = 54
    const val DISABLED_JPEG_QUALITY = 0

    const val BATTERY_FLOOR_PERCENT = 10
    const val LOW_BATTERY_HANDOFF_PERCENT = 15
    const val MODERATE_BATTERY_CONSERVATION_PERCENT = 25

    const val REASON_DISCONNECTED = "disconnected"
    const val REASON_DOFFED = "doffed"
    const val REASON_BATTERY_FLOOR = "battery_floor_10pct"
    const val REASON_LOW_BATTERY_HANDOFF = "low_battery_handoff"
    const val REASON_THERMAL_CUTOFF = "thermal_cutoff"
    const val REASON_THERMAL_SEVERE = "thermal_severe_throttle"
    const val REASON_MODERATE_CONSERVATION = "moderate_conservation"
    const val REASON_NOMINAL = "nominal_1fps"

    private const val MAX_BACKOFF_SHIFT = 6

    enum class ThermalTier {
        NOMINAL,
        MODERATE,
        SEVERE,
        CUTOFF,
    }

    fun classifyThermalStatus(thermalStatus: String): ThermalTier {
        return when (thermalStatus.trim().lowercase(Locale.ROOT)) {
            "critical",
            "emergency",
            "shutdown" -> ThermalTier.CUTOFF
            "severe" -> ThermalTier.SEVERE
            "moderate" -> ThermalTier.MODERATE
            "normal",
            "warm",
            "light",
            "none",
            "unknown",
            "" -> ThermalTier.NOMINAL
            else -> ThermalTier.NOMINAL
        }
    }

    fun applyHttpErrorBackoff(baseIntervalMs: Long, consecutiveHttpErrors: Int): Long {
        val clampedBase = baseIntervalMs.coerceIn(NOMINAL_INTERVAL_MS, MAX_BACKOFF_INTERVAL_MS)
        if (consecutiveHttpErrors <= 0) {
            return clampedBase
        }
        val shift = consecutiveHttpErrors.coerceAtMost(MAX_BACKOFF_SHIFT)
        val multiplied = clampedBase * (1L shl shift)
        return multiplied.coerceAtMost(MAX_BACKOFF_INTERVAL_MS)
    }

    fun evaluate(
        connected: Boolean,
        worn: Boolean,
        batteryPercent: Int?,
        thermalStatus: String,
        consecutiveHttpErrors: Int = 0,
    ): AdaptiveCaptureDecision {
        if (!connected) {
            return blockedDecision(REASON_DISCONNECTED)
        }
        if (!worn) {
            return blockedDecision(REASON_DOFFED)
        }
        if (batteryPercent != null && batteryPercent <= BATTERY_FLOOR_PERCENT) {
            return blockedDecision(REASON_BATTERY_FLOOR)
        }
        if (batteryPercent != null && batteryPercent < LOW_BATTERY_HANDOFF_PERCENT) {
            return blockedDecision(REASON_LOW_BATTERY_HANDOFF)
        }

        val thermalTier = classifyThermalStatus(thermalStatus)
        if (thermalTier == ThermalTier.CUTOFF) {
            return blockedDecision(REASON_THERMAL_CUTOFF)
        }
        if (thermalTier == ThermalTier.SEVERE) {
            return AdaptiveCaptureDecision(
                allowCapture = true,
                minIntervalMs = applyHttpErrorBackoff(SEVERE_INTERVAL_MS, consecutiveHttpErrors),
                jpegQuality = SEVERE_JPEG_QUALITY,
                fallbackToPhoneEye = false,
                reasonCode = REASON_THERMAL_SEVERE,
            )
        }
        if (
            thermalTier == ThermalTier.MODERATE ||
            (batteryPercent != null && batteryPercent < MODERATE_BATTERY_CONSERVATION_PERCENT)
        ) {
            return AdaptiveCaptureDecision(
                allowCapture = true,
                minIntervalMs = applyHttpErrorBackoff(MODERATE_INTERVAL_MS, consecutiveHttpErrors),
                jpegQuality = MODERATE_JPEG_QUALITY,
                fallbackToPhoneEye = false,
                reasonCode = REASON_MODERATE_CONSERVATION,
            )
        }

        return AdaptiveCaptureDecision(
            allowCapture = true,
            minIntervalMs = applyHttpErrorBackoff(NOMINAL_INTERVAL_MS, consecutiveHttpErrors),
            jpegQuality = NOMINAL_JPEG_QUALITY,
            fallbackToPhoneEye = false,
            reasonCode = REASON_NOMINAL,
        )
    }

    private fun blockedDecision(reasonCode: String): AdaptiveCaptureDecision {
        return AdaptiveCaptureDecision(
            allowCapture = false,
            minIntervalMs = MAX_BACKOFF_INTERVAL_MS,
            jpegQuality = DISABLED_JPEG_QUALITY,
            fallbackToPhoneEye = true,
            reasonCode = reasonCode,
        )
    }
}
