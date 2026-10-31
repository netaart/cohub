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
            .setRank(1)
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
    }

    fun pushNewChat(context: Context) {
        val intent = Intent(Intent.ACTION_VIEW, WebOrigin.urlOf(NEW_CHAT_PATH).toUri(), context, MainActivity::class.java)
        val label = context.getString(R.string.shortcut_new_chat)
        val shortcut = ShortcutInfoCompat.Builder(context, "new-chat")
            .setShortLabel(label)
            .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_space))
            .setIntent(intent)
            .setRank(0)
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
    }

    fun clear(context: Context) {
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
    }

    const val NEW_CHAT_PATH = "/sessions/new"
    private const val SHORT_LABEL_MAX = 25
}
