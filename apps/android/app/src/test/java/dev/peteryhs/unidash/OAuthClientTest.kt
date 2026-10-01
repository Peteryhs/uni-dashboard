package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.OAuthClient
import dev.peteryhs.unidash.data.OAuthException
import dev.peteryhs.unidash.data.OAuthCredentials
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64

class OAuthClientTest {
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
    fun `prepare discovers OAuth metadata dynamically registers and creates S256 request`() = runTest {
        var registration: RecordedRequest? = null
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/.well-known/oauth-authorization-server" -> json(
                    """
                    {
                      "issuer":"$base",
                      "authorization_endpoint":"$base/authorize",
                      "token_endpoint":"$base/token",
                      "registration_endpoint":"$base/register",
                      "response_types_supported":["code"],
                      "grant_types_supported":["authorization_code","refresh_token"],
                      "code_challenge_methods_supported":["S256"],
                      "scopes_supported":["openid","dashboard.read"]
                    }
                    """.trimIndent(),
                )
                request.path == "/register" -> {
                    registration = request
                    json("""{"client_id":"managed-public-client","token_endpoint_auth_method":"none"}""", 201)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }

        val pending = OAuthClient(
            allowHttpForTests = true,
            requestedScopes = listOf("openid", "dashboard.read"),
        ).prepare(base, "https://app.example.test/oauth/callback")
        val authorization = pending.authorizationUrl.toHttpUrl()
        assertEquals("code", authorization.queryParameter("response_type"))
        assertEquals("managed-public-client", authorization.queryParameter("client_id"))
        assertEquals("S256", authorization.queryParameter("code_challenge_method"))
        assertEquals("openid dashboard.read", authorization.queryParameter("scope"))
        assertEquals(base, authorization.queryParameter("resource"))
        assertEquals(
            Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(pending.codeVerifier.toByteArray(Charsets.US_ASCII)),
            ),
            authorization.queryParameter("code_challenge"),
        )
        val body = registration!!.body.readUtf8()
        assertTrue(body.contains("\"token_endpoint_auth_method\":\"none\""))
        assertTrue(body.contains("\"authorization_code\""))
        assertTrue(body.contains("\"refresh_token\""))
        assertTrue(body.contains("\"response_types\":[\"code\"]"))
        assertTrue(body.contains("https://app.example.test/oauth/callback"))
    }

    @Test
    fun `exchange checks state and preserves refresh state`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/.well-known/oauth-authorization-server" -> json(
                    """{"issuer":"$base","authorization_endpoint":"$base/authorize","token_endpoint":"$base/token","registration_endpoint":"$base/register"}""",
                )
                request.path == "/register" -> json("""{"client_id":"public"}""", 201)
                request.path == "/token" -> json(
                    """{"access_token":"opaque-access","refresh_token":"opaque-refresh","token_type":"Bearer","expires_in":3600,"scope":"dashboard.read"}""",
                )
                else -> MockResponse().setResponseCode(404)
            }
        }
        val client = OAuthClient(allowHttpForTests = true, clock = { 1_000L })
        val pending = client.prepare(base, "https://app.example.test/oauth/callback")
        val credentials = client.exchange(pending, "authorization-code", pending.state)
        assertEquals("public", credentials.oauth?.clientId)
        assertEquals("opaque-access", credentials.oauth?.accessToken)
        assertEquals("opaque-refresh", credentials.oauth?.refreshToken)
        assertEquals(3_601_000L, credentials.oauth?.expiresAt)

        val tokenRequest = server.takeRequest() // metadata
        assertEquals("/.well-known/oauth-authorization-server", tokenRequest.path)
        server.takeRequest() // registration
        val exchangeRequest = server.takeRequest()
        val exchangeForm = ("http://localhost/?" + exchangeRequest.body.readUtf8()).toHttpUrl()
        assertEquals(pending.codeVerifier, exchangeForm.queryParameter("code_verifier"))
        assertEquals(pending.redirectUri, exchangeForm.queryParameter("redirect_uri"))
        assertEquals(base, exchangeForm.queryParameter("resource"))
        assertNull(exchangeForm.queryParameter("client_secret"))
        val pendingWithBadState = pending
        val error = runCatching { client.exchange(pendingWithBadState, "code", "attacker-state") }.exceptionOrNull()
        assertTrue(error is OAuthException.Exchange)
    }

    @Test
    fun `refresh uses a public client form and rejects error responses carrying token fields`() = runTest {
        val initial = OAuthCredentials(
            clientId = "public", authorizationEndpoint = "$base/authorize", tokenEndpoint = "$base/token",
            accessToken = "old", refreshToken = "refresh+secret", resource = base, issuer = base,
            sessionId = "same-login",
        )
        val client = OAuthClient(allowHttpForTests = true, clock = { 1_000L })
        server.enqueue(json("""{"access_token":"renewed","refresh_token":"rotated","token_type":"Bearer","expires_in":900}"""))
        val renewed = client.refresh(initial)
        assertEquals("rotated", renewed.refreshToken)
        assertEquals("same-login", renewed.sessionId)
        assertEquals(901_000L, renewed.expiresAt)
        val request = server.takeRequest()
        val form = ("http://localhost/?" + request.body.readUtf8()).toHttpUrl()
        assertEquals("refresh_token", form.queryParameter("grant_type"))
        assertEquals("refresh+secret", form.queryParameter("refresh_token"))
        assertEquals(base, form.queryParameter("resource"))
        assertEquals("public", form.queryParameter("client_id"))
        assertNull(form.queryParameter("client_secret"))
        assertNull(request.getHeader("Authorization"))

        server.enqueue(json("""{"access_token":"must-not-be-accepted","token_type":"Bearer"}""", 400))
        assertTrue(runCatching { client.refresh(initial) }.exceptionOrNull() is OAuthException.Exchange)
        server.enqueue(json("""{"error":"invalid_grant"}""", 400))
        assertTrue(runCatching { client.refresh(initial) }.exceptionOrNull() is OAuthException.InvalidGrant)
    }

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("content-type", "application/json")
        .setBody(body)
}
