package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.Recommendation

internal enum class RecommendationWarning(val code: String, val label: String, val detail: String) {
    TimeUnknown("time_unknown", "Time unknown", "Exact time not supplied. Check course instructions."),
    CoverageUnknown("coverage_unknown", "Coverage unknown", "Assessment coverage not supplied. Check course instructions."),
    SubmissionUnknown("submission_unknown", "Submission unknown", "The listed deadline has passed. Check whether you submitted this."),
    CompletionUnknown("completion_unknown", "Completion unknown", "The listed assessment time has passed. Check whether you completed this."),
}

internal data class RecommendationPresentation(val body: String, val warnings: List<RecommendationWarning>)

private val legacyWarnings = listOf(
    Triple(RecommendationWarning.TimeUnknown, Regex("; no exact time was supplied\\. Check the course instructions\\."), "."),
    Triple(RecommendationWarning.CoverageUnknown, Regex("\\s*Coverage has not been provided; check the course instructions\\."), ""),
    Triple(RecommendationWarning.SubmissionUnknown, Regex("; submission status is unknown\\."), "."),
    Triple(RecommendationWarning.CompletionUnknown, Regex("; completion status is unknown\\."), "."),
)

/** Keep saved recommendations concise while an older relay or offline cache is still in use. */
internal fun Recommendation.presentation(): RecommendationPresentation {
    val notices = warnings.mapNotNull { code -> RecommendationWarning.entries.find { it.code == code } }.toMutableSet()
    var text = body
    if (kind == "task") {
        legacyWarnings.forEach { (warning, pattern, replacement) ->
            text = pattern.replace(text) { notices.add(warning); replacement }
        }
    }
    return RecommendationPresentation(text.trim(), notices.toList())
}
