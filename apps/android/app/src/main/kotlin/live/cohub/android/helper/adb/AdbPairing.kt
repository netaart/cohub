package live.cohub.android.helper.adb

import android.net.ssl.SSLSockets
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.DataInputStream
import java.io.IOException
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLSocket

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal object AdbPairing {
    class WrongCode : IOException("the pairing code is wrong or expired")

    private const val EXPORT_LABEL = "adb-label\u0000"
    private const val PEER_INFO_SIZE = 8192
    private const val VERSION: Byte = 1
    private const val SPAKE2: Byte = 0
    private const val PEER_INFO: Byte = 1

    fun pair(key: AdbKey, port: Int, code: String, host: String = "127.0.0.1") {
        val plain = Socket().apply {
            tcpNoDelay = true
            connect(InetSocketAddress(host, port), TIMEOUT_MS)
            soTimeout = TIMEOUT_MS
        }
        val socket = key.tls.socketFactory.createSocket(plain, host, port, true) as SSLSocket
        socket.use {
            it.useClientMode = true
            it.startHandshake()
            val exported = SSLSockets.exportKeyingMaterial(it, EXPORT_LABEL, ByteArray(0), 64) ?: throw IOException("TLS export failed")
            val spake = Spake2(code.toByteArray() + exported)
            val input = DataInputStream(it.inputStream)
            write(it, SPAKE2, spake.message)
            val cipher = PairingCipher(spake.finish(read(input, SPAKE2) ?: throw WrongCode()))
            val info = ByteArray(PEER_INFO_SIZE)
            key.publicKey.toByteArray().copyInto(info, 1)
            write(it, PEER_INFO, cipher.seal(info))
            val sealed = runCatching { read(input, PEER_INFO) }.getOrNull() ?: throw WrongCode()
            runCatching { cipher.open(sealed) }.getOrElse { throw WrongCode() }
        }
    }

    private fun write(socket: SSLSocket, type: Byte, payload: ByteArray) {
        socket.outputStream.apply {
            write(ByteBuffer.allocate(6 + payload.size).put(VERSION).put(type).putInt(payload.size).put(payload).array())
            flush()
        }
    }

    private fun read(input: DataInputStream, type: Byte): ByteArray? {
        val header = ByteArray(6)
        runCatching { input.readFully(header) }.getOrElse { return null }
        val buffer = ByteBuffer.wrap(header)
        if (buffer.get() != VERSION || buffer.get() != type) throw IOException("unexpected pairing packet")
        val size = buffer.getInt()
        if (size !in 1..PEER_INFO_SIZE * 2) throw IOException("bad pairing packet size $size")
        return ByteArray(size).also(input::readFully)
    }

    private const val TIMEOUT_MS = 15_000
}

internal class PairingCipher(secret: ByteArray) {
    private val key = SecretKeySpec(hkdf(secret, "adb pairing_auth aes-128-gcm key".toByteArray(), 16), "AES")
    private var sent = 0L
    private var received = 0L

    fun seal(data: ByteArray) = run(Cipher.ENCRYPT_MODE, sent++, data)

    fun open(data: ByteArray) = run(Cipher.DECRYPT_MODE, received++, data)

    private fun run(mode: Int, sequence: Long, data: ByteArray): ByteArray {
        val nonce = ByteArray(12) { i -> if (i < 8) (sequence ushr (8 * i)).toByte() else 0 }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(mode, key, GCMParameterSpec(128, nonce))
            doFinal(data)
        }
    }

    private fun hkdf(secret: ByteArray, info: ByteArray, size: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        mac.init(SecretKeySpec(mac.doFinal(secret), "HmacSHA256"))
        mac.update(info)
        mac.update(1)
        return mac.doFinal().copyOf(size)
    }
}

