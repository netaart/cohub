package live.cohub.android.ui

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import androidx.core.content.edit
import androidx.core.graphics.ColorUtils
import live.cohub.android.R

class ShellAppearance(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var backgroundColor: Int = prefs.getInt(key(), context.getColor(R.color.shell_background))
        private set

    val isDark: Boolean
        get() = ColorUtils.calculateContrast(Color.WHITE, backgroundColor) >
            ColorUtils.calculateContrast(Color.BLACK, backgroundColor)

    fun update(color: Int): Boolean {
        if (prefs.getInt(key(), 0) != color) prefs.edit { putInt(key(), color) }
        if (color == backgroundColor) return false
        backgroundColor = color
        return true
    }

    private fun key(): String {
        val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) KEY_NIGHT else KEY_DAY
    }

    private companion object {
        const val PREFS = "cohub-appearance"
        const val KEY_DAY = "background_day"
        const val KEY_NIGHT = "background_night"
    }
}
