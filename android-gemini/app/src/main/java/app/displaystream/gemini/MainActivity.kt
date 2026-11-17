package app.displaystream.gemini

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.PermissionStatus
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume

/** The phone screen: connect button, Gemini settings, glasses launcher, setup shortcuts and the activity log. */
class MainActivity : AppCompatActivity() {
    private companion object {
        const val BG = 0xFF0B1020.toInt()
        const val CARD = 0xFF151B30.toInt()
        const val FIELD = 0xFF0F1426.toInt()
        const val STROKE = 0xFF27304F.toInt()
        const val TEXT = 0xFFEEF1FA.toInt()
        const val MUTED = 0xFF8E97B5.toInt()
        const val CYAN = 0xFF7FE7FF.toInt()
        const val VIOLET = 0xFFB9A6FF.toInt()
        const val GREEN = 0xFF5EE6A8.toInt()
        const val AMBER = 0xFFFFC46B.toInt()
        const val GREY = 0xFF5A6384.toInt()
    }

    private lateinit var logView: TextView
    private lateinit var statusDot: View
    private lateinit var statusTitle: TextView
    private lateinit var statusSub: TextView
    private lateinit var mainButton: TextView
    private lateinit var testButton: TextView
    private lateinit var launchState: TextView
    private var camCont: CancellableContinuation<PermissionStatus>? = null

    private val camLauncher = registerForActivityResult(Wearables.RequestPermissionContract()) { r ->
        camCont?.resume(r.getOrDefault(PermissionStatus.Denied)); camCont = null
    }
    private val btLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun rounded(color: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun lp(top: Int = 0, width: Int = ViewGroup.LayoutParams.MATCH_PARENT) =
        LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun label(t: String, size: Float = 14f, color: Int = MUTED, bold: Boolean = false) = TextView(this).apply {
        text = t
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    /** A tappable pill. [fill] null gives an outlined (secondary) button. */
    private fun button(t: String, fill: Int?, onTap: () -> Unit) = TextView(this).apply {
        text = t
        textSize = 16f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        minHeight = dp(52)
        setPadding(dp(18), dp(12), dp(18), dp(12))
        setTextColor(if (fill != null) BG else TEXT)
        val shape = if (fill != null) rounded(fill, 26) else rounded(Color.TRANSPARENT, 26, STROKE)
        background = RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), shape, rounded(Color.WHITE, 26))
        isClickable = true
        isFocusable = true
        setOnClickListener { onTap() }
    }

    private fun field(hintText: String, value: String, mono: Boolean = false) = EditText(this).apply {
        hint = hintText
        setText(value)
        setSingleLine()
        textSize = 16f
        setTextColor(TEXT)
        setHintTextColor(GREY)
        if (mono) typeface = Typeface.MONOSPACE
        background = rounded(FIELD, 14, STROKE)
        setPadding(dp(14), dp(13), dp(14), dp(13))
    }

