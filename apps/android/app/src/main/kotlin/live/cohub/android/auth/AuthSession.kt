package live.cohub.android.auth

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "CohubAuth"

/**
 * The host's single source of credential truth.
 *
 * Refreshes are single-flight: concurrent callers share one exchange rather
 * than each spending a rotating refresh token, which would invalidate the rest.
 */
class AuthSession(
    private val store: CredentialStore,
    private val config: AuthConfig,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val refreshMutex = Mutex()
    private val generation = AtomicLong(0)

    @Volatile
    private var accessToken: String? = null

    @Volatile
    private var accessTokenExpiresAt: Long = 0

    @Volatile
    private var identity: Identity = Identity.None

    suspend fun restore() {
        val stored = store.read()
        if (stored == null) {
            identity = Identity.None
            return
        }
        identity = Identity(authenticated = true, subject = stored.subject, userUuid = stored.userUuid)
        generation.incrementAndGet()
    }

    /** A token good for at least [SKEW_MS] of work; null when there is no session. */
    suspend fun accessToken(forceRefresh: Boolean = false): String? = refreshMutex.withLock {
        val now = clock()
        if (!forceRefresh) {
            val cached = accessToken
            if (cached != null && accessTokenExpiresAt - SKEW_MS > now) return@withLock cached
        }
        val stored = store.read() ?: return@withLock null
        val token = runCatching { exchangeRefreshToken(stored.refreshToken) }
            .getOrElse { error ->
                // A rejected refresh token means the session is over.
                if (error is OAuthFailure) clear()
                return@withLock null
            }
        publish(token)
        token.accessToken
    }

    suspend fun completeSignIn(code: String, verifier: String): String {
        val token = exchangeAuthorizationCode(code, verifier)
        store.write(
            StoredCredentials(
                refreshToken = token.refreshToken
                    ?: error("Authorization response carried no refresh token; is offline_access granted?"),
                idToken = token.idToken,
                subject = token.subject,
                userUuid = null,
            ),
        )
        publish(token)
        identity = Identity(authenticated = true, subject = token.subject, userUuid = null)
        generation.incrementAndGet()
        return token.accessToken
    }

    fun status(): Identity = identity

    fun sessionVersion(): Long = generation.get()

    fun clear() {
        store.clear()
        accessToken = null
        accessTokenExpiresAt = 0
        identity = Identity.None
        generation.incrementAndGet()
    }

    private fun publish(token: TokenResponse) {
        accessToken = token.accessToken
        accessTokenExpiresAt = clock() + token.expiresInSeconds * 1_000
    }

    private suspend fun exchangeAuthorizationCode(code: String, verifier: String): TokenResponse =
        postToken(
            mapOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "code_verifier" to verifier,
                "redirect_uri" to config.redirectUri,
                "client_id" to config.appId,
                "resource" to config.apiResource,
            ),
        )

    private suspend fun exchangeRefreshToken(refreshToken: String): TokenResponse =
        postToken(
            mapOf(
                "grant_type" to "refresh_token",
                "refresh_token" to refreshToken,
                "client_id" to config.appId,
                "resource" to config.apiResource,
            ),
        )

    private suspend fun postToken(fields: Map<String, String>): TokenResponse = withContext(Dispatchers.IO) {
        val body = fields.entries.joinToString("&") { (key, value) ->
            "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
        }
        val connection = (URL(config.tokenEndpoint()).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            setRequestProperty("Accept", "application/json")
        }
        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val payload = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }
                .orEmpty()
            if (status !in 200..299) throw OAuthFailure(status, payload)
            val json = Json.parseToJsonElement(payload) as? JsonObject
                ?: throw OAuthFailure(status, "Malformed token response")
            TokenResponse(
                accessToken = json["access_token"]?.jsonPrimitive?.content
                    ?: throw OAuthFailure(status, "Token response had no access_token"),
                refreshToken = json["refresh_token"]?.jsonPrimitive?.content,
                idToken = json["id_token"]?.jsonPrimitive?.content,
                expiresInSeconds = json["expires_in"]?.jsonPrimitive?.content?.toLongOrNull() ?: 3_600,
                subject = json["id_token"]?.jsonPrimitive?.content?.let(::subjectFromIdToken),
            )
        } catch (error: IOException) {
            throw OAuthFailure(0, error.message ?: "Network failure during token exchange")
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        /** Refresh before expiry so a request in flight never races the clock. */
        const val SKEW_MS = 30_000L
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 20_000
    }
}

private fun AuthConfig.tokenEndpoint(): String = endpoint.trimEnd('/') + "/oidc/token"

/**
 * Read `sub` for local cache partitioning only; it is not verified here and
 * never feeds an authorization decision.
 */
private fun subjectFromIdToken(idToken: String): String? = runCatching {
    val payload = idToken.split('.').getOrNull(1) ?: return null
    val decoded = Base64.getUrlDecoder().decode(payload).toString(Charsets.UTF_8)
    (Json.parseToJsonElement(decoded) as? JsonObject)?.get("sub")?.jsonPrimitive?.content
}.onFailure { error ->
    Log.w(TAG, "Could not read sub from the ID token", error)
}.getOrNull()

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

private data class TokenResponse(
    val accessToken: String,
    val refreshToken: String?,
    val idToken: String?,
    val expiresInSeconds: Long,
    val subject: String?,
)

class OAuthFailure(val status: Int, message: String) : Exception(message)
