package app.displaystream.cast

import android.os.Handler
import android.os.Looper

/** Tiny shared state so the Activity can show what the Service is doing. */
object CastState {
    @Volatile var status: String = "Idle"
    @Volatile var active: Boolean = false
    @Volatile var paused: Boolean = false       // capture stopped by Android (phone locked); call kept open
    @Volatile var lastCode: String? = null
    var listener: (() -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    fun update(text: String, isActive: Boolean = active, isPaused: Boolean = false) {
        status = text; active = isActive; paused = isPaused && isActive
        main.post { listener?.invoke() }
    }
}
