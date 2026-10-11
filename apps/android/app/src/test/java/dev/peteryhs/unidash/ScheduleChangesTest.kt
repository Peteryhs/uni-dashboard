package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CalendarChangeAlert
import dev.peteryhs.unidash.data.CalendarDay
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.notify.NotificationPlanner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduleChangesTest {
    private val now = 1_790_683_200_000L
    private val event = CalendarEvent("class", "class", category = "class", title = "ECE 198 lecture", course = "ECE 198",
        location = "RCH 101", startsAt = now + 3_600_000, endsAt = now + 7_200_000)
    private val change = CalendarChangeAlert("room-change", event.id, "unusual_room", "Different room", "RCH 101; usually E7 2409",
        "ECE 198", event.startsAt, event.endsAt, now, "RCH 101", "E7 2409", state = CardState.Live)
    private fun calendar(events: List<CalendarEvent> = listOf(event), alerts: List<CalendarChangeAlert> = listOf(change)) =
        Calendar(generatedAt = now, start = "2026-09-29", end = "2026-10-13", days = listOf(CalendarDay("2026-09-29", events)), alerts = alerts)

    @Test fun `schedule changes notify once by stable id`() {
        assertEquals(listOf(change), NotificationPlanner.changesToShow(calendar(), emptySet(), now))
        assertTrue(NotificationPlanner.changesToShow(calendar(), setOf(change.id), now).isEmpty())
        assertTrue(NotificationPlanner.changesToShow(calendar(alerts = listOf(change.copy(state = CardState.Stale))), emptySet(), now).isEmpty())
        assertTrue(NotificationPlanner.changesToShow(calendar(alerts = listOf(change.copy(endsAt = now - 1))), emptySet(), now).isEmpty())
        assertTrue(NotificationPlanner.changesToShow(calendar().copy(generatedAt = now - NotificationPlanner.MAX_CALENDAR_AGE_MS - 1), emptySet(), now).isEmpty())
    }

    @Test fun `room change notice starts 24 hours before a Friday class`() {
        val fridayAt = now + 73 * 3_600_000L // Tuesday 8 a.m. to Friday 9 a.m.
        val fridayEvent = event.copy(startsAt = fridayAt, endsAt = fridayAt + 3_600_000L)
        val fridayChange = change.copy(startsAt = fridayAt, endsAt = fridayAt + 3_600_000L)
        val source = calendar(events = listOf(fridayEvent), alerts = listOf(fridayChange))

        assertTrue(NotificationPlanner.changesToShow(source, emptySet(), now).isEmpty())
        val beforeWindow = fridayAt - NotificationPlanner.SCHEDULE_CHANGE_NOTICE_MS - 1
        assertTrue(NotificationPlanner.changesToShow(source.copy(generatedAt = beforeWindow), emptySet(), beforeWindow).isEmpty())
        val inWindow = fridayAt - NotificationPlanner.SCHEDULE_CHANGE_NOTICE_MS
        assertEquals(listOf(fridayChange), NotificationPlanner.changesToShow(source.copy(generatedAt = inWindow), emptySet(), inWindow))
    }

    @Test fun `deadline moved far away still uses its earlier old time for the notice`() {
        val previousAt = now + 12 * 3_600_000L
        val movedTo = now + 7 * 24 * 3_600_000L
        val deadlineEvent = event.copy(category = "deadline", startsAt = movedTo, endsAt = movedTo)
        val deadlineChange = change.copy(
            kind = "deadline",
            startsAt = movedTo,
            endsAt = movedTo + 3_600_000L,
            previousAt = previousAt,
            currentAt = movedTo,
        )

        assertEquals(
            listOf(deadlineChange),
            NotificationPlanner.changesToShow(calendar(events = listOf(deadlineEvent), alerts = listOf(deadlineChange)), emptySet(), now),
        )
    }

    @Test fun `schedule change notice expires at the updated event time`() {
        assertEquals(event.startsAt, NotificationPlanner.changeExpiresAt(change))
        val movedTime = change.copy(kind = "time", previousAt = now + 30 * 60_000, currentAt = now + 90 * 60_000)
        assertEquals(movedTime.currentAt, NotificationPlanner.changeExpiresAt(movedTime))
        val movedDeadline = movedTime.copy(kind = "deadline")
        assertEquals(movedDeadline.currentAt, NotificationPlanner.changeExpiresAt(movedDeadline))
        val allDay = change.copy(allDay = true)
        assertEquals(allDay.endsAt, NotificationPlanner.changeExpiresAt(allDay))
        assertTrue(NotificationPlanner.changesToShow(
            calendar().copy(generatedAt = event.startsAt, alerts = listOf(change)), emptySet(), event.startsAt,
        ).isEmpty())
    }

    @Test fun `change evidence fingerprint ignores freshness state but detects changed content`() {
        assertEquals(NotificationPlanner.changeSignature(change),
            NotificationPlanner.changeSignature(change.copy(state = CardState.Ageing, observedAt = now + 1)))
        assertTrue(NotificationPlanner.changeSignature(change) != NotificationPlanner.changeSignature(change.copy(location = "E7 2409")))
    }

    @Test fun `campus alert evidence ignores routine poll timestamps but detects visible changes`() {
        val alert = dev.peteryhs.unidash.data.Alert(count = 1, summary = "Library access is limited", key = "outage-1",
            checkedAt = now, notices = listOf(dev.peteryhs.unidash.data.Notice("warning", "Library outage", "Use the west entrance")))
        assertEquals(NotificationPlanner.alertSignature(alert), NotificationPlanner.alertSignature(alert.copy(checkedAt = now + 60_000)))
        assertTrue(NotificationPlanner.alertSignature(alert) != NotificationPlanner.alertSignature(alert.copy(summary = "Library access restored")))
    }

    @Test fun `schedule change selection can expose every currently relevant item for digest reconciliation`() {
        val changes = (0..4).map { index -> change.copy(
            id = "change-$index", eventId = "event-$index", startsAt = now + (index + 1) * 60_000L,
            endsAt = now + 3_600_000L + index * 60_000L,
        ) }
        val source = calendar(alerts = changes)
        assertEquals(3, NotificationPlanner.changesToShow(source, emptySet(), now).size)
        assertEquals(changes.map { it.id }, NotificationPlanner.changesToShow(source, emptySet(), now, Int.MAX_VALUE).map { it.id })
    }

    @Test fun `separate deadline edits from one poll keep their own notifications`() {
        val movedTo = now + 7 * 24 * 3_600_000L
        val firstEvent = event.copy(id = "deadline-one", occurrenceId = "deadline-one", category = "deadline", startsAt = movedTo, endsAt = movedTo)
        val secondEvent = event.copy(id = "deadline-two", occurrenceId = "deadline-two", category = "deadline", startsAt = movedTo, endsAt = movedTo)
        val firstChange = change.copy(id = "deadline-change-one", eventId = firstEvent.id, kind = "deadline", startsAt = movedTo, endsAt = movedTo + 3_600_000L, previousAt = now + 12 * 3_600_000L, currentAt = movedTo)
        val secondChange = change.copy(id = "deadline-change-two", eventId = secondEvent.id, kind = "deadline", startsAt = movedTo, endsAt = movedTo + 3_600_000L, previousAt = now + 18 * 3_600_000L, currentAt = movedTo)

        assertEquals(
            listOf(firstChange, secondChange),
            NotificationPlanner.changesToShow(
                calendar(events = listOf(firstEvent, secondEvent), alerts = listOf(firstChange, secondChange)),
                emptySet(),
                now,
            ),
        )
    }

    @Test fun `room warning is carried into the class reminder`() {
        val reminder = NotificationPlanner.plan(calendar(), now).single()
        assertTrue(reminder.text.endsWith(" · E7 2409 → RCH 101 ?"))
        assertEquals("the new room appears once, inside the arrow", 1, Regex("RCH 101").findAll(reminder.text).count())
        val confirmed = NotificationPlanner.plan(calendar(alerts = listOf(change.copy(kind = "room", confidence = "confirmed"))), now).single()
        assertTrue(confirmed.text.endsWith(" · E7 2409 → RCH 101"))
    }

    @Test fun `cancellation leaves a change alert without a class alarm`() {
        val cancelled = calendar(events = emptyList(), alerts = listOf(change.copy(kind = "cancelled")))
        assertTrue(NotificationPlanner.plan(cancelled, now).isEmpty())
        assertEquals("cancelled", NotificationPlanner.changesToShow(cancelled, emptySet(), now).single().kind)
    }

    @Test fun `stale events never create precise class reminders`() {
        assertTrue(NotificationPlanner.plan(calendar(events = listOf(event.copy(state = CardState.Dead))), now).isEmpty())
    }

    @Test fun `dated replacement work cancels attendance while unclear work keeps a warning`() {
        assertTrue(NotificationPlanner.plan(calendar(events = listOf(event.copy(attendance = "replaced"))), now).isEmpty())
        val check = calendar(events = listOf(event.copy(attendance = "check_instructions")), alerts = listOf(change.copy(kind = "tutorial_work")))
        assertTrue(NotificationPlanner.plan(check, now).single().text.contains("Online work · check instructions"))
    }

    @Test fun `an alert exposes the before and after that the UI draws as blocks`() {
        val detail = change.copy(previousAt = now, currentAt = now + 3_600_000).detail
        assertTrue(detail.roomMoved)
        assertEquals("E7 2409", detail.previousLocation)
        assertEquals("RCH 101", detail.location)
        assertEquals(now + 3_600_000, detail.currentAt)
        assertTrue(!detail.confirmed)
        assertTrue(!change.copy(previousLocation = "RCH 101").detail.roomMoved)
    }

    @Test fun `a whole series moving coalesces while separate unusual sessions remain separate`() {
        val second = change.copy(id = "second", eventId = "second", startsAt = now + 86_400_000, endsAt = now + 90_000_000)
        val unusual = calendar(alerts = listOf(change, second))
        assertEquals(2, NotificationPlanner.changesToShow(unusual, emptySet(), now).size)
        val moved = calendar(alerts = listOf(change.copy(kind = "room"), second.copy(kind = "room")))
        assertEquals(1, NotificationPlanner.changesToShow(moved, emptySet(), now).size)
        val unknownCourse = calendar(alerts = listOf(
            change.copy(kind = "room", course = null), second.copy(kind = "room", course = null),
        ))
        assertEquals("without a known course, two room changes are not proven to be one series",
            2, NotificationPlanner.changesToShow(unknownCourse, emptySet(), now).size)
    }
}
