package app.holdup.bridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        DatBridgeController.initialize(applicationContext)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        DatBridgeController.initialize(applicationContext)
        val saved = BridgePreferences.loadSavedEndpoint(applicationContext)
        if (saved.serverUrl.isNotEmpty()) {
            DatBridgeController.updateEndpoint(saved.serverUrl, saved.sessionCode)
        }
        requestRuntimePermissions()
        handleDeepLink(intent)

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF5CC0FF),
                    onPrimary = Color(0xFF04111F),
                    primaryContainer = Color(0xFF0A1F38),
                    onPrimaryContainer = Color(0xFFA6D4FF),
                    secondary = Color(0xFF7EF7C8),
                    onSecondary = Color(0xFF06261D),
                    secondaryContainer = Color(0xFF06261D),
                    onSecondaryContainer = Color(0xFF7EF7C8),
                    tertiary = Color(0xFFFFE169),
                    onTertiary = Color(0xFF261B04),
                    error = Color(0xFFFF8573),
                    onError = Color(0xFF1F0502),
                    errorContainer = Color(0xFF2D0E0A),
                    onErrorContainer = Color(0xFFFFB8AB),
                    background = Color(0xFF0B0F17),
                    onBackground = Color(0xFFF8FAFC),
                    surface = Color(0xFF121926),
                    onSurface = Color(0xFFF8FAFC),
                    surfaceVariant = Color(0xFF1A2333),
                    onSurfaceVariant = Color(0xFFD8E1EE),
                    outline = Color(0xFF6980A3)
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    BridgeScreen(activity = this@MainActivity)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun requestRuntimePermissions() {
        val needed = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.BLUETOOTH_CONNECT
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun handleDeepLink(incomingIntent: Intent?) {
        val data: Uri = incomingIntent?.data ?: return
        if (!data.scheme.equals(DEEP_LINK_SCHEME, ignoreCase = true)) return
        if (!data.host.equals(DEEP_LINK_HOST, ignoreCase = true)) return
        val path = data.path
        if (!path.isNullOrEmpty() && path != "/") return

        val currentState = DatBridgeController.uiState.value
        val rawServer = data.getQueryParameter("server")?.trim()
        val resolvedServer = if (!rawServer.isNullOrEmpty()) {
            val cleanServer = BridgePreferences.sanitizeServerUrl(rawServer)
            if (cleanServer.isEmpty()) return
            cleanServer
        } else {
            BridgePreferences.sanitizeServerUrl(currentState.serverUrl)
        }

        val rawSession = data.getQueryParameter("session")?.trim()
        val resolvedSession = when {
            rawSession == null -> {
                if (!rawServer.isNullOrEmpty()) {
                    ""
                } else {
                    BridgePreferences.sanitizeSessionCode(currentState.sessionCode)
                }
            }
            rawSession.isEmpty() -> ""
            else -> {
                val cleanSession = BridgePreferences.sanitizeSessionCode(rawSession)
                if (cleanSession.isEmpty()) return
                cleanSession
            }
        }

        if (resolvedServer.isEmpty() && resolvedSession.isEmpty()) return
        val saved = BridgePreferences.saveEndpoint(applicationContext, resolvedServer, resolvedSession)
        DatBridgeController.updateEndpoint(saved.serverUrl, saved.sessionCode)
        incomingIntent.setData(null)
    }

    companion object {
        private const val DEEP_LINK_SCHEME = "holdupbridge"
        private const val DEEP_LINK_HOST = "connect"
    }
}
