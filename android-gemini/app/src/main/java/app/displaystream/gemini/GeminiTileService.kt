package app.displaystream.gemini

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: tap to connect to the glasses (and start the Gemini lens screen), tap again to stop. */
class GeminiTileService : TileService() {
    override fun onStartListening() { refresh() }

    override fun onClick() {
        if (Glasses.active) {
            Glasses.disconnect()
            KeepAliveService.stop(this)
        } else {
            KeepAliveService.start(this)
            Glasses.connect()
        }
        refresh()
    }

    private fun refresh() {
        val t = qsTile ?: return
        t.state = if (Glasses.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = "Gemini Glasses"
        t.subtitle = if (Glasses.active) "On · tap to stop" else "Tap to start"
        t.updateTile()
    }
}
