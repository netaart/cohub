package live.cohub.android.files

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import live.cohub.android.host.HostProtocol
import java.io.IOException
import java.nio.ByteBuffer
import kotlin.random.Random

class FileFrame private constructor(val channel: Long, val offset: Long, val bytes: ByteArray) {
    val length: Int get() = bytes.size - HEADER

    companion object {
        const val HEADER = HostProtocol.FILE_FRAME_HEADER_BYTES
        private val MAGIC = HostProtocol.FILE_FRAME_MAGIC.toByteArray(Charsets.US_ASCII)

        fun parse(bytes: ByteArray): FileFrame? {
            if (bytes.size < HEADER || MAGIC.indices.any { bytes[it] != MAGIC[it] }) return null
            val header = ByteBuffer.wrap(bytes, 0, HEADER)
            val channel = header.getInt(MAGIC.size).toLong() and 0xFFFF_FFFFL
            val offset = header.getLong(MAGIC.size + Int.SIZE_BYTES)
            return if (channel == 0L || offset < 0) null else FileFrame(channel, offset, bytes)
        }
    }
}

class FileWindow(private val size: Long, private val chunkBytes: Int, private val windowBytes: Int) {
    var accepted = 0L
        private set

    fun accept(frame: FileFrame, written: Long): Boolean {
        val next = accepted + frame.length
        if (frame.offset != accepted || frame.length > chunkBytes || next > size || next - written > windowBytes) return false
        accepted = next
        return true
    }
}

class FileStreams(private val saver: FileSaver) {
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val transfers = HashMap<String, Transfer>()
    private val opening = HashSet<String>()
    private var document = 0

    class Started(val channel: Long, val chunkBytes: Int, val windowBytes: Int)

    suspend fun begin(id: String, name: String, mimeType: String?, size: Long, progress: (Long) -> Unit): Started {
        require(size in 0..HostProtocol.FILE_STREAM_MAX_BYTES) { "files.write.begin requires a size within the limit" }
        require(id !in transfers && id !in opening) { "A transfer with this id is open" }
        opening += id
        val asked = document
        val pending = try {
            withContext(Dispatchers.IO) {
                if (!saver.hasRoom(size)) throw IOException("Not enough free space")
                saver.create(name, mimeType)
            }
        } catch (error: Exception) {
            opening.remove(id)
            throw error
        }
        if (!opening.remove(id) || asked != document) {
            withContext(Dispatchers.IO) { pending.discard() }
            throw IllegalStateException("The transfer was superseded")
        }
        val channel = generateSequence { Random.nextLong(1, 1L shl 32) }.first { taken -> transfers.values.none { it.channel == taken } }
        transfers[id] = Transfer(channel, size, pending, progress)
        return Started(channel, CHUNK_BYTES, WINDOW_BYTES)
    }

    fun receive(bytes: ByteArray) {
        val frame = FileFrame.parse(bytes) ?: return
        transfers.values.firstOrNull { it.channel == frame.channel }?.receive(frame)
    }

    suspend fun commit(id: String): FileSaver.Saved {
        val transfer = transfers.remove(id) ?: throw IllegalStateException("No open transfer with this id")
        return transfer.commit().also { saver.remember(id, it) }
    }

    fun cancel(id: String) {
        opening.remove(id)
        transfers.remove(id)?.abort("Canceled")
    }

    fun cancelAll() {
        document++
        opening.clear()
        transfers.values.forEach { it.abort("Canceled") }
        transfers.clear()
    }

    private inner class Transfer(
        val channel: Long,
        private val size: Long,
        private val pending: FileSaver.Pending,
        private val progress: (Long) -> Unit,
    ) {
        private val window = FileWindow(size, CHUNK_BYTES, WINDOW_BYTES)
        private val frames = Channel<FileFrame>(Channel.UNLIMITED)

        @Volatile
        private var written = 0L

        @Volatile
        private var failure: String? = null

        private val writer = io.launch(start = CoroutineStart.LAZY) {
            try {
                pending.output().use { output ->
                    for (frame in frames) {
                        output.write(frame.bytes, FileFrame.HEADER, frame.length)
                        written += frame.length
                        progress(written)
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "Could not write a streamed file", error)
                abort("Could not write the file")
            }
        }

        init {
            writer.start()
        }

        fun receive(frame: FileFrame) {
            if (failure != null) return
            if (window.accept(frame, written)) frames.trySend(frame) else abort("A frame was out of order or past the file")
        }

        fun abort(reason: String) {
            if (failure != null) return
            failure = reason
            frames.cancel()
            io.launch {
                writer.cancel()
                writer.join()
                pending.discard()
            }
        }

        suspend fun commit(): FileSaver.Saved {
            frames.close()
            writer.join()
            failure?.let { throw IOException(it) }
            if (written != size) {
                abort("The file is incomplete")
                throw IOException("The file is incomplete")
            }
            return withContext(Dispatchers.IO) {
                runCatching { pending.publish() }.getOrElse {
                    pending.discard()
                    throw it
                }
            }
        }
    }

    private companion object {
        const val TAG = "CohubFiles"
        const val CHUNK_BYTES = 512 * 1024
        const val WINDOW_BYTES = 4 * 1024 * 1024
    }
}
