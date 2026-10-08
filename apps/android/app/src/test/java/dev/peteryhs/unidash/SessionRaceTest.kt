package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.DashboardRepository
import dev.peteryhs.unidash.data.RelayApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Regression coverage for session invalidation crossing refresh and notification delivery. */
class SessionRaceTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private lateinit var api: RelayApi

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
        api = RelayApi(Credentials(server.url("").toString().trimEnd('/'), "test-client", "test-secret"))
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun `sign out during delayed refresh prevents stale cache commit`() = runTest {
        val started = CountDownLatch(3)
        val release = CountDownLatch(1)
        val requestNumber = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (requestNumber.incrementAndGet() <= 3) {
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
            responseFor(request)
        }
        val cache = tmp.newFolder("cache")
        val repo = DashboardRepository(cache, apiFor = { api })
        val refresh = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refresh() }

        assertTrue("all parallel feeds started", started.await(10, TimeUnit.SECONDS))
        val invalidatedGeneration = repo.invalidateSession()
        release.countDown()

        val outcome = runCatching { refresh.await() }
        assertTrue("invalidated refresh must not succeed", outcome.isFailure || outcome.getOrNull()?.isFailure == true)
        assertTrue("invalidated refresh must not write stale cache", cache.listFiles().orEmpty().none { it.isFile })
        repo.clearInvalidated(invalidatedGeneration)
        assertFalse(repo.snapshot.value.hasData)
        assertTrue("sign-out removed stale cache files", cache.listFiles().orEmpty().none { it.isFile })
    }

    @Test
    fun `explicit source refresh updates upstream before reading health`() = runTest {
        server.enqueue(json("""{"receipts":[{"outcome":"ok"},{"outcome":"skipped"}],"deferred":["menu"]}"""))
        server.enqueue(json(fixture("health_sources.json")))
        val repo = DashboardRepository(tmp.newFolder("source-refresh"), apiFor = { api })
        assertTrue(repo.refreshHealth(updateSources = true).isSuccess)
        assertEquals("/v1/poll", server.takeRequest().path)
        assertEquals("/v1/health/sources", server.takeRequest().path)
        assertEquals("Refresh requested. 2 sources are waiting for a safe retry.", repo.snapshot.value.sourceRefreshResult)
        assertFalse(repo.snapshot.value.sourceRefreshing)
        assertFalse(repo.snapshot.value.healthRefreshing)
    }

    @Test
    fun `duplicate source refresh is suppressed while a poll is in progress`() = runTest {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val polls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/poll" -> {
                    polls.incrementAndGet()
                    started.countDown()
                    release.await(10, TimeUnit.SECONDS)
                    json("""{"receipts":[{"outcome":"ok"}]}""")
                }
                else -> json(fixture("health_sources.json"))
            }
        }
        val repo = DashboardRepository(tmp.newFolder("dedup-refresh"), apiFor = { api })
        val first = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refreshHealth(updateSources = true) }
        assertTrue(started.await(10, TimeUnit.SECONDS))
        assertTrue(repo.snapshot.value.sourceRefreshing)
        assertTrue(repo.refreshHealth(updateSources = true).isFailure)
        assertTrue(repo.snapshot.value.sourceRefreshing)
        release.countDown()
        assertTrue(first.await().isSuccess)
        assertEquals(1, polls.get())
        assertFalse(repo.snapshot.value.sourceRefreshing)
    }

    @Test
    fun `health refresh works independently and keeps last known status after failure`() = runTest {
        var healthFails = false
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path.orEmpty().startsWith("/v1/health/sources") -> if (healthFails) {
                    MockResponse().setResponseCode(503)
                } else {
                    json(fixture("health_sources.json"))
                }
                else -> MockResponse().setResponseCode(503)
            }
        }
        val cache = tmp.newFolder("health-cache")
        val repo = DashboardRepository(cache, apiFor = { api })

        assertTrue("feed refresh can fail without preventing the independent status check", repo.refresh().isFailure)
        val first = repo.refreshHealth().getOrThrow()
        assertEquals(first, repo.snapshot.value.health)
        assertFalse(repo.snapshot.value.healthRefreshing)
        assertTrue("health is live state and is not written into the dashboard cache", cache.listFiles().orEmpty().isEmpty())

        healthFails = true
        assertTrue(repo.refreshHealth().isFailure)
        assertEquals("the last successful status remains visible", first, repo.snapshot.value.health)
        assertNotNull(repo.snapshot.value.healthError)
        assertFalse(repo.snapshot.value.healthRefreshing)
    }

    @Test
    fun `a health result from a signed-out session cannot repopulate status`() = runTest {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path.orEmpty().startsWith("/v1/health/sources")) {
                    started.countDown()
                    release.await(10, TimeUnit.SECONDS)
                    return json(fixture("health_sources.json"))
                }
                return MockResponse().setResponseCode(503)
            }
        }
        val cache = tmp.newFolder("health-session-cache")
        val repo = DashboardRepository(cache, apiFor = { api })
        val pending = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refreshHealth() }

        assertTrue("health request reached the server", started.await(10, TimeUnit.SECONDS))
        val invalidatedGeneration = repo.invalidateSession()
        release.countDown()
        val outcome = runCatching { pending.await() }
        assertTrue("invalidated health cannot succeed", outcome.isFailure || outcome.getOrNull()?.isFailure == true)
        repo.clearInvalidated(invalidatedGeneration)

        assertNull(repo.snapshot.value.health)
        assertFalse(repo.snapshot.value.healthRefreshing)
        assertTrue(cache.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun `completed old result cannot deliver after clear and new session can refresh`() = runTest {
        server.dispatcher = fixtureDispatcher(::responseFor)
        val repo = DashboardRepository(tmp.newFolder("cache"), apiFor = { api })

        val old = repo.refresh().getOrThrow()
        val invalidatedGeneration = repo.invalidateSession()
        repo.clearInvalidated(invalidatedGeneration)

        var oldDelivered = false
        assertFalse(repo.deliverIfCurrent(old) { oldDelivered = true })
        assertFalse("old callback was fenced", oldDelivered)
        var oldFailureDelivered = false
        assertFalse(repo.runIfCurrent(old.sessionGeneration) { oldFailureDelivered = true })
        assertFalse("old failure callback was fenced", oldFailureDelivered)

        repo.beginSession()
        val fresh = repo.refresh().getOrThrow()
        assertNotEquals("new sign-in gets a new generation", old.sessionGeneration, fresh.sessionGeneration)
        var freshDelivered = false
        assertTrue(repo.deliverIfCurrent(fresh) { freshDelivered = true })
        assertTrue("new session callback is allowed", freshDelivered)
    }

    @Test
    fun `old sign out cleanup cannot wipe a session that starts while it waits`() = runTest {
        val started = CountDownLatch(3)
        val release = CountDownLatch(1)
        val requestNumber = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (requestNumber.incrementAndGet() <= 3) {
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("cache"), apiFor = { api })
        val refresh = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refresh() }

        assertTrue("all parallel feeds started", started.await(10, TimeUnit.SECONDS))
        val oldGeneration = repo.invalidateSession()
        val cleanup = async(start = CoroutineStart.UNDISPATCHED) {
            repo.clearInvalidated(oldGeneration)
        }
        repo.beginSession()
        release.countDown()
        runCatching { refresh.await() }
        cleanup.await()

        assertTrue("new session remains usable after old cleanup", repo.refresh().isSuccess)
    }

    @Test
    fun `a second sign out fence wins over a session admitted before cleanup`() = runTest {
        server.dispatcher = fixtureDispatcher(::responseFor)
        val repo = DashboardRepository(tmp.newFolder("cache"), apiFor = { api })

        repo.invalidateSession()
        repo.beginSession()
        val finalInvalidation = repo.invalidateSession()
        repo.clearInvalidated(finalInvalidation)

        assertTrue("the re-invalidated session cannot refresh", repo.refresh().isFailure)
        repo.beginSession()
        assertTrue("a later sign-in can refresh", repo.refresh().isSuccess)
    }

    @Test
    fun `cancellation remains cancellation while feeds are delayed`() = runTest {
        val started = CountDownLatch(3)
        val release = CountDownLatch(1)
        val requestNumber = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (requestNumber.incrementAndGet() <= 3) {
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("cache"), apiFor = { api })
        val refresh = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refresh() }

        assertTrue("all parallel feeds started", started.await(10, TimeUnit.SECONDS))
        refresh.cancel(CancellationException("test cancellation"))
        release.countDown()
        val outcome = runCatching { refresh.await() }
        assertTrue("refresh cancellation must propagate", outcome.exceptionOrNull() is CancellationException)
    }

    private fun fixtureDispatcher(handler: (RecordedRequest) -> MockResponse): Dispatcher =
        object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handler(request)
        }

    private fun responseFor(request: RecordedRequest): MockResponse = when {
        request.path.orEmpty().startsWith("/v1/dashboard") -> json(fixture("dashboard.json"))
        request.path.orEmpty().startsWith("/v1/recommendations") -> json(fixture("recommendations.json"))
        request.path.orEmpty().startsWith("/v1/calendar") -> json(fixture("calendar.json"))
        else -> MockResponse().setResponseCode(404)
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("content-type", "application/json")
        .setBody(body)
}
