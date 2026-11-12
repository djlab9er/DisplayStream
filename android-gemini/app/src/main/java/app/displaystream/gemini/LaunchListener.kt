package app.displaystream.gemini

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Waits on PeerJS's public broker under id "pggem-<code>". When the glasses web app (gemini/index.html)
 * pings that id, [onLaunch] runs and the glasses get an ANSWER back so they can say "starting".
 */
class LaunchListener(private val code: String, private val onLaunch: () -> Unit) {
    private val client = OkHttpClient.Builder().pingInterval(0, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var beat: Runnable? = null
    @Volatile private var stopped = false

    fun start() { stopped = false; open() }

    private fun open() {
        if (stopped) return
        val token = java.util.UUID.randomUUID().toString().replace("-", "").take(12)
        val url = "wss://0.peerjs.com/peerjs?key=peerjs&id=pggem-$code&token=$token"
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (e: Exception) { return }
                when (m.optString("type")) {
                    "OPEN" -> startBeat(webSocket)
                    "OFFER" -> {
                        val src = m.optString("src")
                        if (src.startsWith("pgglaunch-")) {
                            val payload = JSONObject().put("type", "launch").put("connectionId", "launch")
                            webSocket.send(JSONObject().put("type", "ANSWER").put("dst", src).put("payload", payload).toString())
                            main.post { onLaunch() }
                        }
                    }
                    "ID-TAKEN" -> retry()
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry()
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
        })
    }

    private fun startBeat(w: WebSocket) {
        beat?.let { main.removeCallbacks(it) }
        val r = object : Runnable {
            override fun run() {
                if (stopped || ws !== w) return
                w.send("""{"type":"HEARTBEAT"}""")
                main.postDelayed(this, 5000)
            }
        }
        beat = r
        main.postDelayed(r, 5000)
    }

    private fun retry() {
        if (stopped) return
        beat?.let { main.removeCallbacks(it) }
        main.postDelayed({ open() }, 5000)
    }

    fun stop() {
        stopped = true
        beat?.let { main.removeCallbacks(it) }
        ws?.close(1000, null)
        client.dispatcher.executorService.shutdown()
    }
}
