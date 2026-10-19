package app.displaystream.cast

import android.os.Handler
import android.os.Looper

/** Tiny shared state so the Activity can show what the Service is doing. */
object CastState {
    @Volatile var status: String = "Idle"
    @Volatile var active: Boolean = false
    var listener: (() -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())
    fun update(text: String, isActive: Boolean = active) {
        status = text; active = isActive
        main.post { listener?.invoke() }
    }
}
