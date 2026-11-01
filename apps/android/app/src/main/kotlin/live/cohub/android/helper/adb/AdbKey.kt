package live.cohub.android.helper.adb

import android.annotation.SuppressLint
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Principal
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509ExtendedTrustManager

internal class AdbKey private constructor(private val keyPair: KeyPair) {
    val pkcs8: ByteArray get() = keyPair.private.encoded

    val publicKey: String by lazy { Base64.getEncoder().encodeToString(encode(keyPair.public as RSAPublicKey)) + " cohub@android" }

    val tls: SSLContext by lazy {
        SSLContext.getInstance("TLSv1.3").apply { init(arrayOf(KeyManager(keyPair.private, certificate())), arrayOf(TrustAll), null) }
    }

    private fun certificate(): X509Certificate {
        val algorithm = der(0x30, der(0x06, SHA256_WITH_RSA), der(0x05))
        val name = der(0x30, der(0x31, der(0x30, der(0x06, COMMON_NAME), der(0x0c, "Cohub".toByteArray()))))
        val validity = der(0x30, der(0x17, "700101000000Z".toByteArray()), der(0x18, "20991231235959Z".toByteArray()))
        val body = der(0x30, der(0xa0, der(0x02, byteArrayOf(2))), der(0x02, byteArrayOf(1)), algorithm, name, validity, name, keyPair.public.encoded)
        val signature = Signature.getInstance("SHA256withRSA").run {
            initSign(keyPair.private)
            update(body)
            sign()
        }
        val cert = der(0x30, body, algorithm, der(0x03, byteArrayOf(0) + signature))
        return CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(cert)) as X509Certificate
    }

    companion object {
        private val SHA256_WITH_RSA = byteArrayOf(0x2a, 0x86.toByte(), 0x48, 0x86.toByte(), 0xf7.toByte(), 0x0d, 0x01, 0x01, 0x0b)
        private val COMMON_NAME = byteArrayOf(0x55, 0x04, 0x03)
        private const val WORDS = 64

        fun generate() = AdbKey(KeyPairGenerator.getInstance("RSA").apply { initialize(RSAKeyGenParameterSpec(2048, RSAKeyGenParameterSpec.F4)) }.generateKeyPair())

        fun of(pkcs8: ByteArray): AdbKey {
            val factory = KeyFactory.getInstance("RSA")
            val private = factory.generatePrivate(PKCS8EncodedKeySpec(pkcs8)) as RSAPrivateCrtKey
            return AdbKey(KeyPair(factory.generatePublic(RSAPublicKeySpec(private.modulus, private.publicExponent)), private))
        }

        private fun encode(key: RSAPublicKey): ByteArray {
            val n = key.modulus
            val r32 = BigInteger.ONE.shiftLeft(32)
            return ByteBuffer.allocate(8 + WORDS * 8 + 4).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(WORDS)
                .putInt((r32 - n.mod(r32).modInverse(r32)).toInt())
                .put(littleEndian(n, WORDS * 4))
                .put(littleEndian(BigInteger.ONE.shiftLeft(4096).mod(n), WORDS * 4))
                .putInt(key.publicExponent.toInt())
                .array()
        }

        fun littleEndian(value: BigInteger, size: Int): ByteArray {
            val big = value.toByteArray()
            return ByteArray(size) { i -> if (i < big.size) big[big.size - 1 - i] else 0 }
        }

        fun der(tag: Int, vararg parts: ByteArray): ByteArray {
            val content = parts.fold(ByteArray(0)) { all, part -> all + part }
            val out = ByteArrayOutputStream()
            out.write(tag)
            val size = content.size
            when {
                size < 0x80 -> out.write(size)
                size < 0x100 -> { out.write(0x81); out.write(size) }
                else -> { out.write(0x82); out.write(size ushr 8); out.write(size and 0xff) }
            }
            out.write(content)
            return out.toByteArray()
        }
    }

    private class KeyManager(private val key: PrivateKey, private val cert: X509Certificate) : X509ExtendedKeyManager() {
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
        override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
        override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS
        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
        override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
        override fun getCertificateChain(alias: String?) = arrayOf(cert)
        override fun getPrivateKey(alias: String?) = key

        private companion object {
            const val ALIAS = "adb"
        }
    }

    @SuppressLint("CustomX509TrustManager")
    private object TrustAll : X509ExtendedTrustManager() {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = Unit
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
