package live.cohub.android.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64

/** PKCE is the only thing between an intercepted redirect and a usable session. */
class PkceTest {

    @Test
    fun `challenge is the sha256 of the verifier`() {
        val challenge = Pkce.create()
        val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256")
                .digest(challenge.verifier.toByteArray(Charsets.US_ASCII)),
        )
        assertEquals(expected, challenge.challenge)
        assertEquals("S256", challenge.method)
    }

    @Test
    fun `verifier is url-safe and within the rfc 7636 length range`() {
        val challenge = Pkce.create()
        val urlSafe = Regex("^[A-Za-z0-9_-]+$")
        assertTrue(urlSafe.matches(challenge.verifier))
        assertTrue(urlSafe.matches(challenge.challenge))
        assertTrue(challenge.verifier.length in 43..128)
    }

    @Test
    fun `each request gets a fresh verifier and state`() {
        assertNotEquals(Pkce.create().verifier, Pkce.create().verifier)
        assertNotEquals(Pkce.createState(), Pkce.createState())
    }
}
