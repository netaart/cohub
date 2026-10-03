package live.cohub.android.host

/**
 * `cohub.host.v1` wire contract, mirroring `packages/protocol/src/host-bridge.ts`.
 * Change both together.
 */
object HostProtocol {
    const val VERSION = 1
    const val GLOBAL = "cohubHost"
    const val PLATFORM = "android"

    object Methods {
        const val HOST_DESCRIBE = "host.describe"
        const val AUTH_GET_ACCESS_TOKEN = "auth.getAccessToken"
        const val AUTH_GET_SESSION_VERSION = "auth.getSessionVersion"
        const val AUTH_GET_SESSION = "auth.getSession"
        const val AUTH_SIGN_IN = "auth.signIn"
        const val AUTH_SIGN_OUT = "auth.signOut"
        const val NOTIFICATIONS_REGISTER = "notifications.register"
        const val SHARE_TEXT = "share.text"
        const val NAVIGATION_OPEN_PATH = "navigation.openPath"
        const val CACHE_CLEAR = "cache.clear"
    }

    object Errors {
        const val UNSUPPORTED = "unsupported"
        const val UNAUTHORIZED = "unauthorized"
        const val CANCELED = "canceled"
        const val FAILED = "failed"
    }

    object Events {
        const val AUTH_CHANGED = "auth.changed"
        const val AUTH_SIGNED_OUT = "auth.signedOut"
        const val NAVIGATION_BACK = "navigation.back"
        const val APP_FOREGROUND = "app.foreground"
        const val APP_BACKGROUND = "app.background"
    }
}
