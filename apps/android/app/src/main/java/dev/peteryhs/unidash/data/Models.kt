package dev.peteryhs.unidash.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Kotlin mirror of packages/contract. Field names match the wire format exactly; anything the app
 * does not render is left out, and `ignoreUnknownKeys` means a new server field never breaks
 * parsing. Server-side the schemas are zod; this file must follow them, not the other way round.
 */
val ContractJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/** The card freshness ladder from packages/contract/src/cards.mjs. */
enum class CardState {
    @SerialName("live") Live,
    @SerialName("ageing") Ageing,
    @SerialName("stale") Stale,
    @SerialName("dead") Dead,
    @SerialName("empty") Empty,
    @SerialName("degraded") Degraded,
    @SerialName("failed") Failed;

    /** Amber means stale, and nothing else. */
    val isStale: Boolean get() = this == Stale || this == Dead
}

@Serializable
data class Bundle(
    @SerialName("schema_version") val schemaVersion: Int,
    @SerialName("min_client_version") val minClientVersion: Int = 1,
    @SerialName("generated_at") val generatedAt: Long,
    val cards: List<Card> = emptyList(),
) {
    /** Card types this client renders. Anything else is skipped and counted, never fatal. */
    fun card(type: String): Card? = cards.firstOrNull { it.type == type }
    val skippedCount: Int get() = cards.count { it.type !in KNOWN_CARD_TYPES }

    companion object {
        const val CLIENT_VERSION = 1
        val KNOWN_CARD_TYPES = setOf("next_commitment", "due_soon", "food", "alert", "food_ai_recommendation")
    }
}

@Serializable
data class Card(
    val id: String,
    val type: String,
    val priority: Double = 0.0,
    val state: CardState = CardState.Empty,
    @SerialName("observed_at") val observedAt: Long? = null,
    @SerialName("valid_until") val validUntil: Long? = null,
    @SerialName("source_id") val sourceId: String = "",
    val data: JsonObject = JsonObject(emptyMap()),
) {
    /** Decodes the per-type payload; null when it does not match, so one bad card cannot take down the screen. */
    inline fun <reified T> payload(): T? = runCatching { ContractJson.decodeFromJsonElement<T>(data) }.getOrNull()
}

@Serializable
data class Weather(
    @SerialName("temp_c") val tempC: Double? = null,
    @SerialName("feels_c") val feelsC: Double? = null,
    @SerialName("precip_prob") val precipProb: Double? = null,
    @SerialName("wind_kmh") val windKmh: Double? = null,
    val show: Boolean = false,
    val reason: String = "",
)

@Serializable
data class Following(
    val title: String,
    val kind: String? = null,
    val location: String = "",
    @SerialName("starts_at") val startsAt: Long? = null,
    @SerialName("ends_at") val endsAt: Long? = null,
    @SerialName("all_day") val allDay: Boolean = false,
)

@Serializable
data class NextCommitment(
    val title: String,
    val subtitle: String = "",
    val kind: String? = null,
    val location: String = "",
    @SerialName("starts_at") val startsAt: Long? = null,
    @SerialName("ends_at") val endsAt: Long? = null,
    @SerialName("all_day") val allDay: Boolean = false,
    val weather: Weather? = null,
    val following: Following? = null,
)

@Serializable
data class Link(val label: String, val url: String, val kind: String = "")

@Serializable
data class DueItem(
    val title: String,
    @SerialName("starts_at") val startsAt: Long,
    val kind: String? = null,
    val url: String? = null,
    val course: String? = null,
    val description: String? = null,
    val links: List<Link> = emptyList(),
    @SerialName("occurrence_id") val occurrenceId: String? = null,
    val phase: String? = null,
    @SerialName("all_day") val allDay: Boolean = false,
    val significant: Boolean = false,
    @SerialName("due_at") val dueAt: Long? = null,
) {
    /** Stable identity for notifications: the occurrence id when the feed gives one. */
    val key: String get() = occurrenceId ?: "$title@$startsAt"
    val isDue: Boolean get() = phase != "opens"
}

