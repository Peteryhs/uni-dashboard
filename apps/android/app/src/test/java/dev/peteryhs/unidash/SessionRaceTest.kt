package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.DashboardRepository
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.Alert
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
        val refresh = async(Dispatchers.IO) { repo.refresh(userInitiated = true) }

        assertTrue("all parallel feeds started", started.await(10, TimeUnit.SECONDS))
        assertTrue("the actual network request is represented as busy", repo.snapshot.value.refreshing)
        assertTrue("the user-requested refresh has visible progress", repo.snapshot.value.manualRefreshing)
        val invalidatedGeneration = repo.invalidateSession()
        assertFalse("session replacement clears the old pull state", repo.snapshot.value.manualRefreshing)
        assertFalse("session replacement clears the old network state", repo.snapshot.value.refreshing)
        release.countDown()

        val outcome = runCatching { refresh.await() }
        assertTrue("invalidated refresh must not succeed", outcome.isFailure || outcome.getOrNull()?.isFailure == true)
        assertTrue("invalidated refresh must not write stale cache", cache.listFiles().orEmpty().none { it.isFile })
        repo.clearInvalidated(invalidatedGeneration)
        assertFalse(repo.snapshot.value.hasData)
        assertTrue("sign-out removed stale cache files", cache.listFiles().orEmpty().none { it.isFile })
    }

    @Test
    fun `manual refresh queues behind an automatic refresh and remains visible`() = runTest {
        val automaticStarted = CountDownLatch(3)
        val releaseAutomatic = CountDownLatch(1)
        val requests = AtomicInteger()
        server.dispatcher = fixtureDispatcher { request ->
            if (requests.incrementAndGet() <= 3) {
                automaticStarted.countDown()
                releaseAutomatic.await(10, TimeUnit.SECONDS)
            }
            responseFor(request)
        }
        val repo = DashboardRepository(tmp.newFolder("manual-after-auto"), apiFor = { api })
        val automatic = async(Dispatchers.IO) { repo.refresh() }

        assertTrue("automatic feeds are in flight", automaticStarted.await(10, TimeUnit.SECONDS))
        assertTrue(repo.snapshot.value.refreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)

        val manual = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            repo.refresh(userInitiated = true)
        }
        assertTrue("manual intent is visible while it waits for the shared request lock", repo.snapshot.value.manualRefreshing)
        releaseAutomatic.countDown()

        assertTrue(automatic.await().isSuccess)
        assertTrue(manual.await().isSuccess)
        assertEquals("the queued manual request runs after the automatic request", 10, requests.get())
        assertFalse(repo.snapshot.value.refreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)
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
    fun `newer health request wins and remains busy while older result finishes`() = runTest {
        val firstStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        val releaseSecond = CountDownLatch(1)
        val healthRequests = AtomicInteger()
        val firstHealth = fixture("health_sources.json").replace("\"now\": 1790536188816", "\"now\": 1799999999999")
        val secondHealth = fixture("health_sources.json").replace("\"now\": 1790536188816", "\"now\": 1800000000000")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (!request.path.orEmpty().startsWith("/v1/health/sources")) return MockResponse().setResponseCode(404)
                return if (healthRequests.incrementAndGet() == 1) {
                    firstStarted.countDown()
                    releaseFirst.await(10, TimeUnit.SECONDS)
                    json(firstHealth)
                } else {
                    secondStarted.countDown()
                    releaseSecond.await(10, TimeUnit.SECONDS)
                    json(secondHealth)
                }
            }
        }
        val repo = DashboardRepository(tmp.newFolder("health-owners"), apiFor = { api })
        try {
            val older = async(Dispatchers.IO) { repo.refreshHealth() }

            assertTrue("first health request reached the server", firstStarted.await(10, TimeUnit.SECONDS))
            // Enter synchronously until the newer request suspends behind the held health mutex;
            // this makes its refresh owner visible before checking the shared busy state.
            val newer = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refreshHealth() }
            assertTrue("pending health checks keep the status row busy", repo.snapshot.value.healthRefreshing)
            releaseFirst.countDown()
            assertTrue("the newer request runs after the older one releases the health lock", secondStarted.await(10, TimeUnit.SECONDS))
            assertEquals("both ordered health requests reached the server", 2, healthRequests.get())
            assertTrue(older.await().isSuccess)
            assertTrue("the second request still owns the busy state while its response is held", repo.snapshot.value.healthRefreshing)
            releaseSecond.countDown()
            assertTrue(newer.await().isSuccess)

            assertEquals("the latest request owns the displayed status", 1800000000000, repo.snapshot.value.health?.now)
            assertFalse("busy clears after every owned health request completes", repo.snapshot.value.healthRefreshing)
        } finally {
            releaseFirst.countDown()
            releaseSecond.countDown()
        }
    }

    @Test
    fun `manual source poll survives a Status health check already in flight`() = runTest {
        val statusStarted = CountDownLatch(1)
        val releaseStatus = CountDownLatch(1)
        val pollStarted = CountDownLatch(1)
        val healthRequests = AtomicInteger()
        val polls = AtomicInteger()
        val oldHealth = fixture("health_sources.json").replace("\"now\": 1790536188816", "\"now\": 1799999999999")
        val newHealth = fixture("health_sources.json").replace("\"now\": 1790536188816", "\"now\": 1800000000000")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/health/sources" -> if (healthRequests.incrementAndGet() == 1) {
                    statusStarted.countDown()
                    releaseStatus.await(10, TimeUnit.SECONDS)
                    json(oldHealth)
                } else json(newHealth)
                "/v1/poll" -> {
                    polls.incrementAndGet()
                    pollStarted.countDown()
                    json("""{"receipts":[{"outcome":"ok"}]}""")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val repo = DashboardRepository(tmp.newFolder("status-then-poll"), apiFor = { api })
        val status = async(Dispatchers.IO) { repo.refreshHealth() }

        assertTrue("Status check reached the server", statusStarted.await(10, TimeUnit.SECONDS))
        // The Status request owns healthRefreshMutex here, so undispatched entry records the
        // manual intent and suspends at that mutex before it can make another blocking request.
        val manualPoll = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { repo.refreshHealth(updateSources = true) }
        assertTrue("the explicit source request owns its progress while it waits", repo.snapshot.value.sourceRefreshing)
        assertTrue(repo.snapshot.value.manualRefreshing)
        releaseStatus.countDown()
        assertTrue("manual source poll proceeds after the in-flight Status check", pollStarted.await(10, TimeUnit.SECONDS))
        assertTrue(status.await().isSuccess)
        assertTrue(repo.snapshot.value.healthRefreshing)
        assertTrue(manualPoll.await().isSuccess)

        assertEquals(1, polls.get())
        assertEquals("the manual poll's later health read wins", 1800000000000L, repo.snapshot.value.health?.now)
        assertFalse(repo.snapshot.value.healthRefreshing)
        assertFalse(repo.snapshot.value.sourceRefreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)
    }

    @Test
    fun `accepted source poll reports dashboard reload failure separately`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/poll" -> json("""{"receipts":[{"outcome":"ok"}]}""")
                "/v1/health/sources" -> json(fixture("health_sources.json"))
                else -> MockResponse().setResponseCode(503)
            }
        }
        val repo = DashboardRepository(tmp.newFolder("source-reload-failure"), apiFor = { api })

        assertTrue("a failed dashboard read does not undo the accepted source poll", repo.refreshSourcesAndDashboard().isFailure)
        val result = repo.snapshot.value.sourceRefreshResult.orEmpty()
        assertTrue(result, result.startsWith("Source refresh finished."))
        assertTrue(result, result.contains("Dashboard content could not reload"))
        assertNotNull("feed reload error is exposed independently", repo.snapshot.value.error)
        assertFalse(repo.snapshot.value.sourceRefreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)
    }

    @Test
    fun `cancelling a source poll clears only its own progress placeholder`() = runTest {
        val pollStarted = CountDownLatch(1)
        val releasePoll = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/poll" -> {
                    pollStarted.countDown()
                    releasePoll.await(10, TimeUnit.SECONDS)
                    json("""{"receipts":[{"outcome":"ok"}]}""")
                }
                else -> json(fixture("health_sources.json"))
            }
        }
        val repo = DashboardRepository(tmp.newFolder("source-cancel"), apiFor = { api })
        val pending = async(Dispatchers.IO) { repo.refreshHealth(updateSources = true) }

        assertTrue(pollStarted.await(10, TimeUnit.SECONDS))
        assertEquals("Refreshing sources…", repo.snapshot.value.sourceRefreshResult)
        assertTrue(repo.snapshot.value.sourceRefreshing)
        pending.cancel(CancellationException("test cancellation"))
        releasePoll.countDown()
        assertTrue(runCatching { pending.await() }.exceptionOrNull() is CancellationException)

        assertFalse(repo.snapshot.value.sourceRefreshing)
        assertEquals("Source refresh was cancelled.", repo.snapshot.value.sourceRefreshResult)
        assertFalse(repo.snapshot.value.healthRefreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)
    }

    @Test
    fun `failed action restores only its own recommendation after another action succeeds`() = runTest {
        server.dispatcher = fixtureDispatcher(::responseFor)
        val repo = DashboardRepository(tmp.newFolder("independent-actions"), apiFor = { api })
        repo.refresh().getOrThrow()
        val original = repo.snapshot.value.recommendations!!.items
        val failedItem = original[0]
        val acceptedItem = original[1]
        val failedPostStarted = CountDownLatch(1)
        val releaseFailedPost = CountDownLatch(1)

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/v1/recommendations/actions") {
                    val body = request.body.readUtf8()
                    if (failedItem.id in body) {
                        failedPostStarted.countDown()
                        releaseFailedPost.await(10, TimeUnit.SECONDS)
                        return MockResponse().setResponseCode(503)
                    }
                    return json("{}")
                }
                return responseFor(request)
            }
        }
        val failed = async(Dispatchers.IO) { repo.act(failedItem, "done") }

        assertTrue(failedPostStarted.await(10, TimeUnit.SECONDS))
        val accepted = async(Dispatchers.IO) { repo.act(acceptedItem, "dismiss") }
        assertTrue(accepted.await().isSuccess)
        assertTrue(repo.snapshot.value.recommendations!!.items.isEmpty())

        releaseFailedPost.countDown()
        assertTrue(failed.await().isFailure)
        assertEquals(listOf(failedItem.id), repo.snapshot.value.recommendations!!.items.map { it.id })
    }

    @Test
    fun `acknowledged alert dismissal stays local when a later feed reload fails`() = runTest {
        server.dispatcher = fixtureDispatcher(::responseFor)
        val repo = DashboardRepository(tmp.newFolder("alert-dismissal"), apiFor = { api })
        repo.refresh().getOrThrow()
        val key = repo.snapshot.value.bundle!!.card("alert")!!.payload<Alert>()!!.key

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/alerts/dismiss" -> json("{}")
                else -> MockResponse().setResponseCode(503)
            }
        }
        assertTrue("the acknowledged action succeeds independently", repo.dismissAlert(key).isSuccess)
        assertTrue(repo.snapshot.value.bundle!!.card("alert")!!.payload<Alert>()!!.dismissed)
        assertTrue("a separate feed read can still report its own failure", repo.refresh().isFailure)

        assertTrue("refresh failure does not restore the alert", repo.snapshot.value.bundle!!.card("alert")!!.payload<Alert>()!!.dismissed)
        assertNotNull(repo.snapshot.value.error)
    }

    @Test
    fun `accepted dining ranking is not reported as failed when feed reload fails`() = runTest {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/ai/rank-food" -> json("{}")
                else -> MockResponse().setResponseCode(503)
            }
        }
        val repo = DashboardRepository(tmp.newFolder("ranking-reload-failure"), apiFor = { api })

        assertTrue("the ranking POST was accepted", repo.rankFood("2026-09-28").isSuccess)
        assertNotNull("the failed follow-up read is still visible separately", repo.snapshot.value.error)
        assertFalse(repo.snapshot.value.foodRankingSubmitting)
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
        val first = async(Dispatchers.IO) { repo.refreshHealth(updateSources = true) }
        assertTrue(started.await(10, TimeUnit.SECONDS))
        assertTrue(repo.snapshot.value.sourceRefreshing)
        assertTrue("an explicit source update exposes manual progress", repo.snapshot.value.manualRefreshing)
        assertTrue(repo.refreshHealth(updateSources = true).isFailure)
        assertTrue(repo.snapshot.value.sourceRefreshing)
        assertTrue("a duplicate request cannot clear the active request's progress", repo.snapshot.value.manualRefreshing)
        release.countDown()
        assertTrue(first.await().isSuccess)
        assertEquals(1, polls.get())
        assertFalse(repo.snapshot.value.sourceRefreshing)
        assertFalse(repo.snapshot.value.manualRefreshing)
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
        val pending = async(Dispatchers.IO) { repo.refreshHealth() }

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
        val refresh = async(Dispatchers.IO) { repo.refresh() }

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
        val refresh = async(Dispatchers.IO) { repo.refresh(userInitiated = true) }

        assertTrue("all parallel feeds started", started.await(10, TimeUnit.SECONDS))
        assertTrue("manual progress is visible during the request", repo.snapshot.value.manualRefreshing)
        refresh.cancel(CancellationException("test cancellation"))
        release.countDown()
        val outcome = runCatching { refresh.await() }
        assertTrue("refresh cancellation must propagate", outcome.exceptionOrNull() is CancellationException)
        assertFalse("cancellation always clears the pull state", repo.snapshot.value.manualRefreshing)
        assertFalse("cancellation always clears actual network busy state", repo.snapshot.value.refreshing)
    }

    @Test
    fun `food ranking submission is immediate and duplicate requests coalesce`() = runTest {
        val postStarted = CountDownLatch(1)
        val releasePost = CountDownLatch(1)
        val refreshStarted = CountDownLatch(3)
        val releaseRefresh = CountDownLatch(1)
        val posts = AtomicInteger()
        val refreshRequests = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path.orEmpty().startsWith("/v1/ai/rank-food")) {
                    posts.incrementAndGet()
                    postStarted.countDown()
                    releasePost.await(10, TimeUnit.SECONDS)
                    return json("{}")
                }
                if (refreshRequests.incrementAndGet() <= 3) {
                    refreshStarted.countDown()
                    releaseRefresh.await(10, TimeUnit.SECONDS)
                }
                return responseFor(request)
            }
        }
        val repo = DashboardRepository(tmp.newFolder("food-ranking"), apiFor = { api })
        val first = async(Dispatchers.IO) { repo.rankFood("2026-09-28") }

        assertTrue("ranking request reached the server", postStarted.await(10, TimeUnit.SECONDS))
        assertTrue("the screen receives submission feedback before the server responds", repo.snapshot.value.foodRankingSubmitting)
        assertTrue("a duplicate tap joins the existing request", repo.rankFood("2026-09-28").isSuccess)
        assertEquals(1, posts.get())

        releasePost.countDown()
        assertTrue("the follow-up feed refresh starts", refreshStarted.await(10, TimeUnit.SECONDS))
        assertTrue("submission stays owned until the server status can be read", repo.snapshot.value.foodRankingSubmitting)
        assertTrue("the follow-up feed read is separate network busy state", repo.snapshot.value.refreshing)
        assertFalse("ranking does not use pull-to-refresh state", repo.snapshot.value.manualRefreshing)
        assertTrue("a tap during the status read is still coalesced", repo.rankFood("2026-09-28").isSuccess)
        assertEquals(1, posts.get())

        releaseRefresh.countDown()
        assertTrue(first.await().isSuccess)
        assertFalse(repo.snapshot.value.foodRankingSubmitting)
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
