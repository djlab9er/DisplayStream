package app.displaystream.gemini

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
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
import com.meta.wearable.dat.core.types.DeviceIdentifier
import com.meta.wearable.dat.core.types.LinkState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.removeDisplay
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/** What the phone screen shows about the link to the glasses. */
enum class Link { OFF, CONNECTING, READY, BUSY }

/** Owns the glasses session: registration, display, camera, and the ask-Gemini loop. */
object Glasses {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: DeviceSession? = null
    private var display: Display? = null
    private var busy = false
    private var lastAnswer: Answer? = null
    /** The last photo as sent to Gemini (small JPEG), kept for follow-up questions. */
    private var lastJpeg: ByteArray? = null
    private var lastMode = Mode.LOOK
    /** When the spoken answer finished; 0 when not relevant. Used to recover if the glasses close the screen then. */
    private var speechDoneAt = 0L
    private var restore: Answer? = null
    private var registrationWatched = false
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

    /** Link state for the phone screen; [onStatus] is called on the main thread when it changes. */
    var link = Link.OFF
        private set
    var onStatus: ((Link) -> Unit)? = null
    private fun mark(l: Link) { if (link != l) { link = l; onStatus?.invoke(l) } }
    /** Shows Meta's camera/microphone prompt. Set only while the phone screen is open, since the prompt needs it. */
    var requestPermission: (suspend (Permission) -> PermissionStatus)? = null

    private fun say(s: String) { log(s) }

