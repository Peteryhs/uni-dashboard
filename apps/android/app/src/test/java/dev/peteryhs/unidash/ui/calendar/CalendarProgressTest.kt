package dev.peteryhs.unidash.ui.calendar

import dev.peteryhs.unidash.data.CalendarEvent
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarProgressTest {
    private fun at(time: String, date: String = "2026-10-16") = OffsetDateTime.parse("${date}T${time}:00-04:00").toInstant().toEpochMilli()
    private fun event(start: String, end: String = start, allDay: Boolean = false) = CalendarEvent(
        id = start, occurrenceId = start, category = "class", title = "Lecture", startsAt = at(start), endsAt = at(end), allDay = allDay,
    )

    @Test fun `Now advances past finished entries without passing an ongoing class`() {
        val events = listOf(event("00:00", allDay = true), event("09:00", "10:00"), event("11:00", "12:00"), event("14:00", "15:00"))
        assertEquals(1, calendarNowIndex(events, at("08:00")))
        assertEquals(2, calendarNowIndex(events, at("10:00")))
        assertEquals(2, calendarNowIndex(events, at("11:30")))
        assertEquals(3, calendarNowIndex(events, at("12:00")))
        assertEquals(4, calendarNowIndex(events, at("15:00")))
        assertEquals(0, calendarNowIndex(emptyList(), at("15:00")))
    }

    @Test fun `date-only entries stay current until campus midnight`() {
        val dateOnly = event("00:00", allDay = true)
        assertFalse(dateOnly.hasPassed(at("23:59")))
        assertTrue(dateOnly.hasPassed(at("00:00", "2026-10-17")))
        assertFalse(dateOnly.hasPassed(OffsetDateTime.parse("2026-10-17T03:59:00Z").toInstant().toEpochMilli()))
        assertFalse(dateOnly.copy(endsAt = at("00:00", "2026-10-18")).hasPassed(at("23:59", "2026-10-17")))
    }

    @Test fun `muting starts at the end time`() {
        val lecture = event("09:00", "10:00")
        assertFalse(lecture.hasPassed(at("09:30")))
        assertTrue(lecture.hasPassed(at("10:00")))
    }
}
