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

    /**
     * "in 25 min" while it is close; "tomorrow at 9:30 a.m." or "Tue at 8:30 a.m." once it is far
     * enough that a countdown stops meaning anything.
     */
    fun whenLabel(target: Long, now: Long): String {
        if (target < now || target - now < 6 * 3_600_000L) return relative(target, now)
        val day = Instant.ofEpochMilli(target).atZone(CAMPUS_ZONE).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(CAMPUS_ZONE).toLocalDate()
        val prefix = when (day) {
            today -> "today"
            today.plusDays(1) -> "tomorrow"
            else -> weekday.format(day)
        }
        return "$prefix at ${time(target)}"
    }
    private val weekday = DateTimeFormatter.ofPattern("EEE", Locale.CANADA)

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
