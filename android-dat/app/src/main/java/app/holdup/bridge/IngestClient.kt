package app.holdup.bridge

import android.os.SystemClock
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

data class BridgeDeviceState(
    val connected: Boolean = false,
    val worn: Boolean = false,
    val battery: Int? = null,
    val streaming: Boolean = false,
)

data class IngestMetrics(
    val framesSent: Long = 0,
    val framesDropped: Long = 0,
    val stateUpdatesSent: Long = 0,
    val lastHttpCode: Int = 0,
    val lastError: String? = null,
)

class IngestClient(
    private val minFrameIntervalMs: Long = 950L,
) {
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private val frameInFlight = AtomicBoolean(false)

    private val _metrics = MutableStateFlow(IngestMetrics())
    val metrics: StateFlow<IngestMetrics> = _metrics.asStateFlow()

    @Volatile
    private var baseServerUrl: String = ""

    @Volatile
    private var activeSessionCode: String? = null

    @Volatile
    private var lastSentAt: Long = -minFrameIntervalMs

    fun configure(serverUrl: String, sessionCode: String = "") {
        baseServerUrl = serverUrl.trim().trimEnd('/')
        activeSessionCode = sessionCode.trim().takeIf { it.isNotEmpty() }
    }

    suspend fun submitFrameIfIdle(jpegBytes: ByteArray): Boolean {
        if (!frameInFlight.compareAndSet(false, true)) {
            _metrics.update { it.copy(framesDropped = it.framesDropped + 1) }
            return false
        }
        try {
            val now = SystemClock.elapsedRealtime()
            if (now - lastSentAt < minFrameIntervalMs || jpegBytes.isEmpty()) {
                _metrics.update { it.copy(framesDropped = it.framesDropped + 1) }
                return false
            }
            val url = buildEndpointUrl("ingest/frame")
            if (url == null) {
                _metrics.update {
                    it.copy(
                        framesDropped = it.framesDropped + 1,
                        lastHttpCode = 0,
                        lastError = "Invalid or empty server URL",
                    )
                }
                return false
            }
            lastSentAt = now
            val request = Request.Builder()
                .url(url)
                .post(jpegBytes.toRequestBody("image/jpeg".toMediaType()))
                .build()
            return try {
                val (code, successful) = executeCall(request)
                if (successful) {
                    _metrics.update {
                        it.copy(
                            framesSent = it.framesSent + 1,
                            lastHttpCode = code,
                            lastError = null,
                        )
                    }
                    true
                } else {
                    _metrics.update {
                        it.copy(
                            lastHttpCode = code,
                            lastError = "HTTP $code",
                        )
                    }
                    false
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Exception) {
                _metrics.update {
                    it.copy(
                        lastHttpCode = 0,
                        lastError = e.message ?: e.javaClass.simpleName,
                    )
                }
                false
            }
        } finally {
            frameInFlight.set(false)
        }
    }

    suspend fun postState(state: BridgeDeviceState) {
        val url = buildEndpointUrl("ingest/state")
        if (url == null) {
            _metrics.update {
                it.copy(
                    lastHttpCode = 0,
                    lastError = "Invalid or empty server URL",
                )
            }
            return
        }
        val json = serializeState(state)
        val request = Request.Builder()
            .url(url)
            .post(json.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        try {
            val (code, successful) = executeCall(request)
            if (successful) {
                _metrics.update {
                    it.copy(
                        stateUpdatesSent = it.stateUpdatesSent + 1,
                        lastHttpCode = code,
                        lastError = null,
                    )
                }
            } else {
                _metrics.update {
                    it.copy(
                        lastHttpCode = code,
                        lastError = "HTTP $code",
                    )
                }
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (e: Exception) {
            _metrics.update {
                it.copy(
                    lastHttpCode = 0,
                    lastError = e.message ?: e.javaClass.simpleName,
                )
            }
        }
    }

    private fun buildEndpointUrl(endpointPath: String): HttpUrl? {
        val base = baseServerUrl
        if (base.isEmpty()) return null
        val endpointUrl = "$base/$endpointPath".toHttpUrlOrNull() ?: return null
        val session = activeSessionCode ?: return endpointUrl
        return endpointUrl.newBuilder()
            .addQueryParameter("session", session)
            .build()
    }

    private fun serializeState(state: BridgeDeviceState): String {
        val batteryJson = state.battery?.toString() ?: "null"
        return "{\"connected\":${state.connected},\"worn\":${state.worn},\"battery\":$batteryJson,\"streaming\":${state.streaming}}"
    }

    private suspend fun executeCall(request: Request): Pair<Int, Boolean> =
        suspendCancellableCoroutine { continuation ->
            val call = httpClient.newCall(request)
            continuation.invokeOnCancellation {
                call.cancel()
            }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(e)
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    val outcome = response.use { it.code to it.isSuccessful }
                    if (continuation.isActive) {
                        continuation.resume(outcome)
                    }
                }
            })
        }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
