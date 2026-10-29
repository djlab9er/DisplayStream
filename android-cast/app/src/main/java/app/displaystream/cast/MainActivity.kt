package app.displaystream.cast

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private val alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    private lateinit var codeInput: EditText
    private lateinit var status: TextView
    private lateinit var start: Button
    private lateinit var stop: Button
    private var pendingCode: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        root.addView(TextView(this).apply { text = "Cast your screen to the glasses"; textSize = 22f })
        root.addView(TextView(this).apply {
            text = "Open Screen Cast on the glasses, then type the code it shows. Your whole screen, including notifications, will be visible on the glasses."
            setPadding(0, pad / 2, 0, pad / 2)
        })
        codeInput = EditText(this).apply {
            hint = "ABCD-EFGH"; textSize = 26f; gravity = Gravity.CENTER
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        root.addView(codeInput)
        start = Button(this).apply { text = "Start casting"; setOnClickListener { beginCast() } }
        stop = Button(this).apply {
            text = "Stop"
            setOnClickListener { startService(Intent(this@MainActivity, CastService::class.java).setAction(CastService.ACTION_STOP)) }
        }
        status = TextView(this).apply { setPadding(0, pad / 2, 0, 0); textSize = 16f }
        root.addView(start); root.addView(stop); root.addView(status)
        setContentView(root)

        intent?.data?.getQueryParameter("c")?.let { codeInput.setText(it) }
        if (intent?.getBooleanExtra(CastService.EXTRA_RESUME, false) == true && CastState.paused) beginCast()
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Tapped "Resume" in the notification: go straight to the screen-capture permission prompt.
        if (intent?.getBooleanExtra(CastService.EXTRA_RESUME, false) == true && CastState.paused) beginCast()
    }

    override fun onResume() {
        super.onResume()
        CastState.listener = { render() }
        render()
    }

    override fun onPause() { CastState.listener = null; super.onPause() }

    private fun render() {
        status.text = CastState.status
        start.isEnabled = !CastState.active || CastState.paused
        start.text = if (CastState.paused) "Resume casting" else "Start casting"
        stop.isEnabled = CastState.active
    }

    private fun normalize(s: String): String? {
        val c = s.uppercase().filter { it.isLetterOrDigit() }
        return if (c.length == 8 && c.all { it in alphabet }) c else null
    }

    private fun beginCast() {
        val code = if (CastState.paused) CastState.lastCode else normalize(codeInput.text.toString())
        if (code == null) { CastState.update("Enter the 8-character code from the glasses.", false); return }
        pendingCode = code
        CastState.lastCode = code
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), 100)
    }

    @Deprecated("Simple single-screen app")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 100) return
        val code = pendingCode
        if (resultCode != RESULT_OK || data == null || code == null) {
            CastState.update("Screen capture was not allowed.", false); return
        }
        val i = Intent(this, CastService::class.java)
            .putExtra(CastService.EXTRA_CODE, code)
            .putExtra(CastService.EXTRA_RESULT, resultCode)
            .putExtra(CastService.EXTRA_DATA, data)
        startForegroundService(i)
    }
}
