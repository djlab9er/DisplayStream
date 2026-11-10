package app.displaystream.gemini

import android.app.Application
import com.meta.wearable.dat.core.Wearables

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Wearables.initialize(this)
    }
}
