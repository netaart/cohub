package live.cohub.android.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.IOException

interface CredentialStore {
    fun read(): StoredCredentials?

    fun write(credentials: StoredCredentials)

    fun clear()
}

data class StoredCredentials(
    val refreshToken: String,
    val idToken: String?,
    val subject: String?,
    val userUuid: String?,
    val accessToken: String? = null,
    val accessTokenExpiresAt: Long = 0,
)

/**
 * Encrypted with a Keystore-backed key so a device dump does not yield tokens.
 * The web view asks for a token over the bridge, per request.
 */
class EncryptedCredentialStore(context: Context) : CredentialStore {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        FILE_NAME,
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override fun read(): StoredCredentials? {
        val refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null) ?: return null
        return StoredCredentials(
            refreshToken = refreshToken,
            idToken = prefs.getString(KEY_ID_TOKEN, null),
            subject = prefs.getString(KEY_SUBJECT, null),
            userUuid = prefs.getString(KEY_USER_UUID, null),
            accessToken = prefs.getString(KEY_ACCESS_TOKEN, null),
            accessTokenExpiresAt = prefs.getLong(KEY_ACCESS_TOKEN_EXPIRES_AT, 0),
        )
    }

    override fun write(credentials: StoredCredentials) {
        val saved = prefs.edit()
            .putString(KEY_REFRESH_TOKEN, credentials.refreshToken)
            .putString(KEY_ID_TOKEN, credentials.idToken)
            .putString(KEY_SUBJECT, credentials.subject)
            .putString(KEY_USER_UUID, credentials.userUuid)
            .putString(KEY_ACCESS_TOKEN, credentials.accessToken)
            .putLong(KEY_ACCESS_TOKEN_EXPIRES_AT, credentials.accessTokenExpiresAt)
            .commit()
        if (!saved) throw IOException("Could not persist credentials")
    }

    override fun clear() {
        val cleared = prefs.edit().clear().commit()
        if (!cleared) throw IOException("Could not clear credentials")
    }

    private companion object {
        const val FILE_NAME = "cohub-credentials"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_ID_TOKEN = "id_token"
        const val KEY_SUBJECT = "subject"
        const val KEY_USER_UUID = "user_uuid"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_ACCESS_TOKEN_EXPIRES_AT = "access_token_expires_at"
    }
}
