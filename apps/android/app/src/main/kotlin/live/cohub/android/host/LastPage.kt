package live.cohub.android.host

import android.content.Context
import androidx.core.content.edit
import androidx.core.net.toUri

class LastPage(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(): String? = prefs.getString(KEY, null)

    fun remember(url: String) {
        val path = WebOrigin.pathOf(url.toUri()) ?: return
        if (isResumable(path) && path != read()) prefs.edit { putString(KEY, path) }
    }

    fun clear() {
        prefs.edit { remove(KEY) }
    }

    companion object {
        private const val PREFS = "cohub-host"
        private const val KEY = "last_page"

        fun isResumable(path: String): Boolean {
            if (!path.startsWith("/") || path.startsWith("//")) return false
            val route = path.substringBefore('?').substringBefore('#')
            return route !in HostProtocol.LANDING_PATHS &&
                HostProtocol.ONE_SHOT_PATHS.none { route == it || route.startsWith("$it/") }
        }
    }
}
