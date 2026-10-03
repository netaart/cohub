package live.cohub.android.auth

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * The only place credentials are persisted, encrypted with a Keystore-backed
 * key so a device dump does not yield refresh tokens. The web view never reads
 * this store; it asks for a token over the bridge, per request.
 */
class CredentialStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        FILE_NAME,
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun read(): StoredCredentials? {
        val refreshToken = prefs.getString(KEY_REFRESH_TOKEN, null) ?: return null
        return StoredCredentials(
            refreshToken = refreshToken,
            idToken = prefs.getString(KEY_ID_TOKEN, null),
            subject = prefs.getString(KEY_SUBJECT, null),
            userUuid = prefs.getString(KEY_USER_UUID, null),
        )
    }

    fun write(credentials: StoredCredentials) {
        prefs.edit {
            putString(KEY_REFRESH_TOKEN, credentials.refreshToken)
            putString(KEY_ID_TOKEN, credentials.idToken)
            putString(KEY_SUBJECT, credentials.subject)
            putString(KEY_USER_UUID, credentials.userUuid)
        }
    }

    fun clear() {
        prefs.edit { clear() }
    }

    private companion object {
        const val FILE_NAME = "cohub-credentials"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_ID_TOKEN = "id_token"
        const val KEY_SUBJECT = "subject"
        const val KEY_USER_UUID = "user_uuid"
    }
}

data class StoredCredentials(
    val refreshToken: String,
    val idToken: String?,
    val subject: String?,
    val userUuid: String?,
)
