package app.holdup.bridge

import android.content.Context
import android.content.SharedPreferences
import java.net.URI

data class SavedBridgeEndpoint(
    val serverUrl: String = "",
    val sessionCode: String = "",
)

object BridgePreferences {
    const val PREFS_NAME = "holdup_bridge_prefs"
    const val KEY_SERVER_URL = "server_url"
    const val KEY_SESSION_CODE = "session_code"
    const val MAX_SERVER_URL_LENGTH = 256
    const val MIN_SESSION_CODE_LENGTH = 4
    const val MAX_SESSION_CODE_LENGTH = 64

    private val SESSION_CODE_REGEX = Regex("^[A-Za-z0-9_-]{4,64}$")

    fun sanitizeServerUrl(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.length > MAX_SERVER_URL_LENGTH) {
            return ""
        }
        if (trimmed.any { it <= ' ' || it.code == 0x7F || it == '\\' }) {
            return ""
        }

        val withoutTrailingSlashes = trimmed.trimEnd('/')
        if (withoutTrailingSlashes.isEmpty()) {
            return ""
        }

        val parsed = try {
            URI(withoutTrailingSlashes)
        } catch (_: Exception) {
            return ""
        }

        val scheme = parsed.scheme?.lowercase() ?: return ""
        if (scheme != "http" && scheme != "https") {
            return ""
        }
        if (parsed.isOpaque) {
            return ""
        }

        val afterScheme = withoutTrailingSlashes.substring(scheme.length)
        if (
            afterScheme.length < 4 ||
            afterScheme[0] != ':' ||
            afterScheme[1] != '/' ||
            afterScheme[2] != '/' ||
            afterScheme[3] == '/'
        ) {
            return ""
        }

        if (parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) {
            return ""
        }

        val authority = parsed.rawAuthority?.takeIf { it.isNotEmpty() } ?: return ""
        if (authority.endsWith(":")) {
            return ""
        }

        val host = parsed.host?.trim().orEmpty()
        if (host.isEmpty()) {
            return ""
        }
        if (parsed.port != -1 && parsed.port !in 1..65535) {
            return ""
        }

        val rawPath = parsed.rawPath.orEmpty()
        if (rawPath.isNotEmpty()) {
            val segments = rawPath.split('/').drop(1)
            if (segments.any { it.isEmpty() || it == "." || it == ".." }) {
                return ""
            }
        }

        return scheme + afterScheme
    }

    fun sanitizeSessionCode(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.length !in MIN_SESSION_CODE_LENGTH..MAX_SESSION_CODE_LENGTH) {
            return ""
        }
        return if (SESSION_CODE_REGEX.matches(trimmed)) trimmed else ""
    }

    fun loadSavedEndpoint(context: Context): SavedBridgeEndpoint {
        val store = sharedPrefs(context)
        val rawServer = store.getString(KEY_SERVER_URL, "").orEmpty()
        val rawSession = store.getString(KEY_SESSION_CODE, "").orEmpty()
        return SavedBridgeEndpoint(
            serverUrl = sanitizeServerUrl(rawServer),
            sessionCode = sanitizeSessionCode(rawSession),
        )
    }

    fun saveEndpoint(
        context: Context,
        serverUrl: String,
        sessionCode: String,
    ): SavedBridgeEndpoint {
        val cleanServer = sanitizeServerUrl(serverUrl)
        val cleanSession = sanitizeSessionCode(sessionCode)
        val editor = sharedPrefs(context).edit()
        if (cleanServer.isEmpty()) {
            editor.remove(KEY_SERVER_URL)
        } else {
            editor.putString(KEY_SERVER_URL, cleanServer)
        }
        if (cleanSession.isEmpty()) {
            editor.remove(KEY_SESSION_CODE)
        } else {
            editor.putString(KEY_SESSION_CODE, cleanSession)
        }
        editor.apply()
        return SavedBridgeEndpoint(
            serverUrl = cleanServer,
            sessionCode = cleanSession,
        )
    }

    fun clearSavedEndpoint(context: Context) {
        sharedPrefs(context).edit()
            .remove(KEY_SERVER_URL)
            .remove(KEY_SESSION_CODE)
            .clear()
            .apply()
    }

    private fun sharedPrefs(context: Context): SharedPreferences {
        val appContext: Context? = context.applicationContext
        val targetContext = appContext ?: context
        return targetContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }
}
