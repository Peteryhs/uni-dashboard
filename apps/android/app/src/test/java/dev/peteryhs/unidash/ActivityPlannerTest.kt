package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CalendarDay
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.notify.LiveClassPlanner
import dev.peteryhs.unidash.notify.NotificationPlanner
import org.junit.Test
import java.time.Instant

/** These exercise production planners without Android services or wall-clock sleeps. */
class ActivityPlannerTest {
    private val start = 1_800_000_000_000L
    private val event = CalendarEvent(id = "portal:math", occurrenceId = "math-occurrence", category = "class",
        title = "MATH 115", location = "MC 4021", startsAt = start, endsAt = start + 3_600_000)
    private fun calendar(now: Long, vararg events: CalendarEvent) = Calendar(generatedAt = now,
        start = "2027-01-01", end = "2027-01-03", days = listOf(CalendarDay("2027-01-01", events.toList())))

    @Test fun `late alarms are resolved against the latest evidence and never arrive after class starts`() {
        val fire = start - NotificationPlanner.CLASS_LEAD_MS
        val data = calendar(fire, event)
        val reminder = NotificationPlanner.plan(data, fire - 1).single()
        check(reminder.occurrenceId == event.occurrenceId && reminder.eventId == event.id)
        check(reminder.expiresAt == event.endsAt && reminder.notificationKey == "next-class")
        check(NotificationPlanner.resolveReminder(data, reminder.key, fire, fire + 60_000) != null)
        check(NotificationPlanner.resolveReminder(data, reminder.key, fire, start) == null)
        check(NotificationPlanner.resolveReminder(data, reminder.key, fire, event.endsAt) == null)
        check(NotificationPlanner.resolveReminder(data, reminder.key, fire, fire - 1) == null)
    }

    @Test fun `removed replaced and stale events cancel both pending and posted reminders`() {
        val fire = start - NotificationPlanner.CLASS_LEAD_MS
        val reminder = NotificationPlanner.plan(calendar(fire, event), fire - 1).single()
        for (data in listOf(calendar(fire), calendar(fire, event.copy(attendance = "cancelled")),
            calendar(fire, event.copy(attendance = "replaced")), calendar(fire, event.copy(state = CardState.Stale)))) {
            check(NotificationPlanner.resolveReminder(data, reminder.key, fire, fire) == null)
            check(NotificationPlanner.reconcilePosted(data, listOf(reminder), fire).isEmpty())
        }
    }

    @Test fun `time moves remove old reminders while room moves refresh their content`() {
        val fire = start - NotificationPlanner.CLASS_LEAD_MS
        val reminder = NotificationPlanner.plan(calendar(fire, event), fire - 1).single()
        val moved = calendar(fire, event.copy(startsAt = start + 60_000, endsAt = event.endsAt + 60_000))
        check(NotificationPlanner.resolveReminder(moved, reminder.key, fire, fire) == null)
        check(NotificationPlanner.reconcilePosted(moved, listOf(reminder), fire).isEmpty())
        val room = calendar(fire, event.copy(location = "RCH 101"))
        check(NotificationPlanner.resolveReminder(room, reminder.key, fire, fire)?.text?.contains("RCH 101") == true)
        check(NotificationPlanner.reconcilePosted(room, listOf(reminder), fire).single().text.contains("RCH 101"))
    }

    @Test fun `posted class reminders expire and multiple classes share one slot`() {
        val fire = start - NotificationPlanner.CLASS_LEAD_MS
        val second = event.copy(id = "portal:second", occurrenceId = "second", startsAt = start + 60_000,
            endsAt = event.endsAt + 60_000)
        val data = calendar(fire, event, second)
        val posted = NotificationPlanner.plan(data, fire - 1)
        check(posted.size == 2)
        val retained = NotificationPlanner.reconcilePosted(data, posted, fire + 60_000)
        check(retained.size == 1 && retained.single().occurrenceId == "second")
        check(NotificationPlanner.reconcilePosted(data, retained, second.endsAt).isEmpty())
    }

    @Test fun `deadline lead reminders replace each other and expire when due`() {
        val due = event.copy(category = "deadline", endsAt = start)
        val before = start - 30 * 3_600_000
        val reminders = NotificationPlanner.plan(calendar(before, due), before)
        check(reminders.size == 2 && reminders.map { it.notificationKey }.distinct().size == 1)
        val data = calendar(start - 2 * 3_600_000, due)
        val keep = NotificationPlanner.reconcilePosted(data, reminders, start - 2 * 3_600_000)
        check(keep.single().key.startsWith("due:2h:"))
        check(NotificationPlanner.reconcilePosted(calendar(start, due), keep, start).isEmpty())
        check(NotificationPlanner.resolveReminder(calendar(reminders.first().fireAt, due), reminders.first().key, reminders.first().fireAt,
            reminders.first().fireAt + NotificationPlanner.ALARM_LATE_TOLERANCE_MS + 1) == null)
    }

