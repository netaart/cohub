package live.cohub.android.auth

import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class PendingSignIn(
    val state: String,
    val verifier: String,
    val redirectUri: String,
    val redirectPath: String?,
    val startedAt: Long,
)

/** Persisted: the system may kill the app while the browser is in front. */
class PendingSignIns(private val prefs: SharedPreferences) {

    fun begin(verifier: String, redirectUri: String, redirectPath: String?): PendingSignIn =
        PendingSignIn(Pkce.createState(), verifier, redirectUri, redirectPath, System.currentTimeMillis()).also {
            prefs.edit { putString(KEY, json.encodeToString(PendingSignIn.serializer(), it)) }
        }

    fun take(state: String?): PendingSignIn? {
        val pending = runCatching { prefs.getString(KEY, null)?.let { json.decodeFromString(PendingSignIn.serializer(), it) } }.getOrNull()
        if (pending == null || state != pending.state) return null
        clear()
        return pending.takeIf { System.currentTimeMillis() - it.startedAt < TTL_MS }
    }

    fun clear() = prefs.edit { remove(KEY) }

    private companion object {
        const val KEY = "pending_sign_in"
        const val TTL_MS = 30 * 60 * 1_000L
        val json = Json { ignoreUnknownKeys = true }
    }
}
