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

    fun build(
        endpoint: String,
        appId: String,
        redirectUri: String,
        resource: String,
        challenge: Pkce.Challenge,
        state: String,
    ): Uri = (endpoint.trimEnd('/') + "/oidc/auth").toUri().buildUpon()
        .appendQueryParameter("client_id", appId)
        .appendQueryParameter("redirect_uri", redirectUri)
        .appendQueryParameter("response_type", "code")
        .appendQueryParameter("scope", SCOPES)
        .appendQueryParameter("prompt", PROMPT)
        .appendQueryParameter("resource", resource)
        .appendQueryParameter("code_challenge", challenge.challenge)
        .appendQueryParameter("code_challenge_method", challenge.method)
        .appendQueryParameter("state", state)
        .build()
}
