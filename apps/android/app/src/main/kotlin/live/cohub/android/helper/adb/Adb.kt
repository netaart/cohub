package live.cohub.android.helper.adb

import android.os.Build
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.net.ssl.SSLSocket

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal object Adb {
    class Unauthorized : IOException("adbd does not know this key; pair again")

    private const val CNXN = 0x4e584e43
    private const val STLS = 0x534c5453
    private const val AUTH = 0x48545541
    private const val OPEN = 0x4e45504f
    private const val OKAY = 0x59414b4f
    private const val WRTE = 0x45545257
    private const val CLSE = 0x45534c43
    private const val VERSION = 0x01000001
    private const val STLS_VERSION = 0x01000000
    private const val MAX_PAYLOAD = 1 shl 20
    private const val TIMEOUT_MS = 10_000

    private class Message(val command: Int, val arg0: Int, val arg1: Int, val data: ByteArray = ByteArray(0))

    fun exec(key: AdbKey, port: Int, command: String, host: String = "127.0.0.1"): String {
        val plain = Socket().apply {
            tcpNoDelay = true
            connect(InetSocketAddress(host, port), TIMEOUT_MS)
            soTimeout = TIMEOUT_MS
        }
        plain.use {
            send(plain.outputStream, Message(CNXN, VERSION, MAX_PAYLOAD, "host::\u0000".toByteArray()))
            val first = read(DataInputStream(plain.inputStream)) ?: throw IOException("adbd closed the connection")
            if (first.command == AUTH) throw Unauthorized()
            if (first.command != STLS) throw IOException("not a Wireless debugging port")
            send(plain.outputStream, Message(STLS, STLS_VERSION, 0))
            val tls = key.tls.socketFactory.createSocket(plain, host, port, true) as SSLSocket
            tls.useClientMode = true
            tls.startHandshake()
            val input = DataInputStream(tls.inputStream)
            val output = tls.outputStream
            val banner = runCatching { read(input) }.getOrNull() ?: throw Unauthorized()
            if (banner.command != CNXN) throw IOException("expected CNXN from adbd")
            send(output, Message(OPEN, 1, 0, "exec:$command\u0000".toByteArray()))
            val out = ByteArrayOutputStream()
            var remote = 0
            while (true) {
                val message = read(input) ?: break
                when (message.command) {
                    OKAY -> remote = message.arg0
                    WRTE -> {
                        out.write(message.data)
                        send(output, Message(OKAY, 1, message.arg0))
                    }
                    CLSE -> {
                        if (remote == 0) throw IOException("adbd refused the command")
                        break
                    }
                }
            }
            return out.toString(Charsets.UTF_8)
        }
    }

    private fun send(output: OutputStream, message: Message) {
        val buffer = ByteBuffer.allocate(24 + message.data.size).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(message.command).putInt(message.arg0).putInt(message.arg1).putInt(message.data.size)
            .putInt(message.data.sumOf { it.toInt() and 0xff }).putInt(message.command.inv()).put(message.data)
        output.write(buffer.array())
        output.flush()
    }

    private fun read(input: DataInputStream): Message? {
        val header = ByteArray(24)
        runCatching { input.readFully(header) }.getOrElse { return null }
        val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        val command = buffer.getInt()
        val arg0 = buffer.getInt()
        val arg1 = buffer.getInt()
        val size = buffer.getInt()
        buffer.getInt()
        if (buffer.getInt() != command.inv() || size !in 0..MAX_PAYLOAD) throw IOException("bad adb packet")
        return Message(command, arg0, arg1, ByteArray(size).also(input::readFully))
    }
}
