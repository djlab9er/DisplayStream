package app.displaystream.gemini

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Foreground service: keeps the glasses session alive with the phone locked, and listens for the glasses launcher. */
class KeepAliveService : Service() {
    private var listener: LaunchListener? = null
    private var listenerCode = ""

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(i: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("gg", "Gemini Glasses", NotificationManager.IMPORTANCE_LOW))
        val code = launcherCode(this)
        val n = Notification.Builder(this, "gg")
            .setContentTitle("Gemini Glasses running")
            .setContentText(if (code.isNotEmpty()) "Waiting for the glasses launcher" else "Connected to your glasses")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        if (code != listenerCode) {
            listener?.stop(); listener = null; listenerCode = code
            if (code.isNotEmpty()) {
                listener = LaunchListener(code) {
                    if (!Glasses.active) Glasses.connect()
                }.also { it.start() }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() { listener?.stop(); super.onDestroy() }

    companion object {
        fun launcherCode(c: Context): String =
            c.getSharedPreferences("gg", Context.MODE_PRIVATE).getString("launch", "")?.trim().orEmpty()

        fun start(c: Context) { c.startForegroundService(Intent(c, KeepAliveService::class.java)) }

        /** Stops the service unless the glasses launcher still needs it to keep listening. */
        fun stop(c: Context) { if (launcherCode(c).isEmpty()) c.stopService(Intent(c, KeepAliveService::class.java)) }

        fun stopAll(c: Context) { c.stopService(Intent(c, KeepAliveService::class.java)) }
    }
}
