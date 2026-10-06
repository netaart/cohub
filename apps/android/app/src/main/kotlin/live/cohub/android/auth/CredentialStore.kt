package live.cohub.android.auth

import android.content.Context
import android.util.Log
import androidx.datastore.core.CorruptionException
import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.Serializer
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.InvalidKeyException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException

interface CredentialStore {
    suspend fun read(): StoredCredentials?

    suspend fun write(credentials: StoredCredentials?)
}

@Serializable
data class StoredCredentials(
    val refreshToken: String,
    val idToken: String?,
    val subject: String?,
    val userUuid: String?,
    val accessToken: String? = null,
    val accessTokenExpiresAt: Long = 0,
)

class SealedCredentialStore(file: File, private val cipher: CredentialCipher) : CredentialStore {

    constructor(context: Context) : this(
        File(context.noBackupFilesDir, FILE_NAME),
        CredentialCipher(KeystoreKey(KEY_ALIAS)),
    )

    private val data: DataStore<StoredCredentials?> = DataStoreFactory.create(
        serializer = CredentialSerializer(cipher),
        corruptionHandler = ReplaceFileCorruptionHandler { error ->
            Log.w(TAG, "Discarding unreadable credentials", error)
            cipher.reset()
            null
        },
        produceFile = { file },
    )

    override suspend fun read(): StoredCredentials? = data.data.first()

    override suspend fun write(credentials: StoredCredentials?) {
        try {
            data.updateData { credentials }
        } catch (_: UnrecoverableKeyException) {
            cipher.reset()
            data.updateData { credentials }
        }
    }

    private companion object {
        const val TAG = "CohubAuth"
        const val FILE_NAME = "credentials.bin"
        const val KEY_ALIAS = "cohub.credentials.v1"
    }
}

internal class CredentialSerializer(private val cipher: CredentialCipher) : Serializer<StoredCredentials?> {

    override val defaultValue: StoredCredentials? = null

    override suspend fun readFrom(input: InputStream): StoredCredentials? {
        val sealed = input.readBytes()
        if (sealed.isEmpty()) return null
        val plaintext = try {
            cipher.open(sealed)
        } catch (error: AEADBadTagException) {
            throw CorruptionException("Credentials do not open with this key", error)
        } catch (error: InvalidKeyException) {
            throw CorruptionException("Credential key is no longer usable", error)
        }
        return try {
            json.decodeFromString(StoredCredentials.serializer(), plaintext.decodeToString())
        } catch (error: IllegalArgumentException) {
            throw CorruptionException("Credentials are malformed", error)
        }
    }

    override suspend fun writeTo(t: StoredCredentials?, output: OutputStream) {
        if (t == null) return
        output.write(cipher.seal(json.encodeToString(StoredCredentials.serializer(), t).encodeToByteArray()))
    }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
