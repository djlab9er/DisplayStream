package app.displaystream.gemini

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Keeps the recent activity lines in memory so the screen can show them even after it is reopened. */
object AppLog {
    private const val MAX = 200
    private val lines = ArrayDeque<String>()
    private val main = Handler(Looper.getMainLooper())
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

    /** Called on the main thread whenever the log changes. */
    var onChange: (() -> Unit)? = null

    fun add(s: String) {
        val line = synchronized(clock) { clock.format(Date()) } + "  " + s
        main.post {
            lines.addLast(line)
            while (lines.size > MAX) lines.removeFirst()
            onChange?.invoke()
        }
    }

    /** Keeps the log across the app restarting itself. */
    fun save(c: android.content.Context) {
        c.getSharedPreferences("gg", android.content.Context.MODE_PRIVATE).edit().putString("log", text()).commit()
    }

    fun restore(c: android.content.Context) {
        val p = c.getSharedPreferences("gg", android.content.Context.MODE_PRIVATE)
        val old = p.getString("log", null) ?: return
        p.edit().remove("log").apply()
        main.post {
            old.split("\n").filter { it.isNotBlank() }.asReversed().forEach { lines.addFirst(it) }
            while (lines.size > MAX) lines.removeFirst()
            onChange?.invoke()
        }
    }

    fun clear() { lines.clear(); onChange?.invoke() }

    fun text(): String = lines.joinToString("\n")
}
