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
    val progressUpdateAt: Long?,
    val progress: Int,
    val expiresAt: Long,
    val nextText: String?,
    val expandedText: String,
)

object LiveClassPlanner {
    const val LEAD_MS = NotificationPlanner.CLASS_LEAD_MS
    /** The system chronometer handles the visible countdown; this only refreshes elapsed progress. */
    const val PROGRESS_REFRESH_MS = 5 * 60_000L
    private val categories = setOf("class", "exam", "office_hours")
    private val freshStates = setOf(CardState.Live, CardState.Ageing)

    private fun usable(event: CalendarEvent): Boolean =
        event.category in categories && !event.allDay && event.endsAt > event.startsAt &&
            event.attendance !in setOf("replaced", "cancelled", "canceled") && event.state in freshStates &&
            event.title.isNotBlank()

    private fun agendaUsable(event: CalendarEvent): Boolean = usable(event) ||
        (event.category == "deadline" && event.phase != "opens" &&
            event.endsAt >= event.startsAt && event.attendance !in setOf("replaced", "cancelled", "canceled") &&
            event.state in freshStates && event.title.isNotBlank())

    private fun agendaAt(event: CalendarEvent): Long =
        if (event.category == "deadline" && event.allDay && event.endsAt > event.startsAt) event.endsAt else event.startsAt

    /** Only actual future commitments; the pinned activity is already shown above this list. */
    fun upcoming(calendar: Calendar?, now: Long, trackedOccurrenceId: String): List<CalendarEvent> {
        if (!NotificationPlanner.calendarIsFresh(calendar, now)) return emptyList()
        return events(calendar).filter { it.occurrenceId != trackedOccurrenceId && agendaUsable(it) && agendaAt(it) > now }
            .sortedWith(compareBy<CalendarEvent> { agendaAt(it) }.thenBy { it.occurrenceId }).take(3)
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
        val displayTitle = event.course?.takeIf { it.isNotBlank() && !event.title.contains(it, ignoreCase = true) }
            ?.let { "$it · ${event.title}" } ?: event.title
        val next = upcoming(calendar, now, event.occurrenceId)
        val zone = runCatching { ZoneId.of(calendar.timezone) }.getOrDefault(CAMPUS_ZONE)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val datePattern = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.CANADA)
        val timePattern = DateTimeFormatter.ofPattern("h:mm a", Locale.CANADA)
        fun dateLabel(at: java.time.ZonedDateTime): String = when (at.toLocalDate()) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            else -> at.format(datePattern)
        }
        fun scheduledTime(epoch: Long): String {
            val at = Instant.ofEpochMilli(epoch).atZone(zone)
            return "${dateLabel(at)} ${at.format(timePattern)}"
        }
        val startAt = Instant.ofEpochMilli(event.startsAt).atZone(zone)
        val endAt = Instant.ofEpochMilli(event.endsAt).atZone(zone)
        val endLabel = if (startAt.toLocalDate() == endAt.toLocalDate()) endAt.format(timePattern) else scheduledTime(event.endsAt)
        val bounds = "Starts ${scheduledTime(event.startsAt)} · Ends $endLabel"
        val activeBounds = if (startAt.toLocalDate() == endAt.toLocalDate()) {
            "${dateLabel(startAt)} ${startAt.format(DateTimeFormatter.ofPattern("h:mm", Locale.CANADA))}–${endAt.format(timePattern)}"
        } else "${scheduledTime(event.startsAt)}–${scheduledTime(event.endsAt)}"
        val text = listOf(if (active) activeBounds else "Starts ${scheduledTime(event.startsAt)}",
            event.location.takeIf { it.isNotBlank() }).filterNotNull().joinToString(" · ")
        val rows = next.map { activity ->
            val due = activity.category == "deadline"
            val at = Instant.ofEpochMilli(if (activity.allDay) activity.startsAt else agendaAt(activity)).atZone(zone)
            val time = if (activity.allDay) dateLabel(at) else "${dateLabel(at)} ${at.format(timePattern)}"
            val label = if (due) "Due $time" else "Next $time"
            val course = activity.course?.takeIf { it.isNotBlank() && !activity.title.contains(it, ignoreCase = true) }
            listOf(label, activity.title, course, activity.location.takeIf { it.isNotBlank() })
                .filterNotNull().joinToString(" · ")
        }
        val nextText = rows.firstOrNull()
        val expanded = listOfNotNull(bounds, event.location.takeIf { it.isNotBlank() })
            .plus(rows)
            .joinToString("\n")
        val dateBoundary = if (next.isEmpty()) Long.MAX_VALUE else
            today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val nextAgendaAt = next.firstOrNull()?.let(::agendaAt) ?: Long.MAX_VALUE
        val progressCandidate = now + PROGRESS_REFRESH_MS
        // A progress tick is inexact. Keep real event, expiry, and agenda transitions exact.
        val progressUpdateAt = progressCandidate.takeIf {
            active && it < boundary && it < expiresAt && it < nextAgendaAt && it < dateBoundary
        }
        return LiveClassState(event, event.occurrenceId, displayTitle, text,
            event.startsAt, event.endsAt, if (active) "active" else "upcoming", boundary,
            minOf(boundary, expiresAt, nextAgendaAt, dateBoundary, progressUpdateAt ?: Long.MAX_VALUE),
            progressUpdateAt, progress, expiresAt, nextText, expanded)
    }
}
