package dev.peteryhs.unidash.ui.calendar

import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant

internal fun campusDay(at: Long) = Instant.ofEpochMilli(at).atZone(CAMPUS_ZONE).toLocalDate()

/** Date-only entries remain current throughout their final day, including zero-length dates. */
internal fun CalendarEvent.hasPassed(now: Long): Boolean = if (allDay) {
    campusDay(now) > campusDay(maxOf(startsAt, endsAt - 1))
} else maxOf(startsAt, endsAt) <= now

internal fun calendarNowIndex(events: List<CalendarEvent>, now: Long): Int {
    val today = campusDay(now)
    val index = events.indexOfFirst { campusDay(it.startsAt) > today || (!it.allDay && !it.hasPassed(now)) }
    return if (index < 0) events.size else index
}
