package live.cohub.android.host

/**
 * Capabilities this build honours. The web side gates every optional call on
 * these, so a capability is a promise — advertise one only when the feature is
 * reachable. FCM is deliberately absent: the server has no delivery channel yet.
 */
object HostCapabilities {
    const val AUTH_TOKEN = "auth.token"
    const val AUTH_SIGN_IN = "auth.signIn"
    const val AUTH_SESSION = "auth.session"
    const val NOTIFICATIONS = "notifications"
    const val SHARE = "share"
    const val FILE_PICKER = "filePicker"
    const val NAVIGATION = "navigation"
    const val CACHE = "cache"
    const val RUNTIME = "runtime"
    const val APPEARANCE = "appearance"
    const val LAUNCH = "launch"
    const val HAPTICS = "haptics"
    const val FILES = "files"
    const val NAVIGATION_BACK = "navigation.back"
    const val SHORTCUTS = "shortcuts"
    const val DISPLAY = "display"

    private val always: List<String> = listOf(
        AUTH_TOKEN,
        AUTH_SIGN_IN,
        AUTH_SESSION,
        SHARE,
        NAVIGATION,
        CACHE,
        APPEARANCE,
        LAUNCH,
        HAPTICS,
        NAVIGATION_BACK,
        SHORTCUTS,
    )

    fun advertised(runtime: Boolean, files: Boolean): List<String> =
        always + listOfNotNull(RUNTIME.takeIf { runtime }, DISPLAY.takeIf { runtime }, FILES.takeIf { files })
}
