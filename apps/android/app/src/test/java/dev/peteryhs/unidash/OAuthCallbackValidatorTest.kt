package dev.peteryhs.unidash

import dev.peteryhs.unidash.ui.OAuthCallback
import dev.peteryhs.unidash.ui.OAuthCallbackValidator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OAuthCallbackValidatorTest {
    private val state = "state-123"
    private val issuer = "https://login.example.com"

    @Test
    fun `valid code callback is accepted`() {
        val result = OAuthCallbackValidator.validate(
            "dev.peteryhs.unidash:/oauth/callback?code=one%2Btwo&state=$state&iss=https%3A%2F%2Flogin.example.com",
            state,
            issuer,
        ).getOrThrow()

        assertEquals(OAuthCallback.Code("one+two", state, issuer), result)
    }

    @Test
    fun `provider error callback is accepted for user facing cancellation`() {
        val result = OAuthCallbackValidator.validate(
            "dev.peteryhs.unidash:/oauth/callback?error=access_denied&error_description=Nope&state=$state",
            state,
            issuer,
        ).getOrThrow()

        assertEquals(OAuthCallback.ProviderError("access_denied", state, "Nope", null), result)
    }

    @Test
    fun `duplicate parameter is rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one&code=two&state=$state")
    }

    @Test
    fun `code and error together are rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one&error=access_denied&state=$state")
    }

    @Test
    fun `missing state is rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one")
    }

    @Test
    fun `wrong scheme and unknown host are rejected`() {
        assertInvalid("https://login.example.com/oauth/callback?code=one&state=$state")
        assertInvalid("dev.peteryhs.unidash://other-host/oauth/callback?code=one&state=$state")
    }

    @Test
    fun `issuer mismatch is rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one&state=$state&iss=https%3A%2F%2Fevil.example")
    }

    @Test
    fun `fragment and user info are rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one&state=$state#fragment")
        assertInvalid("dev.peteryhs.unidash://user@evil-host/oauth/callback?code=one&state=$state")
    }

    @Test
    fun `malformed authority is rejected even when parsed host is absent`() {
        assertInvalid("dev.peteryhs.unidash://evil_host/oauth/callback?code=one&state=$state")
    }

    @Test
    fun `control characters and oversized values are rejected`() {
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one%0Asecond&state=$state")
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=${"x".repeat(8193)}&state=$state")
        assertInvalid("dev.peteryhs.unidash:/oauth/callback?code=one&state=${"x".repeat(1025)}")
    }

    @Test
    fun `state reader exposes stale state without accepting callback`() {
        val stale = "dev.peteryhs.unidash:/oauth/callback?code=one&state=older"
        assertEquals("older", OAuthCallbackValidator.stateFrom(stale))
        assertTrue(OAuthCallbackValidator.validate(stale, state, issuer).isFailure)
    }

    private fun assertInvalid(uri: String) {
        val result = OAuthCallbackValidator.validate(uri, state, issuer)
        assertTrue(result.isFailure)
    }
}
