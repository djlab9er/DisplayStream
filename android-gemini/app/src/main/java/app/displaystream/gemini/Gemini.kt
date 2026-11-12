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

data class Answer(val headline: String, val bullets: List<String>, val spoken: String)

object Gemini {
    const val DEFAULT_MODEL = "gemini-3.8-flash"
    private const val FALLBACK = "gemini-2.5-flash"
    private val http = OkHttpClient.Builder()
        .callTimeout(40, TimeUnit.SECONDS).build()

    private const val PROMPT =
        "You are an assistant on smart glasses with a tiny 600x600 display. Look at the photo " +
        "and say what the person is looking at and anything useful about it. Be brief."

    suspend fun ask(
        key: String, photo: Bitmap, question: String?, model: String = DEFAULT_MODEL,
        wav: ByteArray? = null, mode: Mode = Mode.LOOK, prev: Answer? = null,
    ): Answer = withContext(Dispatchers.IO) {
        val m = model.ifBlank { DEFAULT_MODEL }
        try { call(key, photo, question, m, true, wav, mode, prev, mode == Mode.SPEAK) }
        catch (e: ModelRejected) {
            // Some models reject Google Search together with structured output: retry plain on the same model, then on the fallback.
            try { call(key, photo, question, m, false, wav, mode, prev, false) }
            catch (e2: ModelRejected) { call(key, photo, question, FALLBACK, false, wav, mode, prev, false) }
        }
    }

    private class ModelRejected(msg: String) : Exception(msg)

    private fun call(key: String, photo: Bitmap, question: String?, model: String, thinking: Boolean, wav: ByteArray?, mode: Mode, prev: Answer?, grounded: Boolean): Answer {
        val scaled = scale(photo, 1024)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)

        val schema = JSONObject()
            .put("type", "OBJECT")
            .put("properties", JSONObject()
                .put("headline", JSONObject().put("type", "STRING")
                    .put("description", "2 to 5 words, uppercase"))
                .put("bullets", JSONObject().put("type", "ARRAY")
                    .put("items", JSONObject().put("type", "STRING"))
                    .put("description", "2 or 3 lines, each under 85 characters"))
                .put("spokenSummary", JSONObject().put("type", "STRING")
                    .put("description", "1 or 2 short sentences to read aloud")))
            .put("required", JSONArray(listOf("headline", "bullets", "spokenSummary")))

        val parts = JSONArray()
            .put(JSONObject().put("text", buildString {
                when (mode) {
                    Mode.TRANSLATE -> append("You are an assistant on smart glasses with a tiny 600x600 display. Read all visible text in the photo, translate it into clear English, and highlight prices, key items or warnings. Be brief.")
                    Mode.SPEAK -> append("$PROMPT The attached audio is the person's spoken question about what they are looking at. Answer that question directly, using up-to-date web knowledge if it helps.")
                    Mode.LOOK -> append(PROMPT)
                }
                if (prev != null && mode == Mode.SPEAK)
                    append("\nContext from the previous answer on the display: ${prev.headline} - ${prev.bullets.joinToString("; ")}")
                if (question?.isNotBlank() == true) append("\nQuestion: $question")
            }))
            .apply {
                if (wav != null) put(JSONObject().put("inline_data", JSONObject()
                    .put("mime_type", "audio/wav").put("data", Base64.encodeToString(wav, Base64.NO_WRAP))))
            }
            .put(JSONObject().put("inline_data", JSONObject().put("mime_type", "image/jpeg").put("data", b64)))
        val body = JSONObject()
            .put("contents", JSONArray().put(JSONObject().put("parts", parts)))
            .put("generationConfig", JSONObject()
                .apply { if (thinking) put("thinkingConfig", JSONObject().put("thinkingLevel", "LOW")) }
                .put("responseMimeType", "application/json")
                .put("responseSchema", schema))

        if (grounded) body.put("tools", JSONArray().put(JSONObject().put("google_search", JSONObject())))
        val req = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
            .header("x-goog-api-key", key)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return http.newCall(req).execute().use { r ->
            val txt = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val msg = runCatching { JSONObject(txt).getJSONObject("error").getString("message") }.getOrDefault(txt.take(200))
                if (r.code == 400 || r.code == 404) throw ModelRejected("Gemini ${r.code} ($model): $msg")
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
            Answer(
                j.getString("headline"),
                (0 until arr.length()).map { arr.getString(it) },
                j.optString("spokenSummary", j.getString("headline")),
            )
        }
    }

    private fun scale(b: Bitmap, max: Int): Bitmap {
        val m = maxOf(b.width, b.height)
        if (m <= max) return b
        val f = max.toFloat() / m
        return Bitmap.createScaledBitmap(b, (b.width * f).toInt(), (b.height * f).toInt(), true)
    }
}
