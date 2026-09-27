package dev.peteryhs.unidash.notify

import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class Channel(val id: String, val label: String, val description: String) {
    Classes("classes", "Class reminders", "Before each class, exam and office hour"),
    Deadlines("deadlines", "Deadlines", "A day and two hours before work is due"),
    Alerts("alerts", "Campus alerts", "Campus and IT outages as they are reported"),
    Account("account", "Connection", "When the app can no longer reach your dashboard"),
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

    private val timeFormat = DateTimeFormatter.ofPattern("h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)
    private val dayTimeFormat = DateTimeFormatter.ofPattern("EEE h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)

    fun plan(calendar: Calendar?, now: Long): List<Reminder> {
        if (calendar == null) return emptyList()
        val events = calendar.days.flatMap { it.events }.distinctBy { it.occurrenceId }
        return events.flatMap { remindersFor(it) }
            .filter { it.fireAt > now && it.fireAt <= now + HORIZON_MS }
            .sortedBy { it.fireAt }
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