@Serializable
data class DueSoon(
    val count: Int = 0,
    @SerialName("nearest_at") val nearestAt: Long? = null,
    @SerialName("window_days") val windowDays: Int = 7,
    val items: List<DueItem> = emptyList(),
    val error: String? = null,
)

/** One dish. `station` is the counter inside the outlet ("Hot Dish", "The Carvery"); "" if unnamed. */
@Serializable
data class Dish(
    val dish: String,
    val station: String = "",
    val diet: List<String> = emptyList(),
    val url: String = "",
)

/** Every outlet, pinned or not, carries its full dish list in page order (station order). */
@Serializable
data class Outlet(
    val outlet: String,
    val pinned: Boolean = false,
    val serving: Boolean = false,
    @SerialName("dish_count") val dishCount: Int = 0,
    val dishes: List<Dish> = emptyList(),
)

@Serializable
data class Food(
    @SerialName("service_date") val serviceDate: String,
    val pinned: List<Outlet> = emptyList(),
    val others: List<Outlet> = emptyList(),
    @SerialName("total_dishes") val totalDishes: Int = 0,
    val error: String? = null,
)

@Serializable
data class Highlight(val dish: String, val why: String)

@Serializable
data class RankedOutlet(
    val outlet: String,
    val rank: Int,
    @SerialName("match_score") val matchScore: Int,
    val verdict: String,
    val highlights: List<Highlight> = emptyList(),
)

@Serializable
data class FoodPick(
    @SerialName("service_date") val serviceDate: String,
    val headline: String,
    @SerialName("top_outlet") val topOutlet: String,
    @SerialName("ranked_outlets") val rankedOutlets: List<RankedOutlet> = emptyList(),
    val tip: String = "",
    val model: String = "",
    @SerialName("generated_at") val generatedAt: Long? = null,
)

@Serializable
data class FoodRankingJob(
    val status: String = "idle",
    val error: String = "",
    @SerialName("updated_at") val updatedAt: Long? = null,
)

@Serializable
data class FoodRecommendationResponse(
    val status: String = "pending",
    val recommendation: FoodPick? = null,
    @SerialName("ranking_job") val rankingJob: FoodRankingJob? = null,
    val stale: Boolean = false,
    @SerialName("limit_reason") val limitReason: String = "",
    val error: String = "",
)

@Serializable
data class Notice(
    val severity: String,
    val title: String,
    val body: String = "",
    val components: List<String> = emptyList(),
    @SerialName("incident_status") val incidentStatus: String = "",
    val url: String = "",
)

@Serializable
data class Alert(
    val count: Int = 0,
    val summary: String = "",
    val key: String = "",
    val dismissed: Boolean = false,
    @SerialName("checked_at") val checkedAt: Long? = null,
    val notices: List<Notice> = emptyList(),
)

@Serializable
data class RecAction(val label: String, val url: String)

@Serializable
data class Recommendation(
    val id: String,
    val revision: String = "",
    val kind: String,
    val priority: Double = 0.0,
    val title: String,
    val body: String = "",
    val course: String? = null,
    @SerialName("starts_at") val startsAt: Long? = null,
    @SerialName("ends_at") val endsAt: Long? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    @SerialName("time_label") val timeLabel: String? = null,
    val effort: String = "unknown",
    val action: RecAction? = null,
    val reason: String = "",
    val evidence: String = "",
    @SerialName("source_label") val sourceLabel: String = "",
    val state: CardState = CardState.Live,
    @SerialName("can_complete") val canComplete: Boolean = false,
    /** Set on schedule changes, and on classes whose session has a room or tutorial notice. */
    val change: ChangeDetail? = null,
)

@Serializable
data class Recommendations(
    @SerialName("generated_at") val generatedAt: Long,
    @SerialName("refresh_after_ms") val refreshAfterMs: Long = 60_000,
    val headline: String = "",
    val items: List<Recommendation> = emptyList(),
    val warnings: List<String> = emptyList(),
    val diagnostics: RecommendationDiagnostics? = null,
)

