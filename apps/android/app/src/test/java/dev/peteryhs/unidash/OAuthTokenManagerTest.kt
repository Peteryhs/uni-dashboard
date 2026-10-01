package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.OAuthCredentialStore
import dev.peteryhs.unidash.data.OAuthClient
import dev.peteryhs.unidash.data.OAuthCredentials
import dev.peteryhs.unidash.data.OAuthException
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.TokenManager
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class OAuthTokenManagerTest {
    private lateinit var server: MockWebServer

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun `concurrent callers share one refresh and retain rotated refresh token`() = runTest {
        val initial = credentials(server.url("/").toString().trimEnd('/'), "old")
        val store = MemoryOAuthStore(initial)
        val refreshes = AtomicInteger()
        val manager = TokenManager(
            store,
            OAuthClient(allowHttpForTests = true),
            clock = { 10_000L },
            refreshToken = {
                refreshes.incrementAndGet()
                delay(20)
                it.copy(accessToken = "new", refreshToken = "rotated", expiresAt = 999_999L)
            },
        )
        val values = (1..8).map { async { manager.accessToken() } }.awaitAll()
        assertEquals(List(8) { "new" }, values)
        assertEquals(1, refreshes.get())
        assertEquals("rotated", store.current()!!.oauth!!.refreshToken)
    }

    @Test
    fun `a sign out while refresh is in flight cannot resurrect credentials`() = runTest {
        val initial = credentials(server.url("/").toString().trimEnd('/'), "old")
        val store = MemoryOAuthStore(initial)
        val release = CompletableDeferred<OAuthCredentials>()
        val manager = TokenManager(
            store,
            OAuthClient(allowHttpForTests = true),
            refreshToken = {
                release.await().copy(accessToken = "late")
            },
        )
        val pending = async { manager.accessToken() }
        delay(10)
        store.clear()
        release.complete(initial.oauth!!)
        assertNull(pending.await())
        assertNull(store.current())
    }

    @Test
    fun `owner mismatch refuses to send a token to the old dashboard origin`() = runTest {
        val oldBase = server.url("/").toString().trimEnd('/')
        val newBase = "${oldBase}/replacement"
        val current = credentials(newBase, "new")
        val store = MemoryOAuthStore(current)
        val manager = TokenManager(store, OAuthClient(allowHttpForTests = true))
        assertNull(manager.accessToken(expectedOwner = credentials(oldBase, "old")))
    }

    @Test
    fun `replacement login during refresh keeps its own token and refuses the late token`() = runTest {
        val base = server.url("/").toString().trimEnd('/')
        val initial = credentials(base, "old").let { it.copy(oauth = it.oauth!!.copy(sessionId = "first-login")) }
        val replacement = initial.copy(oauth = initial.oauth!!.copy(accessToken = "replacement", sessionId = "second-login"))
        val store = MemoryOAuthStore(initial)
        val manager = TokenManager(store, OAuthClient(allowHttpForTests = true), refreshToken = {
            store.replace(replacement)
            it.copy(accessToken = "late")
        })
        assertNull(manager.accessToken(expectedOwner = initial))
        assertEquals(replacement, store.current())
    }

    @Test
    fun `replacement immediately after refresh commit cannot leak its token to the old caller`() = runTest {
        val base = server.url("/").toString().trimEnd('/')
        val initial = credentials(base, "old")
        val replacement = credentials("https://another.example", "replacement")
        val store = MemoryOAuthStore(initial).apply { afterSave = { replace(replacement) } }
        val manager = TokenManager(store, OAuthClient(allowHttpForTests = true), refreshToken = {
            it.copy(accessToken = "renewed")
        })
        assertNull(manager.accessToken(expectedOwner = initial))
        assertEquals(replacement, store.current())
    }

    @Test
    fun `force refresh after stale 401 reuses a token rotated by another caller`() = runTest {
        val base = server.url("/").toString().trimEnd('/')
        val owner = credentials(base, "old").copy(oauth = credentials(base, "old").oauth!!.copy(expiresAt = Long.MAX_VALUE))
        val rotated = owner.copy(oauth = owner.oauth!!.copy(accessToken = "rotated", expiresAt = Long.MAX_VALUE))
        val store = MemoryOAuthStore(owner)
        val first = AtomicBoolean(true)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                store.replace(rotated)
                return if (first.getAndSet(false)) MockResponse().setResponseCode(401)
                else MockResponse().setHeader("content-type", "application/json").setBody("""{"schema_version":1,"generated_at":1,"cards":[]}""")
            }
        }
        val manager = TokenManager(store, OAuthClient(allowHttpForTests = true), clock = { 0L })
        val api = RelayApi(owner, tokenManager = manager)
        api.dashboard()
        assertEquals("Bearer old", server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer rotated", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `expired credential without refresh is reauth while network failure stays offline`() = runTest {
        val base = server.url("/").toString().trimEnd('/')
        val expired = credentials(base, "old").copy(oauth = credentials(base, "old").oauth!!.copy(expiresAt = 0, refreshToken = null))
        val manager = TokenManager(MemoryOAuthStore(expired), OAuthClient(allowHttpForTests = true), clock = { 100_000 })
        val reauth = runCatching { manager.accessToken() }.exceptionOrNull()
        assertTrue(reauth is RelayError.ReauthRequired)

        val revoked = TokenManager(
            MemoryOAuthStore(credentials(base, "old")),
            OAuthClient(allowHttpForTests = true),
            refreshToken = { throw OAuthException.InvalidGrant() },
        )
        assertTrue(runCatching { revoked.accessToken() }.exceptionOrNull() is RelayError.ReauthRequired)

        val offline = TokenManager(
            MemoryOAuthStore(credentials(base, "old")),
            OAuthClient(allowHttpForTests = true),
            refreshToken = { throw OAuthException.Network(IOException("down")) },
        )
        assertTrue(runCatching { offline.accessToken() }.exceptionOrNull() is RelayError.Offline)
    }

    private fun credentials(base: String, token: String): Credentials = Credentials(
        base,
        "public",
        "",
        OAuthCredentials(
            clientId = "public",
            authorizationEndpoint = "$base/authorize",
            tokenEndpoint = "$base/token",
            accessToken = token,
            refreshToken = "refresh",
            expiresAt = 0,
            resource = base,
            issuer = base,
        ),
    )

    private class MemoryOAuthStore(initial: Credentials?) : OAuthCredentialStore {
        @Volatile
        private var value: Credentials? = initial
        var afterSave: (() -> Unit)? = null

        override suspend fun current(): Credentials? = value

        override suspend fun compareAndSave(value: Credentials, expectedAccessToken: String?, expectedOwner: Credentials?): Boolean {
            val current = this.value
            if (current == null || current.oauth == null) return false
            if (current?.oauth?.accessToken != expectedAccessToken) return false
            if (expectedOwner != null && !current.sameOwner(expectedOwner)) return false
            this.value = value
            afterSave?.invoke()
            return true
        }

        fun clear() {
            value = null
        }

        fun replace(value: Credentials) {
            this.value = value
        }

        private fun Credentials.sameOwner(other: Credentials): Boolean =
            baseUrl == other.baseUrl && clientId == other.clientId &&
                oauth?.resource == other.oauth?.resource && oauth?.issuer == other.oauth?.issuer &&
                oauth?.sessionId == other.oauth?.sessionId
    }
}
