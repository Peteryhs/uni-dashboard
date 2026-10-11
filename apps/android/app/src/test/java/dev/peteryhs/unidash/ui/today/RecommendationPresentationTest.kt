package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.Recommendation
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class RecommendationPresentationTest {
    @Test fun `older caveats become warnings and retain the listed date`() {
        val rec = Recommendation(id = "old", kind = "task", title = "Quiz", body =
            "Listed for 2026-10-16; no exact time was supplied. Check the course instructions. Coverage has not been provided; check the course instructions.")
        assertEquals("Listed for 2026-10-16.", rec.presentation().body)
        assertEquals(listOf(RecommendationWarning.TimeUnknown, RecommendationWarning.CoverageUnknown), rec.presentation().warnings)
    }

    @Test fun `structured warnings and date parse while unknown codes are ignored`() {
        val rec = Json.decodeFromString<Recommendation>("""{"id":"new","kind":"task","title":"Quiz","scheduled_date":"2026-10-16","warnings":["time_unknown","coverage_unknown","future_warning"]}""")
        assertEquals("2026-10-16", rec.scheduledDate)
        assertEquals(listOf(RecommendationWarning.TimeUnknown, RecommendationWarning.CoverageUnknown), rec.presentation().warnings)
    }

    @Test fun `overdue warning preserves known coverage`() {
        val rec = Recommendation(id = "old", kind = "task", title = "Quiz", body =
            "The listed due time has passed; submission status is unknown. Coverage: Loops.")
        assertEquals("The listed due time has passed. Coverage: Loops.", rec.presentation().body)
        assertEquals(listOf(RecommendationWarning.SubmissionUnknown), rec.presentation().warnings)
    }

    @Test fun `non-task source text and complete tasks are unchanged`() {
        val text = "Coverage has not been provided; check the course instructions."
        val rec = Recommendation(id = "learning", kind = "learning", title = "Reading", body = text)
        assertEquals(text, rec.presentation().body)
        assertEquals(emptyList<RecommendationWarning>(), rec.presentation().warnings)
        assertEquals(emptyList<RecommendationWarning>(), Recommendation(id = "quiz", kind = "task", title = "Quiz", body = "Due today at 11:59 pm. Coverage: Loops.").presentation().warnings)
    }
}
