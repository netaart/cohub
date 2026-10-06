package live.cohub.android.host

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.net.toUri
import live.cohub.android.MainActivity
import live.cohub.android.R

object LauncherShortcuts {

    fun push(context: Context, id: String, label: String, path: String) {
        val intent = Intent(Intent.ACTION_VIEW, WebOrigin.urlOf(path).toUri(), context, MainActivity::class.java)
        val shortcut = ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(label.take(SHORT_LABEL_MAX).trimEnd(Char::isHighSurrogate))
            .setLongLabel(label)
            .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_space))
            .setIntent(intent)
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
    }

    fun clear(context: Context) {
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
    }

    private const val SHORT_LABEL_MAX = 25
}