    @Test fun `live activity crosses onset start progress and exact expiry boundaries`() {
        val onset = start - LiveClassPlanner.LEAD_MS
        val data = calendar(onset, event)
        check(LiveClassPlanner.select(data, onset - 1) == null)
        check(LiveClassPlanner.nextBoundary(data, onset - 1) == onset)
        val upcoming = LiveClassPlanner.select(data, onset)!!
        check(upcoming.phase == "upcoming" && upcoming.countdownAt == start && upcoming.progress == 0)
        check(upcoming.nextUpdateAt == start && upcoming.expiresAt == event.endsAt)
        val active = LiveClassPlanner.select(data, start)!!
        check(active.phase == "active" && active.countdownAt == event.endsAt && active.progress == 0)
        check(LiveClassPlanner.nextBoundary(data, start) == event.endsAt)
        check(LiveClassPlanner.select(data, start + 1_800_000)!!.progress == 50)
        check(LiveClassPlanner.select(data, event.endsAt) == null)
        check(LiveClassPlanner.nextBoundary(data, event.endsAt) == null)
    }

    @Test fun `tracking rejects all day missing end replaced stale far future and ended events`() {
        val invalid = listOf(event.copy(allDay = true), event.copy(endsAt = start),
            event.copy(attendance = "replaced"), event.copy(attendance = "canceled"),
            event.copy(state = CardState.Dead), event.copy(category = "deadline"), event.copy(title = ""))
        invalid.forEach { check(!LiveClassPlanner.canTrack(it, start)) }
        check(!LiveClassPlanner.canTrack(event, start - LiveClassPlanner.LEAD_MS - 1))
        check(!LiveClassPlanner.canTrack(event, event.endsAt))
        check(LiveClassPlanner.plan(calendar(start), event.occurrenceId, start) == null)
        check(LiveClassPlanner.canTrack(event.copy(category = "office_hours", state = CardState.Ageing), start))
    }

    @Test fun `fresh schedule changes update active room and timing and cancellation stops tracking`() {
        val current = start + 60_000
        val room = event.copy(location = "RCH 101")
        check(LiveClassPlanner.plan(calendar(current, room), event.occurrenceId, current)!!.text.contains("RCH 101"))
        val moved = room.copy(startsAt = current + 5 * 60_000, endsAt = current + 65 * 60_000)
        val updated = LiveClassPlanner.plan(calendar(current, moved), event.occurrenceId, current)!!
        check(updated.phase == "upcoming" && updated.countdownAt == moved.startsAt)
        check(LiveClassPlanner.plan(calendar(current, moved.copy(startsAt = current + 20 * 60_000)),
            event.occurrenceId, current) == null)
        check(LiveClassPlanner.plan(calendar(current, event.copy(attendance = "cancelled")), event.occurrenceId, current) == null)
    }

    @Test fun `automatic tracking prioritizes current exam and honors dismissal without resurrection`() {
        val exam = event.copy(id = "exam", occurrenceId = "exam", category = "exam")
        val upcoming = event.copy(id = "next", occurrenceId = "next", startsAt = start + 5 * 60_000)
        val data = calendar(start, upcoming, event, exam)
        check(LiveClassPlanner.select(data, start)!!.occurrenceId == "exam")
        check(LiveClassPlanner.select(data, start, setOf("exam"))!!.occurrenceId == event.occurrenceId)
        check(LiveClassPlanner.select(data, start, setOf("exam", event.occurrenceId, "next")) == null)
        check(LiveClassPlanner.nextBoundary(data, start, setOf("exam", event.occurrenceId, "next")) == null)
        check(LiveClassPlanner.select(data, start + 60_000, setOf("exam"))!!.occurrenceId != "exam")
    }

    @Test fun `old cached live flags and implausibly future generated times cannot send notifications`() {
        val stale = calendar(start - NotificationPlanner.MAX_CALENDAR_AGE_MS - 1, event)
        check(LiveClassPlanner.select(stale, start) == null)
        check(LiveClassPlanner.nextBoundary(stale, start) == null)
        check(NotificationPlanner.plan(stale, start - LiveClassPlanner.LEAD_MS - 1).isNotEmpty())
        val fire = start - LiveClassPlanner.LEAD_MS
        val staleAtAlarm = calendar(fire - NotificationPlanner.MAX_CALENDAR_AGE_MS - 1, event)
        check(NotificationPlanner.resolveReminder(staleAtAlarm, "start:${event.occurrenceId}", fire, fire) == null)
        val posted = NotificationPlanner.plan(calendar(fire, event), fire - 1)
        check(NotificationPlanner.reconcilePosted(staleAtAlarm, posted, fire).isEmpty())
        val farFuture = calendar(start + NotificationPlanner.CLOCK_SKEW_MS + 1, event)
        check(LiveClassPlanner.select(farFuture, start) == null)
        check(NotificationPlanner.plan(farFuture, start).isEmpty())
        check(LiveClassPlanner.select(calendar(start + NotificationPlanner.CLOCK_SKEW_MS, event), start) != null)
    }

