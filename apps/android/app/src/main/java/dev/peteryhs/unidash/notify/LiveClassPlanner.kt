package dev.peteryhs.unidash.notify

import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One current activity. Countdown/progress are derived from event boundaries, never poll time. */
data class LiveClassState(
    val event: CalendarEvent,
    val occurrenceId: String,
    val title: String,
    val text: String,
    val startsAt: Long,
    val endsAt: Long,
    val phase: String,
    val countdownAt: Long,
    val nextUpdateAt: Long,
    val progress: Int,
    val expiresAt: Long,
    val expandedText: String,
)

object LiveClassPlanner {
    const val LEAD_MS = NotificationPlanner.CLASS_LEAD_MS
    private val categories = setOf("class", "exam", "office_hours")
    private val freshStates = setOf(CardState.Live, CardState.Ageing)

    private fun usable(event: CalendarEvent): Boolean =
        event.category in categories && !event.allDay && event.endsAt > event.startsAt &&
            event.attendance !in setOf("replaced", "cancelled", "canceled") && event.state in freshStates &&
            event.title.isNotBlank()

    private fun agendaUsable(event: CalendarEvent): Boolean = usable(event) ||
        (event.category == "deadline" && event.phase != "opens" && !event.allDay &&
            event.endsAt >= event.startsAt && event.attendance !in setOf("replaced", "cancelled", "canceled") &&
            event.state in freshStates && event.title.isNotBlank())

    /** Only actual future commitments; the pinned activity is already shown above this list. */
    fun upcoming(calendar: Calendar?, now: Long, trackedOccurrenceId: String): List<CalendarEvent> {
        if (!NotificationPlanner.calendarIsFresh(calendar, now)) return emptyList()
        return events(calendar).filter { it.occurrenceId != trackedOccurrenceId && agendaUsable(it) && it.startsAt > now }
            .sortedWith(compareBy<CalendarEvent> { it.startsAt }.thenBy { it.occurrenceId }).take(3)
    }

    fun canTrack(event: CalendarEvent, now: Long): Boolean =
        usable(event) && now >= event.startsAt - LEAD_MS && now < event.endsAt

    /** Current calendar evidence controls identity, time and room; missing/stale events stop. */
    fun plan(calendar: Calendar?, occurrenceId: String, now: Long): LiveClassState? {
        if (!NotificationPlanner.calendarIsFresh(calendar, now)) return null
        return events(calendar).firstOrNull { it.occurrenceId == occurrenceId }
            ?.takeIf { canTrack(it, now) }?.let { state(it, now, calendar!!) }
    }

    /** Active commitments win over upcoming ones; exams win ties, followed by stable time/ID. */
    fun select(calendar: Calendar?, now: Long, dismissed: Set<String> = emptySet()): LiveClassState? {
        if (!NotificationPlanner.calendarIsFresh(calendar, now)) return null
        return events(calendar).filter { it.occurrenceId !in dismissed && canTrack(it, now) }
            .sortedWith(compareBy<CalendarEvent> { if (now >= it.startsAt) 0 else 1 }
                .thenBy { if (it.category == "exam") 0 else 1 }
                .thenBy { it.startsAt }.thenBy { it.occurrenceId })
            .firstOrNull()?.let { state(it, now, calendar!!) }
    }

    /** Wake at eligibility onset, start or end, including when no activity is currently visible. */
    fun nextBoundary(calendar: Calendar?, now: Long, dismissed: Set<String> = emptySet()): Long? {
        if (!NotificationPlanner.calendarIsFresh(calendar, now)) return null
        val tracking = events(calendar).filter { usable(it) && it.endsAt > now && it.occurrenceId !in dismissed }
            .flatMap { listOf(it.startsAt - LEAD_MS, it.startsAt, it.endsAt,
                calendar!!.generatedAt + NotificationPlanner.MAX_CALENDAR_AGE_MS + 1) }
        // A due deadline leaves "Next up" even if the current class has not ended yet.
        val agenda = listOfNotNull(select(calendar, now, dismissed)?.nextUpdateAt)
        return (tracking + agenda).filter { it > now }.minOrNull()
    }

    private fun events(calendar: Calendar?) = calendar?.days.orEmpty().flatMap { it.events }.distinctBy { it.occurrenceId }

    private fun state(event: CalendarEvent, now: Long, calendar: Calendar): LiveClassState {
        val active = now >= event.startsAt
        val boundary = if (active) event.endsAt else event.startsAt
        val expiresAt = minOf(event.endsAt, calendar.generatedAt + NotificationPlanner.MAX_CALENDAR_AGE_MS + 1)
        val progress = if (active) (((now - event.startsAt).toDouble() / (event.endsAt - event.startsAt)) * 100)
            .toInt().coerceIn(0, 100) else 0
        val text = listOf(if (active) "In progress" else "Starts soon", event.location.takeIf { it.isNotBlank() })
            .filterNotNull().joinToString(" · ")
        val next = upcoming(calendar, now, event.occurrenceId)
        val zone = runCatching { ZoneId.of(calendar.timezone) }.getOrDefault(CAMPUS_ZONE)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val rows = next.map { activity ->
            val at = Instant.ofEpochMilli(activity.startsAt).atZone(zone)
            val date = when (at.toLocalDate()) {
                today -> "Today"
                today.plusDays(1) -> "Tomorrow"
                else -> at.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.CANADA))
            }
            val time = at.format(DateTimeFormatter.ofPattern("h:mm a", Locale.CANADA))
            val due = if (activity.category == "deadline") "Due " else ""
            listOf("$due$date $time", activity.title, activity.location.takeIf { it.isNotBlank() })
                .filterNotNull().joinToString(" · ")
        }
        val expanded = if (rows.isEmpty()) "$text\n\nNo more scheduled activities"
            else "$text\n\nNext up\n${rows.joinToString("\n")}"
        val dateBoundary = if (next.isEmpty()) Long.MAX_VALUE else
            today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        return LiveClassState(event, event.occurrenceId, event.title, text,
            event.startsAt, event.endsAt, if (active) "active" else "upcoming", boundary,
            minOf(boundary, expiresAt, next.firstOrNull()?.startsAt ?: Long.MAX_VALUE, dateBoundary), progress, expiresAt, expanded)
    }
}
