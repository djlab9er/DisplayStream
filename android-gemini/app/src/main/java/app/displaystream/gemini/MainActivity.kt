package app.displaystream.gemini

import android.Manifest
import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
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
        val prefs = getSharedPreferences("gg", Context.MODE_PRIVATE)
        btLauncher.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS))

        val key = EditText(this).apply {
            hint = "Gemini API key (from aistudio.google.com)"
            setText(prefs.getString("key", ""))
            setSingleLine()
        }
        val modelBox = EditText(this).apply {
            hint = "Model (default ${Gemini.DEFAULT_MODEL})"
            setText(prefs.getString("model", Gemini.DEFAULT_MODEL))
            setSingleLine()
        }
        fun btn(t: String, f: () -> Unit) = Button(this).apply { text = t; setOnClickListener { f() } }
        logView = TextView(this).apply { textSize = 13f }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            addView(TextView(context).apply { text = "Gemini Glasses"; textSize = 22f })
            addView(key)
            addView(modelBox)
            addView(btn("1. Save key and model") { prefs.edit().putString("key", key.text.toString().trim()).putString("model", modelBox.text.toString().trim()).apply(); log("Key and model saved") })
            addView(btn("2. Register with Meta AI app") { Glasses.register(this@MainActivity) })
            addView(btn("3. Connect glasses") { KeepAliveService.start(this@MainActivity); Glasses.connect() })
            addView(btn("Ask from phone (test)") { Glasses.ask() })
            addView(btn("Disconnect") { Glasses.disconnect(); KeepAliveService.stop(this@MainActivity) })
            addView(logView)
        }
        setContentView(ScrollView(this).apply { addView(col, ViewGroup.LayoutParams(-1, -2)) })

        Glasses.initTts(this)
        Glasses.log = { s -> runOnUiThread { log(s) } }
        Glasses.model = { prefs.getString("model", "") ?: "" }
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
