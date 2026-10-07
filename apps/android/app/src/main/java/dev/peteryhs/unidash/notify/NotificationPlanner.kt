package dev.peteryhs.unidash.notify

import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CalendarChangeAlert
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class Channel(val id: String, val label: String, val description: String) {
    Classes("classes", "Class reminders", "Before each class, exam and office hour"),
    Deadlines("deadlines", "Deadlines", "A day and two hours before work is due"),
    Alerts("alerts", "Campus alerts", "Campus and IT outages as they are reported"),
    Changes("schedule_changes", "Schedule changes", "Changed times, unusual rooms and tutorial work"),
    Account("account", "Connection", "When the app can no longer reach your dashboard"),
    Persistent("persistent", "Uni Dashboard", "The dashboard status notification"),
}

/** One notification to fire at a set time. `key` is stable across syncs, so it can be replaced or cancelled. */
data class Reminder(val key: String, val fireAt: Long, val channel: Channel, val title: String, val text: String)

/**
 * Pure planning, no Android types, so it is unit tested directly. The sync calls this with the
 * freshest calendar and reconciles the result against what is already scheduled.
 */
object NotificationPlanner {
    const val CLASS_LEAD_MS = 10 * 60_000L
    val DEADLINE_LEADS_MS = listOf(24 * 3_600_000L, 2 * 3_600_000L)
    /** AlarmManager holds these until they fire; two days is enough, the next sync extends it. */
    const val HORIZON_MS = 48 * 3_600_000L
    const val SCHEDULE_CHANGE_NOTICE_MS = 24 * 3_600_000L
    const val DEADLINE_CHANGE_NOTICE_MS = 72 * 3_600_000L
    const val TUTORIAL_WORK_NOTICE_MS = 72 * 3_600_000L

    private val timeFormat = DateTimeFormatter.ofPattern("h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)
    private val dayTimeFormat = DateTimeFormatter.ofPattern("EEE h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)

    fun plan(calendar: Calendar?, now: Long): List<Reminder> {
        if (calendar == null) return emptyList()
        val events = calendar.days.flatMap { it.events }.distinctBy { it.occurrenceId }
        val roomAlerts = calendar.alerts.filter { it.kind in setOf("room", "unusual_room") }.associateBy { it.eventId }
        val tutorialAlerts = calendar.alerts.filter { it.kind == "tutorial_work" }.associateBy { it.eventId }
        return events.filter { it.attendance != "replaced" && it.state in setOf(CardState.Live, CardState.Ageing) }.flatMap { event ->
            remindersFor(event).map { reminder ->
                // Terse on purpose: a lock screen shows one line. "E7 2409 → RCH 101", "?" when unconfirmed.
                val roomAlert = roomAlerts[event.id]
                val room = roomAlert?.let { " · ${it.previousLocation} → ${it.location}${if (it.confidence == "confirmed") "" else " ?"}" }.orEmpty()
                val tutorial = tutorialAlerts[event.id]?.let { " · Online work · check instructions" }.orEmpty()
                // The arrow already names the new room, so drop the plain one.
                val base = if (roomAlert != null) reminder.text.removeSuffix(" · ${event.location}") else reminder.text
                reminder.copy(text = base + room + tutorial)
            }
        }
            .filter { it.fireAt > now && it.fireAt <= now + HORIZON_MS }
            .sortedBy { it.fireAt }
    }

    /** Only upcoming, fresh evidence triggers a push. The stable IDs survive ordinary syncs. */
    fun changesToShow(calendar: Calendar?, shown: Set<String>, now: Long): List<CalendarChangeAlert> {
        val events = calendar?.days.orEmpty().flatMap { it.events }.associateBy { it.id }
        return calendar?.alerts.orEmpty()
            .filter { change ->
                if (change.id in shown || change.endsAt < now || change.state !in setOf(CardState.Live, CardState.Ageing)) return@filter false
                val event = events[change.eventId]
                val deadlineChange = change.kind == "deadline" ||
                    (change.previousAt != null && event?.category in setOf("deadline", "exam"))
                val noticeWindow = when {
                    deadlineChange -> DEADLINE_CHANGE_NOTICE_MS
                    change.kind == "tutorial_work" -> TUTORIAL_WORK_NOTICE_MS
                    else -> SCHEDULE_CHANGE_NOTICE_MS
                }
                val affectedAt = if (deadlineChange || change.kind == "time") {
                    minOf(change.startsAt, change.previousAt ?: Long.MAX_VALUE, change.currentAt ?: Long.MAX_VALUE)
                } else change.startsAt
                // HORIZON_MS applies to scheduled reminders. A changed deadline may have moved
                // farther away, so its notice window follows the earlier of the old and new time.
                affectedAt <= now + noticeWindow
            }
            .sortedBy { it.startsAt }
            .distinctBy {
                if (it.kind == "room") "${it.course}:${it.kind}:${it.previousLocation}:${it.location}"
                else it.id
            }
            .take(3)
    }

    private fun remindersFor(e: CalendarEvent): List<Reminder> = when {
        e.allDay -> emptyList()
        e.category in setOf("class", "exam", "office_hours") -> listOf(
            Reminder(
                key = "start:${e.occurrenceId}",
                fireAt = e.startsAt - CLASS_LEAD_MS,
                channel = Channel.Classes,
                title = e.title,
                text = listOf("${timeFormat.format(Instant.ofEpochMilli(e.startsAt))}", e.location.ifBlank { null })
                    .filterNotNull().joinToString(" · "),
            ),
        )
        e.category == "deadline" && e.phase != "opens" -> DEADLINE_LEADS_MS.map { lead ->
            Reminder(
                key = "due:${lead / 3_600_000}h:${e.occurrenceId}",
                fireAt = e.startsAt - lead,
                channel = Channel.Deadlines,
                title = e.title,
                text = "Due ${dayTimeFormat.format(Instant.ofEpochMilli(e.startsAt))}" + (e.course?.let { " · $it" } ?: ""),
            )
        }
        else -> emptyList()
    }

    /** An outage worth a notification: present, not dismissed, and not the one already shown. */
    fun alertToShow(alert: Alert?, lastShownKey: String?): Alert? {
        if (alert == null || alert.count == 0 || alert.dismissed || alert.key.isBlank()) return null
        return alert.takeIf { it.key != lastShownKey }
    }
}