@Serializable
data class RecommendationPolicy(
    @SerialName("schedule_notice_hours") val scheduleNoticeHours: Int,
    @SerialName("deadline_change_hours") val deadlineChangeHours: Int,
    @SerialName("tutorial_work_notice_hours") val tutorialWorkNoticeHours: Int = 72,
    @SerialName("task_horizon_days") val taskHorizonDays: Int,
    @SerialName("small_task_feed_days") val smallTaskFeedDays: Int,
    @SerialName("max_feed_items") val maxFeedItems: Int,
)

@Serializable
data class RecommendationSummary(val shown: Int = 0, val deferred: Int = 0, val suppressed: Int = 0)

@Serializable
data class RecommendationDecision(
    val id: String,
    val kind: String,
    val title: String,
    val course: String? = null,
    @SerialName("starts_at") val startsAt: Long? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    @SerialName("scheduled_date") val scheduledDate: String? = null,
    val priority: Double = 0.0,
    val status: String,
    val reason: String,
    @SerialName("eligible_at") val eligibleAt: Long? = null,
    val position: Int? = null,
    @SerialName("course_penalty") val coursePenalty: Double = 0.0,
    @SerialName("ranking_score") val rankingScore: Double? = null,
    val change: ChangeDetail? = null,
)

@Serializable
data class RecommendationDiagnostics(
    val version: Int,
    val policy: RecommendationPolicy,
    val summary: RecommendationSummary,
    val candidates: List<RecommendationDecision> = emptyList(),
)

@Serializable
data class CalendarEvent(
    val id: String,
    @SerialName("occurrence_id") val occurrenceId: String,
    @SerialName("source_label") val sourceLabel: String = "",
    val category: String,
    val phase: String? = null,
    val title: String,
    val subtitle: String = "",
    val course: String? = null,
    val location: String = "",
    val description: String = "",
    val url: String? = null,
    val links: List<Link> = emptyList(),
    @SerialName("group_scope") val groupScope: CalendarGroupScope? = null,
    val topics: List<String> = emptyList(),
    val readings: List<String> = emptyList(),
    @SerialName("syllabus_evidence") val syllabusEvidence: List<String> = emptyList(),
    @SerialName("syllabus_scope") val syllabusScope: String? = null,
    @SerialName("due_at") val dueAt: Long? = null,
    @SerialName("observed_at") val observedAt: Long? = null,
    val attendance: String = "scheduled",
    @SerialName("starts_at") val startsAt: Long,
    @SerialName("ends_at") val endsAt: Long,
    @SerialName("all_day") val allDay: Boolean = false,
    val state: CardState = CardState.Live,
)

@Serializable
data class CalendarGroupScope(
    val section: Int? = null,
    val groups: List<Int>? = null,
)

@Serializable
data class CalendarDay(val date: String, val events: List<CalendarEvent> = emptyList())

@Serializable
data class CalendarSource(
    val id: String,
    val status: String,
    @SerialName("last_run_at") val lastRunAt: Long? = null,
    val optional: Boolean = false,
)

@Serializable
data class CalendarChangeAlert(
    val id: String,
    @SerialName("event_id") val eventId: String? = null,
    val kind: String,
    val title: String,
    val body: String = "",
    val course: String? = null,
    @SerialName("starts_at") val startsAt: Long,
    @SerialName("ends_at") val endsAt: Long,
    @SerialName("observed_at") val observedAt: Long,
    val location: String = "",
    @SerialName("previous_location") val previousLocation: String = "",
    val url: String? = null,
    val confidence: String = "check",
    val evidence: String = "",
    @SerialName("source_label") val sourceLabel: String = "",
    val state: CardState = CardState.Live,
    @SerialName("previous_at") val previousAt: Long? = null,
    @SerialName("current_at") val currentAt: Long? = null,
    @SerialName("all_day") val allDay: Boolean = false,
) {
    val detail: ChangeDetail
        get() = ChangeDetail(kind, previousLocation, location, previousAt, currentAt, allDay, confidence)
}

