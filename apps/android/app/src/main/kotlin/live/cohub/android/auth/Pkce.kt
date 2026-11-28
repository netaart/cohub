package live.cohub.android.auth

import android.net.Uri
import androidx.core.net.toUri
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Authorization Code + PKCE for a public native client. The verifier never
 * leaves the device, so an intercepted redirect code is useless without it.
 */
object Pkce {
    data class Challenge(
        val verifier: String,
        val challenge: String,
        val method: String = "S256",
    )

    private const val VERIFIER_BYTES = 32
    private const val STATE_BYTES = 16

    fun create(): Challenge {
        val verifier = randomUrlSafe(VERIFIER_BYTES)
        return Challenge(verifier = verifier, challenge = sha256(verifier))
    }

    fun createState(): String = randomUrlSafe(STATE_BYTES)

    private fun randomUrlSafe(byteCount: Int): String {
        val bytes = ByteArray(byteCount)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun sha256(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.US_ASCII))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }
}

/** Scopes mirror the web client so both surfaces receive the same token shape. */
object AuthorizationRequest {
    private const val SCOPES = "openid offline_access profile email"

    // Logto issues a refresh token only with consent.
    private const val PROMPT = "consent"

    // After a sign-out: the browser still holds a Logto session that would
    // otherwise return the same account without asking.
    private const val PROMPT_LOGIN = "login consent"

    fun parameters(
        appId: String,
        redirectUri: String,
        resource: String,
        challenge: Pkce.Challenge,
        state: String,
        forceLogin: Boolean = false,
        provider: String? = null,
        googleCredential: String? = null,
    ): List<Pair<String, String>> = listOfNotNull(
        "client_id" to appId,
        "redirect_uri" to redirectUri,
        "response_type" to "code",
        "scope" to SCOPES,
        "prompt" to if (forceLogin) PROMPT_LOGIN else PROMPT,
        "resource" to resource,
        "code_challenge" to challenge.challenge,
        "code_challenge_method" to challenge.method,
        "state" to state,
        provider?.let { "direct_sign_in" to "social:$it" },
        googleCredential?.let { "google_one_tap_credential" to it },
    )

    fun build(endpoint: String, parameters: List<Pair<String, String>>): Uri =
        (endpoint.trimEnd('/') + "/oidc/auth").toUri().buildUpon()
            .apply { for ((name, value) in parameters) appendQueryParameter(name, value) }
            .build()
}