    private fun EditText.onChanged(f: (String) -> Unit) = addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { f(s?.toString().orEmpty().trim()) }
    })

    private fun card(vararg children: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(CARD, 22, STROKE)
        setPadding(dp(18), dp(18), dp(18), dp(18))
        children.forEach { addView(it) }
    }

    private fun section(t: String) = label(t.uppercase(Locale.US), 12f, MUTED, bold = true).apply {
        letterSpacing = 0.12f
        setPadding(dp(6), 0, 0, 0)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("gg", Context.MODE_PRIVATE)
        btLauncher.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS))

        // ----- Status card: the one thing you tap day to day -----
        statusDot = View(this).apply { background = rounded(GREY, 6) }
        statusTitle = label("Not connected", 20f, TEXT, bold = true)
        statusSub = label("", 14f, 0xFFC9D2F0.toInt())
        mainButton = button("Connect glasses", CYAN) {
            if (Glasses.active) {
                Glasses.disconnect()
                KeepAliveService.stop(this)
            } else {
                if (prefs.getString("key", "").isNullOrBlank()) toast("Add your Gemini API key below first")
                KeepAliveService.start(this)
                Glasses.connect()
            }
        }
        testButton = button("Test: describe what I see", null) { Glasses.ask(Mode.LOOK) }
        val statusRow = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(statusDot, LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(10) })
            addView(statusTitle)
        }
        val statusCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFF2B1F8F.toInt(), 0xFF121A3A.toInt())).apply {
                cornerRadius = dp(26).toFloat()
            }
            setPadding(dp(20), dp(22), dp(20), dp(20))
            addView(statusRow)
            addView(statusSub, lp(6))
            addView(mainButton, lp(18))
            addView(testButton, lp(10))
        }

        // ----- Gemini settings (saved as you type) -----
        val key = field("Paste your Gemini API key", prefs.getString("key", "").orEmpty(), mono = true).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            typeface = Typeface.MONOSPACE
            onChanged { prefs.edit().putString("key", it).apply() }
        }
        val showKey = label("Show", 14f, CYAN, bold = true).apply {
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setOnClickListener {
                val hidden = text.toString() == "Show"
                key.inputType = InputType.TYPE_CLASS_TEXT or
                    (if (hidden) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD)
                key.typeface = Typeface.MONOSPACE
                key.setSelection(key.text.length)
                text = if (hidden) "Hide" else "Show"
            }
        }
        val keyHead = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(label("API key"), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(showKey)
        }
        val model = field(Gemini.DEFAULT_MODEL, prefs.getString("model", Gemini.DEFAULT_MODEL).orEmpty()).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            onChanged { prefs.edit().putString("model", it).apply(); render(Glasses.link) }
        }
        // Speech speed: 0.5x to 1.5x in steps of 0.1 (stored as text, as before).
        val startRate = prefs.getString("rate", "")?.toFloatOrNull()?.coerceIn(0.5f, 1.5f) ?: 0.8f
        val rateLabel = label(rateText(startRate), 14f, TEXT, bold = true)
        val rate = SeekBar(this).apply {
            max = 10
            progress = Math.round((startRate - 0.5f) * 10)
            progressTintList = ColorStateList.valueOf(CYAN)
            thumbTintList = ColorStateList.valueOf(CYAN)
            progressBackgroundTintList = ColorStateList.valueOf(GREY)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                    val v = 0.5f + p / 10f
                    rateLabel.text = rateText(v)
                    if (fromUser) prefs.edit().putString("rate", String.format(Locale.US, "%.1f", v)).apply()
                }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) {}
            })
        }
        val rateHead = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(label("Speaking speed"), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(rateLabel)
        }
        val settings = card().apply {
            addView(keyHead)
            addView(key, lp(2))
            addView(label("Model"), lp(16))
            addView(model, lp(8))
            addView(rateHead, lp(18))
            addView(rate, lp(8))
            addView(label("Changes save as you type.", 12f, GREY), lp(10))
        }

        // ----- Open from the glasses (launcher code) -----
        launchState = label("", 13f, MUTED)
        val launch = field("8-letter code", prefs.getString("launch", "").orEmpty(), mono = true).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            filters = arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(8))
            letterSpacing = 0.2f
            textSize = 20f
            onChanged { c ->
                // Only a complete code (or none) changes anything, so typing doesn't restart the listener per letter.
                if (c.length == 8 && c != prefs.getString("launch", "")) {
                    prefs.edit().putString("launch", c).apply()
                    KeepAliveService.start(this@MainActivity)
                    AppLog.add("Launcher on: waiting for the glasses app")
                } else if (c.isEmpty() && !prefs.getString("launch", "").isNullOrEmpty()) {
                    prefs.edit().putString("launch", "").apply()
                    if (!Glasses.active) KeepAliveService.stopAll(this@MainActivity)
                    AppLog.add("Launcher off")
                }
                renderLauncher(c)
            }
        }
        val launcher = card(
            label("Open the Gemini web app on your glasses and type the code it shows. After that, opening it on the glasses starts Gemini here.", 14f, MUTED),
        ).apply {
            addView(launch, lp(12))
            addView(launchState, lp(8))
        }
        renderLauncher(prefs.getString("launch", "").orEmpty())
        // If a launcher code is saved, make sure the listener is running whenever the app is opened.
        if (prefs.getString("launch", "").orEmpty().length == 8) KeepAliveService.start(this)

        // ----- One-time setup and updates -----
        val setup = card(
            label("Needed once, and again only if the glasses stop connecting.", 14f, MUTED),
        ).apply {
            addView(button("Register with Meta AI", null) { Glasses.register(this@MainActivity) }, lp(12))
            addView(button("Update glasses app", null) { Wearables.openDATGlassesAppUpdate(this@MainActivity) }, lp(10))
            addView(button("Update glasses firmware", null) { Wearables.openFirmwareUpdate(this@MainActivity) }, lp(10))
        }

        // ----- Activity log -----
        logView = TextView(this).apply {
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextColor(0xFFB8C1DE.toInt())
            setTextIsSelectable(true)
            setLineSpacing(dp(2).toFloat(), 1f)
        }
        val logActions = LinearLayout(this).apply {
            gravity = Gravity.END
            addView(label("Copy", 14f, CYAN, bold = true).apply {
                setPadding(dp(10), dp(6), dp(10), dp(6))
                setOnClickListener {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Gemini Glasses log", AppLog.text()))
                    toast("Log copied")
                }
            })
            addView(label("Clear", 14f, CYAN, bold = true).apply {
                setPadding(dp(10), dp(6), dp(10), dp(6))
                setOnClickListener { AppLog.clear() }
            })
        }
        val logCard = card(logActions, logView)

        // ----- Page -----
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(28))
            addView(label("Gemini Glasses", 28f, TEXT, bold = true))
            addView(label("Gemini on your Meta Ray-Ban Display", 14f, VIOLET), lp(2))
            addView(statusCard, lp(18))
            addView(section("Gemini"), lp(26))
            addView(settings, lp(10))
            addView(section("Open from glasses"), lp(26))
            addView(launcher, lp(10))
            addView(section("Setup"), lp(26))
            addView(setup, lp(10))
            addView(section("Activity"), lp(26))
            addView(logCard, lp(10))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(BG)
            isFillViewport = true
            clipToPadding = false
            addView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        // Keep content clear of the status bar, navigation bar and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }
        setContentView(scroll)

    }

    override fun onStart() {
        super.onStart()
        Glasses.onStatus = { render(it) }
        // Meta's permission prompt must be launched from a live, visible screen.
        Glasses.requestPermission = { perm ->
            suspendCancellableCoroutine { c ->
                camCont?.resume(PermissionStatus.Denied)
                camCont = c
                c.invokeOnCancellation { camCont = null }
                camLauncher.launch(perm)
            }
        }
        AppLog.onChange = { logView.text = AppLog.text().ifEmpty { "Nothing yet." } }
        render(Glasses.link)
        AppLog.onChange?.invoke()
    }

    override fun onStop() {
        Glasses.onStatus = null
        Glasses.requestPermission = null
        AppLog.onChange = null
        super.onStop()
    }

    private fun rateText(v: Float) = String.format(Locale.US, "%.1f×", v)

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun renderLauncher(code: String) {
        val on = code.length == 8
        launchState.text = when {
            on -> "● Listening for your glasses"
            code.isEmpty() -> "Off. Leave empty if you only use the Connect button."
            else -> "Enter all 8 characters"
        }
        launchState.setTextColor(if (on) GREEN else MUTED)
    }

    private fun render(l: Link) {
        val model = getSharedPreferences("gg", Context.MODE_PRIVATE).getString("model", "").orEmpty().ifBlank { Gemini.DEFAULT_MODEL }
        val (title, sub, color) = when (l) {
            Link.OFF -> Triple("Not connected", "Tap Connect, or open Gemini on your glasses.", GREY)
            Link.CONNECTING -> Triple("Connecting…", "Reaching your glasses through the Meta AI app.", AMBER)
            Link.READY -> Triple("Ready on your glasses", "Using $model", GREEN)
            Link.BUSY -> Triple("Working…", "Using $model", CYAN)
        }
        statusTitle.text = title
        statusSub.text = sub
        (statusDot.background as? GradientDrawable)?.setColor(color)
        mainButton.text = if (l == Link.OFF) "Connect glasses" else "Disconnect"
        testButton.visibility = if (l == Link.READY) View.VISIBLE else View.GONE
    }
}