    fun initTts(c: Context) {
        if (tts != null) return
        tts = TextToSpeech(c.applicationContext) { ok ->
            if (ok == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { speechDoneAt = System.currentTimeMillis() }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {}
                })
                ttsReady = true
            }
        }
    }

    fun register(activity: Activity) {
        if (!registrationWatched) {
            registrationWatched = true
            scope.launch { Wearables.registrationErrorStream.collect { say("Registration error: ${it.description}") } }
            scope.launch { Wearables.registrationState.collect { say("Registration: $it") } }
        }
        Wearables.startRegistration(activity)
    }

    private var sessionJob: Job? = null
    private var retryJob: Job? = null
    private var lastLaunch = 0L
    private var devicesWatched = false
    /** Last known link state per pair of glasses, as reported by the Meta AI app. */
    private val links = mutableMapOf<DeviceIdentifier, String>()

    /** Logs whenever the Meta AI app reports a change in the glasses' link, so "no eligible device" can be explained. */
    fun watchDevices() {
        if (devicesWatched) return
        devicesWatched = true
        val jobs = mutableMapOf<DeviceIdentifier, Job>()
        scope.launch {
            Wearables.devices.collect { ids ->
                (jobs.keys - ids).forEach { id -> jobs.remove(id)?.cancel(); links.remove(id); say("Glasses: gone from Meta AI") }
                ids.forEach { id ->
                    jobs.getOrPut(id) {
                        scope.launch {
                            Wearables.devicesMetadata[id]?.collect { d ->
                                val line = "${d.linkState}" + (if (d.isDisplayCapable()) "" else ", no display") +
                                    ", ${d.compatibility}, battery ${d.batteryLevel}%, heat ${d.thermalLevel}"
                                if (links[id] != line) { links[id] = line; say("Glasses: $line") }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun glassesLinked(): Boolean = links.values.any { it.startsWith(LinkState.CONNECTED.toString()) }

    /**
     * Called when the Gemini web app on the glasses asks to start. Both relays deliver the same request,
     * and the page retries, so ignore repeats while a connection is already being made.
     */
    fun launchFromGlasses() {
        val now = System.currentTimeMillis()
        if (session != null || retryJob?.isActive == true || now - lastLaunch < 8000) return
        lastLaunch = now
        say("Glasses launcher: start requested")
        connect()
    }

    /** Drops everything tied to the current session so the next connect() starts from a clean slate. */
    private fun cleanup() {
        sessionJob?.cancel(); sessionJob = null
        session = null; display = null; current = null; busy = false
        mark(Link.OFF)
    }

    /**
     * The glasses ended the session. If that happened right after a spoken answer to a voice question
     * (the glasses seem to close the screen when that audio ends), reopen once and put the answer back.
     */
    private fun endedByGlasses() {
        val a = lastAnswer
        val revive = a != null && lastMode == Mode.SPEAK && speechDoneAt != 0L &&
            System.currentTimeMillis() - speechDoneAt < 4000
        speechDoneAt = 0L
        cleanup()
        if (revive) {
            say("Glasses closed the screen right after speaking: reopening the answer")
            restore = a
            scope.launch { delay(1000); if (session == null) connect() }
        }
    }

    /** Opens a session and shows the home screen on the lens. Retries a few times if the glasses aren't ready. */
    fun connect(attempt: Int = 0) {
        if (session != null) { say("Already connecting/connected"); return }
        if (attempt == 0) retryJob?.cancel()
        mark(Link.CONNECTING)
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
                            if (session === s) { try { s.stop() } catch (e: Exception) {}; endedByGlasses() }
                        }
                    }
                }
                ss.launch {
                    s.state.collect { st ->
                        say("Session: $st")
                        if (st == DeviceSessionState.STARTED && display == null) attachDisplay(s, ss)
                        if (st == DeviceSessionState.STOPPED && session === s) endedByGlasses()
                    }
                }
                s.start()
            },
            onFailure = { e, _ ->
                say("Could not create session: ${e.description}" + if (attempt == 0) (if (glassesLinked()) "" else " (glasses not linked yet)") else "")
                // One retry chain at a time; wait for the glasses to come back if they aren't linked.
                if (attempt < 5) {
                    retryJob?.cancel()
                    retryJob = scope.launch {
                        var waited = 0
                        do { delay(1000); waited++ } while (!glassesLinked() && waited < 6)
                        if (session == null) connect(attempt + 1)
                    }
                } else {
                    say("Gave up. Make sure the glasses show as connected in the Meta AI app, then tap Connect.")
                    mark(Link.OFF)
                }
            },
        )
    }

    fun disconnect() {
        retryJob?.cancel()
        try { session?.removeDisplay() } catch (e: Exception) {}
        try { session?.stop() } catch (e: Exception) {}
        restore = null; speechDoneAt = 0L
        tts?.stop()
        cleanup()
    }

    private fun attachDisplay(s: DeviceSession, ss: CoroutineScope) {
        s.addDisplay().fold(
            onSuccess = { d ->
                display = d
                ss.launch {
                    d.state.collect { st ->
                        say("Display: $st")
                        if (st == DisplayState.STARTED) {
                            if (!busy) mark(Link.READY)
                            val c = current
                            val r = restore
                            restore = null
                            if (c != null) show(c) else if (r != null) answer(r) else home()
                        }
                    }
                }
            },
            onFailure = { e, _ -> say("Could not add display: ${e.description}") },
        )
    }

    private val sendLock = Mutex()
    private var screenVersion = 0

    /**
     * Puts a screen on the lens. Sends go one at a time and a screen that has already been replaced is skipped,
     * so a slow "THINKING…" can never land on top of the answer.
     */
    private fun show(content: com.meta.wearable.dat.display.views.ContentScope.() -> Unit) {
        current = content
        val v = ++screenVersion
        scope.launch {
            sendLock.withLock {
                if (v != screenVersion) return@withLock
                val d = display ?: return@withLock
                d.sendContent(content).fold(
                    onSuccess = {},
                    onFailure = { e, _ -> say("Display send failed: ${e.description}") },
                )
            }
        }
    }

    /** Sends the current screen again (used after the camera releases the lens, which can drop an update). */
    private fun reshow(afterMs: Long) {
        val c = current ?: return
        val v = screenVersion
        scope.launch { delay(afterMs); if (v == screenVersion && current === c) show(c) }
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
                if (lastJpeg != null) {
                    button("Follow-up", style = ButtonStyle.PRIMARY, iconName = IconName.CHECKMARK,
                        onClick = { ask(Mode.SPEAK, followUp = true) }, actionRole = ActionRole.PRIMARY)
                    button("Home", style = ButtonStyle.SECONDARY, onClick = { say("Tap received: home"); home() })
                } else {
                    button("Home", style = ButtonStyle.PRIMARY, onClick = { say("Tap received: home"); home() }, actionRole = ActionRole.PRIMARY)
                }
            }
        }
    }

    fun ask(mode: Mode = Mode.LOOK, followUp: Boolean = false) {
        val voice = mode == Mode.SPEAK
        say("Tap received: ${if (followUp) "Follow-up" else mode.name.lowercase()}")
        if (busy) { say("Ignored: still working on the last request"); return }
        val s = session ?: run { say("Not connected"); return }
        if (display == null) { say("Display not ready"); return }
        if (apiKey().isBlank()) { home("Add your Gemini key in the phone app."); return }
        busy = true
        mark(Link.BUSY)
        speechDoneAt = 0L
        tts?.stop()
        scope.launch {
            try {
                status(if (voice && followUp) "FOLLOW-UP…" else if (voice) "LISTENING…" else if (mode == Mode.TRANSLATE) "READING…" else "LOOK…", if (voice) "Ask your question" else null)
                val reuse = if (followUp) lastJpeg else null
                val cap = capture(s, voice, skipPhoto = reuse != null)
                status("THINKING…")
                val photo = cap.photo
                val jpeg = reuse ?: withContext(Dispatchers.Default) {
                    Gemini.encode(photo ?: error("No photo"), Gemini.edgeFor(mode))
                }
                lastJpeg = jpeg
                val t0 = System.currentTimeMillis()
                val a = Gemini.ask(apiKey(), jpeg, model(), cap.wav, mode,
                    lastAnswer?.takeIf { System.currentTimeMillis() - lastAt < 120_000 }) { say(it) }
                say("Gemini: ${a.headline} (${(System.currentTimeMillis() - t0) / 100 / 10.0}s)")
                lastAnswer = a; lastAt = System.currentTimeMillis(); lastMode = mode
                answer(a)
                reshow(1500)
                if (ttsReady) {
                    tts?.setSpeechRate(speechRate())
                    tts?.speak(a.spoken, TextToSpeech.QUEUE_FLUSH, null, "ans")
                }
            } catch (e: Exception) {
                say("Ask failed: ${e.message}")
                home("Failed: ${e.message?.take(120)}")
            } finally {
                busy = false
                if (session != null) mark(if (display != null) Link.READY else Link.CONNECTING)
            }
        }
    }

    private class Capture(val photo: Bitmap?, val wav: ByteArray?)

    /**
     * Checks Meta's camera/microphone permission. If it isn't granted and the phone screen is open, shows the prompt
     * (with a time limit). Otherwise carries on and lets the glasses decide, so a stale "not granted" answer never blocks.
     */
    private suspend fun ensure(p: Permission) {
        var status: PermissionStatus? = null
        Wearables.checkPermissionStatus(p).fold(
            onSuccess = { status = it },
            onFailure = { e, _ -> say("Permission check (${p.name}): ${e.description}") })
        if (status == PermissionStatus.Granted) return
        say("${p.name} permission: ${status ?: "unknown"}")
        val ask = requestPermission
        if (ask == null) {
            say("Phone screen closed, trying ${p.name} anyway. If it fails, open Gemini Glasses on the phone and try again.")
            return
        }
        val r = withTimeoutOrNull(60_000) { ask(p) }
        say("${p.name} permission answer: ${r ?: "no answer"}")
        if (r == PermissionStatus.Denied) error("${p.name} permission denied in Meta AI")
    }

    private suspend fun capture(s: DeviceSession, voice: Boolean, skipPhoto: Boolean = false): Capture {
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
            // Wait for the camera to actually deliver a frame before asking for a photo; asking earlier tends to fail.
            if (!skipPhoto) {
                val t0 = System.currentTimeMillis()
                val got = withTimeoutOrNull(4000) { stream.videoStream.first { !it.isCodecConfig } }
                say(if (got != null) "Camera ready (${System.currentTimeMillis() - t0} ms)" else "Camera: no frame yet, trying anyway")
            }
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
            if (skipPhoto) {
                val wav2 = if (voice) synchronized(pcm) { wavOf(pcm.toByteArray()) } else null
                return Capture(null, wav2)
            }
            // Photo transfer from the glasses sometimes fails on a weak link: try up to 3 times.
            var photo: Bitmap? = null
            var lastErr = ""
            for (attempt in 1..3) {
                stream.capturePhoto().fold(
                    onSuccess = { p ->
                        photo = when (p) {
                            is PhotoData.Bitmap -> p.bitmap
                            is PhotoData.HEIC -> {
                                val buf: ByteBuffer = p.data.duplicate().apply { rewind() }
                                val bytes = ByteArray(buf.remaining()); buf.get(bytes)
                                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            }
                        }
                        if (photo == null) lastErr = "could not decode photo"
                    },
                    onFailure = { e, _ -> lastErr = e.description },
                )
                if (photo != null) break
                say("Photo attempt $attempt failed: $lastErr")
                if (attempt < 3) delay(1200)
            }
            if (photo == null) error("capture: $lastErr")
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
