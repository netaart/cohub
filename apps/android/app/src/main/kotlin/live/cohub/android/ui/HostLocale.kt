package live.cohub.android.ui

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.core.content.edit
import live.cohub.android.host.HostProtocol

object HostLocale {
    private const val PREFS = "cohub-host"
    private const val KEY = "locale"
    private val SUPPORTED = setOf(HostProtocol.Locales.EN, HostProtocol.Locales.ZH_CN)

    @Volatile
    private var configured: Pair<String, Context>? = null

    fun set(context: Context, tag: String?): Boolean {
        val locale = tag?.takeIf { it in SUPPORTED }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previous = prefs.getString(KEY, null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val manager = context.getSystemService(LocaleManager::class.java)
            val wanted = when {
                locale != null -> LocaleList.forLanguageTags(locale)
                previous != null -> LocaleList.getEmptyLocaleList()
                else -> null
            }
            if (wanted != null && wanted != manager.applicationLocales) manager.applicationLocales = wanted
        }
        if (locale == previous) return false
        prefs.edit { if (locale == null) remove(KEY) else putString(KEY, locale) }
        return true
    }

    fun strings(context: Context): Context {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return context
        val locale = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return context
        configured?.takeIf { it.first == locale }?.let { return it.second }
        val app = context.applicationContext
        val configuration = Configuration(app.resources.configuration).apply { setLocales(LocaleList.forLanguageTags(locale)) }
        return app.createConfigurationContext(configuration).also { configured = locale to it }
    }
}
