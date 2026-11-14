package app.holdup.bridge

import android.app.Activity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val LedBannerBg = Color(0xFF06261D)
private val LedBannerBorder = Color(0xFF2DD4A0)
private val LedBannerAccent = Color(0xFF7EF7C8)
private val WarnFg = Color(0xFFFFE169)
private val ErrorBg = Color(0xFF2D0E0A)
private val ErrorBorder = Color(0xFFFF6B52)
private val ErrorFg = Color(0xFFFFB8AB)

@Composable
fun BridgeScreen(
    activity: Activity,
    modifier: Modifier = Modifier
) {
    val uiState by DatBridgeController.uiState.collectAsState()
    BridgeScreen(
        uiState = uiState,
        onUpdateEndpoint = { serverUrl, sessionCode ->
            BridgePreferences.saveEndpoint(activity.applicationContext, serverUrl, sessionCode)
            DatBridgeController.updateEndpoint(serverUrl, sessionCode)
        },
        onConnectGlasses = {
            DatBridgeController.connectGlasses(activity)
        },
        onStartStreaming = {
            DatBridgeController.startStreaming(activity.applicationContext)
        },
        onStopStreaming = {
            DatBridgeController.stopStreaming(activity.applicationContext)
        },
        onDisconnect = {
            DatBridgeController.disconnect(activity.applicationContext)
        },
        onOpenFirmwareUpdate = {
            DatBridgeController.openFirmwareUpdate(activity)
        },
        onOpenGlassesAppUpdate = {
            DatBridgeController.openGlassesAppUpdate(activity)
        },
        modifier = modifier,
        onForgetEndpoint = {
            BridgePreferences.clearSavedEndpoint(activity.applicationContext)
            DatBridgeController.updateEndpoint("", "")
        }
    )
}

