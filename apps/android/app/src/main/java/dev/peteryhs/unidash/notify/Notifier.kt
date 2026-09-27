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
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import dev.peteryhs.unidash.MainActivity
import dev.peteryhs.unidash.R
import dev.peteryhs.unidash.UniDashApp
import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.Snapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Posts notifications and keeps the AlarmManager reminders in step with the calendar. */
class Notifier(private val context: Context) {
    private val prefs = context.getSharedPreferences("notifications", Context.MODE_PRIVATE)
    private val alarms = context.getSystemService(AlarmManager::class.java)

    fun createChannels() {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (c in Channel.entries) {
            val importance = if (c == Channel.Alerts || c == Channel.Classes) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
            manager.createNotificationChannel(NotificationChannel(c.id, c.label, importance).apply { description = c.description })
        }
    }

    val canPost: Boolean
        get() = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun post(key: String, channel: Channel, title: String, text: String, bigText: String? = null) {
        if (!canPost) return
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, channel.id)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText ?: text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(if (channel == Channel.Classes) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(key.hashCode(), n)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }

    /** Called after every successful refresh, from the app or the background worker. */
    fun onSnapshot(snapshot: Snapshot, now: Long = System.currentTimeMillis(), fromNetwork: Boolean = true) {
        scheduleReminders(NotificationPlanner.plan(snapshot.calendar, now))
        val alert = snapshot.bundle?.card("alert")?.payload<Alert>()
        NotificationPlanner.alertToShow(alert, prefs.getString(KEY_ALERT, null))?.let { a ->
            val notice = a.notices.firstOrNull()
            post("alert:${a.key}", Channel.Alerts, notice?.title ?: "Campus alert", a.summary.ifBlank { notice?.body ?: "" }, notice?.body)
            prefs.edit { putString(KEY_ALERT, a.key) }
        }
        if (fromNetwork) prefs.edit { putBoolean(KEY_AUTH_WARNED, false) }
    }

    /** Once per failure streak, not every 15 minutes. */
    fun onUnauthorized(message: String) {
        if (prefs.getBoolean(KEY_AUTH_WARNED, false)) return
        post("account", Channel.Account, "Uni Dashboard can't connect", message)
        prefs.edit { putBoolean(KEY_AUTH_WARNED, true) }
    }

    private fun scheduleReminders(reminders: List<Reminder>) {
        val previous = prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty()
        val next = reminders.map { it.key }.toSet()
        (previous - next).forEach { alarms.cancel(pendingFor(it, null)) }
        for (r in reminders) {
            val pi = pendingFor(r.key, r)
            val exact = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()
            if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, r.fireAt, pi)
            else alarms.setWindow(AlarmManager.RTC_WAKEUP, r.fireAt - 5 * 60_000, 5 * 60_000, pi)
        }
        prefs.edit { putStringSet(KEY_SCHEDULED, next) }
    }

    fun cancelAll() {
        prefs.getStringSet(KEY_SCHEDULED, emptySet()).orEmpty().forEach { alarms.cancel(pendingFor(it, null)) }
        prefs.edit { clear() }
        NotificationManagerCompat.from(context).cancelAll()
    }

    private fun pendingFor(key: String, r: Reminder?): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).setAction("reminder:$key")
        if (r != null) {
            intent.putExtra(EXTRA_KEY, r.key).putExtra(EXTRA_CHANNEL, r.channel.name)
                .putExtra(EXTRA_TITLE, r.title).putExtra(EXTRA_TEXT, r.text)
        }
        return PendingIntent.getBroadcast(context, key.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        const val EXTRA_KEY = "key"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        private const val KEY_SCHEDULED = "scheduled"
        private const val KEY_ALERT = "last_alert_key"
        private const val KEY_AUTH_WARNED = "auth_warned"
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getStringExtra(Notifier.EXTRA_KEY) ?: return
        val channel = runCatching { Channel.valueOf(intent.getStringExtra(Notifier.EXTRA_CHANNEL)!!) }.getOrDefault(Channel.Classes)
        Notifier(context).post(key, channel, intent.getStringExtra(Notifier.EXTRA_TITLE).orEmpty(), intent.getStringExtra(Notifier.EXTRA_TEXT).orEmpty())
    }
}

/** Alarms do not survive a reboot; re-plan them from the cached calendar. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as UniDashApp
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                app.notifier.onSnapshot(app.repository.snapshot.value, fromNetwork = false)
                app.scheduleSync()
            } finally {
                pending.finish()
            }
        }
    }
}
