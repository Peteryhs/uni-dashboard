package dev.peteryhs.unidash.ui.today

import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendation

/** A known time window that is happening now, rather than a request's loading state. */
internal data class EventProgress(val startsAt: Long, val endsAt: Long, val fraction: Float)

internal fun NextCommitment.eventProgress(now: Long): EventProgress? =
    if (allDay) null else eventProgress(startsAt, endsAt, now)

internal fun Recommendation.eventProgress(now: Long): EventProgress? =
    if (kind == "change") null else eventProgress(startsAt, endsAt, now)

private fun eventProgress(start: Long?, end: Long?, now: Long): EventProgress? {
    if (start == null || end == null || end <= start || now < start || now >= end) return null
    return EventProgress(start, end, ((now.toDouble() - start) / (end.toDouble() - start)).toFloat().coerceIn(0f, 1f))
}