internal class Spake2(password: ByteArray, seed: ByteArray = ByteArray(64).also(SecureRandom()::nextBytes)) {
    private val hash = MessageDigest.getInstance("SHA-512").digest(password)
    private val secret = littleEndian(seed).mod(Ed.L).shiftLeft(3)
    private val scalar = littleEndian(hash).mod(Ed.L).let { s ->
        var value = s
        if (value.testBit(0)) value += Ed.L
        if (value.testBit(1)) value += Ed.L.shiftLeft(1)
        if (value.testBit(2)) value += Ed.L.shiftLeft(2)
        value
    }
    val message: ByteArray = (Ed.BASE * secret + Ed.M * scalar).encode()

    fun finish(theirs: ByteArray): ByteArray {
        require(theirs.size == 32) { "bad key exchange message" }
        val point = Ed.decode(theirs) ?: throw IOException("bad key exchange point")
        val shared = ((point + -(Ed.N * scalar)) * secret).encode()
        val digest = MessageDigest.getInstance("SHA-512")
        for (part in listOf(CLIENT, SERVER, message, theirs, shared, hash)) {
            digest.update(ByteBuffer.allocate(8).order(java.nio.ByteOrder.LITTLE_ENDIAN).putLong(part.size.toLong()).array())
            digest.update(part)
        }
        return digest.digest()
    }

    private companion object {
        val CLIENT = "adb pair client\u0000".toByteArray()
        val SERVER = "adb pair server\u0000".toByteArray()

        fun littleEndian(bytes: ByteArray) = BigInteger(1, bytes.reversedArray())
    }
}

private class Ed(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger) {
    operator fun plus(o: Ed): Ed {
        val a = (y - x) * (o.y - o.x) % P
        val b = (y + x) * (o.y + o.x) % P
        val c = t * D2 % P * o.t % P
        val d = z * TWO * o.z % P
        val e = b - a
        val f = d - c
        val g = d + c
        val h = b + a
        return Ed(e * f % P, g * h % P, f * g % P, e * h % P)
    }

    operator fun unaryMinus() = Ed((P - x).mod(P), y, z, (P - t).mod(P))

    operator fun times(k: BigInteger): Ed {
        var sum = IDENTITY
        for (bit in k.bitLength() - 1 downTo 0) {
            sum += sum
            if (k.testBit(bit)) sum += this
        }
        return sum
    }

    fun encode(): ByteArray {
        val inverse = z.mod(P).modInverse(P)
        val out = AdbKey.littleEndian((y * inverse).mod(P), 32)
        if ((x * inverse).mod(P).testBit(0)) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    companion object {
        private val TWO = BigInteger.valueOf(2)
        val P: BigInteger = TWO.pow(255) - BigInteger.valueOf(19)
        val L: BigInteger = TWO.pow(252) + BigInteger("27742317777372353535851937790883648493")
        private val D = (BigInteger.valueOf(-121665) * BigInteger.valueOf(121666).modInverse(P)).mod(P)
        private val D2 = D * TWO % P
        private val SQRT_M1 = TWO.modPow((P - BigInteger.ONE).shiftRight(2), P)
        val IDENTITY = Ed(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
        val BASE = decode(hex("5866666666666666666666666666666666666666666666666666666666666666"))!!
        val M = decode(hex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e"))!!
        val N = decode(hex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778"))!!

        fun decode(bytes: ByteArray): Ed? {
            val raw = bytes.copyOf()
            val sign = (raw[31].toInt() ushr 7) and 1
            raw[31] = (raw[31].toInt() and 0x7f).toByte()
            val y = BigInteger(1, raw.reversedArray())
            if (y >= P) return null
            val yy = y * y % P
            val u = (yy - BigInteger.ONE).mod(P)
            val v = (D * yy + BigInteger.ONE) % P
            val v3 = v * v % P * v % P
            var x = u * v3 % P * (u * (v3 * v3 % P * v % P) % P).modPow((P - BigInteger.valueOf(5)).shiftRight(3), P) % P
            val check = v * x % P * x % P
            x = when (check) {
                u -> x
                (P - u).mod(P) -> x * SQRT_M1 % P
                else -> return null
            }
            if (x.testBit(0) != (sign == 1)) x = P - x
            return Ed(x, y, BigInteger.ONE, x * y % P)
        }

        private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
