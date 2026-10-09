package live.cohub.android.host

import android.content.Context
import androidx.core.content.edit
import androidx.core.net.toUri

class LastPage(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(): String? = prefs.getString(KEY, null)

    fun remember(url: String) {
        val path = WebOrigin.pathOf(url.toUri()) ?: return
        val route = path.substringBefore('?').substringBefore('#')
        if (route in HOMES || ONE_SHOT.any { route == it || route.startsWith("$it/") }) return
        if (path != read()) prefs.edit { putString(KEY, path) }
    }

    fun clear() {
        prefs.edit { remove(KEY) }
    }

    private companion object {
        const val PREFS = "cohub-host"
        const val KEY = "last_page"

        val HOMES = setOf("/", "/zh")
        val ONE_SHOT = listOf("/callback", "/app-auth", "/mobile")
    }
}
