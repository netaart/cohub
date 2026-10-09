package live.cohub.android.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These constants must match `packages/protocol/src/host-bridge.ts`. Drift fails
 * silently at runtime (every call degrades to the browser path), so it is
 * pinned here where a mismatch is cheap to catch.
 */
class HostProtocolTest {

    @Test
    fun `constants match the protocol package`() {
        assertEquals(1, HostProtocol.VERSION)
        assertEquals("cohubHost", HostProtocol.GLOBAL)
    }

    @Test
    fun `method and event names match the protocol tables`() {
        assertEquals(
            setOf(
                "host.describe", "auth.getAccessToken", "auth.getSessionVersion",
                "auth.getSession", "auth.signIn", "auth.signOut",
                "notifications.register", "share.text", "navigation.openPath", "cache.clear",
            ),
            setOf(
                HostProtocol.Methods.HOST_DESCRIBE,
                HostProtocol.Methods.AUTH_GET_ACCESS_TOKEN,
                HostProtocol.Methods.AUTH_GET_SESSION_VERSION,
                HostProtocol.Methods.AUTH_GET_SESSION,
                HostProtocol.Methods.AUTH_SIGN_IN,
                HostProtocol.Methods.AUTH_SIGN_OUT,
                HostProtocol.Methods.NOTIFICATIONS_REGISTER,
                HostProtocol.Methods.SHARE_TEXT,
                HostProtocol.Methods.NAVIGATION_OPEN_PATH,
                HostProtocol.Methods.CACHE_CLEAR,
            ),
        )
        assertEquals(
            listOf("auth.changed", "auth.signedOut", "navigation.back", "app.foreground", "app.background"),
            listOf(
                HostProtocol.Events.AUTH_CHANGED,
                HostProtocol.Events.AUTH_SIGNED_OUT,
                HostProtocol.Events.NAVIGATION_BACK,
                HostProtocol.Events.APP_FOREGROUND,
                HostProtocol.Events.APP_BACKGROUND,
            ),
        )
    }

    @Test
    fun `every advertised capability is known to the web side`() {
        val known = setOf(
            "auth.token", "auth.signIn", "auth.session", "notifications",
            "share", "filePicker", "navigation", "cache", "runtime", "appearance",
            "launch", "haptics", "files", "navigation.back", "shortcuts", "display",
        )
        HostCapabilities.advertised(runtime = true, files = true).forEach { capability ->
            assertTrue("Unknown capability advertised: $capability", capability in known)
        }
    }

    @Test
    fun `notifications is not advertised until delivery exists`() {
        // The server has no FCM channel; claiming it would make the web side
        // wait for notifications that never arrive.
        assertFalse(HostCapabilities.NOTIFICATIONS in HostCapabilities.advertised(runtime = true, files = true))
    }
}
