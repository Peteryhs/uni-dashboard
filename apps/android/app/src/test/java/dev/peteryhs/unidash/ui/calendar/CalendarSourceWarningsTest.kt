package dev.peteryhs.unidash.ui.calendar

import dev.peteryhs.unidash.data.CalendarSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarSourceWarningsTest {
    @Test
    fun `unconfigured optional Google Calendar is suppressed when Portal is configured`() {
        val sources = listOf(
            CalendarSource(id = "uw-portal-ics", status = "ok"),
            CalendarSource(id = "google-calendar-ics", status = "unconfigured", optional = true),
            CalendarSource(id = "uw-learn-ics", status = "ok"),
        )
        val warned = filterWarnedCalendarSources(sources)
        assertTrue(warned.isEmpty())
    }

    @Test
    fun `when neither schedule is configured, only one class schedule warning is returned`() {
        val sources = listOf(
            CalendarSource(id = "uw-portal-ics", status = "unconfigured"),
            CalendarSource(id = "google-calendar-ics", status = "unconfigured", optional = true),
            CalendarSource(id = "uw-learn-ics", status = "ok"),
        )
        val warned = filterWarnedCalendarSources(sources)
        assertEquals(1, warned.size)
        assertEquals("uw-portal-ics", warned.single().id)
        assertEquals("Class schedule", CALENDAR_SOURCE_NAMES[warned.single().id])
    }

    @Test
    fun `when Google Calendar is configured, unconfigured Portal is suppressed`() {
        val sources = listOf(
            CalendarSource(id = "uw-portal-ics", status = "unconfigured"),
            CalendarSource(id = "google-calendar-ics", status = "ok", optional = true),
            CalendarSource(id = "uw-learn-ics", status = "ok"),
        )
        val warned = filterWarnedCalendarSources(sources)
        assertTrue(warned.isEmpty())
    }

    @Test
    fun `failed sync is surfaced with human-friendly label`() {
        val sources = listOf(
            CalendarSource(id = "google-calendar-ics", status = "failed", optional = true),
            CalendarSource(id = "uw-learn-ics", status = "failed"),
        )
        val warned = filterWarnedCalendarSources(sources)
        assertEquals(2, warned.size)
        assertEquals("Google Calendar", CALENDAR_SOURCE_NAMES[warned[0].id])
        assertEquals("LEARN calendar", CALENDAR_SOURCE_NAMES[warned[1].id])
    }

    @Test
    fun `optional unconfigured source is suppressed`() {
        val sources = listOf(
            CalendarSource(id = "user-office-hours", status = "unconfigured", optional = true),
            CalendarSource(id = "uw-portal-ics", status = "ok"),
        )
        val warned = filterWarnedCalendarSources(sources)
        assertTrue(warned.isEmpty())
    }
}
