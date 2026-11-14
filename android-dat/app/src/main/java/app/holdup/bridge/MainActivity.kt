package app.holdup.bridge

import android.Manifest.permission.BLUETOOTH
import android.Manifest.permission.BLUETOOTH_CONNECT
import android.Manifest.permission.INTERNET
import android.Manifest.permission.POST_NOTIFICATIONS
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class MainActivity : ComponentActivity() {

  companion object {
    // Same runtime permissions as Meta's CameraAccess sample, plus notifications for the FGS.
    private val PERMISSIONS = arrayOf(BLUETOOTH, BLUETOOTH_CONNECT, INTERNET, POST_NOTIFICATIONS)
    private val REQUIRED = setOf(BLUETOOTH, BLUETOOTH_CONNECT, INTERNET)
  }

  private val viewModel: BridgeViewModel by viewModels()
  private var pendingIntent: Intent? = null

  private val androidPermissions =
      registerForActivityResult(RequestMultiplePermissions()) { result ->
        val granted = REQUIRED.all { p -> result[p] ?: hasPermission(p) }
        viewModel.onBluetoothPermissions(granted)
        if (granted) processIntent()
      }

  // DAT camera permission via the Meta AI app (pattern from the CameraAccess sample).
  private var permissionContinuation: CancellableContinuation<PermissionStatus>? = null
  private val permissionMutex = Mutex()
  private val wearablesPermission =
      registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        val status = result.getOrDefault(PermissionStatus.Denied)
        permissionContinuation?.resume(status)
        permissionContinuation = null
      }

  private suspend fun requestWearablesPermission(permission: Permission): PermissionStatus =
      permissionMutex.withLock {
        suspendCancellableCoroutine { cont ->
          permissionContinuation = cont
          cont.invokeOnCancellation { permissionContinuation = null }
          wearablesPermission.launch(permission)
        }
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    viewModel.permissionRequester = ::requestWearablesPermission
    pendingIntent = intent
    setContent { BridgeScreen() }
  }

  override fun onStart() {
    super.onStart()
    androidPermissions.launch(PERMISSIONS)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    pendingIntent = intent
    if (viewModel.ui.value.sdkReady) processIntent()
  }

  override fun onDestroy() {
    // Don't leak this Activity through the ViewModel; the next onCreate sets it again.
    viewModel.permissionRequester = null
    super.onDestroy()
  }

  /** Our setup deep link, and Meta AI-initiated registration requests (SDK >= 1.0). */
  private fun processIntent() {
    val i = pendingIntent ?: return
    pendingIntent = null
    viewModel.handleDeepLink(i.data)
    runCatching {
      Wearables.handleIntent(i) { request ->
        request.continueRegistration(this).onFailure { e, _ -> viewModel.setError(e.description) }
      }
    }
  }

  private fun hasPermission(p: String) = checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED

  private fun openAppSettings() {
    startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
  }

  @Composable
  private fun BridgeScreen() {
    val ui by viewModel.ui.collectAsStateWithLifecycle()

    // Keep the screen on while streaming so the demo phone doesn't sleep mid-run.
    LaunchedEffect(ui.wantStreaming) {
      if (ui.wantStreaming) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFFFFD54F))) {
      Column(
          modifier =
              Modifier.fillMaxSize()
                  .background(Color.Black)
                  .safeDrawingPadding()
                  .verticalScroll(rememberScrollState())
                  .padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text("HoldUp Bridge", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text("Glasses camera → HoldUp server", color = Color(0xFFB0B0B0), fontSize = 14.sp)

        OutlinedTextField(
            value = ui.serverUrl,
            onValueChange = viewModel::setServerUrl,
            label = { Text("Server URL (cloudflared https)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = ui.sessionCode,
            onValueChange = viewModel::setSessionCode,
            label = { Text("Session code (optional, blank = latest session)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )

        StatusCard(ui)

        if (!ui.btPermissionGranted) {
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { androidPermissions.launch(PERMISSIONS) }) { Text("Grant Bluetooth") }
            OutlinedButton(onClick = ::openAppSettings) { Text("App settings") }
          }
        }

        val connected = ui.sessionState.name != "IDLE" && ui.sessionState.name != "STOPPED"
        BigButton(
            text = if (connected || ui.wantConnected) "Disconnect glasses" else "Connect glasses",
            enabled = ui.sdkReady,
            onClick = {
              if (connected || ui.wantConnected) viewModel.disconnect() else viewModel.connect(this@MainActivity)
            },
        )
        BigButton(
            text = if (ui.wantStreaming) "Stop streaming" else "Start streaming",
            enabled = ui.sdkReady,
            danger = ui.wantStreaming,
            onClick = {
              if (ui.wantStreaming) viewModel.stopStreaming() else viewModel.startStreaming(this@MainActivity)
            },
        )

        if (ui.firmwareUpdateRequired) {
          OutlinedButton(onClick = { viewModel.openFirmwareUpdate(this@MainActivity) }) {
            Text("Update glasses firmware")
          }
        }
        if (ui.glassesAppUpdateRequired) {
          OutlinedButton(onClick = { viewModel.openGlassesAppUpdate(this@MainActivity) }) {
            Text("Update glasses app")
          }
        }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { viewModel.unregister(this@MainActivity) }, enabled = ui.isRegistered) {
          Text("Unlink from Meta AI (troubleshooting)", color = Color(0xFF909090))
        }
      }
    }
  }

  @Composable
  private fun BigButton(text: String, enabled: Boolean, danger: Boolean = false, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(14.dp),
        colors =
            if (danger) ButtonDefaults.buttonColors(containerColor = Color(0xFFE57373))
            else ButtonDefaults.buttonColors(),
        modifier = Modifier.fillMaxWidth().height(60.dp),
    ) {
      Text(text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
    }
  }

  @Composable
  private fun StatusCard(ui: UiState) {
    Column(
        modifier =
            Modifier.fillMaxWidth()
                .background(Color(0xFF1C1C1C), RoundedCornerShape(14.dp))
                .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(ui.status, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
      ui.error?.let {
        Text(it, color = Color(0xFFFF8A80), fontSize = 15.sp)
        TextButton(onClick = viewModel::clearError) { Text("Dismiss") }
      }
      Line("Meta AI link", ui.registration.name.lowercase())
      val glasses =
          if (ui.deviceName == null) "none found"
          else
              buildString {
                append(ui.deviceName)
                append(" · ")
                append(
                    when (ui.linkState) {
                      LinkState.CONNECTED -> "connected"
                      LinkState.CONNECTING -> "connecting"
                      LinkState.DISCONNECTED -> "disconnected"
                      null -> "?"
                    })
                when (ui.donState) {
                  DonState.DONNED -> append(" · worn")
                  DonState.DOFFED -> append(" · not worn")
                  else -> Unit
                }
                ui.battery?.let { append(" · $it%") }
                if (ui.charging) append(" (charging)")
              }
      Line("Glasses", glasses)
      if (ui.thermal.name !in setOf("UNKNOWN", "NONE")) Line("Thermal", ui.thermal.name.lowercase())
      Line("Session", ui.sessionState.name.lowercase())
      Line(
          "Stream",
          ui.streamState.name.lowercase() +
              (if (ui.streamState == StreamState.STREAMING && ui.frameSize.isNotEmpty())
                  " · ${ui.frameSize} ${ui.yuvLayout}"
              else ""))
      Line(
          "Frames",
          "sent ${ui.framesSent} · dropped ${ui.framesDropped} · ${ui.frameHttp}" +
              (if (ui.lastFrameKb > 0) " · ${ui.lastFrameKb} KB" else ""))
      Line("State POST", ui.stateHttp)
      Line(
          "Network",
          when (ui.netOk) {
            true -> "ok"
            false -> "failing (retrying)"
            null -> "–"
          })
    }
  }

  @Composable
  private fun Line(label: String, value: String) {
    Row {
      Text("$label: ", color = Color(0xFF9E9E9E), fontSize = 15.sp)
      Text(value, color = Color(0xFFEDEDED), fontSize = 15.sp)
    }
  }
}