@Composable
fun BridgeScreen(
    uiState: BridgeUiState,
    onUpdateEndpoint: (serverUrl: String, sessionCode: String) -> Unit,
    onConnectGlasses: () -> Unit,
    onStartStreaming: () -> Unit,
    onStopStreaming: () -> Unit,
    onDisconnect: () -> Unit,
    onOpenFirmwareUpdate: () -> Unit,
    onOpenGlassesAppUpdate: () -> Unit,
    modifier: Modifier = Modifier,
    onForgetEndpoint: () -> Unit = {}
) {
    var serverInput by rememberSaveable { mutableStateOf(uiState.serverUrl) }
    var sessionInput by rememberSaveable { mutableStateOf(uiState.sessionCode) }

    LaunchedEffect(uiState.serverUrl) {
        if (uiState.serverUrl != serverInput.trim().trimEnd('/')) {
            serverInput = uiState.serverUrl
        }
    }

    LaunchedEffect(uiState.sessionCode) {
        if (uiState.sessionCode != sessionInput.trim()) {
            sessionInput = uiState.sessionCode
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "HoldUp Glasses Bridge (DAT 1.0.1)",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.semantics { heading() }
                )
                Text(
                    text = "Meta Wearables Developer Mode (App ID 0) - 720x1280 @ ~1 fps RAM-only ingest",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            if (uiState.streaming) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics(mergeDescendants = true) {
                            liveRegion = LiveRegionMode.Polite
                            contentDescription =
                                "Privacy notice: Glasses camera is streaming and the front hardware capture LED is illuminated. Frames stream at roughly 1 frame per second into server RAM only and are never stored on disk."
                        },
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = LedBannerBg),
                    border = BorderStroke(2.dp, LedBannerBorder)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(
                            text = "CAMERA ON - CAPTURE LED ACTIVE",
                            fontSize = 15.sp,
                            fontWeight = FontWeight.ExtraBold,
                            color = LedBannerAccent
                        )
                        Text(
                            text = "The front capture LED on your glasses stays illuminated while streaming. Frames are throttled to ~1 fps in server memory only and never written to disk.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
            }

            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = "Endpoint Pairing",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.semantics { heading() }
                    )
                    Text(
                        text = "Scan the QR code in the HoldUp PWA Device Panel to prefill automatically, or enter values manually.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    OutlinedTextField(
                        value = serverInput,
                        onValueChange = { updated ->
                            serverInput = updated
                            onUpdateEndpoint(updated.trim().trimEnd('/'), sessionInput.trim())
                        },
                        label = { Text("Server URL") },
                        placeholder = { Text("Public HTTPS tunnel or server origin") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Next
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics {
                                contentDescription = "Server URL input field"
                            }
                    )

                    OutlinedTextField(
                        value = sessionInput,
                        onValueChange = { updated ->
                            sessionInput = updated
                            onUpdateEndpoint(serverInput.trim().trimEnd('/'), updated.trim())
                        },
                        label = { Text("Session Code (blank = follow latest)") },
                        placeholder = { Text("Leave blank to attach to latest active session") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Done
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics {
                                contentDescription = "Session Code input field, leave blank to follow latest active session"
                            }
                    )

                    OutlinedButton(
                        onClick = {
                            serverInput = ""
                            sessionInput = ""
                            onForgetEndpoint()
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .semantics {
                                contentDescription = "Forget Saved Server and clear stored endpoint preferences"
                            },
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
                    ) {
                        Text(
                            text = "Forget Saved Server",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
            }

            StatusCard(uiState = uiState)

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = "Primary Actions",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.semantics { heading() }
                )

                Button(
                    onClick = {
                        onUpdateEndpoint(serverInput.trim().trimEnd('/'), sessionInput.trim())
                        onConnectGlasses()
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .semantics {
                            contentDescription = "Connect Glasses in Meta AI Developer Mode"
                        },
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    ),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
                ) {
                    Text(
                        text = "Connect Glasses",
                        fontSize = 17.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                if (uiState.streaming) {
                    Button(
                        onClick = onStopStreaming,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .semantics {
                                contentDescription = "Stop Streaming and turn off glasses capture LED"
                            },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        ),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
                    ) {
                        Text(
                            text = "Stop Streaming",
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                } else {
                    Button(
                        onClick = {
                            onUpdateEndpoint(serverInput.trim().trimEnd('/'), sessionInput.trim())
                            onStartStreaming()
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .semantics {
                                contentDescription = "Start Streaming first-person camera frames from glasses"
                            },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = LedBannerAccent,
                            contentColor = LedBannerBg
                        ),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
                    ) {
                        Text(
                            text = "Start Streaming",
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                OutlinedButton(
                    onClick = onDisconnect,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .semantics {
                            contentDescription = "Disconnect glasses DAT session"
                        },
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.onBackground
                    ),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
                ) {
                    Text(
                        text = "Disconnect",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Troubleshooting",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.semantics { heading() }
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = onOpenFirmwareUpdate,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 56.dp)
                            .semantics {
                                contentDescription = "Update Glasses Firmware in Meta AI app"
                            },
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)
                    ) {
                        Text(
                            text = "Update Glasses Firmware",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center
                        )
                    }

                    OutlinedButton(
                        onClick = onOpenGlassesAppUpdate,
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 56.dp)
                            .semantics {
                                contentDescription = "Update Glasses DAT App in Meta AI app"
                            },
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp)
                    ) {
                        Text(
                            text = "Update Glasses DAT App",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
        }
    }
}

@Composable
private fun StatusCard(uiState: BridgeUiState) {
    val registrationValue = if (uiState.sdkReady) {
        uiState.registrationStatus
    } else {
        "${uiState.registrationStatus} (SDK initializing)"
    }
    val deviceNameValue = uiState.deviceName?.takeIf { it.isNotBlank() } ?: "Not connected"
    val connectionWornValue = buildString {
        append(if (uiState.connected) "Connected" else "Disconnected")
        append(" / ")
        append(
            when {
                !uiState.connected -> "Not worn"
                uiState.worn -> "Worn"
                else -> "Doffed"
            }
        )
    }
    val batteryPercent = uiState.batteryPercent
    val batteryValue = when {
        batteryPercent == null -> "Unknown"
        batteryPercent <= 10 -> "$batteryPercent% (Charge > 10% required)"
        batteryPercent < 15 -> "$batteryPercent% (Low battery)"
        else -> "$batteryPercent%"
    }
    val streamValue = if (uiState.streaming) {
        "Streaming (${uiState.streamStatus})"
    } else {
        uiState.streamStatus
    }
    val framesValue = "${uiState.framesSent} sent / ${uiState.framesDropped} dropped"
    val httpValue = when {
        uiState.lastHttpCode == 204 -> "204 OK"
        uiState.lastHttpCode > 0 -> "${uiState.lastHttpCode}"
        else -> "None"
    }
    val activeError = uiState.lastError?.takeIf { it.isNotBlank() }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outline)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Glasses & Ingest Status",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics { heading() }
            )

            StatusRow(label = "Registration", value = registrationValue)
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(label = "Glasses Device", value = deviceNameValue)
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(
                label = "Connected / Worn",
                value = connectionWornValue,
                valueColor = when {
                    uiState.connected && uiState.worn -> LedBannerAccent
                    uiState.connected && !uiState.worn -> WarnFg
                    else -> MaterialTheme.colorScheme.onSurface
                }
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(
                label = "Battery",
                value = batteryValue,
                valueColor = when {
                    batteryPercent != null && batteryPercent < 15 -> ErrorFg
                    else -> MaterialTheme.colorScheme.onSurface
                }
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(label = "Thermal", value = uiState.thermalStatus)
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(
                label = "Stream State",
                value = streamValue,
                valueColor = if (uiState.streaming) LedBannerAccent else MaterialTheme.colorScheme.onSurface
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(label = "Frames Sent / Dropped", value = framesValue, monospace = true)
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
            StatusRow(
                label = "Last HTTP Code",
                value = httpValue,
                monospace = true,
                valueColor = when {
                    uiState.lastHttpCode in 200..299 -> LedBannerAccent
                    uiState.lastHttpCode >= 400 -> ErrorFg
                    else -> MaterialTheme.colorScheme.onSurface
                }
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)

            if (activeError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics(mergeDescendants = true) {
                            liveRegion = LiveRegionMode.Polite
                            contentDescription = "Last Error: $activeError"
                        },
                    shape = RoundedCornerShape(10.dp),
                    colors = CardDefaults.cardColors(containerColor = ErrorBg),
                    border = BorderStroke(1.5.dp, ErrorBorder)
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            text = "Last Error",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                            color = ErrorFg
                        )
                        Text(
                            text = activeError,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
            } else {
                StatusRow(label = "Last Error", value = "None")
            }
        }
    }
}

@Composable
private fun StatusRow(
    label: String,
    value: String,
    monospace: Boolean = false,
    valueColor: Color = MaterialTheme.colorScheme.onSurface
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {
                contentDescription = "$label: $value"
            },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(0.45f)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
            color = valueColor,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(0.55f)
        )
    }
}
