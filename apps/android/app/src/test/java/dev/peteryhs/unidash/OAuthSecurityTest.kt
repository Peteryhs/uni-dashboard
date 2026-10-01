package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.OAuthClient
import dev.peteryhs.unidash.data.OAuthException
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OAuthSecurityTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
        base = server.url("").toString().trimEnd('/')
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun `registration endpoint outside dashboard and issuer is rejected`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody(
                    """{"issuer":"$base","authorization_endpoint":"$base/authorize","token_endpoint":"$base/token","registration_endpoint":"https://evil.example/register"}""",
                ),
        )
        val error = runCatching {
            OAuthClient(allowHttpForTests = true).prepare(base, "https://app.example.test/oauth/callback")
        }.exceptionOrNull()
        assertTrue(error is OAuthException.Discovery)
    }

    @Test
    fun `HTTP dashboard is refused by default even when endpoint metadata looks valid`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody(
                    """{"issuer":"$base","authorization_endpoint":"$base/authorize","token_endpoint":"$base/token","registration_endpoint":"$base/register"}""",
                ),
        )
        val error = runCatching {
            OAuthClient().prepare(base, "https://app.example.test/oauth/callback")
        }.exceptionOrNull()
        assertTrue(error is OAuthException.Discovery)
    }
}
