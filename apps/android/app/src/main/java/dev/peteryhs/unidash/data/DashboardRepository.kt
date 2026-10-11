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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    val healthRefreshing: Boolean = false,
    val error: RelayError? = null,
    /** Internal session fence used to keep results from a signed-out session out of callbacks. */
    val sessionGeneration: Long = 0L,
    /** A live health check is deliberately not restored from disk as an all-clear. */
    val health: Health? = null,
    val healthError: RelayError? = null,
    val sourceRefreshResult: String? = null,
    val sourceRefreshing: Boolean = false,
    /** Progress for a refresh explicitly requested by the person using the app. */
    val manualRefreshing: Boolean = false,
    /** Short submission feedback for a dining ranking request, separate from feed loading. */
    val foodRankingSubmitting: Boolean = false,
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
    private val healthRefreshMutex = Mutex()
    private val sessionLock = Any()
    private val sessionGeneration = AtomicLong(0L)
    private val sessionInvalidated = AtomicBoolean(false)
    private val activeRefreshJobs = mutableSetOf<Job>()
    private var healthRefreshSequence = 0L
    private var healthRefreshCommittedSequence = 0L
    private val healthRefreshOwners = mutableSetOf<Long>()
    private var sourceRefreshSequence = 0L
    private var sourceRefreshOwner: Long? = null
    private val sourceRefreshPrevious = mutableMapOf<Long, String?>()
    private var manualRefreshSequence = 0L
    private val manualRefreshes = mutableMapOf<Long, Long>()
    private var networkRefreshSequence = 0L
    private var networkRefreshOwner: Long? = null
    private var rankingSubmissionSequence = 0L
    private var rankingSubmissionOwner: Long? = null

    private data class HealthRefreshOutcome(val result: Result<Health>, val sourcePollAccepted: Boolean)

    init {
        cacheDir.mkdirs()
        _snapshot.value = readCache()
    }

    /** Fetches the feeds and source health together. Health failure never hides usable feeds. */
    suspend fun refresh(
        expectedGeneration: Long? = null,
        userInitiated: Boolean = false,
        skipIfFresh: Boolean = false,
    ): Result<Snapshot> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)

        val manualToken = if (userInitiated) beginManualRefresh(generation)
            ?: return Result.failure(StaleSessionException) else null

        val job = currentCoroutineContext()[Job]
        if (job != null) synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) {
                manualToken?.let { finishManualRefresh(it, generation) }
                return Result.failure(StaleSessionException)
            }
            activeRefreshJobs += job
        }
        var networkStarted = false
        var networkToken: Long? = null
        var healthRequestId: Long? = null
        try {
            return mutex.withLock {
                if (!isSessionCurrent(generation)) return@withLock Result.failure(StaleSessionException)
                if (skipIfFresh && !userInitiated) {
                    freshSnapshot(generation)?.let { return@withLock Result.success(it) }
                }
                val reusableCalendar = if (skipIfFresh && !userInitiated) freshCalendar(generation) else null
                val api = apiFor() ?: return@withLock Result.failure(RelayError.Unauthorized("not signed in"))
                synchronized(sessionLock) {
                    if (!isSessionCurrentLocked(generation)) return@withLock Result.failure(StaleSessionException)
                    // Keep the last failed-refresh warning visible through quiet polls. A
                    // successful response below replaces the snapshot and clears it; explicit
                    // refreshes hide it through manualRefreshing while the person is retrying.
                    _snapshot.update { it.copy(refreshing = true) }
                    networkToken = ++networkRefreshSequence
                    networkRefreshOwner = networkToken
                    healthRequestId = beginHealthRefreshLocked(generation)
                    networkStarted = true
                }
                val today = LocalDate.now(CAMPUS_ZONE).toString()
                val requestHealthId = checkNotNull(healthRequestId)
                val result: Result<Pair<Triple<Pair<Bundle, String>, Pair<Recommendations, String>, Pair<Calendar, String?>>, Unit>> = try {
                    Result.success(coroutineScope {
                        val dash = async { api.dashboard() }
                        val recs = async { api.recommendations() }
                        val health = async {
                            val healthResult: Result<Health> = try {
                                healthRefreshMutex.withLock {
                                    val value = api.health().first
                                    Result.success(value)
                                }
                            } catch (error: CancellationException) {
                                throw error
                            } catch (error: Throwable) {
                                Result.failure(error)
                            }
                            finishHealthRefresh(requestHealthId, generation, healthResult)
                        }
                        val cal: Pair<Calendar, String?> = if (reusableCalendar != null) {
                            reusableCalendar to null
                        } else {
                            api.calendar(today, CALENDAR_DAYS).let { it.first to it.second }
                        }
                        Triple(dash.await(), recs.await(), cal) to health.await()
                    })
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    Result.failure(error)
                }
                result.fold(
                    onSuccess = { (feeds, _) ->
                        val (dash, recs, cal) = feeds
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
                            val previousSnapshot = _snapshot.value
                            write(BUNDLE, dash.second)
                            write(RECS, recs.second)
                            cal.second?.let { write(CALENDAR, it) }
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
                                health = previousSnapshot.health,
                                healthError = previousSnapshot.healthError,
                                healthRefreshing = healthRefreshOwners.isNotEmpty(),
                                sourceRefreshResult = previousSnapshot.sourceRefreshResult,
                                sourceRefreshing = previousSnapshot.sourceRefreshing,
                                manualRefreshing = previousSnapshot.manualRefreshing,
                                foodRankingSubmitting = previousSnapshot.foodRankingSubmitting,
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
            // If the coroutine was cancelled before its parallel health child could finish, release
            // that request's busy ownership here. A completed child already released it.
            if (networkStarted && healthRequestId != null) {
                finishHealthRefresh(healthRequestId!!, generation, null)
            }
            if (networkStarted) synchronized(sessionLock) {
                if (isSessionCurrentLocked(generation) && networkRefreshOwner == networkToken) {
                    networkRefreshOwner = null
                    _snapshot.update { if (it.sessionGeneration == generation) it.copy(refreshing = false) else it }
                }
            }
            if (job != null) synchronized(sessionLock) { activeRefreshJobs.remove(job) }
            manualToken?.let { finishManualRefresh(it, generation) }
        }
    }

    /** Keeps one user-requested progress state across the source update and its dashboard reload. */
    suspend fun refreshSourcesAndDashboard(expectedGeneration: Long? = null): Result<Snapshot> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val manualToken = beginManualRefresh(generation) ?: return Result.failure(StaleSessionException)
        return try {
            val sourceResult = refreshHealthInternal(expectedGeneration = generation, updateSources = true, userInitiated = false)
            if (!sourceResult.sourcePollAccepted) {
                return Result.failure(sourceResult.result.exceptionOrNull() ?: IllegalStateException("Source refresh was not accepted"))
            }

            val reload = refresh(expectedGeneration = generation)
            if (reload.isFailure) appendSourceReloadFailure(generation)
            reload
        } finally {
            finishManualRefresh(manualToken, generation)
        }
    }

    /**
     * Complete or snooze a recommendation. Hidden locally at once, so the list reacts under the
     * finger, then restored if the server refuses.
     */
    suspend fun act(
        item: Recommendation,
        action: String,
        until: Long? = null,
        expectedGeneration: Long? = null,
    ): Result<Unit> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        val before = _snapshot.value.recommendations
        val originalIndex = before?.items?.indexOfFirst { it.id == item.id } ?: -1
        synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) return Result.failure(StaleSessionException)
            _snapshot.update { s -> s.copy(recommendations = s.recommendations?.let { r -> r.copy(items = r.items.filterNot { it.id == item.id }) }) }
        }
        return try {
            api.recommendationAction(item.id, action, until)
            synchronized(sessionLock) {
                if (!isSessionCurrentLocked(generation)) Result.failure(StaleSessionException)
                else Result.success(Unit)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            synchronized(sessionLock) {
                if (isSessionCurrentLocked(generation) && before != null && originalIndex >= 0) {
                    _snapshot.update { snapshot ->
                        val current = snapshot.recommendations
                        if (current == null || current.generatedAt != before.generatedAt || current.items.any { it.id == item.id }) {
                            snapshot
                        } else {
                            val restored = current.items.toMutableList().apply {
                                add(originalIndex.coerceIn(0, size), item)
                            }
                            snapshot.copy(recommendations = current.copy(items = restored))
                        }
                    }
                }
            }
            Result.failure(error)
        }
    }

    suspend fun dismissAlert(key: String, expectedGeneration: Long? = null): Result<Unit> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return try {
            api.dismissAlert(key)
            synchronized(sessionLock) {
                if (!isSessionCurrentLocked(generation)) Result.failure(StaleSessionException)
                else {
                    markAlertDismissedLocally(generation, key)
                    Result.success(Unit)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    suspend fun rankFood(date: String, expectedGeneration: Long? = null): Result<Unit> {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val token = synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) return Result.failure(StaleSessionException)
            // Rapid taps share the first submission and its follow-up read. The server response
            // becomes the source of truth for queued/running state after that read completes.
            if (rankingSubmissionOwner != null) return Result.success(Unit)
            (++rankingSubmissionSequence).also { owner ->
                rankingSubmissionOwner = owner
                _snapshot.update { it.copy(foodRankingSubmitting = true) }
            }
        }
        return try {
            val api = apiFor() ?: throw RelayError.Unauthorized("not signed in")
            api.rankFood(date)
            if (!isSessionCurrent(generation)) Result.failure(StaleSessionException)
            else {
                // The POST is the acknowledgement. A failed follow-up read is reported through
                // Snapshot.error and must not turn an accepted ranking request into a failure.
                refresh(expectedGeneration = generation)
                Result.success(Unit)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        } finally {
            synchronized(sessionLock) {
                if (isSessionCurrentLocked(generation) && rankingSubmissionOwner == token) {
                    rankingSubmissionOwner = null
                    _snapshot.update { if (it.sessionGeneration == generation) it.copy(foodRankingSubmitting = false) else it }
                }
            }
        }
    }

    suspend fun health(): Result<Health> {
        val generation = sessionGeneration.get()
        if (!isSessionCurrent(generation)) return Result.failure(StaleSessionException)
        val api = apiFor() ?: return Result.failure(RelayError.Unauthorized("not signed in"))
        return try {
            val health = api.health().first
            if (!isSessionCurrent(generation)) Result.failure(StaleSessionException)
            else Result.success(health)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    /** Fetches source health without depending on the dashboard, recommendations, or calendar. */
    suspend fun refreshHealth(
        expectedGeneration: Long? = null,
        updateSources: Boolean = false,
        userInitiated: Boolean = updateSources,
    ): Result<Health> = refreshHealthInternal(expectedGeneration, updateSources, userInitiated).result

    private suspend fun refreshHealthInternal(
        expectedGeneration: Long? = null,
        updateSources: Boolean = false,
        userInitiated: Boolean = updateSources,
    ): HealthRefreshOutcome {
        val generation = expectedGeneration ?: sessionGeneration.get()
        if (!isSessionCurrent(generation)) return HealthRefreshOutcome(Result.failure(StaleSessionException), false)

        val sourceToken = if (updateSources) beginSourceRefresh(generation)
            ?: return HealthRefreshOutcome(Result.failure(IllegalStateException("Source refresh is already running")), false)
        else null
        val manualToken = if (updateSources && userInitiated) beginManualRefresh(generation)
            ?: run {
                sourceToken?.let { finishSourceRefresh(it, generation, cancelled = false) }
                return HealthRefreshOutcome(Result.failure(StaleSessionException), false)
            } else null

        val job = currentCoroutineContext()[Job]
        if (job != null) synchronized(sessionLock) {
            if (!isSessionCurrentLocked(generation)) {
                manualToken?.let { finishManualRefresh(it, generation) }
                sourceToken?.let { finishSourceRefresh(it, generation, cancelled = false) }
                return HealthRefreshOutcome(Result.failure(StaleSessionException), false)
            }
            activeRefreshJobs += job
        }
        val healthRequestId = beginHealthRefresh(generation)
        if (healthRequestId == null) {
            sourceToken?.let { finishSourceRefresh(it, generation, cancelled = false) }
            if (job != null) synchronized(sessionLock) { activeRefreshJobs.remove(job) }
            manualToken?.let { finishManualRefresh(it, generation) }
            return HealthRefreshOutcome(Result.failure(StaleSessionException), false)
        }

        var pollAccepted = false
        var cancelled = false
        try {
            val outcome = try {
                healthRefreshMutex.withLock {
                    if (!isSessionCurrent(generation)) throw StaleSessionException
                    val api = apiFor() ?: throw RelayError.Unauthorized("not signed in")
                    if (updateSources) {
                        val poll = api.refreshSources()
                        pollAccepted = true
                        val failures = poll.receipts.count { it.outcome !in setOf("ok", "empty", "skipped") } + if (poll.weather?.status == "failed") 1 else 0
                        val skipped = poll.receipts.filter { it.outcome == "skipped" }
                        val waiting = (poll.deferred + skipped.map { it.sourceId }.filter { it.isNotBlank() }).toSet().size +
                            skipped.count { it.sourceId.isBlank() } + if (poll.weather?.status == "deferred") 1 else 0
                        val message = when {
                            failures > 0 -> "$failures ${if (failures == 1) "source could" else "sources could"} not update. Check the recovery details below."
                            waiting > 0 -> "Refresh requested. $waiting ${if (waiting == 1) "source is" else "sources are"} waiting for a safe retry."
                            poll.receipts.isEmpty() && (poll.weather?.status != "ready" || poll.weather.cached) -> "No updates are due. See the next check time below."
                            else -> "Source refresh finished."
                        }
                        synchronized(sessionLock) {
                            if (!isSessionCurrentLocked(generation)) throw StaleSessionException
                            if (sourceRefreshOwner == sourceToken) {
                                _snapshot.update { it.copy(sourceRefreshResult = message) }
                            }
                        }
                    }
                    HealthRefreshOutcome(Result.success(api.health().first), pollAccepted)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (updateSources && !pollAccepted) {
                    synchronized(sessionLock) {
                        if (isSessionCurrentLocked(generation) && sourceRefreshOwner == sourceToken) {
                            _snapshot.update { it.copy(sourceRefreshResult = "Source refresh could not finish. Try again when the backend is reachable.") }
                        }
                    }
                }
                HealthRefreshOutcome(Result.failure(error), pollAccepted)
            }

            if (outcome.result.isFailure && updateSources && outcome.sourcePollAccepted) {
                synchronized(sessionLock) {
                    if (isSessionCurrentLocked(generation) && sourceRefreshOwner == sourceToken) {
                        _snapshot.update {
                            it.copy(sourceRefreshResult = appendSentence(
                                it.sourceRefreshResult ?: "Source refresh finished.",
                                "Source status could not be checked.",
                            ))
                        }
                    }
                }
            }
            finishHealthRefresh(healthRequestId, generation, outcome.result)
            return outcome
        } catch (error: CancellationException) {
            cancelled = true
            finishHealthRefresh(healthRequestId, generation, null)
            throw error
        } finally {
            finishHealthRefresh(healthRequestId, generation, null)
            sourceToken?.let { finishSourceRefresh(it, generation, cancelled) }
            if (job != null) synchronized(sessionLock) { activeRefreshJobs.remove(job) }
            manualToken?.let { finishManualRefresh(it, generation) }
        }
    }

    private fun beginHealthRefresh(generation: Long): Long? = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized null
        beginHealthRefreshLocked(generation)
    }

    private fun beginHealthRefreshLocked(generation: Long): Long {
        val owner = ++healthRefreshSequence
        healthRefreshOwners += owner
        _snapshot.update { if (it.sessionGeneration == generation) it.copy(healthRefreshing = true) else it }
        return owner
    }

    private fun finishHealthRefresh(requestId: Long, generation: Long, result: Result<Health>?) = synchronized(sessionLock) {
        if (!healthRefreshOwners.remove(requestId)) return@synchronized
        if (!isSessionCurrentLocked(generation)) return@synchronized
        val commitResult = result != null && requestId >= healthRefreshCommittedSequence
        if (commitResult) healthRefreshCommittedSequence = requestId
        _snapshot.update { snapshot ->
            if (snapshot.sessionGeneration != generation) snapshot
            else {
                val resolved = if (commitResult) result!!.fold(
                    onSuccess = { snapshot.copy(health = it, healthError = null) },
                    onFailure = { snapshot.copy(healthError = it.toRelayError()) },
                ) else snapshot
                resolved.copy(healthRefreshing = healthRefreshOwners.isNotEmpty())
            }
        }
    }

    private fun beginSourceRefresh(generation: Long): Long? = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation) || sourceRefreshOwner != null) return@synchronized null
        val owner = ++sourceRefreshSequence
        sourceRefreshOwner = owner
        sourceRefreshPrevious[owner] = _snapshot.value.sourceRefreshResult
        _snapshot.update {
            if (it.sessionGeneration == generation) it.copy(sourceRefreshing = true, sourceRefreshResult = "Refreshing sources…") else it
        }
        owner
    }

    private fun finishSourceRefresh(owner: Long, generation: Long, cancelled: Boolean) = synchronized(sessionLock) {
        if (sourceRefreshOwner != owner) return@synchronized
        sourceRefreshOwner = null
        val previous = sourceRefreshPrevious.remove(owner)
        if (!isSessionCurrentLocked(generation)) return@synchronized
        _snapshot.update {
            if (it.sessionGeneration != generation) it
            else it.copy(
                sourceRefreshing = false,
                sourceRefreshResult = when {
                    cancelled -> "Source refresh was cancelled."
                    it.sourceRefreshResult == "Refreshing sources…" -> previous
                    else -> it.sourceRefreshResult
                },
            )
        }
    }

    private fun appendSourceReloadFailure(generation: Long) = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized
        _snapshot.update {
            if (it.sessionGeneration != generation) it
            else it.copy(sourceRefreshResult = appendSentence(
                it.sourceRefreshResult ?: "Source refresh finished.",
                "Dashboard content could not reload; saved content remains available.",
            ))
        }
    }

    private fun markAlertDismissedLocally(generation: Long, key: String) = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized
        val bundle = _snapshot.value.bundle ?: return@synchronized
        val alert = bundle.card("alert") ?: return@synchronized
        val payload = alert.payload<Alert>() ?: return@synchronized
        if (payload.key != key || payload.dismissed) return@synchronized
        val updatedAlert = alert.copy(data = JsonObject(alert.data + ("dismissed" to JsonPrimitive(true))))
        val updatedBundle = bundle.copy(cards = bundle.cards.map { if (it.id == alert.id) updatedAlert else it })
        _snapshot.update { if (it.sessionGeneration == generation) it.copy(bundle = updatedBundle) else it }
    }

    private fun appendSentence(existing: String, addition: String): String =
        if (addition in existing) existing else "$existing $addition"

    /** Invalidates in-flight work immediately, before the suspendable cleanup can acquire mutex. */
    fun invalidateSession(): Long = synchronized(sessionLock) {
        sessionInvalidated.set(true)
        val generation = sessionGeneration.incrementAndGet()
        activeRefreshJobs.toList().forEach { it.cancel() }
        activeRefreshJobs.clear()
        manualRefreshes.clear()
        healthRefreshOwners.clear()
        sourceRefreshOwner = null
        sourceRefreshPrevious.clear()
        networkRefreshOwner = null
        rankingSubmissionOwner = null
        // Remove the old session's disk state at the invalidation boundary. This keeps a process
        // restart or a fast re-sign-in from ever reading the previous account's cache.
        cacheDir.listFiles()?.forEach { it.delete() }
        _snapshot.value = Snapshot(sessionGeneration = generation)
        generation
    }

    /** Starts a new signed-in session after credentials have been stored. */
    fun beginSession(): Long = synchronized(sessionLock) {
        sessionInvalidated.set(false)
        val generation = sessionGeneration.incrementAndGet()
        _snapshot.update { it.copy(sessionGeneration = generation) }
        generation
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

    /** Reuses a completed feed read for quiet polling, after the refresh mutex has been acquired. */
    private fun freshSnapshot(generation: Long): Snapshot? = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized null
        val current = _snapshot.value
        val fetchedAt = current.fetchedAt ?: return@synchronized null
        val now = clock()
        current.takeIf {
            it.sessionGeneration == generation &&
                it.bundle != null && it.recommendations != null && it.calendar != null &&
                it.error == null && now >= fetchedAt && now - fetchedAt < AUTOMATIC_REFRESH_FRESHNESS_MS
        }
    }

    /** Reuses the calendar only for quiet reads while its server timestamp is still recent. */
    private fun freshCalendar(generation: Long): Calendar? = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized null
        val current = _snapshot.value
        val calendar = current.calendar ?: return@synchronized null
        val now = clock()
        calendar.takeIf {
            current.sessionGeneration == generation && current.error == null &&
                now >= it.generatedAt && now - it.generatedAt < AUTOMATIC_CALENDAR_FRESHNESS_MS
        }
    }

    private fun isSessionCurrentLocked(generation: Long): Boolean =
        !sessionInvalidated.get() && sessionGeneration.get() == generation

    private fun beginManualRefresh(generation: Long): Long? = synchronized(sessionLock) {
        if (!isSessionCurrentLocked(generation)) return@synchronized null
        val token = ++manualRefreshSequence
        manualRefreshes[token] = generation
        _snapshot.update { if (it.sessionGeneration == generation) it.copy(manualRefreshing = true) else it }
        token
    }

    private fun finishManualRefresh(token: Long, generation: Long) = synchronized(sessionLock) {
        manualRefreshes.remove(token)
        if (isSessionCurrentLocked(generation)) {
            val another = manualRefreshes.values.any { it == generation }
            _snapshot.update { if (it.sessionGeneration == generation) it.copy(manualRefreshing = another) else it }
        }
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
        private const val AUTOMATIC_REFRESH_FRESHNESS_MS = 60_000L
        private const val AUTOMATIC_CALENDAR_FRESHNESS_MS = 300_000L
        private const val BUNDLE = "dashboard.json"
        private const val RECS = "recommendations.json"
        private const val CALENDAR = "calendar.json"
        private const val FOOD_RANKING = "food-ranking.json"
        private const val FETCHED_AT = "fetched_at"
    }
}

private fun Throwable.toRelayError(): RelayError = this as? RelayError
    ?: RelayError.BadResponse(message ?: "Status check failed")
