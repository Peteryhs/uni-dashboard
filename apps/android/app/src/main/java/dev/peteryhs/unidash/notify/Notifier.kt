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
import dev.peteryhs.unidash.data.Snapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

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
            manager.activeNotifications.filter { it.notification.channelId in setOf(Channel.Classes.id, Channel.Deadlines.id) && it.tag == null }
                .forEach { manager.cancel(it.id) }
            prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty().forEach(::cancelLegacyAlarm)
            prefs.edit { putBoolean(KEY_MIGRATED, true) }
        }
        epoch()
    }

    val canPost: Boolean get() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    private fun canPost(channel: Channel): Boolean = canPost && notifications.areNotificationsEnabled() &&
        manager.getNotificationChannel(channel.id)?.importance != NotificationManager.IMPORTANCE_NONE

    fun post(key: String, channel: Channel, title: String, text: String, bigText: String? = null): Boolean {
        if (!canPost(channel)) return false
        val slot = if (channel == Channel.Alerts) "campus-alert" else key
        val notification = NotificationCompat.Builder(context, channel.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText ?: text)).setContentIntent(openIntent())
            .setAutoCancel(true).setTimeoutAfter(24 * 3_600_000L).setCategory(NotificationCompat.CATEGORY_STATUS).build()
        return runCatching { notifications.notify("message:$slot", SLOT_ID, notification); true }.getOrDefault(false)
    }

    /** Activity permission/resume callbacks restore finite state, never a generic forever notice. */
    fun ensurePersistent(snapshot: Snapshot = app.repository.snapshot.value, now: Long = System.currentTimeMillis()) =
        onSnapshot(snapshot, now, fromNetwork = false)

    fun setAutomaticTracking(enabled: Boolean) {
        // This is a device preference, including while signed out. Session data stays fenced.
        synchronized(lock) {
            prefs.edit { putBoolean(KEY_AUTOMATIC, enabled) }
            if (!enabled) clearTracked()
        }
        val snapshot = app.repository.snapshot.value
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                updateTracker(snapshot, System.currentTimeMillis())
            }
        }
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
                scheduleBoundary(state.nextUpdateAt)
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
                manager.cancel(LEGACY_PERSISTENT_ID)
                reconcilePosted(snapshot, now)
                // A sync can arrive after an alarm's due time but before Android delivers it.
                // Drain still-valid pending records before replacing the future-only plan.
                readReminders(KEY_PENDING).filter { it.fireAt <= now }.forEach {
                    deliverReminder(snapshot, it.key, it.fireAt, now)
                }
                scheduleReminders(NotificationPlanner.plan(snapshot.calendar, now))
                updateTracker(snapshot, now)
                if (fromNetwork) {
                    val shown = prefs.getStringSet(KEY_CHANGES, emptySet()).orEmpty().toMutableSet()
                    shown.retainAll(snapshot.calendar?.alerts.orEmpty().map { it.id }.toSet())
                    for (change in NotificationPlanner.changesToShow(snapshot.calendar, shown, now)) {
                        if (post("change:${change.id}", Channel.Changes, change.title, change.body)) {
                            snapshot.calendar?.alerts.orEmpty().filter {
                                it.course == change.course && it.kind == change.kind && it.observedAt == change.observedAt &&
                                    it.location == change.location && it.previousLocation == change.previousLocation && it.kind != "unusual_room"
                            }.forEach { shown.add(it.id) }
                            shown.add(change.id)
                        }
                    }
                    prefs.edit { putStringSet(KEY_CHANGES, shown); putBoolean(KEY_AUTH_WARNED, false) }
                    notifications.cancel("message:account", SLOT_ID)
                }
                val alert = snapshot.bundle?.card("alert")?.payload<Alert>()
                NotificationPlanner.alertToShow(alert, prefs.getString(KEY_ALERT, null))?.let { a ->
                    val notice = a.notices.firstOrNull()
                    if (post("alert:${a.key}", Channel.Alerts, notice?.title ?: "Campus alert", a.summary.ifBlank { notice?.body ?: "" }, notice?.body)) {
                        prefs.edit { putString(KEY_ALERT, a.key) }
                    }
                }
                if (alert != null && (alert.count == 0 || alert.dismissed)) notifications.cancel("message:campus-alert", SLOT_ID)
            }
        }
    }

    fun onUnauthorized(message: String) = synchronized(lock) {
        if (!prefs.getBoolean(KEY_AUTH_WARNED, false) && post("account", Channel.Account, "Uni Dashboard can't connect", message)) {
            prefs.edit { putBoolean(KEY_AUTH_WARNED, true) }
        }
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
                deliverReminder(snapshot, key, fireAt, now)
            }
        }
    }

    private fun deliverReminder(snapshot: Snapshot, key: String, fireAt: Long, now: Long) {
        val reminder = NotificationPlanner.resolveReminder(snapshot.calendar, key, fireAt, now) ?: return
        val fired = fired(now)
        val identity = "$key@$fireAt"
        if (fired.has(identity)) return
        val trackedOccurrence = updateTracker(snapshot, now)
        if (reminder.channel == Channel.Classes && trackedOccurrence == reminder.occurrenceId) {
            prefs.edit { putString(KEY_HEADSUP_OCCURRENCE, reminder.occurrenceId); putLong(KEY_HEADSUP_FIRE, fireAt); putLong(KEY_HEADSUP_UNTIL, now + HEADSUP_GRACE_MS) }
        }
        if (postReminder(reminder, now)) {
            fired.put(identity, reminder.expiresAt)
            val posted = readReminders(KEY_POSTED).filterNot { it.notificationKey == reminder.notificationKey } + reminder
            prefs.edit { putString(KEY_FIRED, fired.toString()); putString(KEY_POSTED, encodeReminders(posted)) }
        }
    }

    private fun postReminder(reminder: Reminder, now: Long, silent: Boolean = false): Boolean {
        if (!canPost(reminder.channel) || reminder.expiresAt <= now) return false
        val expiresAt = minOf(reminder.expiresAt, headsupUntil(reminder) ?: Long.MAX_VALUE)
        if (expiresAt <= now) return false
        val notification = NotificationCompat.Builder(context, reminder.channel.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(reminder.title).setContentText(reminder.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reminder.text)).setContentIntent(openIntent())
            .setAutoCancel(true).setOnlyAlertOnce(silent).setSilent(silent)
            .setTimeoutAfter(expiresAt - now).setCategory(NotificationCompat.CATEGORY_REMINDER).build()
        return runCatching { notifications.notify(reminderTag(reminder.notificationKey), SLOT_ID, notification); true }.getOrDefault(false)
    }

    private fun reconcilePosted(snapshot: Snapshot, now: Long) {
        val previous = readReminders(KEY_POSTED)
        val active = manager.activeNotifications.map { it.tag }.toSet()
        val next = NotificationPlanner.reconcilePosted(snapshot.calendar, previous, now)
            .filter { reminderTag(it.notificationKey) in active && canPost(it.channel) && (headsupUntil(it) ?: Long.MAX_VALUE) > now }
        (previous.map { it.notificationKey }.toSet() - next.map { it.notificationKey }.toSet())
            .forEach { notifications.cancel(reminderTag(it), SLOT_ID) }
        for (reminder in next) if (previous.none { it == reminder }) postReminder(reminder, now, silent = true)
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
        if (boundary == null || !canPost(Channel.Persistent)) cancelAlarm(ACTION_BOUNDARY, BOUNDARY_KEY) else scheduleBoundary(boundary)
        return postedOccurrence
    }

    private fun renderTracker(state: LiveClassState, now: Long): Boolean {
        val remove = pending(broadcast(ACTION_UNPIN, state.occurrenceId).putExtra(EXTRA_EPOCH, epoch()).putExtra(EXTRA_TRACKED_END, state.endsAt))
        val builder = NotificationCompat.Builder(context, Channel.Persistent.id)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(state.title).setContentText(state.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(state.expandedText)).setContentIntent(openIntent())
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setCategory(NotificationCompat.CATEGORY_EVENT)
            .setWhen(state.countdownAt).setUsesChronometer(true).setChronometerCountDown(true)
            .setProgress(100, state.progress, false).setTimeoutAfter(state.expiresAt - now)
            .addAction(0, "Unpin", remove).setDeleteIntent(remove)
        if (Build.VERSION.SDK_INT >= 36 && manager.canPostPromotedNotifications()) builder.setRequestPromotedOngoing(true)
        return runCatching { notifications.notify(TRACKER_TAG, SLOT_ID, builder.build()); true }.getOrDefault(false)
    }

    fun onTrackerAlarm(intent: Intent) {
        val snapshot = app.repository.snapshot.value
        app.repository.deliverIfCurrent(snapshot) {
            synchronized(lock) {
                if (intent.getStringExtra(EXTRA_EPOCH) != epoch()) return@synchronized
                if (intent.action == ACTION_UNPIN) {
                    dismissOccurrence(intent.getStringExtra(EXTRA_KEY), intent.getLongExtra(EXTRA_TRACKED_END, 0), System.currentTimeMillis())
                } else if (intent.action == ACTION_BOUNDARY) updateTracker(snapshot, System.currentTimeMillis())
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
    }

    private fun clearTracked() {
        notifications.cancel(TRACKER_TAG, SLOT_ID)
        cancelAlarm(ACTION_BOUNDARY, BOUNDARY_KEY)
        prefs.edit { remove(KEY_TRACKED); remove(KEY_TRACKED_END) }
    }

    private fun scheduleBoundary(at: Long) = scheduleAlarm(at, broadcast(ACTION_BOUNDARY, BOUNDARY_KEY).putExtra(EXTRA_EPOCH, epoch()))
    private fun scheduleAlarm(at: Long, intent: Intent) {
        val operation = pending(intent)
        try {
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
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
        private const val ACTION_UNPIN = "dev.peteryhs.unidash.UNPIN"
        private const val BOUNDARY_KEY = "next-activity-boundary"
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
        private const val KEY_AUTH_WARNED = "auth_warned"
        private const val KEY_HEADSUP_OCCURRENCE = "class_headsup_occurrence"
        private const val KEY_HEADSUP_FIRE = "class_headsup_fire_at"
        private const val KEY_HEADSUP_UNTIL = "class_headsup_until"
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
        val app = context.applicationContext as UniDashApp
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val snapshot = app.repository.snapshot.value
                app.repository.deliverIfCurrent(snapshot) { app.notifier.onSnapshot(snapshot, fromNetwork = false); app.scheduleSync() }
            } finally { pending.finish() }
        }
    }
}
