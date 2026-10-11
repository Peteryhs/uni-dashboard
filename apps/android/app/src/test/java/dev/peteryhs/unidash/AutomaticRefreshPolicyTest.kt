package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.DashboardRepository
import dev.peteryhs.unidash.data.RelayApi
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AutomaticRefreshPolicyTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private lateinit var api: RelayApi
    private var calendarGeneratedAtOverride: Long? = null

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
        api = RelayApi(Credentials(server.url("").toString().trimEnd('/'), "test-client", "test-secret"))
        server.dispatcher = fixtureDispatcher(::responseFor)
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun `overlapping automatic reads share the completed bundle`() = runTest {
        val started = CountDownLatch(4)
        val release = CountDownLatch(1)
        val requests = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (requests.incrementAndGet() <= 4) {
                started.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("overlap"), apiFor = { api }, clock = { 100_000L })

        val first = async(Dispatchers.IO) { repo.refresh(skipIfFresh = true) }
        assertTrue("the first bundle is in flight", started.await(10, TimeUnit.SECONDS))
        // The first request owns the mutex, so this coroutine suspends before reaching the blocking
        // HTTP client. It will then observe the completed first result under that same mutex.
        val overlapping = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            repo.refresh(skipIfFresh = true)
        }
        release.countDown()

        assertTrue(first.await().isSuccess)
        assertTrue(overlapping.await().isSuccess)
        assertEquals("dashboard, recommendations, calendar, health, and optional food", 5, requests.get())
        assertFalse(repo.snapshot.value.refreshing)
    }

    @Test
    fun `automatic read reuses fresh data but explicit refresh forces a new bundle`() = runTest {
        val requests = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            requests.incrementAndGet()
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("fresh"), apiFor = { api }, clock = { 200_000L })

        val loaded = repo.refresh(skipIfFresh = true).getOrThrow()
        val reused = repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals(loaded.fetchedAt, reused.fetchedAt)
        assertEquals("only the first automatic call reaches the server", 5, requests.get())

        val manual = repo.refresh(userInitiated = true, skipIfFresh = true).getOrThrow()
        assertEquals("an explicit pull always reads again", 10, requests.get())
        assertEquals(loaded.fetchedAt, manual.fetchedAt)
        assertFalse(repo.snapshot.value.manualRefreshing)
    }

    @Test
    fun `stale and replaced-session data are never reused`() = runTest {
        val requests = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            requests.incrementAndGet()
            responseFor(request)
        }
        var now = 300_000L
        val repo = DashboardRepository(tmp.newFolder("stale-session"), apiFor = { api }, clock = { now })
        val oldGeneration = repo.currentSessionGeneration()

        repo.refresh(skipIfFresh = true).getOrThrow()
        now -= 1L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("a clock value before fetchedAt cannot make data look fresh", 10, requests.get())
        now += 60_000L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("the exact one-minute boundary is fetched again", 15, requests.get())

        val invalidated = repo.invalidateSession()
        repo.clearInvalidated(invalidated)
        val newGeneration = repo.beginSession()
        assertTrue(repo.refresh(expectedGeneration = oldGeneration, skipIfFresh = true).isFailure)
        assertEquals("an old session cannot cause a request", 15, requests.get())
        repo.refresh(expectedGeneration = newGeneration, skipIfFresh = true).getOrThrow()
        assertEquals("the new session fetches its own complete snapshot", 20, requests.get())
        assertEquals(newGeneration, repo.snapshot.value.sessionGeneration)
    }

    @Test
    fun `automatic read retries a fresh snapshot that carries a feed error`() = runTest {
        val requests = AtomicInteger()
        var failDashboard = false
        server.dispatcher = fixtureDispatcher { request ->
            requests.incrementAndGet()
            if (failDashboard && request.path.orEmpty().startsWith("/v1/dashboard")) {
                MockResponse().setResponseCode(502)
            } else responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("error"), apiFor = { api }, clock = { 400_000L })
        repo.refresh(skipIfFresh = true).getOrThrow()

        failDashboard = true
        assertTrue(repo.refresh().isFailure)
        assertTrue(repo.snapshot.value.error != null)
        val afterFailure = requests.get()

        failDashboard = false
        assertTrue(repo.refresh(skipIfFresh = true).isSuccess)
        assertTrue("the failed snapshot was not treated as fresh", requests.get() > afterFailure)
        assertEquals(null, repo.snapshot.value.error)
    }

    @Test
    fun `automatic feed refresh reuses calendar through four minutes and refreshes at five`() = runTest {
        var now = 1_790_536_188_779L
        calendarGeneratedAtOverride = now
        val dashboards = AtomicInteger()
        val recommendations = AtomicInteger()
        val calendars = AtomicInteger()
        val health = AtomicInteger()
        val dining = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            when {
                request.path.orEmpty().startsWith("/v1/dashboard") -> dashboards.incrementAndGet()
                request.path.orEmpty().startsWith("/v1/recommendations") -> recommendations.incrementAndGet()
                request.path.orEmpty().startsWith("/v1/calendar") -> calendars.incrementAndGet()
                request.path.orEmpty().startsWith("/v1/health/sources") -> health.incrementAndGet()
                request.path.orEmpty().startsWith("/v1/food/recommendation") -> dining.incrementAndGet()
            }
            responseFor(request)
        }
        val cache = tmp.newFolder("calendar-cadence")
        val repo = DashboardRepository(cache, apiFor = { api }, clock = { now })

        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals(1, calendars.get())
        val calendarCache = File(cache, "calendar.json")
        assertTrue(calendarCache.setLastModified(946_684_800_000L))
        val savedCalendarTime = calendarCache.lastModified()

        now += 60_000L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("other feeds keep their one-minute cadence", 2, dashboards.get())
        assertEquals(2, recommendations.get())
        assertEquals(2, health.get())
        assertEquals(2, dining.get())
        assertEquals("fresh calendar is not requested again after one minute", 1, calendars.get())
        assertEquals("reusing calendar does not rewrite its disk cache", savedCalendarTime, calendarCache.lastModified())

        repo.refresh(userInitiated = true).getOrThrow()
        repo.refresh().getOrThrow()
        assertEquals("explicit and default forced reads still fetch calendar", 3, calendars.get())

        now = 1_790_536_188_779L + 300_000L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("calendar is fetched again at the exact five-minute boundary", 4, calendars.get())
        assertEquals("other feeds also continued updating", 5, dashboards.get())
        assertEquals(5, recommendations.get())
        assertEquals(5, health.get())
        assertEquals(5, dining.get())
    }

    @Test
    fun `future calendar timestamp and local clock rollback force automatic calendar reads`() = runTest {
        var now = 1_790_536_188_779L
        calendarGeneratedAtOverride = now + 300_001L
        val calendars = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (request.path.orEmpty().startsWith("/v1/calendar")) calendars.incrementAndGet()
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("calendar-clock"), apiFor = { api }, clock = { now })

        repo.refresh(skipIfFresh = true).getOrThrow()
        now += 60_000L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("future generated_at is not reused", 2, calendars.get())

        now -= 1L
        repo.refresh(skipIfFresh = true).getOrThrow()
        assertEquals("clock rollback cannot make the prior snapshot or calendar reusable", 3, calendars.get())
    }

    private fun fixtureDispatcher(handler: (RecordedRequest) -> MockResponse): Dispatcher =
        object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handler(request)
        }

    private fun responseFor(request: RecordedRequest): MockResponse = when {
        request.path.orEmpty().startsWith("/v1/dashboard") -> json(fixture("dashboard.json"))
        request.path.orEmpty().startsWith("/v1/recommendations") -> json(fixture("recommendations.json"))
        request.path.orEmpty().startsWith("/v1/calendar") -> calendarResponse()
        request.path.orEmpty().startsWith("/v1/health/sources") -> json(fixture("health_sources.json"))
        request.path.orEmpty().startsWith("/v1/food/recommendation") -> json("{}")
        else -> MockResponse().setResponseCode(404)
    }

    private fun calendarResponse(): MockResponse {
        val body = fixture("calendar.json")
        val generatedAt = calendarGeneratedAtOverride ?: return json(body)
        val updated = Regex("\"generated_at\":\\s*\\d+").replaceFirst(body, "\"generated_at\": $generatedAt")
        return json(updated)
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("content-type", "application/json")
        .setBody(body)
}
