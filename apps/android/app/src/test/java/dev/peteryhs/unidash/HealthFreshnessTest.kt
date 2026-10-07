package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.LastRun
import dev.peteryhs.unidash.data.SourceHealth
import dev.peteryhs.unidash.data.conditionAt
import dev.peteryhs.unidash.data.summaryAt
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthFreshnessTest {
    @Test fun `source age continues to advance after the server health response`() {
        val successAt = 10_000L
        val source = SourceHealth(
            id = "schedule",
            cadenceMs = 1_000,
            ready = true,
            lastRun = LastRun(at = successAt, outcome = "ok"),
            lastSuccessAt = successAt,
        )

        assertEquals("healthy", source.conditionAt(successAt + 3_000))
        assertEquals("stale", source.conditionAt(successAt + 3_001))
        assertEquals("stale", source.conditionAt(successAt + 6_000))
        assertEquals("dead", source.conditionAt(successAt + 6_001))
    }

    @Test fun `source-specific stale and dead thresholds override its polling cadence`() {
        val successAt = 10_000L
        val weather = SourceHealth(
            id = "weather",
            cadenceMs = 30 * 60_000L,
            ready = true,
            lastRun = LastRun(at = successAt, outcome = "ok"),
            lastSuccessAt = successAt,
            staleAfterMs = 60 * 60_000L,
            deadAfterMs = 180 * 60_000L,
        )

        assertEquals("stale", weather.conditionAt(successAt + 60 * 60_000L + 1))
        assertEquals("dead", weather.conditionAt(successAt + 180 * 60_000L + 1))
    }

    @Test fun `custom freshness thresholds replace the cadence defaults in either direction`() {
        val successAt = 10_000L
        val slow = SourceHealth(
            id = "slow-feed",
            cadenceMs = 1_000,
            ready = true,
            lastRun = LastRun(at = successAt, outcome = "ok"),
            lastSuccessAt = successAt,
            staleAfterMs = 8_000,
            deadAfterMs = 12_000,
        )

        assertEquals("healthy", slow.conditionAt(successAt + 7_000))
        assertEquals("stale", slow.conditionAt(successAt + 9_000))
        assertEquals("dead", slow.conditionAt(successAt + 13_000))
    }

    @Test fun `unchecked is distinct from a monitored source that is blocked`() {
        val optional = SourceHealth(id = "optional", optional = true, monitored = false)
        val blocked = SourceHealth(id = "required", ready = false, blockedBy = "secret")

        val uncheckedSummary = Health(now = 1, sources = listOf(optional)).summaryAt(1)
        val blockedSummary = Health(now = 1, sources = listOf(blocked)).summaryAt(1)

        assertEquals("unknown", uncheckedSummary.condition)
        assertEquals(0, uncheckedSummary.total)
        assertEquals("attention", blockedSummary.condition)
        assertEquals(1, blockedSummary.issues)
    }
}
