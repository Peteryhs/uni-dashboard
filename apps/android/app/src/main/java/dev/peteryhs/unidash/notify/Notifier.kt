package dev.peteryhs.unidash.notify

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import dev.peteryhs.unidash.MainActivity
import dev.peteryhs.unidash.R
import dev.peteryhs.unidash.UniDashApp
import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.Recommendation
import dev.peteryhs.unidash.data.Snapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private data class NoticeRecord(
    val tag: String,
    val channel: Channel,
    val kind: String,
    val evidence: String,
    val expiresAt: Long,
    val cleanupAt: Long = expiresAt,
)

private data class ChangeRef(val id: String, val signature: String, val expiresAt: Long)
private data class SeenChange(val signature: String, val expiresAt: Long)
private data class DoneDeadline(
    val eventId: String,
    val expiresAt: Long,
    val epoch: String,
    val diagnosticsBaselineAt: Long = Long.MIN_VALUE,
)

/** Owns notification slots, durable alarm generations, and finite activity tracking. */
class Notifier(private val context: Context) {
    private val prefs = context.getSharedPreferences("notifications", Context.MODE_PRIVATE)
    private val alarms = context.getSystemService(AlarmManager::class.java)
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val notifications get() = NotificationManagerCompat.from(context)
    private val app get() = context.applicationContext as UniDashApp
    val automaticTrackingEnabled: Boolean get() = prefs.getBoolean(KEY_AUTOMATIC, true)

    fun createChannels() = synchronized(lock) {
        for (channel in Channel.entries) {
            // Creating an existing ID preserves the channel choices Android owns.
            manager.createNotificationChannel(NotificationChannel(channel.id, channel.label, channelImportance(channel))
                .apply { description = channel.description })
        }
        manager.cancel(LEGACY_PERSISTENT_ID)
        if (!prefs.getBoolean(KEY_MIGRATED, false)) {
            val appChannels = Channel.entries.map { it.id }.toSet()
            manager.activeNotifications.filter { it.notification.channelId in appChannels && it.tag == null }
                .forEach { manager.cancel(it.tag, it.id) }
            prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty().forEach(::cancelLegacyAlarm)
            prefs.edit { putBoolean(KEY_MIGRATED, true) }
        }
        epoch()
    }

    val canPost: Boolean get() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    private fun canPost(channel: Channel): Boolean = canPost && notifications.areNotificationsEnabled() &&
        manager.getNotificationChannel(channel.id)?.importance != NotificationManager.IMPORTANCE_NONE

