package app.displaystream.cast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import org.webrtc.*

class CastService : Service(), Signaling.Listener {
    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_RESULT = "resultCode"
        const val EXTRA_DATA = "data"
        const val ACTION_STOP = "app.displaystream.cast.STOP"
        private const val CHANNEL = "cast"
        private const val NOTIF_ID = 1
    }

    private val main = Handler(Looper.getMainLooper())
    private var signaling: Signaling? = null
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var egl: EglBase? = null
    private var dst = ""
    private var connectionId = ""
    private var remoteSet = false
    private val pendingRemote = mutableListOf<IceCandidate>()
    private var timeout: Runnable? = null
    private var stopped = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopCast("Stopped."); return START_NOT_STICKY }
        val code = intent?.getStringExtra(EXTRA_CODE)
        val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
        val result = intent?.getIntExtra(EXTRA_RESULT, 0) ?: 0
        if (code == null || data == null) { stopSelf(); return START_NOT_STICKY }

        // Must be a foreground service of type mediaProjection BEFORE the projection is used.
        startAsForeground()
        CastState.update("Connecting…", true)
        try {
            begin(code, result, data)
        } catch (e: Exception) {
            stopCast("Failed to start: ${e.message}")
        }
        return START_NOT_STICKY
    }

    private fun startAsForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Casting", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(
            this, 0, Intent(this, CastService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("Casting your screen to the glasses")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else startForeground(NOTIF_ID, n)
    }

    private fun begin(code: String, resultCode: Int, data: Intent) {
        dst = "pgcast-$code"
        connectionId = "mc_" + java.util.UUID.randomUUID().toString().replace("-", "").take(16)

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions(),
        )
        egl = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
            .createPeerConnectionFactory()

        // Scale the capture so the long edge is at most 720 px.
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(0).getRealMetrics(dm)
        val scale = minOf(1f, 720f / maxOf(dm.widthPixels, dm.heightPixels))
        val w = (dm.widthPixels * scale).toInt() and 1.inv()
        val h = (dm.heightPixels * scale).toInt() and 1.inv()

        capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() { main.post { stopCast("Screen sharing was stopped.") } }
        })
        helper = SurfaceTextureHelper.create("capture", egl!!.eglBaseContext)
        source = factory!!.createVideoSource(true)
        capturer!!.initialize(helper, applicationContext, source!!.capturerObserver)
        capturer!!.startCapture(w, h, 15)
        track = factory!!.createVideoTrack("screen", source)

        val cfg = PeerConnection.RTCConfiguration(
            listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
            ),
        ).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }

        pc = factory!!.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                signaling?.sendCandidate(dst, connectionId, c.sdpMid, c.sdpMLineIndex, c.sdp)
            }
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {
                main.post {
                    when (s) {
                        PeerConnection.IceConnectionState.CONNECTED,
                        PeerConnection.IceConnectionState.COMPLETED -> { clearTimeout(); CastState.update("Casting. Tap Stop to end.", true) }
                        PeerConnection.IceConnectionState.FAILED,
                        PeerConnection.IceConnectionState.CLOSED -> stopCast("Connection lost.")
                        PeerConnection.IceConnectionState.DISCONNECTED -> CastState.update("Reconnecting…", true)
                        else -> {}
                    }
                }
            }
            override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
            override fun onAddStream(s: MediaStream?) {}
            override fun onRemoveStream(s: MediaStream?) {}
            override fun onDataChannel(d: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver?, s: Array<out MediaStream>?) {}
        })
        pc!!.addTrack(track, listOf("stream"))
        // Cap bitrate for a small display / mobile networks.
        pc!!.senders.firstOrNull()?.let { s ->
            val p = s.parameters
            p.encodings.forEach { it.maxBitrateBps = 1_500_000; it.maxFramerate = 15 }
            s.parameters = p
        }

        signaling = Signaling(newPeerId(), this).also { it.connect() }
        timeout = Runnable { stopCast("No answer. Check the code, and that the glasses are not already casting.") }
        main.postDelayed(timeout!!, 20_000)
    }

    private fun newPeerId() = "pgsend-" + java.util.UUID.randomUUID().toString().replace("-", "").take(10)
    private fun clearTimeout() { timeout?.let { main.removeCallbacks(it) }; timeout = null }

    // ---- Signaling callbacks (called on OkHttp threads) ----
    override fun onOpen() {
        val peer = pc ?: return
        peer.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(d: SessionDescription) {
                peer.setLocalDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() { signaling?.sendOffer(dst, connectionId, d.description) }
                }, d)
            }
        }, MediaConstraints())
    }

    override fun onAnswer(connectionId: String, sdp: String) {
        if (connectionId != this.connectionId) return
        main.post {
            pc?.setRemoteDescription(object : SdpObserverAdapter() {
                override fun onSetSuccess() {
                    main.post {
                        remoteSet = true
                        pendingRemote.forEach { pc?.addIceCandidate(it) }
                        pendingRemote.clear()
                    }
                }
            }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
        }
    }

    override fun onCandidate(connectionId: String, mid: String?, index: Int, candidate: String) {
        if (connectionId != this.connectionId) return
        val c = IceCandidate(mid, index, candidate)
        main.post { if (remoteSet) pc?.addIceCandidate(c) else pendingRemote.add(c) }
    }

    override fun onError(message: String) { main.post { stopCast("Error: $message") } }
    override fun onClosed() { main.post { if (!stopped) stopCast("Disconnected from the broker.") } }

    private fun stopCast(message: String) {
        if (stopped) return
        stopped = true
        clearTimeout()
        try { signaling?.close() } catch (_: Exception) {}
        try { capturer?.stopCapture() } catch (_: Exception) {}
        try { capturer?.dispose() } catch (_: Exception) {}
        try { pc?.close() } catch (_: Exception) {}
        try { track?.dispose(); source?.dispose(); helper?.dispose(); factory?.dispose(); egl?.release() } catch (_: Exception) {}
        CastState.update(message, false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() { if (!stopped) stopCast("Stopped."); super.onDestroy() }
}

open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(d: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(e: String?) {}
    override fun onSetFailure(e: String?) {}
}
