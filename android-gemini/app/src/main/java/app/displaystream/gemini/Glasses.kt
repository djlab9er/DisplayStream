package app.displaystream.gemini

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.speech.tts.TextToSpeech
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.types.DisplayState
import com.meta.wearable.dat.display.views.ActionRole
import com.meta.wearable.dat.display.views.ButtonStyle
import com.meta.wearable.dat.display.views.Direction
import com.meta.wearable.dat.display.views.FlexBoxBackground
import com.meta.wearable.dat.display.views.IconName
import com.meta.wearable.dat.display.views.TextColor
import com.meta.wearable.dat.display.views.TextStyle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.nio.ByteBuffer
import java.util.Locale

/** Owns the glasses session: registration, display, camera, and the ask-Gemini loop. */
object Glasses {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: DeviceSession? = null
    private var display: Display? = null
    private var busy = false
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    var log: (String) -> Unit = {}
    var apiKey: () -> String = { "" }
    var model: () -> String = { "" }
    var requestCamera: suspend () -> PermissionStatus = { PermissionStatus.Denied }

    private fun say(s: String) { log(s) }

    fun initTts(c: Context) {
        if (tts != null) return
        tts = TextToSpeech(c.applicationContext) { ok ->
            if (ok == TextToSpeech.SUCCESS) { tts?.language = Locale.getDefault(); ttsReady = true }
        }
    }

    fun register(activity: Activity) {
        scope.launch { Wearables.registrationErrorStream.collect { say("Registration error: ${it.description}") } }
        scope.launch {
            Wearables.registrationState.collect { say("Registration: $it") }
        }
        Wearables.startRegistration(activity)
    }

    /** Opens a session and shows the home screen on the lens. */
    fun connect() {
        if (session != null) { say("Already connecting/connected"); return }
        Wearables.createSession(AutoDeviceSelector(filter = { it.isDisplayCapable() })).fold(
            onSuccess = { s ->
                session = s
                scope.launch { s.errors.collect { say("Session error: ${it.description}") } }
                scope.launch {
                    s.state.collect { st ->
                        say("Session: $st")
                        if (st == DeviceSessionState.STARTED && display == null) attachDisplay(s)
                        if (st == DeviceSessionState.STOPPED) { session = null; display = null }
                    }
                }
                s.start()
            },
            onFailure = { e, _ -> say("Could not create session: ${e.description}") },
        )
    }

    fun disconnect() {
        session?.stop(); session = null; display = null
    }

    private fun attachDisplay(s: DeviceSession) {
        s.addDisplay().fold(
            onSuccess = { d ->
                display = d
                scope.launch {
                    d.state.collect { st ->
                        say("Display: $st")
                        if (st == DisplayState.STARTED) home()
                    }
                }
            },
            onFailure = { e, _ -> say("Could not add display: ${e.description}") },
        )
    }

    private fun show(content: com.meta.wearable.dat.display.views.ContentScope.() -> Unit) {
        val d = display ?: return
        scope.launch {
            d.sendContent(content).fold(
                onSuccess = {},
                onFailure = { e, _ -> say("Display send failed: ${e.description}") },
            )
        }
    }

    private fun home(note: String? = null) = show {
        flexBox(direction = Direction.COLUMN, gap = 12, padding = 24, background = FlexBoxBackground.CARD) {
            text("GEMINI", style = TextStyle.HEADING)
            text(note ?: "Look at something, then pinch Ask.", style = TextStyle.BODY, color = TextColor.SECONDARY)
            button("Ask", style = ButtonStyle.PRIMARY, iconName = IconName.CHECKMARK,
                onClick = { ask() }, actionRole = ActionRole.PRIMARY)
        }
    }

    private fun thinking() = show {
        flexBox(padding = 24, background = FlexBoxBackground.CARD) {
            text("THINKING…", style = TextStyle.HEADING)
        }
    }

    private fun answer(a: Answer) = show {
        flexBox(direction = Direction.COLUMN, gap = 12, padding = 24, background = FlexBoxBackground.CARD) {
            text(a.headline, style = TextStyle.HEADING)
            a.bullets.forEach { text(it, style = TextStyle.BODY) }
            button("Ask again", style = ButtonStyle.PRIMARY, iconName = IconName.CHECKMARK,
                onClick = { ask() }, actionRole = ActionRole.PRIMARY)
        }
    }

    fun ask() {
        if (busy) return
        val s = session ?: run { say("Not connected"); return }
        if (display == null) { say("Display not ready"); return }
        if (apiKey().isBlank()) { home("Add your Gemini key in the phone app."); return }
        busy = true
        scope.launch {
            try {
                thinking()
                val bmp = takePhoto(s)
                val a = Gemini.ask(apiKey(), bmp, null, model())
                say("Gemini: ${a.headline}")
                answer(a)
                if (ttsReady) tts?.speak(a.spoken, TextToSpeech.QUEUE_FLUSH, null, "ans")
            } catch (e: Exception) {
                say("Ask failed: ${e.message}")
                home("Failed: ${e.message?.take(120)}")
            } finally {
                busy = false
            }
        }
    }

    private suspend fun takePhoto(s: DeviceSession): Bitmap {
        val perm = Wearables.checkPermissionStatus(Permission.CAMERA)
        var granted = false
        perm.fold(onSuccess = { granted = it == PermissionStatus.Granted }, onFailure = { e, _ -> say("Permission check: ${e.description}") })
        if (!granted && requestCamera() != PermissionStatus.Granted) error("Camera permission denied")

        val cam = CompletableDeferred<Camera>()
        s.addCamera(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 15)).fold(
            onSuccess = { cam.complete(it) },
            onFailure = { e, _ -> cam.completeExceptionally(IllegalStateException("addCamera: ${e.description}")) },
        )
        val camera = cam.await()
        try {
            val stream = camera.stream
            stream.start().fold(onSuccess = {}, onFailure = { e, _ -> error("stream start: ${e.description}") })
            withTimeout(15_000) { stream.state.first { it == StreamState.STREAMING } }
            delay(400) // let auto-exposure settle
            val out = CompletableDeferred<Bitmap>()
            stream.capturePhoto().fold(
                onSuccess = { p ->
                    val b = when (p) {
                        is PhotoData.Bitmap -> p.bitmap
                        is PhotoData.HEIC -> {
                            val buf: ByteBuffer = p.data.duplicate().apply { rewind() }
                            val bytes = ByteArray(buf.remaining()); buf.get(bytes)
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        }
                    }
                    if (b != null) out.complete(b) else out.completeExceptionally(IllegalStateException("Could not decode photo"))
                },
                onFailure = { e, _ -> out.completeExceptionally(IllegalStateException("capture: ${e.description}")) },
            )
            return out.await()
        } finally {
            camera.stop()
        }
    }
}
