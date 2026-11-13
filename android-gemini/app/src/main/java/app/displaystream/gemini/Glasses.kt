package app.displaystream.gemini

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.speech.tts.TextToSpeech
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.AudioCodec
import com.meta.wearable.dat.camera.types.AudioSampleRate
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/** Owns the glasses session: registration, display, camera, and the ask-Gemini loop. */
object Glasses {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: DeviceSession? = null
    private var display: Display? = null
    private var busy = false
    private var lastAnswer: Answer? = null
    private var lastPhoto: Bitmap? = null
    private var lastAt = 0L
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    /** The screen currently meant to be on the lens, so it can be restored if the glasses interrupt the display. */
    private var current: (com.meta.wearable.dat.display.views.ContentScope.() -> Unit)? = null

    var log: (String) -> Unit = {}
    var apiKey: () -> String = { "" }
    var model: () -> String = { "" }
    var speechRate: () -> Float = { 0.8f }
    val active: Boolean get() = session != null
    var requestPermission: suspend (Permission) -> PermissionStatus = { PermissionStatus.Denied }

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

    private var sessionJob: Job? = null

    /** Drops everything tied to the current session so the next connect() starts from a clean slate. */
    private fun cleanup() {
        sessionJob?.cancel(); sessionJob = null
        session = null; display = null; current = null; busy = false
    }

    /** Opens a session and shows the home screen on the lens. Retries a few times if the glasses aren't ready. */
    fun connect(attempt: Int = 0) {
        if (session != null) { say("Already connecting/connected"); return }
        Wearables.createSession(AutoDeviceSelector(filter = { it.isDisplayCapable() })).fold(
            onSuccess = { s ->
                session = s
                val job = SupervisorJob()
                sessionJob = job
                val ss = CoroutineScope(job + Dispatchers.Main)
                ss.launch {
                    s.errors.collect {
                        say("Session error: ${it.description}")
                        // The glasses ended it. If the state never reaches STOPPED, don't stay stuck as "connected".
                        ss.launch {
                            delay(2500)
                            if (session === s) { try { s.stop() } catch (e: Exception) {}; cleanup() }
                        }
                    }
                }
                ss.launch {
                    s.state.collect { st ->
                        say("Session: $st")
                        if (st == DeviceSessionState.STARTED && display == null) attachDisplay(s, ss)
                        if (st == DeviceSessionState.STOPPED && session === s) cleanup()
                    }
                }
                s.start()
            },
            onFailure = { e, _ ->
                say("Could not create session: ${e.description}")
                if (attempt < 3) scope.launch { delay(4000); if (session == null) connect(attempt + 1) }
            },
        )
    }

    fun disconnect() {
        try { session?.stop() } catch (e: Exception) {}
        cleanup()
    }

    private fun attachDisplay(s: DeviceSession, ss: CoroutineScope) {
        s.addDisplay().fold(
            onSuccess = { d ->
                display = d
                ss.launch {
                    d.state.collect { st ->
                        say("Display: $st")
                        if (st == DisplayState.STARTED) { val c = current; if (c != null) show(c) else home() }
                    }
                }
            },
            onFailure = { e, _ -> say("Could not add display: ${e.description}") },
        )
    }

