package app.holdup.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.util.concurrent.atomic.AtomicBoolean

class StreamingForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "holdup_glasses_stream"
        const val NOTIFICATION_ID = 4401
        const val NOTIFICATION_TITLE = "HoldUp Glasses Camera Active"
        const val ACTION_START_STREAM = "app.holdup.bridge.ACTION_START_STREAM"
        const val ACTION_STOP_STREAM = "app.holdup.bridge.ACTION_STOP_STREAM"

        private const val CHANNEL_NAME = "HoldUp Glasses Camera"
        private const val CHANNEL_DESCRIPTION =
            "Active privacy indicator while HoldUp streams frames from Meta AI Glasses"
        private const val NOTIFICATION_TEXT =
            "Streaming ~1 fps to HoldUp for label verification. Tap Stop Camera anytime."
        private const val ACTION_STOP_LABEL = "Stop Camera"
        private const val WAKELOCK_TAG = "HoldUpBridge:GlassesStream"
        private const val WAKELOCK_TIMEOUT_MS = 30L * 60L * 1000L

        private val startRequested = AtomicBoolean(false)
        private val stopPending = AtomicBoolean(false)
        private val isRunning = AtomicBoolean(false)

        fun start(context: Context) {
            val appContext = context.applicationContext
            stopPending.set(false)
            if (isRunning.get() || !startRequested.compareAndSet(false, true)) {
                return
            }
            val intent = Intent(appContext, StreamingForegroundService::class.java).apply {
                action = ACTION_START_STREAM
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appContext.startForegroundService(intent)
            } else {
                appContext.startService(intent)
            }
        }

        fun stop(context: Context) {
            val appContext = context.applicationContext
            if (isRunning.getAndSet(false)) {
                startRequested.set(false)
                stopPending.set(false)
                appContext.stopService(Intent(appContext, StreamingForegroundService::class.java))
            } else if (startRequested.get()) {
                stopPending.set(true)
            }
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!enterForeground()) {
            startRequested.set(false)
            stopPending.set(false)
            isRunning.set(false)
            stopSelf()
            return START_NOT_STICKY
        }

        val isStopAction = intent?.action == ACTION_STOP_STREAM
        if (isStopAction || stopPending.getAndSet(false)) {
            startRequested.set(false)
            isRunning.set(false)
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            if (isStopAction) {
                DatBridgeController.stopStreaming(this)
            }
            return START_NOT_STICKY
        }

        startRequested.set(false)
        isRunning.set(true)
        acquireWakeLock()
        return START_STICKY
    }

    override fun onDestroy() {
        startRequested.set(false)
        stopPending.set(false)
        isRunning.set(false)
        releaseWakeLock()
        super.onDestroy()
    }

    private fun enterForeground(): Boolean {
        val notification = buildNotification()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = CHANNEL_DESCRIPTION
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, StreamingForegroundService::class.java).apply {
            action = ACTION_STOP_STREAM
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopAction = Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_media_pause),
            ACTION_STOP_LABEL,
            stopPendingIntent,
        ).build()

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(stopAction)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        if (launchIntent != null) {
            val contentPendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.setContentIntent(contentPendingIntent)
        }

        return builder.build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) {
            return
        }
        runCatching {
            val powerManager = getSystemService(PowerManager::class.java) ?: return
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                WAKELOCK_TAG,
            ).apply {
                setReferenceCounted(false)
                acquire(WAKELOCK_TIMEOUT_MS)
            }
        }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        wakeLock = null
        runCatching {
            if (lock.isHeld) {
                lock.release()
            }
        }
    }
}
