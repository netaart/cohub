package live.cohub.android.auth

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Single-flight refresh. Logto rotates the refresh token on every use, so each
 * rotation must be persisted: replaying a spent one ends the session.
 */
class AuthSession(
    private val store: CredentialStore,
    private val config: AuthConfig,
    private val endpoint: TokenEndpoint = HttpTokenEndpoint(config.endpoint.trimEnd('/') + "/oidc"),
    private val clock: () -> Long = System::currentTimeMillis,
    private val onAccountChanged: (previous: Account, current: Account) -> Unit = { _, _ -> },
) {
    private val exchange = Mutex()

    private val writes = Mutex()

    @Volatile
    private var session: Session? = null

    private data class Session(val credentials: StoredCredentials?, val generation: Long)

    val account: Account
        get() = session.toAccount()

    suspend fun load() {
        loaded()
    }

    /** A token good for at least [SKEW_MS] of work; null when there is no session. */
    suspend fun accessToken(forceRefresh: Boolean = false): String? = exchange.withLock {
        val current = loaded()
        val stored = current.credentials ?: return@withLock null
        if (!forceRefresh && stored.accessToken != null && stored.accessTokenExpiresAt - SKEW_MS > clock()) {
            return@withLock stored.accessToken
        }
        val token = try {
            endpoint.exchange(refreshFields(stored.refreshToken))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (error is OAuthFailure && (error.status == 400 || error.status == 401)) {
                change(null, expectedGeneration = current.generation)
            }
            return@withLock null
        }
        val next = stored.copy(
            refreshToken = token.refreshToken ?: stored.refreshToken,
            idToken = token.idToken ?: stored.idToken,
            subject = token.subject ?: stored.subject,
            accessToken = token.accessToken,
            accessTokenExpiresAt = clock() + token.expiresInSeconds * 1_000,
        )
        change(next, expectedGeneration = current.generation) ?: return@withLock null
        token.accessToken
    }

    suspend fun completeSignIn(code: String, verifier: String): String = exchange.withLock {
        val token = endpoint.exchange(codeFields(code, verifier))
        val refreshToken = token.refreshToken
            ?: error("Authorization response carried no refresh token; is offline_access granted?")
        change(
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
        token.accessToken
    }

    suspend fun status(): Identity =
        loaded().credentials?.let { Identity(authenticated = true, subject = it.subject, userUuid = it.userUuid) }
            ?: Identity.None

    suspend fun sessionVersion(): Long = loaded().generation

    /**
     * Ends the session, then revokes its grant as the web SDK does, so a copy of
     * the refresh token cannot outlive sign-out. Revocation is best effort.
     */
    suspend fun signOut() {
        loaded()
        val refreshToken = change(null, expectedGeneration = null)?.credentials?.refreshToken ?: return
        try {
            withTimeoutOrNull(REVOKE_TIMEOUT_MS) { endpoint.revoke(revokeFields(refreshToken)) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Could not revoke the refresh token", error)
        }
    }

    suspend fun clear() {
        change(null, expectedGeneration = null)
    }

    private suspend fun loaded(): Session = session ?: writes.withLock {
        session ?: Session(read(), generation = 0).also(::publish)
    }

    private suspend fun read(): StoredCredentials? = try {
        store.read()
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        Log.e(TAG, "Could not read credentials", error)
        null
    }

    private suspend fun change(next: StoredCredentials?, expectedGeneration: Long?): Session? =
        withContext(NonCancellable) {
            writes.withLock {
                val current = session ?: Session(null, generation = 0)
                if (expectedGeneration != null && expectedGeneration != current.generation) return@withLock null
                val bump = next == null || expectedGeneration == null
                try {
                    store.write(next)
                } catch (error: Exception) {
                    Log.e(TAG, "Could not persist credentials", error)
                }
                publish(Session(next, if (bump) current.generation + 1 else current.generation))
                current
            }
        }

    private fun publish(next: Session) {
        val previous = session.toAccount()
        session = next
        val current = next.toAccount()
        if (current != previous) onAccountChanged(previous, current)
    }

    private fun Session?.toAccount(): Account = when {
        this == null -> Account.Loading
        credentials == null -> Account.SignedOut
        else -> Account.SignedIn(credentials.subject ?: credentials.userUuid ?: "")
    }

    private fun refreshFields(refreshToken: String) = mapOf(
        "grant_type" to "refresh_token",
        "refresh_token" to refreshToken,
        "client_id" to config.appId,
        "resource" to config.apiResource,
    )

    private fun revokeFields(refreshToken: String) = mapOf(
        "token" to refreshToken,
        "token_type_hint" to "refresh_token",
        "client_id" to config.appId,
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
        const val REVOKE_TIMEOUT_MS = 5_000L
    }
}

sealed interface Account {
    data object Loading : Account

    data object SignedOut : Account

    data class SignedIn(val key: String) : Account
}

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
