package app.displaystream.gemini

import android.graphics.Bitmap
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

enum class Mode { LOOK, SPEAK, TRANSLATE }

data class Answer(val headline: String, val bullets: List<String>, val spoken: String, val pictures: List<String> = emptyList())

object Gemini {
    const val DEFAULT_MODEL = "gemini-4-hydrogen"
    private const val FALLBACK = "gemini-3.8-flash"
    private val JSON_TYPE = "application/json".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS).build()

    private const val BASE =
        "You are an assistant on smart glasses with a tiny 600x600 display. "
    private const val PROMPT = BASE +
        "Look at the photo and say what the person is looking at and anything useful about it. Be brief."

    /** Built once: the shape of every answer (headline, bullets, spoken line). */
    private val SCHEMA: JSONObject = JSONObject()
        .put("type", "OBJECT")
        .put("properties", JSONObject()
            .put("headline", JSONObject().put("type", "STRING")
                .put("description", "2 to 5 words, uppercase"))
            .put("bullets", JSONObject().put("type", "ARRAY")
                .put("items", JSONObject().put("type", "STRING"))
                .put("description", "2 or 3 lines, each under 85 characters"))
            .put("spokenSummary", JSONObject().put("type", "STRING")
                .put("description", "1 or 2 short sentences to read aloud"))
            .put("pictures", JSONObject().put("type", "ARRAY")
                .put("items", JSONObject().put("type", "STRING"))
                .put("description", "Only if the person asks to see pictures, examples, kinds or types of something: " +
                    "2 to 6 specific names to look up photos of on Wikipedia, e.g. 'Gala (apple)', 'Granny Smith'. Otherwise an empty list.")))
        .put("required", JSONArray(listOf("headline", "bullets", "spokenSummary")))

    /** Longest edge sent to Gemini: small text needs more pixels than a general scene. */
    fun edgeFor(mode: Mode) = if (mode == Mode.TRANSLATE) 1024 else 768

    /** Shrinks and JPEG-encodes a photo once, so retries and follow-ups reuse the same bytes. */
    fun encode(photo: Bitmap, maxEdge: Int): ByteArray {
        val m = maxOf(photo.width, photo.height)
        val scaled = if (m <= maxEdge) photo else {
            val f = maxEdge.toFloat() / m
            Bitmap.createScaledBitmap(photo, (photo.width * f).toInt(), (photo.height * f).toInt(), true)
        }
        val out = ByteArrayOutputStream(160 * 1024)
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
        if (scaled !== photo) scaled.recycle()
        return out.toByteArray()
    }

    private class ModelRejected(msg: String) : Exception(msg)

    /** What a request may include beyond the basics. Dropped step by step if the model refuses them. */
    private class Extras(val resolution: Boolean, val thinking: Boolean, val grounded: Boolean)

    /**
     * Asks Gemini about a photo (already JPEG-encoded). If the model rejects the request, retries with
     * fewer options and finally on the fallback model; [note] reports each step so it shows in the log.
     */
    suspend fun ask(
        key: String, jpeg: ByteArray, model: String, wav: ByteArray?, mode: Mode, prev: Answer?,
        note: (String) -> Unit = {},
    ): Answer = withContext(Dispatchers.IO) {
        val m = model.ifBlank { DEFAULT_MODEL }
        val image = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        val audio = wav?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
        val web = mode == Mode.SPEAK
        val steps = listOf(
            m to Extras(resolution = true, thinking = true, grounded = web),
            m to Extras(resolution = false, thinking = true, grounded = web),
            m to Extras(resolution = false, thinking = false, grounded = false),
            FALLBACK to Extras(resolution = false, thinking = false, grounded = false),
        )
        var last: Exception? = null
        for ((i, step) in steps.withIndex()) {
            try {
                val a = call(key, image, audio, step.first, mode, prev, step.second)
                if (i > 0) note("Answered by ${step.first} after $i retr${if (i == 1) "y" else "ies"}")
                return@withContext a
            } catch (e: ModelRejected) {
                last = e
                note("${e.message}")
            }
        }
        throw last ?: IllegalStateException("Gemini gave no answer")
    }

    private fun call(key: String, image: String, audio: String?, model: String, mode: Mode, prev: Answer?, x: Extras): Answer {
        val prompt = buildString {
            when (mode) {
                Mode.TRANSLATE -> append(BASE + "Read all visible text in the photo, translate it into clear English, and highlight prices, key items or warnings. Be brief.")
                Mode.SPEAK -> append("$PROMPT The attached audio is the person's spoken question about what they are looking at. Answer that question directly, using up-to-date web knowledge if it helps. If they ask to see pictures or kinds of something, list them in pictures; the photos are shown separately, so keep the text short.")
                Mode.LOOK -> append(PROMPT)
            }
            if (prev != null && mode == Mode.SPEAK)
                append("\nContext from the previous answer on the display: ${prev.headline} - ${prev.bullets.joinToString("; ")}")
        }
        val parts = JSONArray().put(JSONObject().put("text", prompt))
        if (audio != null) parts.put(JSONObject().put("inline_data", JSONObject()
            .put("mime_type", "audio/wav").put("data", audio)))
        parts.put(JSONObject().put("inline_data", JSONObject().put("mime_type", "image/jpeg").put("data", image)))

        val config = JSONObject()
            .put("responseMimeType", "application/json")
            .put("responseSchema", SCHEMA)
        if (x.thinking) config.put("thinkingConfig", JSONObject().put("thinkingLevel", "LOW"))
        if (x.resolution) config.put("mediaResolution",
            if (mode == Mode.TRANSLATE) "MEDIA_RESOLUTION_HIGH" else "MEDIA_RESOLUTION_MEDIUM")
        val body = JSONObject()
            .put("contents", JSONArray().put(JSONObject().put("parts", parts)))
            .put("generationConfig", config)
        if (x.grounded) body.put("tools", JSONArray().put(JSONObject().put("google_search", JSONObject())))

        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
            .header("x-goog-api-key", key)
            .post(body.toString().toRequestBody(JSON_TYPE))
            .build()
        return http.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val msg = runCatching { JSONObject(txt).getJSONObject("error").getString("message") }.getOrDefault(txt.take(200))
                if (r.code == 400 || r.code == 404) throw ModelRejected("Gemini ${r.code} ($model): ${msg.take(160)}")
                error("Gemini ${r.code}: $msg")
            }
            val ps = JSONObject(txt).getJSONArray("candidates").getJSONObject(0)
                .getJSONObject("content").getJSONArray("parts")
            var text = "{}"
            for (i in 0 until ps.length()) {
                val o = ps.getJSONObject(i)
                if (!o.optBoolean("thought", false) && o.has("text")) text = o.getString("text")
            }
            val j = JSONObject(text)
            val arr = j.getJSONArray("bullets")
            val pics = j.optJSONArray("pictures")
            Answer(
                j.getString("headline"),
                (0 until arr.length()).map { arr.getString(it) },
                j.optString("spokenSummary", j.getString("headline")),
                if (pics == null) emptyList() else (0 until pics.length()).map { pics.getString(it) }.filter { it.isNotBlank() },
            )
        }
    }
}
