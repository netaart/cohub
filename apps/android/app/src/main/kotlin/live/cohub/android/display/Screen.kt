package live.cohub.android.display

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.Log
import android.view.Surface
import androidx.annotation.RequiresApi
import androidx.core.graphics.createBitmap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import live.cohub.android.helper.ICohubHelper
import java.io.ByteArrayOutputStream
import kotlin.math.abs

private const val TAG = "CohubDisplay"

data class Capture(val mimeType: String, val base64: String, val width: Int, val height: Int)

data class ScreenSize(val width: Int, val height: Int, val densityDpi: Int)

interface StreamSink {
    fun sample(data: ByteArray, length: Int, ptsUs: Long, key: Boolean)
    fun ended(error: DisplayError?)
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class Screen(
    val id: String,
    val displayId: Int,
    size: ScreenSize,
    private val helper: ICohubHelper,
    private val changes: FrameChanges,
) {
    private val captures = Mutex()
    private val lock = Any()
    private val sinks = mutableMapOf<StreamSink, Int>()
    private var encoder: ScreenEncoder? = null
    private var stream: IBinder? = null
    private var watch: IBinder? = null
    @Volatile private var released = false

    @Volatile var size: ScreenSize = size
        private set

    val agent: Boolean get() = displayId != android.view.Display.DEFAULT_DISPLAY

    val streaming: Boolean get() = synchronized(lock) { sinks.isNotEmpty() }

    fun mirror(surface: Surface, width: Int, height: Int): IBinder {
        if (released) throw DisplayError(DisplayError.UNAVAILABLE, "the screen is gone")
        return try {
            helper.mirror(displayId, width, height, surface)
        } catch (error: Exception) {
            throw DisplayError(DisplayError.FAILED, error.message ?: "the phone could not mirror the screen")
        }
    }

    fun unmirror(token: IBinder) {
        runCatching { helper.releaseMirror(token) }
    }

    fun watch(on: Boolean) {
        changes.reporting = on
        if (agent) return
        synchronized(lock) {
            watch?.let(::unmirror)
            watch = if (on && !released) changes.size(size).let { (width, height) -> mirror(changes.surface, width, height) } else null
        }
    }

    fun subscribe(sink: StreamSink, bitrate: Int) {
        synchronized(lock) {
            if (released) throw DisplayError(DisplayError.UNAVAILABLE, "the screen is gone")
            sinks[sink] = bitrate
            val current = try {
                encoder ?: startEncoder()
            } catch (error: Exception) {
                Log.w(TAG, "Encoder could not start", error)
                sinks.remove(sink)
                throw DisplayError(DisplayError.FAILED, "the video encoder could not start: ${error.message}")
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

    private fun startEncoder(): ScreenEncoder {
        val (width, height) = fit(size.width, size.height, MAX_STREAM_EDGE, align = 16)
        val created = ScreenEncoder(width, height, targetBitrate(), FPS, ::fanOut) { error ->
            Log.w(TAG, "Encoder failed", error)
            failEncoder()
        }
        val token = try {
            mirror(created.surface, width, height)
        } catch (error: DisplayError) {
            created.release()
            throw error
        }
        encoder = created
        stream = token
        return created
    }

    private fun stopEncoder() {
        stream?.let(::unmirror)
        stream = null
        encoder?.release()
        encoder = null
    }

    private fun failEncoder() {
        val ended = synchronized(lock) {
            sinks.keys.toList().also {
                sinks.clear()
                stopEncoder()
            }
        }
        ended.forEach { it.ended(DisplayError(DisplayError.FAILED, "the video encoder failed")) }
    }

    private fun fanOut(data: ByteArray, length: Int, ptsUs: Long, key: Boolean) {
        val targets = synchronized(lock) { sinks.keys.toList() }
        for (sink in targets) sink.sample(data, length, ptsUs, key)
    }

    suspend fun capture(format: String, quality: Int, maxSize: Int): Capture = captures.withLock {
        val (width, height) = fit(size.width, size.height, maxSize)
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
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
        }, FrameChanges.handler)
        val token = try {
            mirror(reader.surface, width, height)
        } catch (error: DisplayError) {
            reader.close()
            throw error
        }
        try {
            val bitmap = withTimeout(CAPTURE_TIMEOUT_MS) { frame.await() }
            withContext(Dispatchers.Default) { encode(bitmap, format, quality) }
        } catch (_: TimeoutCancellationException) {
            throw DisplayError(DisplayError.FAILED, "the screen produced no frame")
        } finally {
            unmirror(token)
            reader.close()
        }
    }

    private fun encode(bitmap: Bitmap, format: String, quality: Int): Capture {
        val out = ByteArrayOutputStream(bitmap.width * bitmap.height / 4)
        val png = format == "png"
        bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality, out)
        val capture = Capture(if (png) "image/png" else "image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), bitmap.width, bitmap.height)
        bitmap.recycle()
        return capture
    }

    fun resize(next: ScreenSize) {
        val restart = synchronized(lock) {
            if (released || next == size) return
            size = next
            watch?.let {
                unmirror(it)
                watch = runCatching { changes.size(next).let { (width, height) -> mirror(changes.surface, width, height) } }.getOrNull()
            }
            if (encoder == null) return@synchronized false
            stopEncoder()
            runCatching { startEncoder() }.isFailure
        }
        if (restart) failEncoder()
    }

    fun release() {
        val ended = synchronized(lock) {
            if (released) return
            released = true
            watch?.let(::unmirror)
            watch = null
            sinks.keys.toList().also {
                sinks.clear()
                stopEncoder()
            }
        }
        ended.forEach { it.ended(null) }
        if (agent) runCatching { helper.releaseDisplay(displayId) }
        changes.close()
    }

    companion object {
        const val FPS = 30
        const val DEFAULT_BITRATE = 2_000_000
        const val MIN_BITRATE = 150_000
        const val MAX_BITRATE = 8_000_000
        const val MAX_STREAM_EDGE = 1920
        private const val CAPTURE_TIMEOUT_MS = 2_000L

        fun fit(width: Int, height: Int, limit: Int, align: Int = 2): Pair<Int, Int> {
            val scale = if (limit > 0 && maxOf(width, height) > limit) limit.toDouble() / maxOf(width, height) else 1.0
            fun aligned(value: Int) = ((value * scale).toInt() / align * align).coerceAtLeast(align)
            return aligned(width) to aligned(height)
        }
    }
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class FrameChanges(size: ScreenSize, private val onChanged: () -> Unit) {
    private val dimensions = size(size)
    private val reader = ImageReader.newInstance(dimensions.first, dimensions.second, PixelFormat.RGBA_8888, 2)
    private var baseline: ByteArray? = null
    @Volatile var reporting = false

    val surface: Surface get() = reader.surface

    init {
        reader.setOnImageAvailableListener({ source ->
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            val grey = image.use {
                val plane = it.planes[0]
                val buffer = plane.buffer
                ByteArray(it.width * it.height) { index ->
                    val offset = (index / it.width) * plane.rowStride + (index % it.width) * plane.pixelStride
                    ((buffer.get(offset).toInt() and 0xff) * 77 + (buffer.get(offset + 1).toInt() and 0xff) * 150 + (buffer.get(offset + 2).toInt() and 0xff) * 29 ushr 8).toByte()
                }
            }
            val last = baseline
            if (last == null || differs(last, grey)) {
                baseline = grey
                if (last != null && reporting) onChanged()
            }
        }, handler)
    }

    fun size(screen: ScreenSize): Pair<Int, Int> =
        THUMB_WIDTH to (screen.height * THUMB_WIDTH / screen.width.coerceAtLeast(1)).coerceAtLeast(1)

    private fun differs(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return true
        var changed = 0
        for (i in a.indices) if (abs((a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)) > LEVELS) changed++
        return changed > a.size * SHARE
    }

    fun close() = reader.close()

    companion object {
        private const val THUMB_WIDTH = 96
        private const val LEVELS = 24
        private const val SHARE = 0.004
        private val thread = HandlerThread("cohub-frames").apply { start() }
        val handler = Handler(thread.looper)
    }
}
