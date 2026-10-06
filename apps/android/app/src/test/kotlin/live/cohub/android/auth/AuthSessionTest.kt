package live.cohub.android.auth

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class AuthSessionTest {

    @Test
    fun `every rotated refresh token is persisted`() = runBlocking {
        var stored: StoredCredentials? = StoredCredentials("rt-0", idToken = null, subject = "sub", userUuid = null)
        val store = object : CredentialStore {
            override fun read() = stored
            override fun write(credentials: StoredCredentials) {
                stored = credentials
            }
            override fun clear() {
                stored = null
            }
        }
        var issued = 0
        val endpoint = TokenEndpoint { fields ->
            if (fields["refresh_token"] != "rt-$issued") throw OAuthFailure(400, "invalid_grant")
            issued += 1
            TokenResponse("at-$issued", "rt-$issued", idToken = null, expiresInSeconds = 3_600, subject = "sub")
        }
        val config = AuthConfig(endpoint = "https://auth.test/", appId = "app", redirectUri = "r", apiResource = "api")

        val auth = AuthSession(store, config, endpoint)
        assertEquals("at-1", auth.accessToken(forceRefresh = true))
        assertEquals("at-2", auth.accessToken(forceRefresh = true))
        assertEquals("at-3", AuthSession(store, config, endpoint).accessToken(forceRefresh = true))
    }
}
