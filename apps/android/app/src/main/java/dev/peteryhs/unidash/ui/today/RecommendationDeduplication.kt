package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.DueItem
import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendation
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant

/**
 * Only hide a card when the saved recommendation has enough independent evidence to identify the
 * same scheduled item. Missing course, kind, or time data is ambiguous, so it stays visible.
 */
internal fun Recommendation.represents(next: NextCommitment): Boolean {
    val sameKind = when {
        kind == "task" -> next.kind in setOf("exam", "deadline")
        else -> kind == next.kind && kind in setOf("class", "office_hours")
    }
    val recommendationCourse = course ?: return false
    val commitmentStart = dueAt ?: startsAt ?: return false
    val nextStart = next.startsAt ?: return false
    val recommendationTitle = if (kind == "task") title.removeTaskPrefix() else title.removeSchedulePrefix()
    val commitmentTitle = if (kind == "task") next.title.removeTaskPrefix() else next.title.removeSchedulePrefix()

    return sameKind &&
        normalizedTitle(recommendationTitle) == normalizedTitle(commitmentTitle) &&
        commitmentStart == nextStart &&
        (endsAt == null || next.endsAt == null || endsAt == next.endsAt) &&
        next.identifiesCourse(recommendationCourse)
}

internal fun Recommendation.represents(item: DueItem): Boolean {
    if (kind != "task" || item.kind !in setOf("deadline", "exam")) return false
    val recommendationCourse = course ?: return false
    val itemCourse = item.course ?: return false
    val recommendationTime = dueAt ?: startsAt
    val itemTime = item.dueAt ?: item.startsAt
    val sameTime = when {
        recommendationTime != null -> recommendationTime == itemTime
        item.allDay && scheduledDate != null ->
            Instant.ofEpochMilli(item.startsAt).atZone(CAMPUS_ZONE).toLocalDate().toString() == scheduledDate
        else -> false
    }

    return normalizedTitle(title.removeTaskPrefix()) == normalizedTitle(item.title.removeTaskPrefix()) &&
        normalizedTitle(recommendationCourse) == normalizedTitle(itemCourse) &&
        sameTime
}

private fun NextCommitment.identifiesCourse(course: String): Boolean {
    val wanted = normalizedTitle(course)
    if (wanted.isBlank()) return false
    val visibleText = normalizedTitle("$title $subtitle")
    return Regex("(^| )${Regex.escape(wanted)}($| )").containsMatchIn(visibleText)
}

private fun String.removeSchedulePrefix(): String =
    replace(Regex("^(?:now|starting soon|next today):\\s*", RegexOption.IGNORE_CASE), "")

private fun String.removeTaskPrefix(): String =
    replace(Regex("^(?:now|confirm assessment|confirm submission):\\s*", RegexOption.IGNORE_CASE), "")
        .replace(Regex("\\s+(?:[-–—]\\s*)?(?:due|available)$", RegexOption.IGNORE_CASE), "")

private fun normalizedTitle(value: String): String =
    value.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim().replace(Regex("\\s+"), " ")
