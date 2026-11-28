package live.cohub.android.host

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import live.cohub.android.host.HostProtocol.Capabilities as C

class HostProtocolTest {

    @Test
    fun `runtime remains available without display control`() {
        val capabilities = HostCapabilities.advertised(runtime = true, files = true, display = false)
        assertTrue(C.RUNTIME in capabilities)
        assertTrue(C.WORKSPACE in capabilities)
        assertTrue(C.WORKSPACE_FILES in capabilities)
        assertFalse(C.DISPLAY in capabilities)
        assertFalse(C.DISPLAY_PRESENTING in capabilities)
        assertFalse(C.DISPLAY_FLOAT in capabilities)
    }

    @Test
    fun `notifications is not advertised until delivery exists`() {
        // The server has no FCM channel; claiming it would make the web side
        // wait for notifications that never arrive.
        assertFalse(C.NOTIFICATIONS in HostCapabilities.advertised(runtime = true, files = true))
    }

    @Test
    fun `files stream only where files are saved and frames can cross`() {
        assertTrue(C.FILES_STREAM in HostCapabilities.advertised(runtime = false, files = true, fileStream = true))
        assertFalse(C.FILES_STREAM in HostCapabilities.advertised(runtime = false, files = true))
        assertFalse(C.FILES_STREAM in HostCapabilities.advertised(runtime = false, files = false, fileStream = true))
    }
}
