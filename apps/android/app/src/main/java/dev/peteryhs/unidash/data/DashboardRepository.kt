package dev.peteryhs.unidash.data

import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

val CAMPUS_ZONE: ZoneId = ZoneId.of("America/Toronto")

/** Everything the screens render, plus what the app knows about how current it is. */
data class Snapshot(
    val bundle: Bundle? = null,
    val recommendations: Recommendations? = null,
    val calendar: Calendar? = null,
    val foodRanking: FoodRecommendationResponse? = null,
    /** When this device last got a full answer from the Worker; null before the first one. */
    val fetchedAt: Long? = null,
    val refreshing: Boolean = false,
    val error: RelayError? = null,
) {
    val hasData: Boolean get() = bundle != null || recommendations != null || calendar != null
}

/**
 * Single source of truth for the app and the background worker. The last good response of each
 * endpoint is written to disk verbatim, so a cold start with no network still shows the last
 * dashboard, and the card states in it still say how old it is.
 */
class DashboardRepository(
    private val cacheDir: File,
    private val apiFor: suspend () -> RelayApi?,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _snapshot = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()
    private val mutex = Mutex()

    init {
        cacheDir.mkdirs()
        _snapshot.value = readCache()
    }

    /** Fetches all three feeds together. Keeps the previous data on failure and reports why. */
    suspend fun refresh(): Result<Snapshot> = mutex.withLock {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        _snapshot.update { it.copy(refreshing = true) }
        val today = LocalDate.now(CAMPUS_ZONE).toString()
        val result = runCatching {
            coroutineScope {
                val dash = async { api.dashboard() }
                val recs = async { api.recommendations() }
                val cal = async { api.calendar(today, CALENDAR_DAYS) }
                Triple(dash.await(), recs.await(), cal.await())
            }
        }
        result.fold(
            onSuccess = { (dash, recs, cal) ->
                val foodDate = dash.first.card("food")?.payload<Food>()?.serviceDate
                // The ranking endpoint is optional for the rest of the dashboard. A failed AI
                // request must leave the menu, calendar, and last saved ranking usable.
                val dining = foodDate?.let { date ->
                    try { api.foodRecommendation(date) }
                    catch (error: Exception) {
                        if (error is CancellationException) throw error
                        null
                    }
                }
                val savedDining = dining?.first ?: _snapshot.value.foodRanking?.takeIf {
                    it.recommendation?.serviceDate == foodDate
                }
                write(BUNDLE, dash.second)
                write(RECS, recs.second)
                write(CALENDAR, cal.second)
                if (dining != null) write(FOOD_RANKING, dining.second)
                val now = clock()
                write(FETCHED_AT, now.toString())
                _snapshot.value = Snapshot(dash.first, recs.first, cal.first, foodRanking = savedDining, fetchedAt = now)
                Result.success(_snapshot.value)
            },
            onFailure = { e ->
                val error = e as? RelayError ?: RelayError.BadResponse(e.message ?: "unknown error")
                _snapshot.update { it.copy(refreshing = false, error = error) }
                Result.failure(error)
            },
        )
    }

    /**
     * Complete or snooze a recommendation. Hidden locally at once, so the list reacts under the
     * finger, then restored if the server refuses.
     */
    suspend fun act(item: Recommendation, action: String, until: Long? = null): Result<Unit> {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        val before = _snapshot.value.recommendations
        _snapshot.update { s -> s.copy(recommendations = s.recommendations?.let { r -> r.copy(items = r.items.filterNot { it.id == item.id }) }) }
        return runCatching { api.recommendationAction(item.id, action, until) }
            .onFailure { _snapshot.update { it.copy(recommendations = before) } }
            .onSuccess { refresh() }
    }

    suspend fun dismissAlert(key: String): Result<Unit> {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return runCatching { api.dismissAlert(key) }.onSuccess { refresh() }
    }

    suspend fun rankFood(date: String): Result<Unit> {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return runCatching { api.rankFood(date) }.onSuccess { refresh() }
    }

    suspend fun health(): Result<Health> {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return runCatching { api.health().first }
    }

    fun clear() {
        cacheDir.listFiles()?.forEach { it.delete() }
        _snapshot.value = Snapshot()
    }

    private fun readCache(): Snapshot {
        fun <T> read(name: String, parse: (String) -> T): T? =
            runCatching { File(cacheDir, name).takeIf { it.exists() }?.readText()?.let(parse) }.getOrNull()
        return Snapshot(
            bundle = read(BUNDLE) { ContractJson.decodeFromString<Bundle>(it) },
            recommendations = read(RECS) { ContractJson.decodeFromString<Recommendations>(it) },
            calendar = read(CALENDAR) { ContractJson.decodeFromString<Calendar>(it) },
            foodRanking = read(FOOD_RANKING) { ContractJson.decodeFromString<FoodRecommendationResponse>(it) },
            fetchedAt = read(FETCHED_AT) { it.trim().toLong() },
        )
    }

    /** Write then rename, so a process killed mid-write never leaves a half file as the cache. */
    private fun write(name: String, text: String) {
        val tmp = File(cacheDir, "$name.tmp")
        tmp.writeText(text)
        tmp.renameTo(File(cacheDir, name))
    }

    companion object {
        const val CALENDAR_DAYS = 14
        private const val BUNDLE = "dashboard.json"
        private const val RECS = "recommendations.json"
        private const val CALENDAR = "calendar.json"
        private const val FOOD_RANKING = "food-ranking.json"
        private const val FETCHED_AT = "fetched_at"
    }
}
