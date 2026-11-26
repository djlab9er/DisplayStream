package app.displaystream.gemini

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** One picture to show on the lens. */
class Picture(val label: String, val caption: String, val bitmap: Bitmap)

/**
 * Finds real photos for names Gemini suggests (e.g. "Gala apple") using Wikipedia's free API: no key, no account.
 * Each name is searched, and the top article's lead image is downloaded and shrunk for the lens.
 */
object Pictures {
    private const val UA = "GeminiGlasses/0.2 (personal app; github.com/djlab9er/DisplayStream)"
    private const val MAX_EDGE = 360
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()

    suspend fun find(names: List<String>, note: (String) -> Unit = {}): List<Picture> = withContext(Dispatchers.IO) {
        coroutineScope {
            names.take(6).map { n -> async { runCatching { one(n) }.onFailure { note("Picture '$n': ${it.message}") }.getOrNull() } }
                .awaitAll().filterNotNull()
        }
    }

    private fun one(name: String): Picture? {
        val url = "https://en.wikipedia.org/w/api.php".toHttpUrl().newBuilder()
            .addQueryParameter("action", "query").addQueryParameter("format", "json")
            .addQueryParameter("formatversion", "2").addQueryParameter("redirects", "1")
            .addQueryParameter("generator", "search").addQueryParameter("gsrsearch", name)
            .addQueryParameter("gsrlimit", "1")
            .addQueryParameter("prop", "pageimages|description")
            .addQueryParameter("piprop", "thumbnail").addQueryParameter("pithumbsize", "480")
            .build()
        val body = get(url.toString())?.toString(Charsets.UTF_8) ?: return null
        val pages = JSONObject(body).optJSONObject("query")?.optJSONArray("pages") ?: return null
        if (pages.length() == 0) return null
        val p = pages.getJSONObject(0)
        val src = p.optJSONObject("thumbnail")?.optString("source").orEmpty()
        if (src.isEmpty()) return null
        val bytes = get(src) ?: return null
        val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val m = maxOf(raw.width, raw.height)
        val bmp = if (m <= MAX_EDGE) raw else {
            val f = MAX_EDGE.toFloat() / m
            Bitmap.createScaledBitmap(raw, (raw.width * f).toInt(), (raw.height * f).toInt(), true).also { raw.recycle() }
        }
        return Picture(name, p.optString("description").take(80), bmp)
    }

    private fun get(url: String): ByteArray? =
        http.newCall(Request.Builder().url(url).header("User-Agent", UA).build()).execute().use { r ->
            if (r.isSuccessful) r.body?.bytes() else null
        }
}