    private fun show(content: com.meta.wearable.dat.display.views.ContentScope.() -> Unit) {
        current = content
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
            text(note ?: "Look at something, then pinch.", style = TextStyle.BODY, color = TextColor.SECONDARY)
            actions()
        }
    }

    private fun com.meta.wearable.dat.display.views.FlexBoxScope.actions() {
        buttonGroup {
            button("Speak", style = ButtonStyle.PRIMARY, iconName = IconName.CHECKMARK,
                onClick = { ask(Mode.SPEAK) }, actionRole = ActionRole.PRIMARY)
            button("Look", style = ButtonStyle.SECONDARY, onClick = { ask(Mode.LOOK) })
            button("Translate", style = ButtonStyle.SECONDARY, onClick = { ask(Mode.TRANSLATE) })
        }
    }

    private fun status(title: String, sub: String? = null) = show {
        flexBox(direction = Direction.COLUMN, gap = 12, padding = 24, background = FlexBoxBackground.CARD) {
            text(title, style = TextStyle.HEADING)
            if (sub != null) text(sub, style = TextStyle.BODY, color = TextColor.SECONDARY)
        }
    }

    private fun answer(a: Answer) = show {
        flexBox(direction = Direction.COLUMN, gap = 12, padding = 24, background = FlexBoxBackground.CARD) {
            text(a.headline, style = TextStyle.HEADING)
            a.bullets.forEach { text(it, style = TextStyle.BODY) }
            buttonGroup {
                if (lastPhoto != null) {
                    button("Follow-up", style = ButtonStyle.PRIMARY, iconName = IconName.CHECKMARK,
                        onClick = { ask(Mode.SPEAK, followUp = true) }, actionRole = ActionRole.PRIMARY)
                    button("Home", style = ButtonStyle.SECONDARY, onClick = { home() })
                } else {
                    button("Home", style = ButtonStyle.PRIMARY, onClick = { home() }, actionRole = ActionRole.PRIMARY)
                }
            }
        }
    }

    fun ask(mode: Mode = Mode.LOOK, followUp: Boolean = false) {
        val voice = mode == Mode.SPEAK
        if (busy) return
        val s = session ?: run { say("Not connected"); return }
        if (display == null) { say("Display not ready"); return }
        if (apiKey().isBlank()) { home("Add your Gemini key in the phone app."); return }
        busy = true
        scope.launch {
            try {
                status(if (voice && followUp) "FOLLOW-UP…" else if (voice) "LISTENING…" else if (mode == Mode.TRANSLATE) "READING…" else "LOOK…", if (voice) "Ask your question" else null)
                val reuse = if (followUp) lastPhoto else null
                val cap = capture(s, voice, reuse)
                lastPhoto = cap.photo
                status("THINKING…")
                val a = Gemini.ask(apiKey(), cap.photo, null, model(), cap.wav, mode,
                    lastAnswer?.takeIf { System.currentTimeMillis() - lastAt < 120_000 })
                say("Gemini: ${a.headline}")
                lastAnswer = a; lastAt = System.currentTimeMillis()
                answer(a)
                if (ttsReady) tts?.setSpeechRate(speechRate()); tts?.speak(a.spoken, TextToSpeech.QUEUE_FLUSH, null, "ans")
            } catch (e: Exception) {
                say("Ask failed: ${e.message}")
                home("Failed: ${e.message?.take(120)}")
            } finally {
                busy = false
            }
        }
    }

    private class Capture(val photo: Bitmap, val wav: ByteArray?)

    private suspend fun ensure(p: Permission) {
        var granted = false
        Wearables.checkPermissionStatus(p).fold(
            onSuccess = { granted = it == PermissionStatus.Granted },
            onFailure = { e, _ -> say("Permission check: ${e.description}") })
        if (!granted && requestPermission(p) != PermissionStatus.Granted) error("${p.name} permission denied")
    }

    private suspend fun capture(s: DeviceSession, voice: Boolean, reuse: Bitmap? = null): Capture {
        ensure(Permission.CAMERA)
        if (voice) ensure(Permission.MICROPHONE)

        val cam = CompletableDeferred<Camera>()
        val cfg = StreamConfiguration(
            audioCodec = if (voice) AudioCodec.PCM(AudioSampleRate.RATE_16000, 1) else null,
            videoQuality = VideoQuality.LOW,
            frameRate = 7,
            compressVideo = true,
        )
        s.addCamera(cfg).fold(
            onSuccess = { cam.complete(it) },
            onFailure = { e, _ -> cam.completeExceptionally(IllegalStateException("addCamera: ${e.description}")) },
        )
        val camera = cam.await()
        var audioJob: Job? = null
        try {
            val stream = camera.stream
            val pcm = ByteArrayOutputStream()
            val heard = MutableStateFlow(0L) // bumps on every loud frame
            var lastLoud = 0L
            var spoke = false
            var frames = 0
            var maxRms = 0
            if (voice) {
                audioJob = scope.launch(Dispatchers.Default) {
                    stream.audioStream.collect { frame ->
                        val sb = frame.buffer.duplicate().order(ByteOrder.nativeOrder()).asShortBuffer()
                        if (!sb.hasRemaining()) return@collect
                        var sum = 0.0
                        val bytes = ByteArray(sb.remaining() * 2)
                        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                        while (sb.hasRemaining()) { val v = sb.get(); sum += v.toDouble() * v; bb.putShort(v) }
                        synchronized(pcm) { pcm.write(bytes) }
                        val rms = Math.sqrt(sum / (bytes.size / 2))
                        frames++
                        if (rms.toInt() > maxRms) maxRms = rms.toInt()
                        if (rms > 600) { spoke = true; lastLoud = System.currentTimeMillis(); heard.value = lastLoud }
                    }
                }
            }
            stream.start().fold(onSuccess = {}, onFailure = { e, _ -> error("stream start: ${e.description}") })
            withTimeout(15_000) { stream.state.first { it == StreamState.STREAMING } }
            if (voice) {
                val t0 = System.currentTimeMillis()
                while (true) {
                    delay(100)
                    val now = System.currentTimeMillis()
                    if (spoke && now - lastLoud > 1300) break
                    if (!spoke && now - t0 > 7000) error(if (frames == 0) "No audio from glasses mic (turn off Hey Meta in Meta AI, close other mic apps)" else "I didn't hear anything (loudest $maxRms, need 600)")
                    if (now - t0 > 15000) break
                }
            } else {
                delay(400)
            }
            if (reuse != null) {
                val wav2 = if (voice) synchronized(pcm) { wavOf(pcm.toByteArray()) } else null
                return Capture(reuse, wav2)
            }
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
            val photo = out.await()
            val wav = if (voice) synchronized(pcm) { wavOf(pcm.toByteArray()) } else null
            return Capture(photo, wav)
        } finally {
            audioJob?.cancel()
            camera.stop()
        }
    }

    private fun wavOf(pcm: ByteArray, rate: Int = 16000): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }
}
