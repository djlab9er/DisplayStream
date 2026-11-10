package app.displaystream.gemini

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Foreground service so the glasses session keeps running with the phone locked. */
class KeepAliveService : Service() {
    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("gg", "Gemini Glasses", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "gg")
            .setContentTitle("Gemini Glasses running")
            .setContentText("Connected to your glasses")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        return START_STICKY
    }

    companion object {
        fun start(c: Context) { c.startForegroundService(Intent(c, KeepAliveService::class.java)) }
        fun stop(c: Context) { c.stopService(Intent(c, KeepAliveService::class.java)) }
    }
}
