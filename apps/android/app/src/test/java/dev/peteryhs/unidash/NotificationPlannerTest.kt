package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.ContractJson
import dev.peteryhs.unidash.notify.Channel
import dev.peteryhs.unidash.notify.NotificationPlanner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPlannerTest {
    private val calendar = ContractJson.decodeFromString<Calendar>(fixture("calendar.json"))
    private val events = calendar.days.flatMap { it.events }
    private val firstClass = events.filter { it.category == "class" && !it.allDay }.minBy { it.startsAt }

    @Test
    fun `a class gets one reminder ten minutes before it starts`() {
        val now = firstClass.startsAt - 3_600_000
        val plan = NotificationPlanner.plan(calendar, now)
        val r = plan.single { it.key == "start:${firstClass.occurrenceId}" }
        assertEquals(firstClass.startsAt - NotificationPlanner.CLASS_LEAD_MS, r.fireAt)
        assertEquals(Channel.Classes, r.channel)
        assertTrue("the text carries the time and room", r.text.contains(firstClass.location))
    }

    @Test
    fun `nothing is scheduled in the past or beyond the horizon`() {
        val now = firstClass.startsAt - 5 * 60_000 // inside the lead: that reminder has passed
        val plan = NotificationPlanner.plan(calendar, now)
        assertTrue(plan.none { it.key == "start:${firstClass.occurrenceId}" })
        assertTrue(plan.all { it.fireAt > now && it.fireAt <= now + NotificationPlanner.HORIZON_MS })
        assertEquals("sorted by fire time", plan.sortedBy { it.fireAt }, plan)
    }

    @Test
    fun `deadlines get a day-before and two-hours-before reminder, opening dates get none`() {
        val deadline = events.first { it.category == "deadline" }
        val plan = NotificationPlanner.plan(calendar, deadline.startsAt - 30 * 3_600_000L)
        val keys = plan.filter { it.channel == Channel.Deadlines && it.key.endsWith(deadline.occurrenceId) }.map { it.key }.toSet()
        assertEquals(setOf("due:24h:${deadline.occurrenceId}", "due:2h:${deadline.occurrenceId}"), keys)
        events.filter { it.category == "opens" }.forEach { o -> assertTrue(plan.none { it.key.endsWith(o.occurrenceId) }) }
    }

    @Test
    fun `keys are stable across syncs so reminders are replaced, not duplicated`() {
        val now = firstClass.startsAt - 3_600_000
        assertEquals(NotificationPlanner.plan(calendar, now).map { it.key }, NotificationPlanner.plan(calendar, now + 1).map { it.key })
        assertEquals(NotificationPlanner.plan(calendar, now).size, NotificationPlanner.plan(calendar, now).map { it.key }.toSet().size)
    }

    @Test
    fun `an alert notifies once per key, never when dismissed or clear`() {
        val alert = Alert(count = 1, summary = "Wi-Fi down", key = "k1")
        assertNotNull(NotificationPlanner.alertToShow(alert, lastShownKey = null))
        assertNull(NotificationPlanner.alertToShow(alert, lastShownKey = "k1"))
        assertNotNull("a changed outage is new", NotificationPlanner.alertToShow(alert.copy(key = "k2"), "k1"))
        assertNull(NotificationPlanner.alertToShow(alert.copy(dismissed = true), null))
        assertNull(NotificationPlanner.alertToShow(alert.copy(count = 0), null))
        assertNull(NotificationPlanner.alertToShow(null, null))
    }
}
