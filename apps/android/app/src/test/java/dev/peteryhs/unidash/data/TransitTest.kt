package dev.peteryhs.unidash.data

import org.junit.Assert.*
import org.junit.Test

class TransitTest {
    private val now = 1_800_000_000_000L
    private val departure = TransitDeparture("bus:trip:date:1", "13", "Campus", now + 600_000, now + 1_200_000, now + 780_000, now + 1_440_000, now)
    @Test fun predictionsExpireLocallyAndOfflineUsesTheSchedule() {
        assertEquals(now + 780_000, departure.departureAt(now))
        assertEquals(now + 600_000, departure.departureAt(now + 90_001))
        assertEquals(now + 600_000, departure.departureAt(now, offline = true))
        assertFalse(departure.isLive(now - 1))
        assertEquals(now + 1_200_000, departure.arrivalAt(now, offline = true))
    }
    @Test fun oldRecommendationCachesStillDecodeAndNewTransitCachesRoundTrip() {
        val old = ContractJson.decodeFromString<Recommendations>("""{"generated_at":1800000000000,"items":[]}""")
        assertNull(old.transit)
        val view = TransitView(now, "ready", commutes = listOf(TransitCommute(id = "c1", name = "To campus", origin = "bus:1", destination = "bus:2")), journeys = listOf(TransitJourney("c1", listOf(departure), scheduleValid = true)))
        val cached = old.copy(transit = view)
        assertEquals(cached, ContractJson.decodeFromString<Recommendations>(ContractJson.encodeToString(cached)))
    }
    @Test fun missingArrivalPredictionRemainsScheduled() {
        val partial = departure.copy(predictedArrival = null)
        assertTrue(partial.isLive(now))
        assertEquals(partial.scheduledArrival, partial.arrivalAt(now))
    }
}
