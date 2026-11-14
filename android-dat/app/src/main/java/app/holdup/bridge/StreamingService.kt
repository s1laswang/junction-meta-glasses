package app.holdup.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service (type connectedDevice) that keeps the process alive while frames stream and
 * the phone browser (HoldUp PWA) is in the foreground. Pattern taken from Meta's CameraAccess
 * sample StreamingService. It holds no stream logic itself.
 */
class StreamingService : Service() {

  companion object {
    private const val TAG = "HoldUpBridge:Service"
    private const val CHANNEL_ID = "holdup_streaming"
    private const val NOTIFICATION_ID = 1001
    private const val WAKELOCK_TIMEOUT_MS = 2L * 60L * 60L * 1000L
    private const val ACTION_STOP = "app.holdup.bridge.STOP"

    fun start(context: Context) {
      context.startForegroundService(
          Intent(context, StreamingService::class.java).setPackage(context.packageName))
    }

    /** Routed through onStartCommand so startForeground() always runs before stopping. */
    fun stop(context: Context) {
      context.startForegroundService(
          Intent(context, StreamingService::class.java)
              .setPackage(context.packageName)
              .setAction(ACTION_STOP))
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val channel =
        NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      startForeground(
          NOTIFICATION_ID,
          buildNotification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
    } catch (e: Exception) {
      Log.e(TAG, "Could not enter foreground", e)
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      releaseWakeLock()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    if (wakeLock == null) {
      wakeLock =
          getSystemService(PowerManager::class.java)
              .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HoldUpBridge::Streaming")
              .apply { acquire(WAKELOCK_TIMEOUT_MS) }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun buildNotification(): Notification {
    val open =
        PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    return Notification.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.notification_title))
        .setContentText(getString(R.string.notification_body))
        .setSmallIcon(R.drawable.ic_launcher_foreground)
        .setOngoing(true)
        .setContentIntent(open)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build()
  }
}
