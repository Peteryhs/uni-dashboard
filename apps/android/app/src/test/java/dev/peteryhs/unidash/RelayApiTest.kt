package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.DashboardRepository
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.RelayError
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RelayApiTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private lateinit var api: RelayApi

    @Before fun start() {
        server = MockWebServer().apply { start() }
        // Tests talk plain http to the mock; the app itself only ever builds https bases.
        api = RelayApi(Credentials(server.url("").toString().trimEnd('/'), "client.access", "s3cret"))
    }

    @After fun stop() = server.shutdown()

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)

    @Test
    fun `every request carries the Access service token headers`() = runTest {
        server.enqueue(json(fixture("health_sources.json")))
        api.health()
        val req = server.takeRequest()
        assertEquals("client.access", req.getHeader("CF-Access-Client-Id"))
        assertEquals("s3cret", req.getHeader("CF-Access-Client-Secret"))
        assertNull("no bearer token anymore", req.getHeader("Authorization"))
    }

    @Test
    fun `food page reads the same ranking endpoint as web and can request a rerank`() = runTest {
        server.enqueue(json("""{"status":"ready","recommendation":{"service_date":"2026-09-28","headline":"Lunch pick","top_outlet":"V1","ranked_outlets":[{"outlet":"V1","rank":1,"match_score":90,"verdict":"Good match.","highlights":[{"dish":"Noodles","why":"Your preference"}]}],"tip":"Go early.","generated_at":1},"ranking_job":{"status":"idle"}}"""))
        server.enqueue(json("{}"))
        val ranking = api.foodRecommendation("2026-09-28").first
        assertEquals("V1", ranking.recommendation?.topOutlet)
        assertEquals("Your preference", ranking.recommendation?.rankedOutlets?.first()?.highlights?.first()?.why)
        assertEquals("/v1/food/recommendation?date=2026-09-28", server.takeRequest().path)
        api.rankFood("2026-09-28")
        val rerank = server.takeRequest()
        assertEquals("/v1/ai/rank-food", rerank.path)
        assertEquals("POST", rerank.method)
        assertTrue(rerank.body.readUtf8().contains("2026-09-28"))
    }

    @Test
    fun `source refresh posts to the polling endpoint and reads deferred results`() = runTest {
        server.enqueue(json("""{"receipts":[{"source_id":"schedule","outcome":"ok"},{"source_id":"status","outcome":"skipped","error":"retry later"}],"deferred":["menu"]}"""))
        val result = api.refreshSources()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/poll", request.path)
        assertEquals(listOf("ok", "skipped"), result.receipts.map { it.outcome })
        assertEquals(listOf("menu"), result.deferred)
    }

    @Test
    fun `refusals map to errors the UI can act on`() = runTest {
        suspend fun failure(response: MockResponse): Throwable {
            server.enqueue(response)
            return runCatching { api.health() }.exceptionOrNull()!!
        }
        assertTrue(failure(json("{\"error\":\"unauthorized\"}", 401)) is RelayError.Unauthorized)
        assertTrue(failure(MockResponse().setResponseCode(403)) is RelayError.Unauthorized)
        assertTrue("the Access login redirect is not followed", failure(MockResponse().setResponseCode(302).setHeader("location", "https://team.cloudflareaccess.com/login")) is RelayError.Unauthorized)
        assertTrue("a login page with a 200 is still a refusal", failure(MockResponse().setHeader("content-type", "text/html").setBody("<html>Sign in</html>")) is RelayError.Unauthorized)
        assertTrue(failure(json("{\"error\":\"access not configured\"}", 503)) is RelayError.NotConfigured)
        assertTrue(failure(json("{}", 500)) is RelayError.Http)
        assertTrue(failure(json("{\"not\":\"the contract\"}")) is RelayError.BadResponse)
    }

    @Test
    fun `offline is its own error`() = runTest {
        server.shutdown()
        assertTrue(runCatching { api.health() }.exceptionOrNull() is RelayError.Offline)
    }

    @Test
    fun `the repository caches the last good answer and keeps it through a failure`() = runTest {
        var up = true
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                !up -> MockResponse().setResponseCode(502)
                request.path!!.startsWith("/v1/dashboard") -> json(fixture("dashboard.json"))
                request.path!!.startsWith("/v1/recommendations") -> json(fixture("recommendations.json"))
                request.path!!.startsWith("/v1/calendar") -> json(fixture("calendar.json"))
                else -> MockResponse().setResponseCode(404)
            }
        }
        val dir = tmp.newFolder("cache")
        val repo = DashboardRepository(dir, apiFor = { api }, clock = { 42L })
        assertTrue(repo.refresh().isSuccess)
        assertEquals(42L, repo.snapshot.value.fetchedAt)

        up = false
        assertTrue(repo.refresh().isFailure)
        val kept = repo.snapshot.value
        assertNotNull("data survives a failed refresh", kept.bundle)
        assertTrue(kept.error is RelayError.Http)

        val cold = DashboardRepository(dir, apiFor = { null })
        assertNotNull("a cold start reads the cache with no network", cold.snapshot.value.bundle)
        assertNotNull(cold.snapshot.value.calendar)
        assertEquals(42L, cold.snapshot.value.fetchedAt)
    }

    @Test
    fun `a pasted address is normalised to an https origin`() {
        assertEquals("https://dash.example.com", Credentials.normaliseUrl(" dash.example.com/ "))
        assertEquals("https://dash.example.com", Credentials.normaliseUrl("https://dash.example.com/v1/dashboard"))
        assertEquals("https://x.workers.dev:8443", Credentials.normaliseUrl("https://x.workers.dev:8443"))
        assertNull("plain http would send the token in clear text", Credentials.normaliseUrl("http://dash.example.com"))
        assertNull(Credentials.normaliseUrl(""))
        assertNull("release builds never allow the emulator host", Credentials.normaliseUrl("http://10.0.2.2:8792"))
        assertEquals("http://10.0.2.2:8792", Credentials.normaliseUrl("http://10.0.2.2:8792", allowEmulatorHost = true))
        assertEquals("http://127.0.0.1:8792", Credentials.normaliseUrl("http://127.0.0.1:8792", allowEmulatorHost = true))
        assertNull("debug still refuses any other plain-http host", Credentials.normaliseUrl("http://evil.test", allowEmulatorHost = true))
    }
}
