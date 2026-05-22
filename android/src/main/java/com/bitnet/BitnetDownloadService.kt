package com.bitnet

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Foreground service whose only job is to claim "user-visible" status so the
// OS doesn't kill the process when the app backgrounds while a download is in
// flight. Doesn't own the downloads themselves — ModelDownloader.start() does
// the actual work on its own thread pool. The service is started when the
// first download begins and stopped once ModelDownloader.hasActiveDownloads()
// is false.
class BitnetDownloadService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel(this)
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Downloading model")
      .setContentText("BitNet is downloading a model")
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
    START_NOT_STICKY

  companion object {
    private const val CHANNEL_ID = "bitnet_downloads"
    private const val NOTIFICATION_ID = 0x71717

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val mgr = context.getSystemService(NotificationManager::class.java) ?: return
      if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(
        CHANNEL_ID, "Model downloads", NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Shown while BitNet is downloading a model in the background"
      }
      mgr.createNotificationChannel(channel)
    }

    fun ensureRunning(context: Context) {
      ensureChannel(context)
      val intent = Intent(context, BitnetDownloadService::class.java)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (_: Throwable) {
        // Background-start restrictions on Android 12+ can throw here. Downloads
        // will still proceed but may be killed if the app backgrounds.
      }
    }

    fun stopIfIdle(context: Context) {
      if (ModelDownloader.hasActiveDownloads()) return
      try {
        context.stopService(Intent(context, BitnetDownloadService::class.java))
      } catch (_: Throwable) {
        // best-effort
      }
    }
  }
}
