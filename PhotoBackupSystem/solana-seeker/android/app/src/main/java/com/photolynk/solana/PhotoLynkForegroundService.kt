package com.photolynk.solana

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps PhotoLynk alive during background operations.
 *
 * When the user starts backup, sync, or auto-upload, this service runs as a
 * foreground process with a persistent notification. Android's Low Memory
 * Killer will not terminate it, allowing uploads and sync to continue even
 * when the app is backgrounded or the screen is off.
 */
class PhotoLynkForegroundService : Service() {

    companion object {
        private const val TAG = "PhotoLynkService"
        private const val CHANNEL_ID = "photolynk_background_v1"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_START = "ACTION_START"
        private const val ACTION_STOP = "ACTION_STOP"
        private const val ACTION_UPDATE = "ACTION_UPDATE"

        @Volatile
        var lastTitle: String = "PhotoLynk"

        @Volatile
        var lastBody: String = "Running in background…"

        fun start(context: Context, title: String, body: String) {
            Log.i(TAG, "start() called title=$title")
            lastTitle = title
            lastBody = body
            val intent = Intent(context, PhotoLynkForegroundService::class.java).apply {
                action = ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun update(context: Context, title: String, body: String) {
            Log.i(TAG, "update() called title=$title")
            lastTitle = title
            lastBody = body
            val intent = Intent(context, PhotoLynkForegroundService::class.java).apply {
                action = ACTION_UPDATE
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            Log.i(TAG, "stop() called")
            val intent = Intent(context, PhotoLynkForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "onCreate()")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand action=${intent?.action}")
        when (intent?.action) {
            ACTION_START -> {
                Log.i(TAG, "ACTION_START → startForeground()")
                try {
                    startForeground(NOTIFICATION_ID, buildNotification())
                    Log.i(TAG, "startForeground() succeeded")
                } catch (e: Exception) {
                    Log.e(TAG, "startForeground() failed: ${e.message}", e)
                }
            }
            ACTION_UPDATE -> {
                Log.i(TAG, "ACTION_UPDATE → notify()")
                try {
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIFICATION_ID, buildNotification())
                    Log.i(TAG, "notify() succeeded")
                } catch (e: Exception) {
                    Log.e(TAG, "notify() failed: ${e.message}", e)
                }
            }
            ACTION_STOP -> {
                Log.i(TAG, "ACTION_STOP → stopForeground() + stopSelf()")
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> {
                Log.w(TAG, "Unknown or null action: ${intent?.action}")
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Background Operations",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps PhotoLynk running during backup and sync"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                enableLights(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
            Log.i(TAG, "Notification channel created: $CHANNEL_ID")
        }
    }

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        Log.i(TAG, "buildNotification title=$lastTitle body=$lastBody")
        val smallIconRes = R.drawable.ic_notification
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(lastTitle)
            .setContentText(lastBody)
            .setSmallIcon(smallIconRes)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
