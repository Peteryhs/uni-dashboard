package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.CAMPUS_ZONE
import dev.peteryhs.unidash.ui.Format
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZonedDateTime

class FormatTest {
    private fun at(h: Int, m: Int = 0, day: Int = 27) = ZonedDateTime.of(2026, 9, day, h, m, 0, 0, CAMPUS_ZONE).toInstant().toEpochMilli()

    @Test
    fun `close events count down, far ones name the day`() {
        val now = at(16, 30)
        assertEquals("in 25 min", Format.whenLabel(at(16, 55), now))
        assertEquals("in 2 h 30 min", Format.whenLabel(at(19), now))
        assertEquals("tomorrow at 9:30 a.m.", Format.whenLabel(at(9, 30, day = 28), now))
        assertEquals("Tue at 8:30 a.m.", Format.whenLabel(at(8, 30, day = 29), now))
        assertEquals("30 min ago", Format.whenLabel(at(16), now))
    }

    @Test
    fun `campus time is used whatever the phone's zone`() {
        // 13:30 UTC is 9:30 in Toronto during daylight time.
        assertEquals("9:30 a.m.", Format.time(ZonedDateTime.parse("2026-09-28T13:30:00Z").toInstant().toEpochMilli()))
    }
}
