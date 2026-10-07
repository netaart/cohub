package live.cohub.android.display

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Surface
import androidx.annotation.RequiresApi

private const val TAG = "CohubDisplay"

@RequiresApi(Build.VERSION_CODES.R)
internal class ScreenEncoder(
    val width: Int,
    val height: Int,
    bitrate: Int,
    private val fps: Int,
    private val onSample: (data: ByteArray, length: Int, ptsUs: Long, key: Boolean) -> Unit,
    private val onFailure: (Throwable) -> Unit,
) {
    private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    val surface: Surface
    private val drain: Thread
    @Volatile private var running = true
    private var buffer = ByteArray(256 * 1024)

    init {
        try {
            configure(bitrate, constrainedBaseline = true)
        } catch (error: Exception) {
            // Some encoders refuse a profile they would choose anyway.
            Log.i(TAG, "Encoder refused baseline; using its default profile", error)
            codec.reset()
            configure(bitrate, constrainedBaseline = false)
        }
        surface = codec.createInputSurface()
        codec.start()
        drain = Thread(::drainLoop, "cohub-display-encoder").apply { start() }
    }

    private fun configure(bitrate: Int, constrainedBaseline: Boolean) {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, KEY_FRAME_INTERVAL_SECONDS)
            // A still screen produces no frames; repeating the last one lets a
            // key frame request be answered and a joining viewer see something.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_AFTER_US)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            setInteger(MediaFormat.KEY_LATENCY, 1)
            if (constrainedBaseline) setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    }

    fun setBitrate(bps: Int) = parameters { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) }

    fun requestKeyFrame() = parameters { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }

    private inline fun parameters(build: Bundle.() -> Unit) {
        if (!running) return
        runCatching { codec.setParameters(Bundle().apply(build)) }
            .onFailure { Log.w(TAG, "Encoder rejected parameters", it) }
    }

    private fun drainLoop() {
        val info = MediaCodec.BufferInfo()
        try {
            while (running) {
                val index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
                if (index < 0) continue
                val output = codec.getOutputBuffer(index)
                if (output != null && info.size > 0) {
                    if (buffer.size < info.size) buffer = ByteArray(info.size + info.size / 2)
                    output.position(info.offset)
                    output.get(buffer, 0, info.size)
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    onSample(buffer, info.size, info.presentationTimeUs, key)
                }
                codec.releaseOutputBuffer(index, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
        } catch (error: Exception) {
            if (running) onFailure(error)
        }
    }

    fun release() {
        if (!running) return
        running = false
        drain.join(DRAIN_JOIN_MS)
        runCatching { codec.stop() }
        codec.release()
        surface.release()
    }

    private companion object {
        const val KEY_FRAME_INTERVAL_SECONDS = 10
        const val REPEAT_AFTER_US = 100_000L
        const val DEQUEUE_TIMEOUT_US = 100_000L
        const val DRAIN_JOIN_MS = 500L
    }
}
