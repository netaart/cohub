package live.cohub.android.auth

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Single-flight refresh. Logto rotates the refresh token on every use, so each
 * rotation must be persisted: replaying a spent one ends the session.
 */
class AuthSession(
    private val store: CredentialStore,
    private val config: AuthConfig,
    private val endpoint: TokenEndpoint = HttpTokenEndpoint(config.tokenEndpoint()),
    private val clock: () -> Long = System::currentTimeMillis,
    private val onAccountChanged: (signedIn: Boolean) -> Unit = {},
) {
    private val exchange = Mutex()

    private val lock = Any()
    private var generation = 0L
    private var loaded = false
    private var credentials: StoredCredentials? = null

    /** A token good for at least [SKEW_MS] of work; null when there is no session. */
    suspend fun accessToken(forceRefresh: Boolean = false): String? = exchange.withLock {
        val (stored, version) = synchronized(lock) { current() to generation }
        if (stored == null) return@withLock null
        if (!forceRefresh && stored.accessToken != null && stored.accessTokenExpiresAt - SKEW_MS > clock()) {
            return@withLock stored.accessToken
        }
        val token = try {
            endpoint.exchange(refreshFields(stored.refreshToken))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (error is OAuthFailure && (error.status == 400 || error.status == 401)) clear(version)
            return@withLock null
        }
        val next = stored.copy(
            refreshToken = token.refreshToken ?: stored.refreshToken,
            idToken = token.idToken ?: stored.idToken,
            subject = token.subject ?: stored.subject,
            accessToken = token.accessToken,
            accessTokenExpiresAt = clock() + token.expiresInSeconds * 1_000,
        )
        if (!commit(next, expectedGeneration = version)) return@withLock null
        token.accessToken
    }

    suspend fun completeSignIn(code: String, verifier: String): String = exchange.withLock {
        val token = endpoint.exchange(codeFields(code, verifier))
        val refreshToken = token.refreshToken
            ?: error("Authorization response carried no refresh token; is offline_access granted?")
        commit(
            StoredCredentials(
                refreshToken = refreshToken,
                idToken = token.idToken,
                subject = token.subject,
                userUuid = null,
                accessToken = token.accessToken,
                accessTokenExpiresAt = clock() + token.expiresInSeconds * 1_000,
            ),
            expectedGeneration = null,
        )
        onAccountChanged(true)
        token.accessToken
    }

    fun status(): Identity =
        current()?.let { Identity(authenticated = true, subject = it.subject, userUuid = it.userUuid) }
            ?: Identity.None

    fun hasCredentials(): Boolean = current() != null

    fun accountKey(): String? = current()?.let { it.subject ?: it.userUuid ?: "" }

    fun sessionVersion(): Long = synchronized(lock) { generation }

    fun clear() = clear(expectedGeneration = null)

    private fun clear(expectedGeneration: Long?) {
        synchronized(lock) {
            if (expectedGeneration != null && expectedGeneration != generation) return
            credentials = null
            loaded = true
            generation += 1
            runCatching { store.clear() }.onFailure { Log.e(TAG, "Could not clear credentials", it) }
        }
        onAccountChanged(false)
    }

    private fun current(): StoredCredentials? = synchronized(lock) {
        if (!loaded) {
            credentials = store.read()
            loaded = true
        }
        credentials
    }

    private suspend fun commit(next: StoredCredentials, expectedGeneration: Long?): Boolean =
        withContext(Dispatchers.IO) {
            synchronized(lock) {
                if (expectedGeneration != null && expectedGeneration != generation) return@withContext false
                // Memory first: the token has already rotated server-side.
                credentials = next
                loaded = true
                if (expectedGeneration == null) generation += 1
                runCatching { store.write(next) }.onFailure { Log.e(TAG, "Could not persist credentials", it) }
                true
            }
        }

    private fun refreshFields(refreshToken: String) = mapOf(
        "grant_type" to "refresh_token",
        "refresh_token" to refreshToken,
        "client_id" to config.appId,
        "resource" to config.apiResource,
    )

    private fun codeFields(code: String, verifier: String) = mapOf(
        "grant_type" to "authorization_code",
        "code" to code,
        "code_verifier" to verifier,
        "redirect_uri" to config.redirectUri,
        "client_id" to config.appId,
        "resource" to config.apiResource,
    )

    private companion object {
        const val TAG = "CohubAuth"

        /** Refresh before expiry so a request in flight never races the clock. */
        const val SKEW_MS = 30_000L
    }
}

private fun AuthConfig.tokenEndpoint(): String = endpoint.trimEnd('/') + "/oidc/token"

data class AuthConfig(
    val endpoint: String,
    val appId: String,
    val redirectUri: String,
    val apiResource: String,
)

data class Identity(
    val authenticated: Boolean,
    val subject: String?,
    val userUuid: String?,
) {
    companion object {
        val None = Identity(authenticated = false, subject = null, userUuid = null)
    }
}
