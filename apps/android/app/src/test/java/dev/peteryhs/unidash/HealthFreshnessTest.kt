package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.LastRun
import dev.peteryhs.unidash.data.SourceHealth
import dev.peteryhs.unidash.data.conditionAt
import dev.peteryhs.unidash.data.summaryAt
import dev.peteryhs.unidash.data.freshnessAt
import dev.peteryhs.unidash.data.recoveryTextAt
import dev.peteryhs.unidash.data.SourceRecovery
import dev.peteryhs.unidash.data.SourceHealthJob
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthFreshnessTest {
    @Test fun `expired manual check does not promise an automatic retry`() {
        val source = SourceHealth(id = "schedule", ready = true,
            job = SourceHealthJob(leaseExpiresAt = 10_000),
            recovery = SourceRecovery(state = "refreshing", action = "wait", automatic = false))
        assertEquals("The check ended or was interrupted. Use Refresh sources to check again.", source.recoveryTextAt(10_001))
    }

    @Test fun `interrupted job failure cannot leave older receipt looking healthy`() {
        val source = SourceHealth(id = "schedule", ready = true, cadenceMs = 1_000,
            lastSuccessAt = 10_000, lastRun = LastRun(at = 10_000, outcome = "ok"),
            job = SourceHealthJob(lastOutcome = "failed", lastFinishedAt = 10_100, failures = 1))
        assertEquals("failing", source.conditionAt(10_200))
        assertEquals("live", source.freshnessAt(10_200))
        assertEquals("attention", Health(now = 10_200, sources = listOf(source)).summaryAt(10_200).condition)
    }

    @Test fun `failed attempts preserve saved data age and recovery deadlines advance`() {
        val source = SourceHealth(id = "schedule", ready = true, cadenceMs = 1_000,
            lastSuccessAt = 10_000, lastRun = LastRun(at = 20_000, outcome = "failed"),
            recovery = SourceRecovery(state = "backoff", action = "wait", nextAttemptAt = 25_000, automatic = true))
        assertEquals("failing", source.conditionAt(20_000))
        assertEquals("dead", source.freshnessAt(20_000))
        assertEquals("Retry is due and waiting for the next polling tick.", source.recoveryTextAt(25_001))
    }

    @Test fun `successful empty data ages normally and manual polling offers a refresh`() {
        val source = SourceHealth(id = "schedule", ready = true, cadenceMs = 1_000,
            lastRun = LastRun(at = 10_000, outcome = "empty"),
            recovery = SourceRecovery(state = "manual", action = "refresh"))
        assertEquals("live", source.freshnessAt(11_000))
        assertEquals("ageing", source.freshnessAt(11_001))
        assertEquals("stale", source.freshnessAt(13_001))
        assertEquals("Automatic polling is off. Use Refresh sources to check again.", source.recoveryTextAt(13_001))
    }

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