    @Test fun `activity timeout includes cache evidence expiry before a long event ends`() {
        val generated = start - NotificationPlanner.MAX_CALENDAR_AGE_MS + 60_000
        val data = calendar(generated, event)
        val expected = generated + NotificationPlanner.MAX_CALENDAR_AGE_MS + 1
        check(LiveClassPlanner.select(data, start)!!.expiresAt == expected)
        check(LiveClassPlanner.nextBoundary(data, start) == expected)
        check(LiveClassPlanner.select(data, expected) == null)
    }

    @Test fun `next up is chronological unique and limited to three future commitments`() {
        fun future(id: String, minutes: Long) = event.copy(id = id, occurrenceId = id, title = id,
            startsAt = start + minutes * 60_000, endsAt = start + (minutes + 60) * 60_000)
        val first = future("first", 60)
        val second = future("second", 90).copy(category = "deadline", endsAt = start + 90 * 60_000)
        val third = future("third", 120).copy(category = "exam")
        val fourth = future("fourth", 180)
        val data = calendar(start, fourth, third, second, first, first, event,
            future("past", -1), future("cancelled", 1).copy(attendance = "cancelled"),
            future("stale", 2).copy(state = CardState.Stale), future("all-day", 3).copy(allDay = true),
            future("opens", 4).copy(category = "deadline", phase = "opens"),
            future("invalid", 5).copy(endsAt = start), future("blank", 6).copy(title = ""))
        check(LiveClassPlanner.upcoming(data, start, event.occurrenceId).map { it.occurrenceId } ==
            listOf("first", "second", "third"))
        val expanded = LiveClassPlanner.select(data, start)!!.expandedText
        check(expanded.startsWith("In progress · MC 4021\n\nNext up\n"))
        check(expanded.contains("Due ") && !expanded.contains("fourth"))
    }

    @Test fun `next up uses the calendar timezone and labels tomorrow across local midnight`() {
        val now = Instant.parse("2026-10-09T03:55:00Z").toEpochMilli() // Oct 8, 11:55 PM in Toronto.
        val current = event.copy(startsAt = now - 5 * 60_000, endsAt = now + 55 * 60_000)
        val next = event.copy(id = "next", occurrenceId = "next", title = "Office hours",
            category = "office_hours", location = "RCH 101", startsAt = now + 10 * 60_000, endsAt = now + 40 * 60_000)
        val data = calendar(now, current, next)
        val expanded = LiveClassPlanner.plan(data, current.occurrenceId, now)!!.expandedText
        // AM spelling varies across Android/JDK locale-data versions (AM versus a.m.).
        check(expanded.contains("Tomorrow 12:05 ") && expanded.endsWith(" · Office hours · RCH 101"))
        val midnight = Instant.parse("2026-10-09T04:00:00Z").toEpochMilli()
        check(LiveClassPlanner.plan(data, current.occurrenceId, now)!!.nextUpdateAt == midnight)
        check(LiveClassPlanner.nextBoundary(data, now) == midnight)
        check(LiveClassPlanner.plan(data, current.occurrenceId, midnight)!!.expandedText.contains("Today 12:05 "))
        check(LiveClassPlanner.plan(data.copy(timezone = "UTC"), current.occurrenceId, now)!!.expandedText
            .contains("Today 4:05 "))
        check(LiveClassPlanner.plan(data.copy(timezone = "invalid"), current.occurrenceId, now)!!.expandedText
            .contains("Tomorrow 12:05 "))
    }

    @Test fun `next up repairs schedule edits and removes canceled items without filling phantom rows`() {
        val next = event.copy(id = "next", occurrenceId = "next", title = "A long descriptive activity title",
            startsAt = start + 2 * 3_600_000, endsAt = start + 3 * 3_600_000, location = "")
        val state = LiveClassPlanner.select(calendar(start, event, next), start)!!
        check(state.expandedText.lines().last().endsWith(next.title))
        check(state.expandedText.lines().count { it.contains(next.title) } == 1)
        val moved = next.copy(title = "Changed title", location = "RCH 101", startsAt = next.startsAt + 60_000)
        val repaired = LiveClassPlanner.select(calendar(start, event, moved), start)!!.expandedText
        check(repaired.contains("Changed title · RCH 101") && !repaired.contains(next.title))
        check(LiveClassPlanner.select(calendar(start, event, next.copy(attendance = "cancelled")), start)!!
            .expandedText.endsWith("No more scheduled activities"))
        check(LiveClassPlanner.upcoming(calendar(start - NotificationPlanner.MAX_CALENDAR_AGE_MS - 1, next),
            start, event.occurrenceId).isEmpty())
    }

    @Test fun `a deadline leaving next up schedules a transition before the active class ends`() {
        val due = event.copy(id = "due", occurrenceId = "due", category = "deadline", title = "Assignment",
            startsAt = start + 60_000, endsAt = start + 60_000)
        val data = calendar(start, event, due)
        check(LiveClassPlanner.select(data, start)!!.nextUpdateAt == due.startsAt)
        check(LiveClassPlanner.nextBoundary(data, start) == due.startsAt)
        check(LiveClassPlanner.select(data, due.startsAt)!!.expandedText.endsWith("No more scheduled activities"))
        check(LiveClassPlanner.nextBoundary(data, start, setOf(event.occurrenceId)) == null)
    }
}
