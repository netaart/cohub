package live.cohub.android.display

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.view.Display
import android.view.Surface
import androidx.annotation.RequiresApi
import live.cohub.android.helper.ICohubHelper

internal interface ScreenSource {
    val recording: Boolean

    fun mirror(surface: Surface, width: Int, height: Int, background: Boolean): IBinder

    fun unmirror(token: IBinder)

    fun release()
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class HelperSource(private val helper: ICohubHelper, private val displayId: Int) : ScreenSource {
    override val recording = false

    override fun mirror(surface: Surface, width: Int, height: Int, background: Boolean): IBinder =
        helper.mirror(displayId, width, height, surface) ?: throw DisplayError(DisplayError.FAILED, "the phone could not mirror the screen")

    override fun unmirror(token: IBinder) {
        runCatching { helper.releaseMirror(token) }
    }

    override fun release() {
        if (displayId != Display.DEFAULT_DISPLAY) runCatching { helper.releaseDisplay(displayId) }
    }
}

/** Screen recording: one virtual display, held by the newest mirror; background ones get it only when alone. */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class ProjectionSource(private val projection: MediaProjection, size: ScreenSize, onStop: () -> Unit) : ScreenSource {
    private class Mirror(val token: IBinder, val surface: Surface, val width: Int, val height: Int, val background: Boolean)

    private val densityDpi = size.densityDpi
    private val mirrors = mutableListOf<Mirror>()
    private val callback = object : MediaProjection.Callback() {
        override fun onStop() = onStop()
    }
    private val display: VirtualDisplay
    private var shown: Mirror? = null

    override val recording = true

    init {
        projection.registerCallback(callback, FrameChanges.handler)
        display = projection.createVirtualDisplay(
            "cohub-screen", size.width, size.height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, FrameChanges.handler,
        ) ?: throw DisplayError(DisplayError.FAILED, "the phone could not record the screen")
    }

    @Synchronized
    override fun mirror(surface: Surface, width: Int, height: Int, background: Boolean): IBinder {
        val mirror = Mirror(Binder(), surface, width, height, background)
        mirrors += mirror
        show()
        return mirror.token
    }

    @Synchronized
    override fun unmirror(token: IBinder) {
        if (mirrors.removeAll { it.token === token }) show()
    }

    private fun show() {
        val next = mirrors.lastOrNull { !it.background } ?: mirrors.lastOrNull()
        if (next === shown) return
        shown = next
        if (next != null) display.resize(next.width, next.height, densityDpi)
        display.surface = next?.surface
    }

    @Synchronized
    override fun release() {
        mirrors.clear()
        projection.unregisterCallback(callback)
        display.release()
        projection.stop()
    }
}
