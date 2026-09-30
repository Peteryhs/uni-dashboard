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
    }

    @Test fun `room warning is carried into the class reminder`() {
        val reminder = NotificationPlanner.plan(calendar(), now).single()
        assertTrue(reminder.text.contains("RCH 101"))
        assertTrue(reminder.text.contains("Different room (usually E7 2409)"))
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
        assertTrue(NotificationPlanner.plan(check, now).single().text.contains("Check tutorial instructions before attending"))
    }

    @Test fun `a whole series moving coalesces while separate unusual sessions remain separate`() {
        val second = change.copy(id = "second", eventId = "second", startsAt = now + 86_400_000, endsAt = now + 90_000_000)
        val unusual = calendar(alerts = listOf(change, second))
        assertEquals(2, NotificationPlanner.changesToShow(unusual, emptySet(), now).size)
        val moved = calendar(alerts = listOf(change.copy(kind = "room"), second.copy(kind = "room")))
        assertEquals(1, NotificationPlanner.changesToShow(moved, emptySet(), now).size)
    }
}
