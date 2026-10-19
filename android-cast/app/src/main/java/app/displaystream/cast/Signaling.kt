package app.displaystream.cast

import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Minimal PeerJS-broker client (wire protocol of peerjs 1.5.4), media calls only. */
class Signaling(
    private val myId: String,
    private val listener: Listener,
    private val host: String = "0.peerjs.com",
) {
    interface Listener {
        fun onOpen()
        fun onAnswer(connectionId: String, sdp: String)
        fun onCandidate(connectionId: String, mid: String?, index: Int, candidate: String)
        fun onError(message: String)
        fun onClosed()
    }

    private val client = OkHttpClient.Builder().pingInterval(0, TimeUnit.SECONDS).build()
    private var ws: WebSocket? = null
    private var beat: ScheduledExecutorService? = null
    @Volatile private var closed = false

    fun connect() {
        val token = java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        val url = "wss://$host/peerjs?key=peerjs&id=$myId&token=$token"
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (e: Exception) { return }
                when (m.optString("type")) {
                    "OPEN" -> { startBeat(); listener.onOpen() }
                    "ID-TAKEN", "INVALID-KEY", "ERROR" -> listener.onError(m.optJSONObject("payload")?.optString("msg") ?: m.optString("type"))
                    "ANSWER" -> {
                        val p = m.optJSONObject("payload") ?: return
                        val sdp = p.optJSONObject("sdp")?.optString("sdp") ?: return
                        listener.onAnswer(p.optString("connectionId"), sdp)
                    }
                    "CANDIDATE" -> {
                        val p = m.optJSONObject("payload") ?: return
                        val c = p.optJSONObject("candidate") ?: return
                        listener.onCandidate(
                            p.optString("connectionId"),
                            if (c.isNull("sdpMid")) null else c.optString("sdpMid"),
                            c.optInt("sdpMLineIndex", 0),
                            c.optString("candidate"),
                        )
                    }
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!closed) listener.onError("Network error: ${t.message}")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) listener.onClosed()
            }
        })
    }

    private fun startBeat() {
        beat = Executors.newSingleThreadScheduledExecutor().also {
            it.scheduleAtFixedRate({ ws?.send("""{"type":"HEARTBEAT"}""") }, 5, 5, TimeUnit.SECONDS)
        }
    }

    fun sendOffer(dst: String, connectionId: String, sdp: String) {
        val payload = JSONObject()
            .put("sdp", JSONObject().put("type", "offer").put("sdp", sdp))
            .put("type", "media")
            .put("connectionId", connectionId)
            .put("browser", "chrome")
        ws?.send(JSONObject().put("type", "OFFER").put("dst", dst).put("payload", payload).toString())
    }

    fun sendCandidate(dst: String, connectionId: String, mid: String?, index: Int, candidate: String) {
        val c = JSONObject().put("candidate", candidate).put("sdpMLineIndex", index)
        if (mid != null) c.put("sdpMid", mid)
        val payload = JSONObject().put("candidate", c).put("type", "media").put("connectionId", connectionId)
        ws?.send(JSONObject().put("type", "CANDIDATE").put("dst", dst).put("payload", payload).toString())
    }

    fun close() {
        closed = true
        beat?.shutdownNow()
        ws?.close(1000, null)
        client.dispatcher.executorService.shutdown()
    }
}
