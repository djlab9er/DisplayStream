package app.displaystream.gemini

import android.app.Application
import android.content.Context
import com.meta.wearable.dat.core.Wearables

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Wearables.initialize(this)
        val prefs = getSharedPreferences("gg", Context.MODE_PRIVATE)
        Glasses.initTts(this)
        Glasses.apiKey = { prefs.getString("key", "") ?: "" }
        Glasses.model = { prefs.getString("model", "") ?: "" }
        Glasses.speechRate = { prefs.getString("rate", "")?.toFloatOrNull()?.coerceIn(0.4f, 2f) ?: 0.8f }
    }
}
