package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.DueItem
import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendation
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecommendationDeduplicationTest {
    @Test fun `next class duplicates only with matching course kind title and time`() {
        val next = NextCommitment(
            title = "ECE 150 LEC 001",
            kind = "class",
            startsAt = 1_000_000,
            endsAt = 1_300_000,
        )
        val recommendation = Recommendation(
            id = "class",
            kind = "class",
            title = "Next today: ECE 150 LEC 001",
            course = "ECE 150",
            startsAt = 1_000_000,
            endsAt = 1_300_000,
        )

        assertTrue(recommendation.represents(next))
        assertFalse(recommendation.copy(course = "ECE 105").represents(next))
        assertFalse(recommendation.copy(kind = "office_hours").represents(next))
        assertFalse(recommendation.copy(startsAt = 1_000_001).represents(next))
        assertFalse(recommendation.copy(course = null).represents(next))
    }

    @Test fun `same-title next commitment without course evidence stays visible`() {
        val next = NextCommitment(title = "Review", kind = "event", startsAt = 10_000)
        val recommendation = Recommendation(
            id = "event", kind = "class", title = "Review", course = "ECE 150", startsAt = 10_000,
        )

        assertFalse(recommendation.represents(next))
    }

    @Test fun `task recommendation can match an exam or deadline hero by due time`() {
        val recommendation = Recommendation(
            id = "task",
            kind = "task",
            title = "Confirm submission: ECE 105 Lab report 2",
            course = "ECE 105",
            dueAt = 1_000_000,
        )

        for (kind in listOf("exam", "deadline")) {
            val next = NextCommitment(
                title = "ECE 105 - Lab report 2 due",
                kind = kind,
                startsAt = 1_000_000,
            )
            assertTrue("$kind hero with the same course, title, and due time", recommendation.represents(next))
            assertFalse("a different due time remains distinct", recommendation.copy(dueAt = 1_000_001).represents(next))
        }
        assertFalse("classes never collapse into task recommendations", recommendation.represents(
            NextCommitment(title = "ECE 105 Lab report 2", kind = "class", startsAt = 1_000_000),
        ))
    }

    @Test fun `due task duplicate requires course kind exact time and title`() {
        val item = DueItem(
            title = "ECE 105 - Lab report 2 - Due",
            startsAt = 5_000_000,
            kind = "deadline",
            course = "ECE 105",
        )
        val recommendation = Recommendation(
            id = "task",
            kind = "task",
            title = "Confirm submission: ECE 105 - Lab report 2",
            course = "ECE 105",
            dueAt = 5_000_000,
        )

        assertTrue(recommendation.represents(item))
        assertFalse(recommendation.copy(course = "ECE 150").represents(item))
        assertFalse(recommendation.copy(dueAt = 5_000_001).represents(item))
        assertFalse(recommendation.copy(kind = "learning").represents(item))
        assertFalse(recommendation.copy(course = null).represents(item))
        assertFalse(recommendation.represents(item.copy(kind = null)))
    }

    @Test fun `date-only due task needs matching campus date and course`() {
        val item = DueItem(
            title = "ECE 105 - Lab report",
            startsAt = java.time.LocalDate.parse("2026-10-16").atStartOfDay(dev.peteryhs.unidash.data.CAMPUS_ZONE).toInstant().toEpochMilli(),
            kind = "deadline",
            course = "ECE 105",
            allDay = true,
        )
        val recommendation = Recommendation(
            id = "task", kind = "task", title = "ECE 105 - Lab report", course = "ECE 105",
            scheduledDate = "2026-10-16",
        )

        assertTrue(recommendation.represents(item))
        assertFalse(recommendation.copy(scheduledDate = "2026-10-17").represents(item))
        assertFalse(recommendation.represents(item.copy(allDay = false)))
    }
}
