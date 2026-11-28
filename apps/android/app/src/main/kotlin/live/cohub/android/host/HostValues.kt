package live.cohub.android.host

object HostValues {
    const val PLATFORM = "android"

    enum class Haptic(val wire: String) {
        TICK("tick"),
        CONFIRM("confirm"),
        REJECT("reject"),
        LONG_PRESS("longPress"),
        ;

        companion object {
            fun of(wire: String?): Haptic? = entries.firstOrNull { it.wire == wire }
        }
    }

    private val COLOR = Regex("^#[0-9a-fA-F]{6}$")

    fun parseColor(value: String): Int? =
        if (COLOR.matches(value)) (0xFF000000 or value.substring(1).toLong(16)).toInt() else null
}