/**
 * The structured before → after of a schedule change (packages/contract ChangeDetail), drawn as
 * blocks: [E7 2409] → [RCH 101], [10:30 AM] → [11:30 AM]. Blank location / null time means that
 * part did not change.
 */
@Serializable
data class ChangeDetail(
    val kind: String,
    @SerialName("previous_location") val previousLocation: String = "",
    val location: String = "",
    @SerialName("previous_at") val previousAt: Long? = null,
    @SerialName("current_at") val currentAt: Long? = null,
    @SerialName("all_day") val allDay: Boolean = false,
    val confidence: String = "check",
) {
    val roomMoved: Boolean get() = previousLocation.isNotBlank() && previousLocation != location
    val confirmed: Boolean get() = confidence == "confirmed"
}

@Serializable
data class Calendar(
    val timezone: String = "America/Toronto",
    @SerialName("generated_at") val generatedAt: Long,
    val start: String,
    val end: String,
    val days: List<CalendarDay> = emptyList(),
    val count: Int = 0,
    val sources: List<CalendarSource> = emptyList(),
    val alerts: List<CalendarChangeAlert> = emptyList(),
)

@Serializable
data class LastRun(
    val at: Long? = null,
    val outcome: String = "",
    val rows: Int = 0,
    val error: String? = null,
    val meta: Map<String, JsonElement> = emptyMap(),
)

@Serializable
data class SourceHealthJob(
    val circuit: String = "",
    @SerialName("next_due_at") val nextDueAt: Long? = null,
    val failures: Int = 0,
    @SerialName("lease_expires_at") val leaseExpiresAt: Long? = null,
    @SerialName("last_outcome") val lastOutcome: String? = null,
    @SerialName("last_finished_at") val lastFinishedAt: Long? = null,
    @SerialName("last_started_at") val lastStartedAt: Long? = null,
)

@Serializable
data class SourceRecovery(
    val state: String = "unknown",
    val action: String = "none",
    @SerialName("next_attempt_at") val nextAttemptAt: Long? = null,
    val automatic: Boolean = false,
    val reason: String = "",
)

@Serializable
data class SourcePollReceipt(val outcome: String, val error: String = "", @SerialName("source_id") val sourceId: String = "")

@Serializable
data class SourceWeatherResult(val status: String, val cached: Boolean = false)

@Serializable
data class SourcePollResult(
    val receipts: List<SourcePollReceipt> = emptyList(),
    val deferred: List<String> = emptyList(),
    val weather: SourceWeatherResult? = null,
)

@Serializable
data class SourceHealth(
    val id: String,
    @SerialName("cadence_ms") val cadenceMs: Long = 0,
    val ready: Boolean = false,
    @SerialName("blocked_by") val blockedBy: String = "",
    @SerialName("last_run") val lastRun: LastRun? = null,
    @SerialName("age_s") val ageS: Long? = null,
    val optional: Boolean = false,
    val name: String = "",
    val monitored: Boolean? = null,
    val condition: String? = null,
    @SerialName("last_success_at") val lastSuccessAt: Long? = null,
    val job: SourceHealthJob? = null,
    @SerialName("stale_after_ms") val staleAfterMs: Long? = null,
    @SerialName("dead_after_ms") val deadAfterMs: Long? = null,
    val freshness: String? = null,
    val recovery: SourceRecovery? = null,
)

@Serializable
data class RuntimeHealth(
    val target: String,
    @SerialName("uptime_s") val uptimeS: Long,
    @SerialName("uptime_scope") val uptimeScope: String,
    val polling: String,
)

@Serializable
data class HealthSummary(
    val condition: String,
    val healthy: Int = 0,
    val total: Int = 0,
    val issues: Int = 0,
    val unchecked: Int = 0,
    val warning: String? = null,
)

@Serializable
data class Health(
    val now: Long,
    val sources: List<SourceHealth> = emptyList(),
    val runtime: RuntimeHealth? = null,
    val summary: HealthSummary? = null,
)
