package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EventProgressTest {
    private val start = 1_800_000_000_000L
    private val end = start + 3_600_000L
    private val event = NextCommitment(title = "ECE 105", startsAt = start, endsAt = end)

    @Test
    fun `elapsed fraction follows the clock without a refresh`() {
        assertEquals(0f, event.eventProgress(start)!!.fraction, 0f)
        assertEquals(0.25f, event.eventProgress(start + 900_000L)!!.fraction, 0.0001f)
        assertEquals(0.5f, event.eventProgress(start + 1_800_000L)!!.fraction, 0.0001f)
        assertEquals(start, event.eventProgress(start)!!.startsAt)
        assertEquals(end, event.eventProgress(start)!!.endsAt)
    }

    @Test
    fun `future and finished events have no timeline`() {
        assertNull(event.eventProgress(start - 1))
        assertNull(event.eventProgress(end))
        assertNull(event.eventProgress(end + 1))
    }

    @Test
    fun `missing or invalid windows never produce a fraction`() {
        assertNull(event.copy(startsAt = null).eventProgress(start))
        assertNull(event.copy(endsAt = null).eventProgress(start))
        assertNull(event.copy(endsAt = start).eventProgress(start))
        assertNull(event.copy(endsAt = start - 1).eventProgress(start))
        assertNull(event.copy(allDay = true).eventProgress(start))
    }

    @Test
    fun `active recommendations share the timeline but schedule changes do not`() {
        val rec = Recommendation(id = "study", kind = "focus", title = "Study window", startsAt = start, endsAt = end)
        assertEquals(event.eventProgress(start + 900_000L), rec.eventProgress(start + 900_000L))
        assertNull(rec.copy(kind = "change").eventProgress(start + 900_000L))
        assertNull(rec.copy(endsAt = start).eventProgress(start))
        assertNull(rec.copy(endsAt = null).eventProgress(start))
        assertNull(rec.eventProgress(end))
    }
}
