package dev.peteryhs.unidash.ui

import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

/** Formatting in campus time, whatever zone the phone is in. */
object Format {
    private val time = DateTimeFormatter.ofPattern("h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)
    private val dayTime = DateTimeFormatter.ofPattern("EEE, MMM d · h:mm a", Locale.CANADA).withZone(CAMPUS_ZONE)
    private val dayHeader = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.CANADA)

    fun time(ms: Long): String = time.format(Instant.ofEpochMilli(ms))
    fun dayTime(ms: Long): String = dayTime.format(Instant.ofEpochMilli(ms))

    fun dayHeader(isoDate: String, today: LocalDate = LocalDate.now(CAMPUS_ZONE)): String {
        val date = LocalDate.parse(isoDate)
        return when (date) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            else -> dayHeader.format(date)
        }
    }

    /** "in 25 min", "in 2 h 5 min", "3 days ago": the countdown the hero card reads. */
    fun relative(target: Long, now: Long): String {
        val diff = target - now
        val minutes = abs(diff) / 60_000
        val text = when {
            minutes < 1 -> return if (diff >= 0) "now" else "just now"
            minutes < 60 -> "$minutes min"
            minutes < 24 * 60 -> "${minutes / 60} h" + (minutes % 60).let { if (it > 0) " $it min" else "" }
            else -> (minutes / (24 * 60)).let { "$it day" + if (it > 1) "s" else "" }
        }
        return if (diff >= 0) "in $text" else "$text ago"
    }

    /** "3 h old": for freshness labels. */
    fun age(since: Long, now: Long): String {
        val minutes = (now - since).coerceAtLeast(0) / 60_000
        return when {
            minutes < 1 -> "just now"
            minutes < 60 -> "$minutes min old"
            minutes < 24 * 60 -> "${minutes / 60} h old"
            else -> "${minutes / (24 * 60)} d old"
        }
    }
}
