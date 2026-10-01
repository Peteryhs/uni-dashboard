package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.OAuthCredentials
import dev.peteryhs.unidash.data.RelayApi
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class OAuthRelayApiTest {
    private lateinit var server: MockWebServer

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun `OAuth relay uses bearer token and never sends legacy service secret`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody("""{"schema_version":1,"generated_at":1,"cards":[]}"""),
        )
        val base = server.url("").toString().trimEnd('/')
        val oauth = OAuthCredentials(
            clientId = "public-client",
            authorizationEndpoint = "https://issuer.example/authorize",
            tokenEndpoint = "https://issuer.example/token",
            accessToken = "opaque-access",
            refreshToken = "opaque-refresh",
            expiresAt = null,
            resource = base,
            issuer = "https://issuer.example",
        )
        RelayApi(Credentials(base, "public-client", "", oauth)).dashboard()
        val request = server.takeRequest()
        assertEquals("Bearer opaque-access", request.getHeader("Authorization"))
        assertNull(request.getHeader("CF-Access-Client-Secret"))
        assertNull(request.getHeader("CF-Access-Client-Id"))
    }

    @Test
    fun `a GET may refresh and replay once while a write is never replayed`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(
            MockResponse()
                .setHeader("content-type", "application/json")
                .setBody("""{"schema_version":1,"generated_at":1,"cards":[]}"""),
        )
        val base = server.url("").toString().trimEnd('/')
        val oauth = OAuthCredentials(
            clientId = "public-client",
            authorizationEndpoint = "https://issuer.example/authorize",
            tokenEndpoint = "https://issuer.example/token",
            accessToken = "old-access",
            refreshToken = "refresh",
            resource = base,
            issuer = "https://issuer.example",
        )
        val tokens = mutableListOf<Boolean>()
        val api = RelayApi(
            Credentials(base, "public-client", "", oauth),
            accessTokenProvider = { force ->
                tokens += force
                if (force) "new-access" else "old-access"
            },
        )
        api.dashboard()
        assertEquals(listOf(false, true), tokens)
        assertEquals("Bearer old-access", server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer new-access", server.takeRequest().getHeader("Authorization"))

        server.enqueue(MockResponse().setResponseCode(401))
        runCatching { api.recommendationAction("r1", "done") }
        assertEquals("POST", server.takeRequest(1, TimeUnit.SECONDS)?.method)
        assertEquals(null, server.takeRequest(100, TimeUnit.MILLISECONDS))
    }
}
