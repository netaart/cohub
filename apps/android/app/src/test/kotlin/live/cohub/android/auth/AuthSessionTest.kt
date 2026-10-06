package live.cohub.android.auth

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AuthSessionTest {

    private class MemoryStore(var stored: StoredCredentials?) : CredentialStore {
        override suspend fun read() = stored
        override suspend fun write(credentials: StoredCredentials?) {
            stored = credentials
        }
    }

    /** Rotates on every refresh and rejects a spent token, as Logto does. */
    private class RotatingEndpoint : TokenEndpoint {
        var issued = 0
        val revoked = mutableListOf<String>()

        override suspend fun exchange(fields: Map<String, String>): TokenResponse {
            if (fields["refresh_token"] != "rt-$issued") throw OAuthFailure(400, "invalid_grant")
            issued += 1
            return TokenResponse("at-$issued", "rt-$issued", idToken = null, expiresInSeconds = 3_600, subject = "sub")
        }

        override suspend fun revoke(fields: Map<String, String>) {
            revoked += fields.getValue("token")
        }
    }

    private val config = AuthConfig(endpoint = "https://auth.test/", appId = "app", redirectUri = "r", apiResource = "api")
    private val store = MemoryStore(StoredCredentials("rt-0", idToken = null, subject = "sub", userUuid = null))
    private val endpoint = RotatingEndpoint()

    @Test
    fun `every rotated refresh token is persisted`() = runBlocking {
        val auth = AuthSession(store, config, endpoint)
        assertEquals("at-1", auth.accessToken(forceRefresh = true))
        assertEquals("at-2", auth.accessToken(forceRefresh = true))
        assertEquals("at-3", AuthSession(store, config, endpoint).accessToken(forceRefresh = true))
    }

    @Test
    fun `sign-out ends the session and revokes its grant`() = runBlocking {
        val auth = AuthSession(store, config, endpoint)
        auth.signOut()
        assertNull(store.stored)
        assertFalse(auth.status().authenticated)
        assertEquals(listOf("rt-0"), endpoint.revoked)
    }
}
