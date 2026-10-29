package app.displaystream.cast

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: tap to start casting to the remembered glasses code, tap again to stop. */
class CastTileService : TileService() {
    override fun onStartListening() { refresh() }

    override fun onClick() {
        if (CastState.active) {
            startService(Intent(this, CastService::class.java).setAction(CastService.ACTION_STOP))
            return
        }
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_AUTOSTART, true)
        if (Build.VERSION.SDK_INT >= 34) {
            val pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            startActivityAndCollapse(pi)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(open)
        }
    }

    private fun refresh() {
        val t = qsTile ?: return
        t.state = if (CastState.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = "Cast to glasses"
        if (Build.VERSION.SDK_INT >= 29) t.subtitle = if (CastState.active) "Casting · tap to stop" else "Tap to start"
        t.updateTile()
    }
}
