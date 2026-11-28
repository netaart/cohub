package live.cohub.android.host

import live.cohub.android.host.HostProtocol.Capabilities as C

/**
 * Capabilities this build honours. The web side gates every optional call on
 * these, so a capability is a promise — advertise one only when the feature is
 * reachable. FCM is deliberately absent: the server has no delivery channel yet.
 */
object HostCapabilities {
    private val always: List<String> = listOf(
        C.AUTH_TOKEN,
        C.AUTH_SIGN_IN,
        C.AUTH_SESSION,
        C.AUTH_PROVIDER,
        C.SHARE,
        C.NAVIGATION,
        C.CACHE,
        C.APPEARANCE,
        C.LAUNCH,
        C.HAPTICS,
        C.NAVIGATION_BACK,
        C.SHORTCUTS,
        C.MEDIA_CAPTURE,
        C.PERMISSIONS,
        C.SHARE_INCOMING,
        C.SHARE_FILE_URL,
        C.APP_ABOUT,
        C.APP_LOCALE,
    )

    fun advertised(runtime: Boolean, files: Boolean, display: Boolean = runtime, fileStream: Boolean = false): List<String> =
        always + listOfNotNull(C.FILES.takeIf { files }, C.FILES_STREAM.takeIf { files && fileStream }) +
            (if (runtime) listOf(C.RUNTIME, C.WORKSPACE, C.WORKSPACE_FILES) else emptyList()) +
            (if (runtime && display) listOf(C.DISPLAY, C.DISPLAY_PRESENTING, C.DISPLAY_FLOAT) else emptyList())
}
