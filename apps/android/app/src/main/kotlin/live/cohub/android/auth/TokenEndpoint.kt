package live.cohub.android.auth

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64

private const val TAG = "CohubAuth"

interface TokenEndpoint {
    suspend fun exchange(fields: Map<String, String>): TokenResponse

    suspend fun revoke(fields: Map<String, String>)
}

data class TokenResponse(
    val accessToken: String,
    val refreshToken: String?,
    val idToken: String?,
    val expiresInSeconds: Long,
    val subject: String?,
)

class OAuthFailure(val status: Int, message: String) : Exception(message)

/** [oidc] is the provider's OIDC base, e.g. `https://auth.example/oidc`. */
class HttpTokenEndpoint(private val oidc: String) : TokenEndpoint {

    override suspend fun exchange(fields: Map<String, String>): TokenResponse {
        val (status, payload) = post("$oidc/token", fields)
        val json = runCatching { Json.parseToJsonElement(payload) as? JsonObject }.getOrNull()
            ?: throw OAuthFailure(status, "Malformed token response")
        return TokenResponse(
            accessToken = json["access_token"]?.jsonPrimitive?.content
                ?: throw OAuthFailure(status, "Token response had no access_token"),
            refreshToken = json["refresh_token"]?.jsonPrimitive?.content,
            idToken = json["id_token"]?.jsonPrimitive?.content,
            expiresInSeconds = json["expires_in"]?.jsonPrimitive?.content?.toLongOrNull() ?: 3_600,
            subject = json["id_token"]?.jsonPrimitive?.content?.let(::subjectFromIdToken),
        )
    }

    override suspend fun revoke(fields: Map<String, String>) {
        post("$oidc/token/revocation", fields)
    }

    /** The 2xx status and body; anything else throws [OAuthFailure]. */
    private suspend fun post(url: String, fields: Map<String, String>): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val body = fields.entries.joinToString("&") { (key, value) ->
                "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
            }
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
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
                status to payload
            } catch (error: IOException) {
                throw OAuthFailure(0, error.message ?: "Network failure calling $url")
            } finally {
                connection.disconnect()
            }
        }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 20_000
    }
}

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
