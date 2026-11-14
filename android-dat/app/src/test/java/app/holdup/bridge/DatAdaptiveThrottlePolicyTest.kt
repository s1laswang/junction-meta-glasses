package app.holdup.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DatAdaptiveThrottlePolicyTest {

    @Test
    fun disconnectedAndDoffedStates_blockCaptureAndFallbackToPhoneEye() {
        val disconnectedWhileWorn = DatAdaptiveThrottlePolicy.evaluate(
            connected = false,
            worn = true,
            batteryPercent = 95,
            thermalStatus = "Normal",
        )
        assertFalse(disconnectedWhileWorn.allowCapture)
        assertTrue(disconnectedWhileWorn.fallbackToPhoneEye)
        assertEquals("disconnected", disconnectedWhileWorn.reasonCode)
        assertEquals(5000L, disconnectedWhileWorn.minIntervalMs)

        val disconnectedAndDoffedLowBattery = DatAdaptiveThrottlePolicy.evaluate(
            connected = false,
            worn = false,
            batteryPercent = 5,
            thermalStatus = "Shutdown",
            consecutiveHttpErrors = 8,
        )
        assertFalse(disconnectedAndDoffedLowBattery.allowCapture)
        assertTrue(disconnectedAndDoffedLowBattery.fallbackToPhoneEye)
        assertEquals("disconnected", disconnectedAndDoffedLowBattery.reasonCode)

        val connectedButDoffedNominal = DatAdaptiveThrottlePolicy.evaluate(
            connected = true,
            worn = false,
            batteryPercent = 100,
            thermalStatus = "Normal",
        )
        assertFalse(connectedButDoffedNominal.allowCapture)
        assertTrue(connectedButDoffedNominal.fallbackToPhoneEye)
        assertEquals("doffed", connectedButDoffedNominal.reasonCode)

        val connectedButDoffedCritical = DatAdaptiveThrottlePolicy.evaluate(
            connected = true,
            worn = false,
            batteryPercent = 5,
            thermalStatus = "Critical",
            consecutiveHttpErrors = 4,
        )
        assertFalse(connectedButDoffedCritical.allowCapture)
        assertTrue(connectedButDoffedCritical.fallbackToPhoneEye)
        assertEquals("doffed", connectedButDoffedCritical.reasonCode)
    }

    @Test
    fun batteryThresholds_enforce10PercentFloorUnder15HandoffUnder25ConservationAndNominal() {
        val explicitBatteryCases = listOf(
            BatteryExpectation(
                batteryPercent = null,
                allowCapture = true,
                minIntervalMs = 960L,
                jpegQuality = 78,
                fallbackToPhoneEye = false,
                reasonCode = "nominal_1fps",
            ),
            BatteryExpectation(
                batteryPercent = 100,
                allowCapture = true,
                minIntervalMs = 960L,
                jpegQuality = 78,
                fallbackToPhoneEye = false,
                reasonCode = "nominal_1fps",
            ),
            BatteryExpectation(
                batteryPercent = 25,
                allowCapture = true,
                minIntervalMs = 960L,
                jpegQuality = 78,
                fallbackToPhoneEye = false,
                reasonCode = "nominal_1fps",
            ),
            BatteryExpectation(
                batteryPercent = 24,
                allowCapture = true,
                minIntervalMs = 1500L,
                jpegQuality = 66,
                fallbackToPhoneEye = false,
                reasonCode = "moderate_conservation",
            ),
            BatteryExpectation(
                batteryPercent = 20,
                allowCapture = true,
                minIntervalMs = 1500L,
                jpegQuality = 66,
                fallbackToPhoneEye = false,
                reasonCode = "moderate_conservation",
            ),
            BatteryExpectation(
                batteryPercent = 15,
                allowCapture = true,
                minIntervalMs = 1500L,
                jpegQuality = 66,
                fallbackToPhoneEye = false,
                reasonCode = "moderate_conservation",
            ),
            BatteryExpectation(
                batteryPercent = 14,
                allowCapture = false,
                minIntervalMs = 5000L,
                jpegQuality = 0,
                fallbackToPhoneEye = true,
                reasonCode = "low_battery_handoff",
            ),
            BatteryExpectation(
                batteryPercent = 11,
                allowCapture = false,
                minIntervalMs = 5000L,
                jpegQuality = 0,
                fallbackToPhoneEye = true,
                reasonCode = "low_battery_handoff",
            ),
            BatteryExpectation(
                batteryPercent = 10,
                allowCapture = false,
                minIntervalMs = 5000L,
                jpegQuality = 0,
                fallbackToPhoneEye = true,
                reasonCode = "battery_floor_10pct",
            ),
            BatteryExpectation(
                batteryPercent = 5,
                allowCapture = false,
                minIntervalMs = 5000L,
                jpegQuality = 0,
                fallbackToPhoneEye = true,
                reasonCode = "battery_floor_10pct",
            ),
            BatteryExpectation(
                batteryPercent = 0,
                allowCapture = false,
                minIntervalMs = 5000L,
                jpegQuality = 0,
                fallbackToPhoneEye = true,
                reasonCode = "battery_floor_10pct",
            ),
        )

        for (case in explicitBatteryCases) {
            for (nominalThermal in listOf("Normal", "Warm")) {
                val decision = DatAdaptiveThrottlePolicy.evaluate(
                    connected = true,
                    worn = true,
                    batteryPercent = case.batteryPercent,
                    thermalStatus = nominalThermal,
                    consecutiveHttpErrors = 0,
                )
                assertEquals(
                    "Unexpected allowCapture for battery=${case.batteryPercent} thermal=$nominalThermal",
                    case.allowCapture,
                    decision.allowCapture,
                )
                assertEquals(
                    "Unexpected fallbackToPhoneEye for battery=${case.batteryPercent} thermal=$nominalThermal",
                    case.fallbackToPhoneEye,
                    decision.fallbackToPhoneEye,
                )
                assertEquals(
                    "Unexpected reasonCode for battery=${case.batteryPercent} thermal=$nominalThermal",
                    case.reasonCode,
                    decision.reasonCode,
                )
                assertEquals(
                    "Unexpected minIntervalMs for battery=${case.batteryPercent} thermal=$nominalThermal",
                    case.minIntervalMs,
                    decision.minIntervalMs,
                )
                assertEquals(
                    "Unexpected jpegQuality for battery=${case.batteryPercent} thermal=$nominalThermal",
                    case.jpegQuality,
                    decision.jpegQuality,
                )
            }
        }

        for (pct in -5..10) {
            val floorDecision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = pct,
                thermalStatus = "Normal",
            )
            assertFalse(floorDecision.allowCapture)
            assertTrue(floorDecision.fallbackToPhoneEye)
            assertEquals("battery_floor_10pct", floorDecision.reasonCode)
        }

        for (pct in 11..14) {
            val handoffDecision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = pct,
                thermalStatus = "Normal",
            )
            assertFalse(handoffDecision.allowCapture)
            assertTrue(handoffDecision.fallbackToPhoneEye)
            assertEquals("low_battery_handoff", handoffDecision.reasonCode)
        }

        for (pct in 15..24) {
            val conserveDecision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = pct,
                thermalStatus = "Normal",
            )
            assertTrue(conserveDecision.allowCapture)
            assertFalse(conserveDecision.fallbackToPhoneEye)
            assertEquals(1500L, conserveDecision.minIntervalMs)
            assertEquals(66, conserveDecision.jpegQuality)
            assertEquals("moderate_conservation", conserveDecision.reasonCode)
        }

        for (pct in 25..100) {
            val nominalDecision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = pct,
                thermalStatus = "Normal",
            )
            assertTrue(nominalDecision.allowCapture)
            assertFalse(nominalDecision.fallbackToPhoneEye)
            assertEquals(960L, nominalDecision.minIntervalMs)
            assertEquals(78, nominalDecision.jpegQuality)
            assertEquals("nominal_1fps", nominalDecision.reasonCode)
        }
    }

    @Test
    fun thermalTiers_normalWarmModerateSevereAndCutoffEnforceExactRatesAndJpegTiers() {
        for (nominalLabel in listOf("Normal", "Warm", "LIGHT", "NONE", "UNKNOWN", "", "  warm  ")) {
            assertEquals(
                DatAdaptiveThrottlePolicy.ThermalTier.NOMINAL,
                DatAdaptiveThrottlePolicy.classifyThermalStatus(nominalLabel),
            )
            for (battery in listOf(null, 25, 72, 100)) {
                val decision = DatAdaptiveThrottlePolicy.evaluate(
                    connected = true,
                    worn = true,
                    batteryPercent = battery,
                    thermalStatus = nominalLabel,
                )
                assertEquals(
                    AdaptiveCaptureDecision(
                        allowCapture = true,
                        minIntervalMs = 960L,
                        jpegQuality = 78,
                        fallbackToPhoneEye = false,
                        reasonCode = "nominal_1fps",
                    ),
                    decision,
                )
            }
        }

        for (moderateLabel in listOf("Moderate", "MODERATE", " moderate ")) {
            assertEquals(
                DatAdaptiveThrottlePolicy.ThermalTier.MODERATE,
                DatAdaptiveThrottlePolicy.classifyThermalStatus(moderateLabel),
            )
            for (battery in listOf(null, 15, 20, 25, 100)) {
                val decision = DatAdaptiveThrottlePolicy.evaluate(
                    connected = true,
                    worn = true,
                    batteryPercent = battery,
                    thermalStatus = moderateLabel,
                )
                assertEquals(
                    AdaptiveCaptureDecision(
                        allowCapture = true,
                        minIntervalMs = 1500L,
                        jpegQuality = 66,
                        fallbackToPhoneEye = false,
                        reasonCode = "moderate_conservation",
                    ),
                    decision,
                )
            }
        }

        for (severeLabel in listOf("Severe", "SEVERE", " severe ")) {
            assertEquals(
                DatAdaptiveThrottlePolicy.ThermalTier.SEVERE,
                DatAdaptiveThrottlePolicy.classifyThermalStatus(severeLabel),
            )
            for (battery in listOf(null, 15, 20, 25, 100)) {
                val decision = DatAdaptiveThrottlePolicy.evaluate(
                    connected = true,
                    worn = true,
                    batteryPercent = battery,
                    thermalStatus = severeLabel,
                )
                assertEquals(
                    AdaptiveCaptureDecision(
                        allowCapture = true,
                        minIntervalMs = 2500L,
                        jpegQuality = 54,
                        fallbackToPhoneEye = false,
                        reasonCode = "thermal_severe_throttle",
                    ),
                    decision,
                )
            }
        }

        val cutoffLabels = listOf(
            "Critical",
            "Emergency",
            "Shutdown",
            "CRITICAL",
            "EMERGENCY",
            "SHUTDOWN",
            " critical ",
        )
        for (cutoffLabel in cutoffLabels) {
            assertEquals(
                DatAdaptiveThrottlePolicy.ThermalTier.CUTOFF,
                DatAdaptiveThrottlePolicy.classifyThermalStatus(cutoffLabel),
            )
            for (battery in listOf(null, 15, 20, 25, 100)) {
                val decision = DatAdaptiveThrottlePolicy.evaluate(
                    connected = true,
                    worn = true,
                    batteryPercent = battery,
                    thermalStatus = cutoffLabel,
                )
                assertFalse(decision.allowCapture)
                assertTrue(decision.fallbackToPhoneEye)
                assertEquals("thermal_cutoff", decision.reasonCode)
                assertEquals(5000L, decision.minIntervalMs)
                assertEquals(0, decision.jpegQuality)
            }
        }
    }

    @Test
    fun precedenceHierarchy_resolvesCompoundBatteryThermalAndWearFaultsDeterministically() {
        assertEquals(
            "battery_floor_10pct",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 10,
                thermalStatus = "Critical",
            ).reasonCode,
        )
        assertEquals(
            "battery_floor_10pct",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 5,
                thermalStatus = "Shutdown",
            ).reasonCode,
        )
        assertEquals(
            "low_battery_handoff",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 14,
                thermalStatus = "Emergency",
            ).reasonCode,
        )
        assertEquals(
            "thermal_cutoff",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 15,
                thermalStatus = "Critical",
            ).reasonCode,
        )
        assertEquals(
            "thermal_severe_throttle",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 20,
                thermalStatus = "Severe",
            ).reasonCode,
        )
        assertEquals(
            "thermal_severe_throttle",
            DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 15,
                thermalStatus = "Severe",
            ).reasonCode,
        )
    }

    @Test
    fun httpErrorExponentialBackoff_multipliesMinIntervalCapsAt5000MsAndNeverOverflows() {
        for (nonPositive in listOf(Int.MIN_VALUE, -100, -1, 0)) {
            assertEquals(
                960L,
                DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(960L, nonPositive),
            )
            assertEquals(
                1500L,
                DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(1500L, nonPositive),
            )
            assertEquals(
                2500L,
                DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(2500L, nonPositive),
            )
        }

        val nominalBackoffVectors = listOf(
            0 to 960L,
            1 to 1920L,
            2 to 3840L,
            3 to 5000L,
            4 to 5000L,
            10 to 5000L,
            31 to 5000L,
            63 to 5000L,
            64 to 5000L,
            1024 to 5000L,
            Int.MAX_VALUE to 5000L,
        )
        for ((errors, expectedIntervalMs) in nominalBackoffVectors) {
            val decision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 85,
                thermalStatus = "Normal",
                consecutiveHttpErrors = errors,
            )
            assertTrue(decision.allowCapture)
            assertFalse(decision.fallbackToPhoneEye)
            assertEquals(78, decision.jpegQuality)
            assertEquals("nominal_1fps", decision.reasonCode)
            assertEquals("Nominal backoff mismatch at errors=$errors", expectedIntervalMs, decision.minIntervalMs)
        }

        val moderateBackoffVectors = listOf(
            0 to 1500L,
            1 to 3000L,
            2 to 5000L,
            3 to 5000L,
            64 to 5000L,
            Int.MAX_VALUE to 5000L,
        )
        for ((errors, expectedIntervalMs) in moderateBackoffVectors) {
            val byThermal = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 85,
                thermalStatus = "Moderate",
                consecutiveHttpErrors = errors,
            )
            val byBattery = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 20,
                thermalStatus = "Warm",
                consecutiveHttpErrors = errors,
            )
            assertEquals(expectedIntervalMs, byThermal.minIntervalMs)
            assertEquals(66, byThermal.jpegQuality)
            assertEquals("moderate_conservation", byThermal.reasonCode)
            assertEquals(byThermal, byBattery)
        }

        val severeBackoffVectors = listOf(
            0 to 2500L,
            1 to 5000L,
            2 to 5000L,
            64 to 5000L,
            Int.MAX_VALUE to 5000L,
        )
        for ((errors, expectedIntervalMs) in severeBackoffVectors) {
            val severeDecision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = 85,
                thermalStatus = "Severe",
                consecutiveHttpErrors = errors,
            )
            assertTrue(severeDecision.allowCapture)
            assertFalse(severeDecision.fallbackToPhoneEye)
            assertEquals(54, severeDecision.jpegQuality)
            assertEquals("thermal_severe_throttle", severeDecision.reasonCode)
            assertEquals(expectedIntervalMs, severeDecision.minIntervalMs)
        }
    }

    @Test
    fun monotonicSafetyInvariants_holdAcrossCartesianStateMatrixAndSessionTrajectory() {
        val allowedReasonCodes = setOf(
            "disconnected",
            "doffed",
            "battery_floor_10pct",
            "low_battery_handoff",
            "thermal_cutoff",
            "thermal_severe_throttle",
            "moderate_conservation",
            "nominal_1fps",
        )
        val batteries = listOf(null, 100, 50, 25, 24, 20, 15, 14, 11, 10, 5, 0)
        val orderedThermals = listOf(
            "Normal",
            "Warm",
            "Moderate",
            "Severe",
            "Critical",
            "Emergency",
            "Shutdown",
        )
        val orderedErrors = listOf(0, 1, 2, 3, 5, 64)

        for (connected in listOf(false, true)) {
            for (worn in listOf(false, true)) {
                for (battery in batteries) {
                    for (thermal in orderedThermals) {
                        var previousInterval = 0L
                        for (errors in orderedErrors) {
                            val decision = DatAdaptiveThrottlePolicy.evaluate(
                                connected = connected,
                                worn = worn,
                                batteryPercent = battery,
                                thermalStatus = thermal,
                                consecutiveHttpErrors = errors,
                            )
                            assertEquals(decision.allowCapture, !decision.fallbackToPhoneEye)
                            assertTrue(decision.minIntervalMs in 960L..5000L)
                            assertTrue(decision.reasonCode in allowedReasonCodes)
                            if (decision.allowCapture) {
                                assertTrue(decision.jpegQuality in setOf(54, 66, 78))
                            } else {
                                assertEquals(0, decision.jpegQuality)
                            }
                            assertTrue(decision.minIntervalMs >= previousInterval)
                            previousInterval = decision.minIntervalMs
                        }
                    }

                    var lastThermalInterval = 0L
                    var lastThermalQuality = 100
                    for (thermal in orderedThermals) {
                        val decision = DatAdaptiveThrottlePolicy.evaluate(
                            connected = connected,
                            worn = worn,
                            batteryPercent = battery,
                            thermalStatus = thermal,
                            consecutiveHttpErrors = 0,
                        )
                        assertTrue(decision.minIntervalMs >= lastThermalInterval)
                        assertTrue(decision.jpegQuality <= lastThermalQuality)
                        lastThermalInterval = decision.minIntervalMs
                        lastThermalQuality = decision.jpegQuality
                    }
                }
            }
        }

        val nominal = DatAdaptiveThrottlePolicy.evaluate(true, true, 100, "Normal", 0)
        val (allow, interval, quality, fallback, reason) = nominal
        assertTrue(allow)
        assertEquals(960L, interval)
        assertEquals(78, quality)
        assertFalse(fallback)
        assertEquals("nominal_1fps", reason)
        assertEquals(nominal, nominal.copy())
        assertEquals(nominal.hashCode(), nominal.copy().hashCode())
        assertNotEquals(nominal, nominal.copy(minIntervalMs = 1500L))
    }

    @Test
    fun defaultConsecutiveHttpErrorsParameter_matchesExplicitZeroAcrossAllTiers() {
        val probeInputs = listOf(
            Quadruple(false, false, 80, "Normal"),
            Quadruple(true, false, 80, "Normal"),
            Quadruple(true, true, 5, "Normal"),
            Quadruple(true, true, 10, "Normal"),
            Quadruple(true, true, 14, "Normal"),
            Quadruple(true, true, 15, "Normal"),
            Quadruple(true, true, 20, "Warm"),
            Quadruple(true, true, 25, "Normal"),
            Quadruple(true, true, 100, "Moderate"),
            Quadruple(true, true, 100, "Severe"),
            Quadruple(true, true, null, "Critical"),
            Quadruple(true, true, null, "Emergency"),
            Quadruple(true, true, null, "Shutdown"),
        )
        for ((connected, worn, battery, thermal) in probeInputs) {
            assertEquals(
                DatAdaptiveThrottlePolicy.evaluate(connected, worn, battery, thermal, 0),
                DatAdaptiveThrottlePolicy.evaluate(connected, worn, battery, thermal),
            )
        }
    }

    @Test
    fun sessionLifecycleTrajectory_transitionsAcrossWearThermalNetworkBackoffAndBatteryRecovery() {
        val step1Nominal = DatAdaptiveThrottlePolicy.evaluate(true, true, 92, "Normal", 0)
        assertEquals(AdaptiveCaptureDecision(true, 960L, 78, false, "nominal_1fps"), step1Nominal)

        val step2Warm = DatAdaptiveThrottlePolicy.evaluate(true, true, 85, "Warm", 0)
        assertEquals(AdaptiveCaptureDecision(true, 960L, 78, false, "nominal_1fps"), step2Warm)

        val step3TransientHttpError = DatAdaptiveThrottlePolicy.evaluate(true, true, 85, "Warm", 2)
        assertEquals(AdaptiveCaptureDecision(true, 3840L, 78, false, "nominal_1fps"), step3TransientHttpError)

        val step4HttpRecoveredModerate = DatAdaptiveThrottlePolicy.evaluate(true, true, 80, "Moderate", 0)
        assertEquals(
            AdaptiveCaptureDecision(true, 1500L, 66, false, "moderate_conservation"),
            step4HttpRecoveredModerate,
        )

        val step5SevereThermal = DatAdaptiveThrottlePolicy.evaluate(true, true, 76, "Severe", 0)
        assertEquals(
            AdaptiveCaptureDecision(true, 2500L, 54, false, "thermal_severe_throttle"),
            step5SevereThermal,
        )

        val step6CriticalCutoff = DatAdaptiveThrottlePolicy.evaluate(true, true, 74, "Critical", 0)
        assertEquals(
            AdaptiveCaptureDecision(false, 5000L, 0, true, "thermal_cutoff"),
            step6CriticalCutoff,
        )

        val step7CooledLowBatteryConserve = DatAdaptiveThrottlePolicy.evaluate(true, true, 20, "Normal", 0)
        assertEquals(
            AdaptiveCaptureDecision(true, 1500L, 66, false, "moderate_conservation"),
            step7CooledLowBatteryConserve,
        )

        val step8LowBatteryHandoff = DatAdaptiveThrottlePolicy.evaluate(true, true, 14, "Normal", 0)
        assertEquals(
            AdaptiveCaptureDecision(false, 5000L, 0, true, "low_battery_handoff"),
            step8LowBatteryHandoff,
        )

        val step9ChargeFloor = DatAdaptiveThrottlePolicy.evaluate(true, true, 10, "Normal", 0)
        assertEquals(
            AdaptiveCaptureDecision(false, 5000L, 0, true, "battery_floor_10pct"),
            step9ChargeFloor,
        )

        val step10DoffedToCharge = DatAdaptiveThrottlePolicy.evaluate(true, false, 10, "Normal", 0)
        assertEquals(
            AdaptiveCaptureDecision(false, 5000L, 0, true, "doffed"),
            step10DoffedToCharge,
        )

        val step11RechargedAndDonned = DatAdaptiveThrottlePolicy.evaluate(true, true, 65, "Normal", 0)
        assertEquals(
            AdaptiveCaptureDecision(true, 960L, 78, false, "nominal_1fps"),
            step11RechargedAndDonned,
        )
    }

    @Test
    fun baseIntervalCoercionAndUnrecognizedThermalStrings_stayBoundedWithin960To5000Ms() {
        assertEquals(960L, DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(0L, 0))
        assertEquals(960L, DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(500L, 0))
        assertEquals(1920L, DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(500L, 1))
        assertEquals(5000L, DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(9000L, 0))
        assertEquals(5000L, DatAdaptiveThrottlePolicy.applyHttpErrorBackoff(9000L, 3))

        for (unmappedThermal in listOf("Nominal", "Cool", "UNSPECIFIED")) {
            val decision = DatAdaptiveThrottlePolicy.evaluate(
                connected = true,
                worn = true,
                batteryPercent = null,
                thermalStatus = unmappedThermal,
            )
            assertEquals(
                AdaptiveCaptureDecision(true, 960L, 78, false, "nominal_1fps"),
                decision,
            )
        }
    }

    private data class Quadruple<A, B, C, D>(
        val first: A,
        val second: B,
        val third: C,
        val fourth: D,
    )

    private data class BatteryExpectation(
        val batteryPercent: Int?,
        val allowCapture: Boolean,
        val minIntervalMs: Long,
        val jpegQuality: Int,
        val fallbackToPhoneEye: Boolean,
        val reasonCode: String,
    )
}
