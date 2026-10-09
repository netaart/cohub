package live.cohub.android.display

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream

private const val TAG = "CohubDisplay"

data class Capture(val mimeType: String, val base64: String, val width: Int, val height: Int)

data class ScreenSize(val width: Int, val height: Int, val densityDpi: Int)

interface StreamSink {
    fun sample(data: ByteArray, length: Int, ptsUs: Long, key: Boolean)
    fun ended(error: DisplayError?)
}

@RequiresApi(Build.VERSION_CODES.R)
internal class ScreenCapture(
    private val context: Context,
    private val projection: MediaProjection,
    private val onStopped: () -> Unit,
    private val onResized: (ScreenSize) -> Unit,
) {
    private val thread = HandlerThread("cohub-display").apply { start() }
    private val handler = Handler(thread.looper)
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val lock = Any()
    private val captureLock = Mutex()
    private val sinks = mutableMapOf<StreamSink, Int>()
    private var encoder: ScreenEncoder? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var stopped = false

    @Volatile var size: ScreenSize = currentSize()
        private set

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() = stop()
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) resize()
        }
    }

    init {
        // Android 14 requires the callback before the virtual display exists.
        projection.registerCallback(projectionCallback, handler)
        val streamSize = streamSize(size)
        virtualDisplay = projection.createVirtualDisplay(
            "cohub-display", streamSize.width, streamSize.height, size.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler,
        )
        displays.registerDisplayListener(displayListener, handler)
    }

    val active: Boolean get() = synchronized(lock) { !stopped }

    fun subscribe(sink: StreamSink, bitrate: Int) {
        synchronized(lock) {
            if (stopped) throw DisplayError(DisplayError.UNAVAILABLE, "screen sharing stopped")
            sinks[sink] = bitrate
            val current = encoder ?: startEncoder() ?: run {
                sinks.remove(sink)
                throw DisplayError(DisplayError.FAILED, "the video encoder could not start")
            }
            current.setBitrate(targetBitrate())
            current.requestKeyFrame()
        }
    }

    fun unsubscribe(sink: StreamSink) {
        synchronized(lock) {
            if (sinks.remove(sink) == null) return
            if (sinks.isEmpty()) stopEncoder() else encoder?.setBitrate(targetBitrate())
        }
    }

    fun setBitrate(sink: StreamSink, bps: Int) {
        synchronized(lock) {
            if (sink !in sinks) return
            sinks[sink] = bps
            encoder?.setBitrate(targetBitrate())
        }
    }

    fun requestKeyFrame() {
        synchronized(lock) { encoder?.requestKeyFrame() }
    }

    private fun targetBitrate(): Int = sinks.values.minOrNull()?.coerceIn(MIN_BITRATE, MAX_BITRATE) ?: DEFAULT_BITRATE

    private fun startEncoder(): ScreenEncoder? {
        val streamSize = streamSize(size)
        val created = runCatching {
            ScreenEncoder(streamSize.width, streamSize.height, targetBitrate(), FPS, ::fanOut) { error ->
                Log.w(TAG, "Encoder failed", error)
                handler.post { failEncoder() }
            }
        }.onFailure { Log.w(TAG, "Encoder could not start", it) }.getOrNull() ?: return null
        encoder = created
        virtualDisplay?.surface = created.surface
        return created
    }

    private fun stopEncoder() {
        val current = encoder ?: return
        encoder = null
        virtualDisplay?.surface = null
        current.release()
    }

    private fun failEncoder() {
        val ended = synchronized(lock) {
            val all = sinks.keys.toList()
            sinks.clear()
            stopEncoder()
            all
        }
        ended.forEach { it.ended(DisplayError(DisplayError.FAILED, "the video encoder failed")) }
    }

    private fun fanOut(data: ByteArray, length: Int, ptsUs: Long, key: Boolean) {
        val targets = synchronized(lock) { sinks.keys.toList() }
        for (sink in targets) sink.sample(data, length, ptsUs, key)
    }

    suspend fun capture(format: String, quality: Int, maxSize: Int): Capture = captureLock.withLock {
        val streamSize = streamSize(size)
        val reader = ImageReader.newInstance(streamSize.width, streamSize.height, PixelFormat.RGBA_8888, 2)
        try {
            val frame = CompletableDeferred<Bitmap>()
            reader.setOnImageAvailableListener({ source ->
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                image.use {
                    val plane = it.planes[0]
                    val padded = createBitmap(plane.rowStride / plane.pixelStride, it.height)
                    padded.copyPixelsFromBuffer(plane.buffer)
                    val bitmap = if (padded.width == it.width) padded else Bitmap.createBitmap(padded, 0, 0, it.width, it.height).also { padded.recycle() }
                    if (!frame.complete(bitmap)) bitmap.recycle()
                }
            }, handler)
            synchronized(lock) {
                if (stopped) throw DisplayError(DisplayError.UNAVAILABLE, "screen sharing stopped")
                virtualDisplay?.surface = reader.surface
            }
            val bitmap = try {
                withTimeout(CAPTURE_TIMEOUT_MS) { frame.await() }
            } finally {
                synchronized(lock) {
                    virtualDisplay?.surface = encoder?.surface
                    encoder?.requestKeyFrame()
                }
            }
            withContext(Dispatchers.Default) { encode(bitmap, format, quality, maxSize) }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw DisplayError(DisplayError.FAILED, "the screen produced no frame")
        } finally {
            reader.close()
        }
    }

    private fun encode(bitmap: Bitmap, format: String, quality: Int, maxSize: Int): Capture {
        val (width, height) = fit(bitmap.width, bitmap.height, maxSize)
        val scaled = if (width == bitmap.width && height == bitmap.height) bitmap else bitmap.scale(width, height)
        val out = ByteArrayOutputStream(width * height / 4)
        val png = format == "png"
        scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality, out)
        if (scaled !== bitmap) scaled.recycle()
        bitmap.recycle()
        return Capture(if (png) "image/png" else "image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), width, height)
    }

    private fun resize() {
        val next = currentSize()
        val restarted = synchronized(lock) {
            if (stopped || next == size) return
            size = next
            val streamSize = streamSize(next)
            virtualDisplay?.resize(streamSize.width, streamSize.height, next.densityDpi)
            if (encoder == null) return@synchronized false
            stopEncoder()
            startEncoder() != null
        }
        if (!restarted && synchronized(lock) { sinks.isNotEmpty() && encoder == null }) failEncoder()
        onResized(next)
    }

    @Suppress("DEPRECATION")
    private fun currentSize(): ScreenSize {
        val display = displays.getDisplay(Display.DEFAULT_DISPLAY)
        val point = android.graphics.Point()
        display.getRealSize(point)
        return ScreenSize(point.x, point.y, context.resources.displayMetrics.densityDpi)
    }

    fun stop() {
        val ended = synchronized(lock) {
            if (stopped) return
            stopped = true
            val all = sinks.keys.toList()
            sinks.clear()
            stopEncoder()
            all
        }
        ended.forEach { it.ended(null) }
        displays.unregisterDisplayListener(displayListener)
        virtualDisplay?.release()
        virtualDisplay = null
        projection.unregisterCallback(projectionCallback)
        projection.stop()
        thread.quitSafely()
        onStopped()
    }

    companion object {
        const val FPS = 30
        const val DEFAULT_BITRATE = 2_000_000
        const val MIN_BITRATE = 150_000
        const val MAX_BITRATE = 8_000_000
        const val MAX_STREAM_EDGE = 1920
        private const val CAPTURE_TIMEOUT_MS = 2_000L

        fun streamSize(screen: ScreenSize): ScreenSize {
            val (width, height) = fit(screen.width, screen.height, MAX_STREAM_EDGE, align = 16)
            return ScreenSize(width, height, screen.densityDpi)
        }

        fun fit(width: Int, height: Int, limit: Int, align: Int = 2): Pair<Int, Int> {
            val scale = if (limit > 0 && maxOf(width, height) > limit) limit.toDouble() / maxOf(width, height) else 1.0
            fun aligned(value: Int) = ((value * scale).toInt() / align * align).coerceAtLeast(align)
            return aligned(width) to aligned(height)
        }
    }
}
