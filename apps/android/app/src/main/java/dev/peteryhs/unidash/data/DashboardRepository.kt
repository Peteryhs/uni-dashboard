package dev.peteryhs.unidash.data

import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

val CAMPUS_ZONE: ZoneId = ZoneId.of("America/Toronto")

internal object StaleSessionException : Exception("session was invalidated")

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
    /** Internal session fence used to keep results from a signed-out session out of callbacks. */
    val sessionGeneration: Long = 0L,
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
    private val sessionLock = Any()
    private val sessionGeneration = AtomicLong(0L)
    private val sessionInvalidated = AtomicBoolean(false)
    private val activeRefreshJobs = mutableSetOf<Job>()

    init {
        cacheDir.mkdirs()
        _snapshot.value = readCache()
    }

    /** Fetches all three feeds together. Keeps the previous data on failure and reports why. */
    suspend fun refresh(expectedGeneration: Long? = null): Result<Snapshot> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)

        val job = currentCoroutineContext()[Job]
        if (job != null) synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) return Result.failure(StaleSessionException)
            activeRefreshJobs += job
        }
        try {
            return mutex.withLock {
                if (!isSessionCurrent(generation)) return@withLock Result.failure(StaleSessionException)
                val api = apiFor() ?: return@withLock Result.failure(RelayError.Unauthorized("not signed in"))
                synchronized(sessionLock) {
                    if (!isSessionCurrentLocked(generation)) return@withLock Result.failure(StaleSessionException)
                    _snapshot.update { it.copy(refreshing = true, error = null) }
                }
                val today = LocalDate.now(CAMPUS_ZONE).toString()
                val result: Result<Triple<Pair<Bundle, String>, Pair<Recommendations, String>, Pair<Calendar, String>>> = try {
                    Result.success(coroutineScope {
                        val dash = async { api.dashboard() }
                        val recs = async { api.recommendations() }
                        val cal = async { api.calendar(today, CALENDAR_DAYS) }
                        Triple(dash.await(), recs.await(), cal.await())
                    })
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    Result.failure(error)
                }
                result.fold(
                    onSuccess = { (dash, recs, cal) ->
                        if (!isSessionCurrent(generation)) return@fold Result.failure(StaleSessionException)
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
                        if (!isSessionCurrent(generation)) return@fold Result.failure(StaleSessionException)
                        synchronized(sessionLock) {
                            if (!isSessionCurrentLocked(generation)) return@fold Result.failure(StaleSessionException)
                            val savedDining = dining?.first ?: _snapshot.value.foodRanking?.takeIf {
                                it.recommendation?.serviceDate == foodDate
                            }
                            write(BUNDLE, dash.second)
                            write(RECS, recs.second)
                            write(CALENDAR, cal.second)
                            if (dining != null) write(FOOD_RANKING, dining.second)
                            val now = clock()
                            write(FETCHED_AT, now.toString())
                            _snapshot.value = Snapshot(
                                dash.first,
                                recs.first,
                                cal.first,
                                foodRanking = savedDining,
                                fetchedAt = now,
                                sessionGeneration = generation,
                            )
                            Result.success(_snapshot.value)
                        }
                    },
                    onFailure = { e ->
                        if (e is CancellationException) throw e
                        synchronized(sessionLock) {
                            if (!isSessionCurrentLocked(generation)) return@fold Result.failure(StaleSessionException)
                            val error = e as? RelayError ?: RelayError.BadResponse(e.message ?: "unknown error")
                            _snapshot.update { it.copy(refreshing = false, error = error) }
                            Result.failure(error)
                        }
                    },
                )
            }
        } finally {
            if (job != null) synchronized(sessionLock) { activeRefreshJobs.remove(job) }
        }
    }

    /**
     * Complete or snooze a recommendation. Hidden locally at once, so the list reacts under the
     * finger, then restored if the server refuses.
     */
    suspend fun act(item: Recommendation, action: String, until: Long? = null): Result<Unit> {
        val generation = sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        val before = _snapshot.value.recommendations
        synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) return Result.failure(StaleSessionException)
            _snapshot.update { s -> s.copy(recommendations = s.recommendations?.let { r -> r.copy(items = r.items.filterNot { it.id == item.id }) }) }
        }
        return try {
            api.recommendationAction(item.id, action, until)
            if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
            refresh(expectedGeneration = generation).map { }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            synchronized(sessionLock) {
                if (isSessionCurrentLocked(generation)) _snapshot.update { it.copy(recommendations = before) }
            }
            Result.failure(error)
        }
    }

    suspend fun dismissAlert(key: String): Result<Unit> {
        val generation = sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return try {
            api.dismissAlert(key)
            if (!isSessionCurrent(generation)) Result.failure(StaleSessionException)
            else refresh(expectedGeneration = generation).map { }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    suspend fun rankFood(date: String): Result<Unit> {
        val generation = sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return try {
            api.rankFood(date)
            if (!isSessionCurrent(generation)) Result.failure(StaleSessionException)
            else refresh(expectedGeneration = generation).map { }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    suspend fun health(): Result<Health> {
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return try {
            Result.success(api.health().first)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    /** Invalidates in-flight work immediately, before the suspendable cleanup can acquire mutex. */
    fun invalidateSession(): Long = synchronized(sessionLock) {
        sessionInvalidated.set(true)
        val generation = sessionGeneration.incrementAndGet()
        activeRefreshJobs.toList().forEach { it.cancel() }
        activeRefreshJobs.clear()
        // Remove the old session's disk state at the invalidation boundary. This keeps a process
        // restart or a fast re-sign-in from ever reading the previous account's cache.
        cacheDir.listFiles()?.forEach { it.delete() }
        _snapshot.value = Snapshot(sessionGeneration = generation)
        generation
    }

    /** Starts a new signed-in session after credentials have been stored. */
    fun beginSession(): Long = synchronized(sessionLock) {
        sessionInvalidated.set(false)
        sessionGeneration.incrementAndGet()
    }

    /** Removes disk and in-memory state while serialized with refresh writes. */
    suspend fun clear() {
        val generation = invalidateSession()
        clearInvalidated(generation)
    }

    /** Completes a sign-out cleanup only if no newer session began while cleanup was suspended. */
    internal suspend fun clearInvalidated(invalidatedGeneration: Long) {
        mutex.withLock {
            synchronized(sessionLock) {
                if (sessionInvalidated.get() && sessionGeneration.get() == invalidatedGeneration) {
                    cacheDir.listFiles()?.forEach { it.delete() }
                    _snapshot.value = Snapshot(sessionGeneration = invalidatedGeneration)
                }
            }
        }
    }

    /** Delivers a refresh result only while its session is still current. */
    fun deliverIfCurrent(snapshot: Snapshot, deliver: () -> Unit): Boolean = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(snapshot.sessionGeneration) || _snapshot.value.sessionGeneration != snapshot.sessionGeneration) {
            false
        } else {
            deliver()
            true
        }
    }

    /** Reads the token used by a caller that may need to deliver a non-snapshot result. */
    fun currentSessionGeneration(): Long = synchronized(sessionLock) { sessionGeneration.get() }

    /** Runs a side effect only while the exact session that started the operation is current. */
    fun runIfCurrent(expectedGeneration: Long, action: () -> Unit): Boolean = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(expectedGeneration)) false else {
            action()
            true
        }
    }

    private fun isSessionCurrent(generation: Long): Boolean = synchronized(sessionLock) {
        isSessionCurrentLocked(generation)
    }

    private fun isSessionCurrentLocked(generation: Long): Boolean =
        !sessionInvalidated.get() && sessionGeneration.get() == generation

    private fun readCache(): Snapshot {
        fun <T> read(name: String, parse: (String) -> T): T? =
            runCatching { File(cacheDir, name).takeIf { it.exists() }?.readText()?.let(parse) }.getOrNull()
        return Snapshot(
            bundle = read(BUNDLE) { ContractJson.decodeFromString<Bundle>(it) },
            recommendations = read(RECS) { ContractJson.decodeFromString<Recommendations>(it) },
            calendar = read(CALENDAR) { ContractJson.decodeFromString<Calendar>(it) },
            foodRanking = read(FOOD_RANKING) { ContractJson.decodeFromString<FoodRecommendationResponse>(it) },
            fetchedAt = read(FETCHED_AT) { it.trim().toLong() },
            sessionGeneration = sessionGeneration.get(),
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
