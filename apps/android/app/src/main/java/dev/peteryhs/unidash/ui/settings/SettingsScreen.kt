package dev.peteryhs.unidash.ui.settings

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AlarmOn
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing

@Composable
fun SettingsScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState, baseUrl: String?) {
    val context = LocalContext.current
    var health by remember { mutableStateOf<Result<Health>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(reload) { health = vm.health() }

    // Permission state changes in system settings, so re-read it whenever the screen returns.
    var notificationsOn by remember { mutableStateOf(true) }
    var exactAlarms by remember { mutableStateOf(true) }
    LifecycleResumeEffect(Unit) {
        notificationsOn = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
        exactAlarms = Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        onPauseOrDispose {}
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsOn = it }

    ScreenScaffold("Settings", null, snapshot, now, snackbar, onRefresh = { vm.refresh(); reload++ }) {
        item { SectionHeader("Connection") }
        item {
            ListItem(
                leadingContent = { Icon(Icons.Outlined.Link, null) },
                headlineContent = { Text(baseUrl ?: "Not connected") },
                supportingContent = {
                    Text(snapshot.fetchedAt?.let { "Last updated ${Format.dayTime(it)} · refreshes every minute while open, every 15 min in the background" } ?: "Not updated yet")
                },
            )
        }
        item {
            ListItem(
                leadingContent = { Icon(Icons.Outlined.Logout, null) },
                headlineContent = { Text("Disconnect this phone") },
                supportingContent = { Text("Removes the service token and saved data. Revoke the token in Zero Trust to lock it out entirely.") },
                trailingContent = { TextButton(onClick = { confirmSignOut = true }) { Text("Disconnect") } },
            )
        }

        item { SectionHeader("Notifications") }
        item {
            ListItem(
                leadingContent = { Icon(Icons.Outlined.Notifications, null) },
                headlineContent = { Text("Reminders and alerts") },
                supportingContent = { Text(if (notificationsOn) "On. Choose channels in system settings." else "Off. Class reminders, deadlines and outages will not reach you.") },
                trailingContent = {
                    TextButton(onClick = {
                        if (!notificationsOn && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    }) { Text(if (notificationsOn) "Channels" else "Turn on") }
                },
            )
        }
        if (!exactAlarms) item {
            ListItem(
                leadingContent = { Icon(Icons.Outlined.AlarmOn, null) },
                headlineContent = { Text("On-time class reminders") },
                supportingContent = { Text("Without this, reminders can arrive up to 5 minutes late.") },
                trailingContent = {
                    TextButton(onClick = {
                        context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")))
                    }) { Text("Allow") }
                },
            )
        }

        item { SectionHeader("Sources") }
        when (val h = health) {
            null -> item { LoadingIndicator(Modifier.padding(Spacing.m)) }
            else -> h.fold(
                onSuccess = { data ->
                    data.sources.forEach { s ->
                        item(key = "src:${s.id}") { SourceRow(s, data.now) }
                    }
                },
                onFailure = { e -> item { EmptyNote(MainViewModel.describe(e)) } },
            )
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Disconnect this phone?") },
            text = { Text("You'll need the client ID and secret to connect again.") },
            confirmButton = { TextButton(onClick = { confirmSignOut = false; vm.signOut() }) { Text("Disconnect") } },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SourceRow(s: dev.peteryhs.unidash.data.SourceHealth, now: Long) {
    val stale = LocalStaleColors.current
    val run = s.lastRun
    val failed = run?.outcome in setOf("error", "failed", "implausible")
    val old = run?.at != null && s.cadenceMs > 0 && now - run.at > s.cadenceMs * 3
    val (icon, tint) = when {
        !s.ready -> Icons.Outlined.HourglassEmpty to MaterialTheme.colorScheme.onSurfaceVariant
        failed -> Icons.Outlined.ErrorOutline to MaterialTheme.colorScheme.error
        old -> Icons.Outlined.ErrorOutline to stale.accent
        else -> Icons.Outlined.CheckCircle to MaterialTheme.colorScheme.primary
    }
    ListItem(
        leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
        headlineContent = { Text(s.id) },
        supportingContent = {
            Text(
                when {
                    !s.ready -> "Needs ${s.blockedBy.ifBlank { "configuration" }}"
                    run?.at == null -> "Not fetched yet"
                    else -> buildString {
                        append(run.outcome.ifBlank { "ok" }).append(" · ").append(Format.age(run.at, now))
                        if (old) append(" · overdue")
                        run.error?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                    }
                },
            )
        },
    )
}