    /** Permission is checked immediately before posting to cover revocation races and lint. */
    private fun notifySafely(tag: String, id: Int, notification: android.app.Notification): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED) return false
        if (!notifications.areNotificationsEnabled()) return false
        return try {
            notifications.notify(tag, id, notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    fun post(
        key: String,
        channel: Channel,
        title: String,
        text: String,
        bigText: String? = null,
        expiresAt: Long = System.currentTimeMillis() + NotificationPlanner.MESSAGE_NOTICE_TTL_MS,
        kind: String = "message",
        evidence: String = key,
        cleanupAt: Long = expiresAt,
        timeoutAt: Long = expiresAt,
        silent: Boolean = false,
        postedAt: Long = System.currentTimeMillis(),
    ): Boolean {
        val now = postedAt
        if (!canPost(channel) || expiresAt <= now || timeoutAt <= now) return false
        val slot = if (channel == Channel.Alerts) "campus-alert" else key
        val tag = "message:$slot"
        val notification = NotificationCompat.Builder(context, channel.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText ?: text)).setContentIntent(openIntent())
            .setAutoCancel(true).setOnlyAlertOnce(silent).setSilent(silent)
            .setTimeoutAfter(minOf(expiresAt, timeoutAt) - now).setCategory(NotificationCompat.CATEGORY_STATUS).build()
        val posted = notifySafely(tag, SLOT_ID, notification)
        if (posted) upsertNotice(NoticeRecord(tag, channel, kind, evidence, expiresAt, cleanupAt))
        return posted
    }

    /** Activity permission/resume callbacks restore finite state, never a generic forever notice. */
    fun ensurePersistent(snapshot: Snapshot = app.repository.snapshot.value, now: Long = System.currentTimeMillis()) =
        onSnapshot(snapshot, now, fromNetwork = false)

    /** Reconcile user actions against the latest fenced snapshot without requesting a network refresh. */
    fun reconcileAfterAction(
        snapshot: Snapshot = app.repository.snapshot.value,
        now: Long = System.currentTimeMillis(),
        actedItem: Recommendation? = null,
        action: String? = null,
    ) = app.repository.deliverIfCurrent(snapshot) {
        synchronized(lock) {
            if (action == "done" && actedItem != null) rememberAcceptedDone(snapshot, actedItem, now)
            reconcileSnapshot(snapshot, now, fromNetwork = false)
        }
    }

    fun setAutomaticTracking(enabled: Boolean) {
        // This is a device preference, including while signed out. Session data stays fenced.
        synchronized(lock) {
            prefs.edit { putBoolean(KEY_AUTOMATIC, enabled) }
            if (!enabled) clearTracked()
        }
        reconcileAfterAction(app.repository.snapshot.value)
    }

    fun isTracking(occurrenceId: String): Boolean = synchronized(lock) {
        prefs.getString(KEY_TRACKED, null) == occurrenceId && prefs.getLong(KEY_TRACKED_END, 0) > System.currentTimeMillis() &&
            manager.activeNotifications.any { it.tag == TRACKER_TAG && it.id == SLOT_ID }
    }

    fun startTracking(event: CalendarEvent): Boolean {
        val now = System.currentTimeMillis()
        if (!LiveClassPlanner.canTrack(event, now) || !canPost(Channel.Persistent)) return false
        val snapshot = app.repository.snapshot.value
        var started = false
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                val state = LiveClassPlanner.plan(snapshot.calendar, event.occurrenceId, now) ?: return@synchronized
                saveDismissed(dismissed(now).apply { remove(event.occurrenceId) })
                prefs.edit { putString(KEY_TRACKED, state.occurrenceId); putLong(KEY_TRACKED_END, state.endsAt) }
                started = renderTracker(state, now)
                scheduleBoundary(state.nextUpdateAt, exact = state.progressUpdateAt != state.nextUpdateAt)
                scheduleExpiryCleanup(snapshot, now)
            }
        }
        return started
    }

    /** Removal suppresses this occurrence through its end, including after reboot/sync. */
    fun stopTracking() {
        val snapshot = app.repository.snapshot.value
        app.repository.deliverIfCurrent(snapshot) { synchronized(lock) { dismissTracked(System.currentTimeMillis()) } }
    }

    fun onSnapshot(snapshot: Snapshot, now: Long = System.currentTimeMillis(), fromNetwork: Boolean = true) {
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                reconcileSnapshot(snapshot, now, fromNetwork)
            }
        }
    }

    private fun reconcileSnapshot(snapshot: Snapshot, now: Long, fromNetwork: Boolean) {
        manager.cancel(LEGACY_PERSISTENT_ID)
        val completedDeadlineEventIds = completedDeadlineEventIds(snapshot, now)
        reconcileMessageNotices(snapshot, now, fromNetwork)
        reconcileCampusAlert(snapshot.bundle?.card("alert")?.payload<Alert>(), now)
        reconcilePosted(snapshot, now, completedDeadlineEventIds)
        // A sync or cleanup alarm may arrive after a reminder's due time but before its alarm.
        readReminders(KEY_PENDING).filter { it.fireAt <= now }.forEach {
            deliverReminder(snapshot, it.key, it.fireAt, now, completedDeadlineEventIds)
        }
        scheduleReminders(NotificationPlanner.plan(snapshot.calendar, now, completedDeadlineEventIds))
        updateTracker(snapshot, now)
        reconcileChangeHistoryAndPost(snapshot, now, fromNetwork)

        if (fromNetwork) {
            prefs.edit { putBoolean(KEY_AUTH_WARNED, false) }
            cancelMessage("message:account")
        }

        scheduleExpiryCleanup(snapshot, now)
        reconcileAppNotificationOrphans()
    }

    /** Reconcile an alert outside bundle decoding so new incidents and quiet repairs stay distinct. */
    internal fun reconcileCampusAlert(alert: Alert?, now: Long) = synchronized(lock) {
        val tag = "message:campus-alert"
        val active = manager.activeNotifications.any { it.id == SLOT_ID && it.tag == tag }
        val current = readNotice(tag)?.takeIf { it.kind == "alert" }
        val shownKey = prefs.getString(KEY_ALERT, null)
        val validAlert = alert?.takeIf { it.count > 0 && !it.dismissed }

        if (!active) {
            if (current != null) saveNoticeRecords(readNoticeRecords().filterNot { it.tag == tag })
        } else if (!canPost(Channel.Alerts) || validAlert == null) {
            cancelMessage(tag)
        } else if (current != null && NotificationPlanner.alertSignature(validAlert) != current.evidence) {
            if (validAlert.key != shownKey) {
                // A different incident is a new heads-up; leave KEY_ALERT unchanged so the
                // normal alert path below posts the replacement with the configured sound.
                cancelMessage(tag)
            } else {
                postCampusAlert(validAlert, now, silent = true)
            }
        }

        validAlert?.let { value ->
            NotificationPlanner.alertToShow(value, prefs.getString(KEY_ALERT, null))?.let {
                postCampusAlert(it, now, silent = false)
            }
        }
    }

    private fun postCampusAlert(alert: Alert, now: Long, silent: Boolean): Boolean {
        val notice = alert.notices.firstOrNull()
        val expiresAt = now + NotificationPlanner.MESSAGE_NOTICE_TTL_MS
        val posted = post("campus-alert", Channel.Alerts, notice?.title ?: "Campus alert",
            alert.summary.ifBlank { notice?.body ?: "" }, notice?.body,
            expiresAt = expiresAt, kind = "alert", evidence = NotificationPlanner.alertSignature(alert),
            cleanupAt = expiresAt, silent = silent, postedAt = now)
        if (posted) prefs.edit { putString(KEY_ALERT, alert.key) }
        return posted
    }

    private fun reconcileChangeHistoryAndPost(snapshot: Snapshot, now: Long, allowNew: Boolean) {
        val history = readSeenChanges()
        val alerts = snapshot.calendar?.alerts.orEmpty().associateBy { it.id }
        val latest = alerts.mapValues { NotificationPlanner.changeSignature(it.value) }
        val fresh = NotificationPlanner.calendarIsFresh(snapshot.calendar, now)
        val shown = prefs.getStringSet(KEY_CHANGES, emptySet()).orEmpty().toMutableSet()
        for (id in shown.toList()) {
            val previous = history[id]
            val current = alerts[id]
            val previousSignature = previous?.signature.orEmpty().ifBlank {
                // Migrate IDs saved by older versions that did not persist fingerprints.
                current?.let(NotificationPlanner::changeSignature).orEmpty()
            }
            val expiresAt = previous?.expiresAt?.takeIf { it > 0 }
                ?: current?.let(NotificationPlanner::changeExpiresAt)
                ?: now + NotificationPlanner.MESSAGE_NOTICE_TTL_MS
            val changed = fresh && current != null && previousSignature.isNotEmpty() &&
                latest[id] != previousSignature
            if (expiresAt <= now || changed) {
                shown.remove(id)
                history.remove(id)
            } else {
                // Keep seen/dismissed history across a missing, stale, or partial response. It
                // expires at the original affected time, so a later identical alert stays quiet.
                history[id] = SeenChange(previousSignature, expiresAt)
            }
        }
        if (allowNew) {
            val changes = NotificationPlanner.changesToShow(snapshot.calendar, shown, now)
            if (changes.isNotEmpty()) {
                val relevant = NotificationPlanner.changesToShow(
                    snapshot.calendar, emptySet(), now, Int.MAX_VALUE, coalesceRoomSeries = false,
                ).associateBy { it.id }
                val existing = readNotice("message:changes")?.takeIf { it.kind == "changes" }
                    ?.let { decodeChangeRefs(it.evidence).mapNotNull { ref ->
                        relevant[ref.id]?.takeIf { change -> NotificationPlanner.changeSignature(change) == ref.signature }
                    } }.orEmpty()
                val digest = (existing + changes).distinctBy { it.id }
                    .sortedBy { it.startsAt }.take(3)
                val includedNew = changes.filter { change -> digest.any { it.id == change.id } }
                val marked = includedNew.flatMap { change ->
                    if (change.kind != "room" || change.course.isNullOrBlank()) listOf(change) else relevant.values.filter {
                        it.id != change.id && it.kind == "room" && it.course == change.course &&
                            it.location == change.location && it.previousLocation == change.previousLocation
                    }.plus(change)
                }.distinctBy { it.id }
                if (includedNew.isNotEmpty() && postChangeDigest(
                        digest, now, silent = false, calendarFreshUntil = calendarFreshUntil(snapshot.calendar),
                    )) {
                    marked.forEach { change ->
                        shown.add(change.id)
                        history[change.id] = SeenChange(NotificationPlanner.changeSignature(change),
                            NotificationPlanner.changeExpiresAt(change))
                    }
                }
            }
        }
        history.keys.retainAll(shown)
        saveSeenChanges(history)
        prefs.edit { putStringSet(KEY_CHANGES, shown) }
    }

    private fun postChangeDigest(
        changes: List<dev.peteryhs.unidash.data.CalendarChangeAlert>,
        now: Long,
        silent: Boolean,
        calendarFreshUntil: Long? = null,
    ): Boolean {
        if (changes.isEmpty()) return false
        val refs = changes.map { ChangeRef(it.id, NotificationPlanner.changeSignature(it), NotificationPlanner.changeExpiresAt(it)) }
        val lines = changes.map { change ->
            listOf(change.course, change.title, change.body).filterNotNull().filter { it.isNotBlank() }.distinct().joinToString(" · ")
        }
        val expiresAt = refs.maxOf { it.expiresAt }
        val cleanupAt = minOf(refs.minOf { it.expiresAt }, calendarFreshUntil ?: Long.MAX_VALUE)
        return post("changes", Channel.Changes, "Schedule changes", lines.first(), lines.joinToString("\n"),
            expiresAt = expiresAt, kind = "changes", evidence = encodeChangeRefs(refs), cleanupAt = cleanupAt,
            timeoutAt = calendarFreshUntil ?: expiresAt, silent = silent, postedAt = now)
    }

    private fun reconcileMessageNotices(snapshot: Snapshot, now: Long, fromNetwork: Boolean) {
        val activeByTag = manager.activeNotifications.filter { it.id == SLOT_ID }.mapNotNull { active ->
            active.tag?.let { it to active }
        }.toMap()
        val activeChanges = NotificationPlanner.changesToShow(
            snapshot.calendar, emptySet(), now, Int.MAX_VALUE, coalesceRoomSeries = false,
        ).associateBy { it.id }
        val kept = mutableListOf<NoticeRecord>()

        for (record in readNoticeRecords()) {
            if (record.tag !in activeByTag) continue // Dismissed or auto-cancelled; never restore it.
            if (record.expiresAt <= now || !canPost(record.channel) || (fromNetwork && record.kind == "account")) {
                cancelMessage(record.tag)
                continue
            }
            when (record.kind) {
                "changes" -> {
                    val valid = decodeChangeRefs(record.evidence).mapNotNull { ref ->
                        activeChanges[ref.id]?.takeIf {
                            NotificationPlanner.changeSignature(it) == ref.signature && NotificationPlanner.changeExpiresAt(it) > now
                        }
                    }
                    if (valid.isEmpty()) {
                        cancelMessage(record.tag)
                    } else {
                        val updated = valid.map { ChangeRef(it.id, NotificationPlanner.changeSignature(it), NotificationPlanner.changeExpiresAt(it)) }
                        if (encodeChangeRefs(updated) != record.evidence || updated.maxOf { it.expiresAt } != record.expiresAt) {
                            if (postChangeDigest(valid, now, silent = true,
                                    calendarFreshUntil = calendarFreshUntil(snapshot.calendar))) {
                                readNotice(record.tag)?.let(kept::add)
                            }
                        } else kept.add(record)
                    }
                }
                // Campus alert identity and quiet updates are handled separately below, so a
                // changed incident can replace this slot through the normal heads-up path.
                "alert" -> kept.add(record)
                "account" -> kept.add(record)
                else -> cancelMessage(record.tag)
            }
        }
        saveNoticeRecords(kept)
        val allowed = kept.map { it.tag }.toSet()
        manager.activeNotifications.filter { it.tag?.startsWith("message:") == true && it.tag !in allowed }
            .forEach { notifications.cancel(it.tag, it.id) }
    }

    private fun reconcileAppNotificationOrphans() {
        val channels = Channel.entries.map { it.id }.toSet()
        val valid = buildSet {
            addAll(readNoticeRecords().map { it.tag })
            addAll(readReminders(KEY_POSTED).map { reminderTag(it.notificationKey) })
            if (prefs.getString(KEY_TRACKED, null) != null) add(TRACKER_TAG)
        }
        manager.activeNotifications.filter { it.notification.channelId in channels }.forEach { active ->
            if (active.id != SLOT_ID || active.tag !in valid) notifications.cancel(active.tag, active.id)
        }
    }

    private fun scheduleExpiryCleanup(snapshot: Snapshot, now: Long) {
        val notices = readNoticeRecords()
        val posted = readReminders(KEY_POSTED)
        val hasCalendarNotices = posted.isNotEmpty() || notices.any { it.kind == "changes" }
        val calendarExpiry = calendarFreshUntil(snapshot.calendar).takeIf { hasCalendarNotices }
        val expiries = notices.map { it.cleanupAt } + posted.map { it.expiresAt } +
            listOfNotNull(calendarExpiry, prefs.getLong(KEY_TRACKED_END, 0).takeIf { it > 0 })
        val next = expiries.filter { it > now }.minOrNull()
        if (next == null) cancelAlarm(ACTION_CLEANUP, CLEANUP_KEY)
        else scheduleAlarm(next, broadcast(ACTION_CLEANUP, CLEANUP_KEY).putExtra(EXTRA_EPOCH, epoch()), exact = false)
    }

    private fun calendarFreshUntil(calendar: dev.peteryhs.unidash.data.Calendar?): Long? =
        calendar?.generatedAt?.let { it + NotificationPlanner.MAX_CALENDAR_AGE_MS + 1 }

    /** A successful Done POST can precede a failed feed refresh; keep its exact event quiet locally. */
    private fun rememberAcceptedDone(snapshot: Snapshot, item: Recommendation, now: Long) {
        if (item.kind != "task") return
        val eventId = item.sourceEventId?.takeIf { it.isNotBlank() } ?: return
        val event = snapshot.calendar?.days.orEmpty().flatMap { it.events }.firstOrNull { it.id == eventId }
        if (event != null && event.category != "deadline") return // Exams and classes remain scheduled events.
        val expiresAt = event?.let { maxOf(it.dueAt ?: it.startsAt, it.endsAt) } ?: item.dueAt ?: return
        if (expiresAt <= now) return
        val values = readDoneDeadlines()
        values[eventId] = DoneDeadline(eventId, expiresAt, epoch(), maxOf(snapshot.recommendations?.generatedAt ?: Long.MIN_VALUE, now))
        saveDoneDeadlines(values)
    }

    /**
     * Server diagnostics cover actions taken elsewhere. Local accepted actions bridge the window
     * before those diagnostics arrive. Missing/stale evidence never clears that local bridge.
     */
    private fun completedDeadlineEventIds(snapshot: Snapshot, now: Long): Set<String> {
        val currentEpoch = epoch()
        val local = readDoneDeadlines().filterValues { it.epoch == currentEpoch && it.expiresAt > now }.toMutableMap()
        val recommendations = snapshot.recommendations
        val diagnosticsFresh = recommendations != null && recommendations.generatedAt >= now - NotificationPlanner.MAX_CALENDAR_AGE_MS &&
            recommendations.generatedAt <= now + NotificationPlanner.CLOCK_SKEW_MS
        val taskDecisions = if (diagnosticsFresh) recommendations.diagnostics?.candidates.orEmpty()
            .filter { it.kind == "task" && !it.sourceEventId.isNullOrBlank() }
            .groupBy { it.sourceEventId!! } else emptyMap()

        // An explicit fresh Undo (or other non-Done action) releases the local fallback. Absence
        // from the visible feed is not proof of Undo; candidates may be deferred or out of view.
        val calendarFresh = NotificationPlanner.calendarIsFresh(snapshot.calendar, now)
        val events = if (calendarFresh) snapshot.calendar?.days.orEmpty().flatMap { it.events }.associateBy { it.id }
            else emptyMap()
        taskDecisions.forEach { (eventId, decisions) ->
            if (decisions.none { it.suppressedAction == "done" }) {
                val previous = local[eventId]
                if (previous != null && recommendations!!.generatedAt > previous.diagnosticsBaselineAt) local.remove(eventId)
            } else {
                val event = events[eventId]
                val taskDue = decisions.mapNotNull { it.dueAt }.maxOrNull()
                val expiresAt = when {
                    event?.category == "deadline" -> maxOf(event.dueAt ?: event.startsAt, event.endsAt)
                    event == null -> taskDue
                    else -> null // Keep exams and other scheduled activities as notifications.
                }
                if (expiresAt != null && expiresAt > now) {
                    local[eventId] = DoneDeadline(eventId, expiresAt, currentEpoch, recommendations!!.generatedAt)
                }
            }
        }

        if (calendarFresh) {
            for ((eventId, old) in local.toMap()) {
                val event = events[eventId] ?: continue // Partial/missing evidence preserves suppression to its saved boundary.
                if (event.category != "deadline") {
                    local.remove(eventId)
                    continue
                }
                val boundary = maxOf(event.dueAt ?: event.startsAt, event.endsAt)
                if (boundary <= now) local.remove(eventId)
                else local[eventId] = old.copy(expiresAt = boundary)
            }
        }
        saveDoneDeadlines(local)
        return local.keys + taskDecisions.filterValues { rows -> rows.any { it.suppressedAction == "done" } }.keys
    }

    private fun readDoneDeadlines(): MutableMap<String, DoneDeadline> = runCatching {
        val json = JSONArray(prefs.getString(KEY_DONE_DEADLINES, "[]").orEmpty())
        buildMap {
            for (index in 0 until json.length()) {
                val value = json.getJSONObject(index)
                val eventId = value.getString("event")
                put(eventId, DoneDeadline(eventId, value.getLong("expires"), value.getString("epoch"),
                    value.optLong("diagnostics_baseline", Long.MIN_VALUE)))
            }
        }.toMutableMap()
    }.getOrDefault(mutableMapOf())

    private fun saveDoneDeadlines(values: Map<String, DoneDeadline>) {
        val json = JSONArray().apply { values.values.forEach { value -> put(JSONObject()
            .put("event", value.eventId).put("expires", value.expiresAt).put("epoch", value.epoch)
            .put("diagnostics_baseline", value.diagnosticsBaselineAt)) } }
        prefs.edit { putString(KEY_DONE_DEADLINES, json.toString()) }
    }

    private fun encodeChangeRefs(refs: List<ChangeRef>): String = JSONArray().apply {
        refs.forEach { put(JSONObject().put("id", it.id).put("signature", it.signature).put("expires", it.expiresAt)) }
    }.toString()

    private fun decodeChangeRefs(value: String): List<ChangeRef> = runCatching {
        val array = JSONArray(value)
        (0 until array.length()).map { index -> array.getJSONObject(index).let {
            ChangeRef(it.getString("id"), it.getString("signature"), it.getLong("expires"))
        } }
    }.getOrDefault(emptyList())

    private fun readSeenChanges(): MutableMap<String, SeenChange> = runCatching {
        val json = JSONObject(prefs.getString(KEY_CHANGE_SIGNATURES, "{}").orEmpty())
        buildMap {
            val ids = json.keys()
            while (ids.hasNext()) {
                val id = ids.next()
                val value = json.opt(id)
                when (value) {
                    is JSONObject -> put(id, SeenChange(value.optString("signature"), value.optLong("expires")))
                    is String -> put(id, SeenChange(value, 0)) // Legacy signature-only format.
                }
            }
        }.toMutableMap()
    }.getOrDefault(mutableMapOf())

    private fun saveSeenChanges(history: Map<String, SeenChange>) {
        val json = JSONObject().apply { history.forEach { (id, seen) ->
            put(id, JSONObject().put("signature", seen.signature).put("expires", seen.expiresAt))
        } }
        prefs.edit { putString(KEY_CHANGE_SIGNATURES, json.toString()) }
    }

    private fun readNoticeRecords(): List<NoticeRecord> = runCatching {
        val array = JSONArray(prefs.getString(KEY_NOTICES, "[]").orEmpty())
        (0 until array.length()).map { index -> array.getJSONObject(index).let { value ->
            NoticeRecord(value.getString("tag"), Channel.valueOf(value.getString("channel")), value.getString("kind"),
                value.getString("evidence"), value.getLong("expires"), value.optLong("cleanup", value.getLong("expires")))
        } }
    }.getOrDefault(emptyList())

    private fun readNotice(tag: String): NoticeRecord? = readNoticeRecords().firstOrNull { it.tag == tag }

    private fun saveNoticeRecords(records: List<NoticeRecord>) {
        val json = JSONArray().apply { records.forEach { record -> put(JSONObject().put("tag", record.tag)
            .put("channel", record.channel.name).put("kind", record.kind).put("evidence", record.evidence)
            .put("expires", record.expiresAt).put("cleanup", record.cleanupAt)) } }
        prefs.edit { putString(KEY_NOTICES, json.toString()) }
    }

    private fun upsertNotice(record: NoticeRecord) {
        saveNoticeRecords(readNoticeRecords().filterNot { it.tag == record.tag } + record)
    }

    private fun cancelMessage(tag: String) {
        notifications.cancel(tag, SLOT_ID)
        saveNoticeRecords(readNoticeRecords().filterNot { it.tag == tag })
    }

    fun onUnauthorized(message: String) = synchronized(lock) {
        val now = System.currentTimeMillis()
        val expiresAt = now + NotificationPlanner.MESSAGE_NOTICE_TTL_MS
        if (!prefs.getBoolean(KEY_AUTH_WARNED, false) && post("account", Channel.Account, "Uni Dashboard can't connect", message,
                expiresAt = expiresAt, kind = "account", evidence = "unauthorized", cleanupAt = expiresAt)) {
            prefs.edit { putBoolean(KEY_AUTH_WARNED, true) }
        }
        scheduleExpiryCleanup(app.repository.snapshot.value, now)
    }

    private fun scheduleReminders(reminders: List<Reminder>) {
        val previous = prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty()
        val next = reminders.map { it.key }.toSet()
        (previous - next).forEach { key -> cancelAlarm(ACTION_REMINDER, key) }
        val currentEpoch = epoch()
        for (reminder in reminders) scheduleAlarm(reminder.fireAt, broadcast(ACTION_REMINDER, reminder.key)
            .putExtra(EXTRA_FIRE_AT, reminder.fireAt).putExtra(EXTRA_EPOCH, currentEpoch))
        prefs.edit { putStringSet(KEY_SCHEDULED, next); putString(KEY_PENDING, encodeReminders(reminders)) }
    }

    /** Extras identify an alarm; its contents are re-derived from the current calendar. */
    fun onReminderAlarm(intent: Intent, now: Long = System.currentTimeMillis()) {
        val snapshot = app.repository.snapshot.value
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                if (intent.getStringExtra(EXTRA_EPOCH) != epoch()) return@synchronized
                val key = intent.getStringExtra(EXTRA_KEY) ?: return@synchronized
                val fireAt = intent.getLongExtra(EXTRA_FIRE_AT, Long.MIN_VALUE)
                if (readReminders(KEY_PENDING).none { it.key == key && it.fireAt == fireAt }) return@synchronized
                reconcileSnapshot(snapshot, now, fromNetwork = false)
            }
        }
    }

    private fun deliverReminder(
        snapshot: Snapshot,
        key: String,
        fireAt: Long,
        now: Long,
        completedDeadlineEventIds: Set<String>,
    ) {
        val reminder = NotificationPlanner.resolveReminder(
            snapshot.calendar, key, fireAt, now, completedDeadlineEventIds,
        ) ?: return
        val fired = fired(now)
        val identity = "$key@$fireAt"
        if (fired.has(identity)) return
        val trackedOccurrence = updateTracker(snapshot, now)
        if (reminder.channel == Channel.Classes && trackedOccurrence == reminder.occurrenceId) {
            prefs.edit { putString(KEY_HEADSUP_OCCURRENCE, reminder.occurrenceId); putLong(KEY_HEADSUP_FIRE, fireAt); putLong(KEY_HEADSUP_UNTIL, now + HEADSUP_GRACE_MS) }
        }
        if (postReminder(reminder, now, calendarFreshUntil = calendarFreshUntil(snapshot.calendar))) {
            fired.put(identity, reminder.expiresAt)
            val posted = readReminders(KEY_POSTED).filterNot { it.notificationKey == reminder.notificationKey } + reminder
            prefs.edit { putString(KEY_FIRED, fired.toString()); putString(KEY_POSTED, encodeReminders(posted)) }
        }
    }

    private fun postReminder(
        reminder: Reminder,
        now: Long,
        silent: Boolean = false,
        calendarFreshUntil: Long? = null,
    ): Boolean {
        if (!canPost(reminder.channel) || reminder.expiresAt <= now) return false
        val expiresAt = minOf(reminder.expiresAt, headsupUntil(reminder) ?: Long.MAX_VALUE,
            calendarFreshUntil ?: Long.MAX_VALUE)
        if (expiresAt <= now) return false
        val notification = NotificationCompat.Builder(context, reminder.channel.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(reminder.title).setContentText(reminder.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reminder.text)).setContentIntent(openIntent())
            .setAutoCancel(true).setOnlyAlertOnce(silent).setSilent(silent)
            .setTimeoutAfter(expiresAt - now).setCategory(NotificationCompat.CATEGORY_REMINDER).build()
        return notifySafely(reminderTag(reminder.notificationKey), SLOT_ID, notification)
    }

    private fun reconcilePosted(snapshot: Snapshot, now: Long, completedDeadlineEventIds: Set<String>) {
        val previous = readReminders(KEY_POSTED)
        val active = manager.activeNotifications.mapNotNull { it.tag }.toSet()
        val next = NotificationPlanner.reconcilePosted(snapshot.calendar, previous, now, completedDeadlineEventIds)
            .filter { reminderTag(it.notificationKey) in active && canPost(it.channel) && (headsupUntil(it) ?: Long.MAX_VALUE) > now }
        val nextTags = next.map { reminderTag(it.notificationKey) }.toSet()
        (previous.map { reminderTag(it.notificationKey) }.toSet() - nextTags)
            .forEach { notifications.cancel(it, SLOT_ID) }
        active.filter { it.startsWith("reminder:") && it !in nextTags }.forEach { notifications.cancel(it, SLOT_ID) }
        for (reminder in next) if (previous.none { it == reminder }) postReminder(
            reminder, now, silent = true, calendarFreshUntil = calendarFreshUntil(snapshot.calendar),
        )
        prefs.edit { putString(KEY_POSTED, encodeReminders(next)); putString(KEY_FIRED, fired(now).toString()) }
    }

    private fun updateTracker(snapshot: Snapshot, now: Long): String? {
        var postedOccurrence: String? = null
        val suppressed = dismissed(now)
        saveDismissed(suppressed)
        val state = if (automaticTrackingEnabled) LiveClassPlanner.select(snapshot.calendar, now, suppressed.keys)
            else prefs.getString(KEY_TRACKED, null)?.let { LiveClassPlanner.plan(snapshot.calendar, it, now) }
        if (state == null || !canPost(Channel.Persistent)) clearTracked() else {
            prefs.edit { putString(KEY_TRACKED, state.occurrenceId); putLong(KEY_TRACKED_END, state.endsAt) }
            if (renderTracker(state, now)) {
                postedOccurrence = state.occurrenceId
                val redundant = readReminders(KEY_POSTED).filter { it.channel == Channel.Classes && it.occurrenceId == state.occurrenceId &&
                    (headsupUntil(it) ?: Long.MIN_VALUE) <= now }
                redundant.forEach { notifications.cancel(reminderTag(it.notificationKey), SLOT_ID) }
                prefs.edit { putString(KEY_POSTED, encodeReminders(readReminders(KEY_POSTED) - redundant.toSet())) }
            }
        }
        val boundary = if (automaticTrackingEnabled) LiveClassPlanner.nextBoundary(snapshot.calendar, now, suppressed.keys) else state?.nextUpdateAt
        if (boundary == null || !canPost(Channel.Persistent)) cancelAlarm(ACTION_BOUNDARY, BOUNDARY_KEY) else {
            val progressRefresh = state?.progressUpdateAt == boundary
            scheduleBoundary(boundary, exact = !progressRefresh)
        }
        return postedOccurrence
    }

    private fun renderTracker(state: LiveClassState, now: Long): Boolean {
        val remove = pending(broadcast(ACTION_UNPIN, state.occurrenceId).putExtra(EXTRA_EPOCH, epoch()).putExtra(EXTRA_TRACKED_END, state.endsAt))
        val builder = NotificationCompat.Builder(context, Channel.Persistent.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(state.title).setContentText(state.text)
            .setContentIntent(openIntent())
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setCategory(NotificationCompat.CATEGORY_EVENT)
            .setWhen(state.countdownAt).setUsesChronometer(true).setChronometerCountDown(true)
            .setShowWhen(true).setTimeoutAfter(state.expiresAt - now)
            .addAction(0, "Unpin", remove).setDeleteIntent(remove)
        if (state.phase == "active" && Build.VERSION.SDK_INT >= 36) {
            builder.setSubText(state.nextText)
                .setStyle(NotificationCompat.ProgressStyle().setProgress(state.progress).setStyledByProgress(true))
        } else {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(state.expandedText))
            if (state.phase == "active") builder.setProgress(100, state.progress, false)
        }
        if (Build.VERSION.SDK_INT >= 36 && manager.canPostPromotedNotifications()) builder.setRequestPromotedOngoing(true)
        return notifySafely(TRACKER_TAG, SLOT_ID, builder.build())
    }

    fun onTrackerAlarm(intent: Intent) {
        val snapshot = app.repository.snapshot.value
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                if (intent.getStringExtra(EXTRA_EPOCH) != epoch()) return@synchronized
                if (intent.action == ACTION_UNPIN) {
                    val now = System.currentTimeMillis()
                    dismissOccurrence(intent.getStringExtra(EXTRA_KEY), intent.getLongExtra(EXTRA_TRACKED_END, 0), now)
                    scheduleExpiryCleanup(snapshot, now)
                    reconcileAppNotificationOrphans()
                } else if (intent.action == ACTION_BOUNDARY || intent.action == ACTION_CLEANUP) {
                    reconcileSnapshot(snapshot, System.currentTimeMillis(), fromNetwork = false)
                }
            }
        }
    }

    private fun dismissTracked(now: Long) {
        dismissOccurrence(prefs.getString(KEY_TRACKED, null), prefs.getLong(KEY_TRACKED_END, 0), now)
    }

    private fun dismissOccurrence(occurrence: String?, end: Long, now: Long) {
        val latestEnd = app.repository.snapshot.value.calendar?.days.orEmpty().flatMap { it.events }
            .firstOrNull { it.occurrenceId == occurrence }?.endsAt ?: end
        if (occurrence != null && latestEnd > now) saveDismissed(dismissed(now).apply { put(occurrence, latestEnd) })
        if (occurrence == prefs.getString(KEY_TRACKED, null)) clearTracked()
        updateTracker(app.repository.snapshot.value, now)
        scheduleExpiryCleanup(app.repository.snapshot.value, now)
    }

    private fun clearTracked() {
        notifications.cancel(TRACKER_TAG, SLOT_ID)
        cancelAlarm(ACTION_BOUNDARY, BOUNDARY_KEY)
        prefs.edit { remove(KEY_TRACKED); remove(KEY_TRACKED_END) }
    }

    private fun scheduleBoundary(at: Long, exact: Boolean = true) =
        scheduleAlarm(at, broadcast(ACTION_BOUNDARY, BOUNDARY_KEY).putExtra(EXTRA_EPOCH, epoch()), exact)
    private fun scheduleAlarm(at: Long, intent: Intent, exact: Boolean = true) {
        val operation = pending(intent)
        try {
            if (exact && (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms())) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
            else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
        } catch (_: SecurityException) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
        }
    }

    fun cancelAll() = synchronized(lock) {
        prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty().forEach { cancelAlarm(ACTION_REMINDER, it) }
        // Clean up PendingIntents from the old hash-based reminder implementation too.
        prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty().forEach(::cancelLegacyAlarm)
        cancelAlarm(ACTION_BOUNDARY, BOUNDARY_KEY)
        cancelAlarm(ACTION_CLEANUP, CLEANUP_KEY)
        val automatic = automaticTrackingEnabled
        prefs.edit { clear(); putBoolean(KEY_AUTOMATIC, automatic); putString(KEY_EPOCH, UUID.randomUUID().toString()); putBoolean(KEY_MIGRATED, true) }
        notifications.cancelAll()
    }

    private fun epoch(): String = prefs.getString(KEY_EPOCH, null) ?: UUID.randomUUID().toString().also { value -> prefs.edit { putString(KEY_EPOCH, value) } }
    private fun cancelLegacyAlarm(key: String) {
        PendingIntent.getBroadcast(context, key.hashCode(), Intent(context, ReminderReceiver::class.java).setAction("reminder:$key"),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let { alarms.cancel(it); it.cancel() }
    }
    private fun broadcast(action: String, key: String): Intent = Intent(context, if (action == ACTION_REMINDER) ReminderReceiver::class.java else TrackingReceiver::class.java)
        .setAction(action).setData(Uri.parse("unidash://notifications/${Uri.encode(action)}/${Uri.encode(key)}")).putExtra(EXTRA_KEY, key)
    private fun pending(intent: Intent): PendingIntent = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun cancelAlarm(action: String, key: String) {
        PendingIntent.getBroadcast(context, 0, broadcast(action, key), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
            ?.let { alarms.cancel(it); it.cancel() }
    }
    private fun openIntent(): PendingIntent = PendingIntent.getActivity(context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun reminderTag(key: String) = "reminder:$key"
    private fun headsupUntil(reminder: Reminder): Long? = if (reminder.channel == Channel.Classes &&
        reminder.occurrenceId == prefs.getString(KEY_HEADSUP_OCCURRENCE, null) && reminder.fireAt == prefs.getLong(KEY_HEADSUP_FIRE, Long.MIN_VALUE))
        prefs.getLong(KEY_HEADSUP_UNTIL, 0) else null
    private fun json(key: String): JSONObject = runCatching { JSONObject(prefs.getString(key, "{}").orEmpty()) }.getOrDefault(JSONObject())
    private fun fired(now: Long): JSONObject = json(KEY_FIRED).also { value -> value.keys().asSequence().toList().filter { value.optLong(it) <= now }.forEach(value::remove) }
    private fun dismissed(now: Long): MutableMap<String, Long> = json(KEY_DISMISSED).let { value ->
        val ends = app.repository.snapshot.value.calendar?.days.orEmpty().flatMap { it.events }.associate { it.occurrenceId to it.endsAt }
        value.keys().asSequence().map { it to (ends[it] ?: value.optLong(it)) }.filter { it.second > now }.toMap().toMutableMap()
    }
    private fun saveDismissed(values: Map<String, Long>) { prefs.edit { putString(KEY_DISMISSED, JSONObject(values).toString()) } }
    private fun encodeReminders(reminders: List<Reminder>): String = JSONArray().apply {
        reminders.forEach { r -> put(JSONObject().put("key", r.key).put("fire", r.fireAt).put("channel", r.channel.name)
            .put("title", r.title).put("text", r.text).put("expires", r.expiresAt).put("event", r.eventId)
            .put("occurrence", r.occurrenceId).put("starts", r.eventStartsAt).put("ends", r.eventEndsAt).put("slot", r.notificationKey)) }
    }.toString()
    private fun readReminders(key: String): List<Reminder> = runCatching {
        val array = JSONArray(prefs.getString(key, "[]").orEmpty())
        (0 until array.length()).map { index -> array.getJSONObject(index).let { r -> Reminder(
            r.getString("key"), r.getLong("fire"), Channel.valueOf(r.getString("channel")), r.getString("title"), r.getString("text"),
            r.getLong("expires"), r.getString("event"), r.getString("occurrence"), r.getLong("starts"), r.getLong("ends"), r.getString("slot")) } }
    }.getOrDefault(emptyList())

    companion object {
        const val EXTRA_KEY = "key"
        private const val EXTRA_EPOCH = "epoch"
        private const val EXTRA_FIRE_AT = "fire_at"
        private const val EXTRA_TRACKED_END = "tracked_end"
        private const val ACTION_REMINDER = "dev.peteryhs.unidash.REMINDER"
        private const val ACTION_BOUNDARY = "dev.peteryhs.unidash.TRACKING_BOUNDARY"
        private const val ACTION_CLEANUP = "dev.peteryhs.unidash.NOTIFICATION_CLEANUP"
        private const val ACTION_UNPIN = "dev.peteryhs.unidash.UNPIN"
        private const val BOUNDARY_KEY = "next-activity-boundary"
        private const val CLEANUP_KEY = "notification-expiry-cleanup"
        private const val TRACKER_TAG = "tracked-activity"
        private const val SLOT_ID = 1
        private const val LEGACY_PERSISTENT_ID = 0x554E49
        private const val KEY_SCHEDULED = "scheduled"
        private const val KEY_PENDING = "pending_records"
        private const val KEY_POSTED = "posted_records"
        private const val KEY_FIRED = "fired_records"
        private const val KEY_DISMISSED = "dismissed_occurrences"
        private const val KEY_TRACKED = "tracked_occurrence"
        private const val KEY_TRACKED_END = "tracked_end"
        private const val KEY_AUTOMATIC = "automatic_activity_tracking"
        private const val KEY_EPOCH = "session_epoch"
        private const val KEY_MIGRATED = "finite_notifications_migrated"
        private const val KEY_ALERT = "last_alert_key"
        private const val KEY_CHANGES = "schedule_change_ids"
        private const val KEY_CHANGE_SIGNATURES = "schedule_change_signatures"
        private const val KEY_NOTICES = "posted_notice_records"
        private const val KEY_AUTH_WARNED = "auth_warned"
        private const val KEY_HEADSUP_OCCURRENCE = "class_headsup_occurrence"
        private const val KEY_HEADSUP_FIRE = "class_headsup_fire_at"
        private const val KEY_HEADSUP_UNTIL = "class_headsup_until"
        private const val KEY_DONE_DEADLINES = "completed_deadline_events"
        private const val HEADSUP_GRACE_MS = 5_000L
        private val lock = Any()
    }
}

internal fun channelImportance(c: Channel): Int = when (c) {
    Channel.Classes, Channel.Alerts, Channel.Changes -> NotificationManager.IMPORTANCE_HIGH
    else -> NotificationManager.IMPORTANCE_DEFAULT
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { (context.applicationContext as UniDashApp).notifier.onReminderAlarm(intent) }
}
class TrackingReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { (context.applicationContext as UniDashApp).notifier.onTrackerAlarm(intent) }
}
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(
                Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED,
                "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED",
            )) return
        val app = context.applicationContext as UniDashApp
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                if (app.credentialStore.current() == null) {
                    app.notifier.cancelAll()
                    app.cancelSync()
                } else {
                    val snapshot = app.repository.snapshot.value
                    app.repository.deliverIfCurrent(snapshot) { app.notifier.onSnapshot(snapshot, fromNetwork = false); app.scheduleSync() }
                }
            } finally { pending.finish() }
        }
    }
}
