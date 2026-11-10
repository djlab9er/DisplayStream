package app.displaystream.gemini

import android.Manifest
import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.PermissionStatus
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class MainActivity : AppCompatActivity() {
    private lateinit var logView: TextView
    private var camCont: CancellableContinuation<PermissionStatus>? = null

    private val camLauncher = registerForActivityResult(Wearables.RequestPermissionContract()) { r ->
        camCont?.resume(r.getOrDefault(PermissionStatus.Denied)); camCont = null
    }
    private val btLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val prefs = getSharedPreferences("gg", Context.MODE_PRIVATE)
        btLauncher.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.RECORD_AUDIO))

        val key = EditText(this).apply {
            hint = "Gemini API key (from aistudio.google.com)"
            setText(prefs.getString("key", ""))
            setSingleLine()
        }
        fun btn(t: String, f: () -> Unit) = Button(this).apply { text = t; setOnClickListener { f() } }
        logView = TextView(this).apply { textSize = 13f }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            addView(TextView(context).apply { text = "Gemini Glasses"; textSize = 22f })
            addView(key)
            addView(btn("1. Save key") { prefs.edit().putString("key", key.text.toString().trim()).apply(); log("Key saved") })
            addView(btn("2. Register with Meta AI app") { Glasses.register(this@MainActivity) })
            addView(btn("3. Connect glasses") { Glasses.connect() })
            addView(btn("Ask from phone (test)") { Glasses.ask() })
            addView(btn("Disconnect") { Glasses.disconnect() })
            addView(logView)
        }
        setContentView(ScrollView(this).apply { addView(col, ViewGroup.LayoutParams(-1, -2)) })

        Glasses.initTts(this)
        Glasses.log = { s -> runOnUiThread { log(s) } }
        Glasses.apiKey = { prefs.getString("key", "") ?: "" }
        Glasses.requestCamera = {
            suspendCancellableCoroutine { c ->
                camCont = c
                c.invokeOnCancellation { camCont = null }
                camLauncher.launch(com.meta.wearable.dat.core.types.Permission.CAMERA)
            }
        }
    }

    private fun log(s: String) { logView.append(s + "\n") }
}
