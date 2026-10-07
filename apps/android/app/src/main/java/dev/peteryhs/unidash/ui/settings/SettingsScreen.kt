package dev.peteryhs.unidash.ui.settings

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.SourceHealth
import dev.peteryhs.unidash.data.conditionAt
import dev.peteryhs.unidash.data.summaryAt
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.setup.MobileSetupGuide
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing

enum class SettingsDestination(val title: String) {
    Overview("Settings"),
    Connections("Connections"),
    Notifications("Notifications"),
    Status("Status"),
    About("About"),
}

@Composable
fun SettingsScreen(
    vm: MainViewModel,
    snapshot: Snapshot,
    now: Long,
    snackbar: SnackbarHostState,
    baseUrl: String?,
    managedOAuth: Boolean,
    onReauthenticate: (String) -> Unit,
    destination: SettingsDestination = SettingsDestination.Overview,
    onDestination: (SettingsDestination) -> Unit = {},
    onStatus: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val browser by vm.browserState.collectAsStateWithLifecycle()
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var guideOpen by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = destination != SettingsDestination.Overview) {
        onDestination(SettingsDestination.Overview)
    }

    LaunchedEffect(destination) {
        if (destination == SettingsDestination.Status) vm.refreshHealth()
    }

    var notificationsOn by remember { mutableStateOf(true) }
    var exactAlarms by remember { mutableStateOf(true) }
    LifecycleResumeEffect(Unit) {
        notificationsOn = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
        exactAlarms = Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        onPauseOrDispose {}
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsOn = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    val title = destination.title
    ScreenScaffold(
        title = title,
        subtitle = null,
        snapshot = snapshot,
        now = now,
        snackbar = snackbar,
        refreshing = if (destination == SettingsDestination.Status) snapshot.healthRefreshing else snapshot.refreshing,
        navigationIcon = {
            if (destination != SettingsDestination.Overview) {
                IconButton(onClick = { onDestination(SettingsDestination.Overview) }) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to settings")
                }
            }
        },
        onStatus = if (destination == SettingsDestination.Status) null else onStatus,
        showConnectionBanner = destination != SettingsDestination.Status,
        onRefresh = if (destination == SettingsDestination.Status) vm::refreshHealth else vm::refresh,
    ) {
        when (destination) {
            SettingsDestination.Overview -> settingsOverview(snapshot, now, onDestination)
            SettingsDestination.Connections -> connectionsSettings(
                baseUrl, managedOAuth, browser.error, browser.busy, onReauthenticate,
                onOpenGuide = { guideOpen = true },
                onDisconnect = { confirmSignOut = true },
            )
            SettingsDestination.Notifications -> notificationsSettings(
                notificationsOn = notificationsOn,
                exactAlarms = exactAlarms,
                onNotifications = {
                    if (!notificationsOn && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                },
                onExactAlarms = {
                    context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")))
                },
            )
            SettingsDestination.Status -> statusSettings(snapshot, now)
            SettingsDestination.About -> aboutSettings { uri.openUri("https://github.com/Peteryhs/uni-dashboard") }
        }
    }

    if (guideOpen) MobileSetupGuide(
        dashboardAddress = baseUrl,
        onDismiss = { guideOpen = false },
        onNotifications = {
            guideOpen = false
            onDestination(SettingsDestination.Notifications)
        },
    )

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Disconnect this phone?") },
            text = { Text("This removes the saved connection and cached dashboard data. You can sign in again from the setup screen.") },
            confirmButton = { TextButton(onClick = { confirmSignOut = false; vm.signOut() }) { Text("Disconnect") } },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.settingsOverview(
    snapshot: Snapshot,
    now: Long,
    onDestination: (SettingsDestination) -> Unit,
) {
    item { SectionHeader("Settings") }
    val rows = listOf(
        Triple(SettingsDestination.Connections, "Dashboard address, sign-in and setup guide", "Connections"),
        Triple(SettingsDestination.Notifications, "Class reminders and app alerts", "Notifications"),
        Triple(SettingsDestination.Status, statusTeaser(snapshot, now), "Status"),
        Triple(SettingsDestination.About, "App version and project information", "About"),
    )
    rows.forEach { (destination, detail, label) ->
        item(key = "settings:${destination.name}") {
            ListItem(
                headlineContent = { Text(label) },
                supportingContent = { Text(detail) },
                trailingContent = { Text("Open", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) },
                modifier = Modifier.fillMaxWidth().clickable { onDestination(destination) },
            )
        }
    }
}

private fun statusTeaser(snapshot: Snapshot, now: Long): String {
    val summary = snapshot.health?.summaryAt(now)
    return when {
        snapshot.healthError != null && snapshot.health != null -> "Status check failed · showing last known status"
        snapshot.healthError != null -> "Source status could not be checked"
        summary?.condition == "healthy" -> "All monitored sources are current"
        summary?.warning != null -> summary.warning
        snapshot.health != null -> "Source status is incomplete"
        else -> "Waiting for a live source check"
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.connectionsSettings(
    baseUrl: String?,
    managedOAuth: Boolean,
    browserError: String?,
    browserBusy: Boolean,
    onReauthenticate: (String) -> Unit,
    onOpenGuide: () -> Unit,
    onDisconnect: () -> Unit,
) {
    item { SectionHeader("Dashboard") }
    item {
        ListItem(
            headlineContent = { Text("Setup guide") },
            supportingContent = { Text("Connect calendar feeds in the web app and finish phone setup.") },
            trailingContent = { TextButton(onClick = onOpenGuide) { Text("Open guide") } },
        )
    }
    item {
        ListItem(
            headlineContent = { Text("Dashboard address") },
            supportingContent = { Text(baseUrl ?: "Not connected") },
        )
    }
    item {
        ListItem(
            headlineContent = {
                Text(if (managedOAuth) "Managed sign-in" else "Browser sign-in")
            },
            supportingContent = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text(
                        when {
                            browserError != null -> "$browserError Try again when you are ready."
                            managedOAuth -> "This phone uses Cloudflare Access in the system browser. No service token is stored."
                            else -> "Use browser sign-in when it is enabled for this dashboard."
                        },
                    )
                    if (baseUrl == null) Text("Connect from the setup screen first.")
                }
            },
            trailingContent = {
                TextButton(onClick = { baseUrl?.let(onReauthenticate) }, enabled = baseUrl != null && !browserBusy) {
                    Text(if (browserBusy) "Opening…" else if (managedOAuth) "Sign in again" else "Use browser")
                }
            },
        )
    }
    item {
        ListItem(
            headlineContent = { Text("Disconnect this phone") },
            supportingContent = {
                Text(
                    if (managedOAuth) "Removes this phone’s saved sign-in and cached dashboard data. Your browser login stays active."
                    else "Removes the saved service token and cached dashboard data."
                )
            },
            trailingContent = { TextButton(onClick = onDisconnect) { Text("Disconnect") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.notificationsSettings(
    notificationsOn: Boolean,
    exactAlarms: Boolean,
    onNotifications: () -> Unit,
    onExactAlarms: () -> Unit,
) {
    item { SectionHeader("Notifications") }
    item {
        ListItem(
            headlineContent = { Text("Reminders and alerts") },
            supportingContent = {
                Text(if (notificationsOn) "On. Choose channels in system settings." else "Off. Class reminders, deadlines and outages will not reach you.")
            },
            trailingContent = { TextButton(onClick = onNotifications) { Text(if (notificationsOn) "Channels" else "Turn on") } },
        )
    }
    if (!exactAlarms) item {
        ListItem(
            headlineContent = { Text("On-time class reminders") },
            supportingContent = { Text("Without exact-alarm access, reminders can arrive a few minutes late.") },
            trailingContent = { TextButton(onClick = onExactAlarms) { Text("Allow") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.statusSettings(snapshot: Snapshot, now: Long) {
    val health = snapshot.health
    val summary = health?.summaryAt(now)
    val title = when {
        snapshot.healthError != null && health != null -> "Last known status · check failed"
        health == null && snapshot.healthError != null -> "Status could not be checked"
        health == null && (snapshot.refreshing || snapshot.healthRefreshing) -> "Checking sources"
        health == null -> "Waiting for a live source check"
        summary?.condition == "healthy" -> "Sources are current"
        summary?.condition == "attention" -> "Some sources need attention"
        else -> "Status is incomplete"
    }
    val detail = when {
        snapshot.healthError != null && health != null -> "${MainViewModel.describe(snapshot.healthError)} Last status check ${Format.age(health.now, now).removeSuffix(" old").let { age -> if (age == "just now") age else "$age ago" }}."
        snapshot.healthError != null -> MainViewModel.describe(snapshot.healthError)
        summary?.warning != null -> summary.warning
        summary?.condition == "healthy" -> "All monitored sources have a recent successful update."
        health == null && snapshot.healthRefreshing -> "Checking source status now. A missing check is unknown, not an all clear."
        health == null -> "A missing status check is unknown, not an all clear. Pull to refresh to try again."
        else -> "Some sources have not been checked successfully yet."
    }

    item { SectionHeader("Source health") }
    item {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m),
        ) {
            val tone = when {
                snapshot.healthError != null -> MaterialTheme.colorScheme.error
                summary?.condition == "healthy" -> MaterialTheme.colorScheme.primary
                summary?.condition == "attention" -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.tertiary
            }
            Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Text(title, style = MaterialTheme.typography.titleMediumEmphasized, color = tone)
                Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (snapshot.healthRefreshing) {
                    Text("Checking for updates…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (summary != null && summary.total > 0) {
                    Text(
                        "${summary.healthy} of ${summary.total} monitored sources within their freshness window · ${summary.issues} ${if (summary.issues == 1) "needs" else "need"} attention · ${summary.unchecked} unchecked",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
                health?.let {
                    Text("Checked ${Format.age(it.now, now).removeSuffix(" old").let { age -> if (age == "just now") age else "$age ago" }}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }

    health?.runtime?.let { runtime ->
        item { SectionHeader("Runtime") }
        item {
            ListItem(
                headlineContent = { Text(if (runtime.target == "cloudflare") "Cloudflare Worker" else "Local relay") },
                supportingContent = {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        Text("Current instance age ${uptime(runtime.uptimeS)} · ${if (runtime.uptimeScope == "isolate") "since this isolate started" else "since this process started"}")
                        Text("Polling: ${runtime.polling.replaceFirstChar { it.uppercase() }}")
                        Text("Instance age does not measure service availability.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
            )
        }
    }

    item { SectionHeader("Sources") }
    if (health == null) {
        item {
            EmptyNote(
                if (snapshot.healthRefreshing) "Checking source status now."
                else snapshot.healthError?.let(MainViewModel::describe)
                    ?: "Source details appear after the next status check.",
            )
        }
    } else if (health.sources.isEmpty()) {
        item { EmptyNote("No source details were returned.") }
    } else {
        health.sources.forEach { source -> item(key = "health:${source.id}") { HealthSourceRow(source, now) } }
    }
    item {
        Text(
            "Optional and shared feeds are not counted in the monitored total.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
        )
    }
}

@Composable
private fun HealthSourceRow(source: SourceHealth, now: Long) {
    val stale = LocalStaleColors.current
    val condition = source.conditionAt(now)
    val excluded = source.monitored == false || (source.optional && !source.ready)
    val (label, tone) = when {
        excluded -> if (source.ready) "Shared connection" to MaterialTheme.colorScheme.onSurfaceVariant else "Not counted" to MaterialTheme.colorScheme.onSurfaceVariant
        condition == "healthy" -> "Current" to MaterialTheme.colorScheme.primary
        condition == "partial" -> "Partial data" to MaterialTheme.colorScheme.tertiary
        condition == "stale" -> "Stale" to stale.accent
        condition == "dead" -> "Out of date" to stale.accent
        condition == "failing" -> "Update failed" to MaterialTheme.colorScheme.error
        condition == "blocked" -> "Not set up" to MaterialTheme.colorScheme.error
        else -> "Unchecked" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val lastRun = source.lastRun
    val lastSuccessAt = source.lastSuccessAt ?: lastRun?.takeIf { it.outcome in setOf("ok", "empty") }?.at
    val hasCheckDetails = condition == "failing" || condition == "partial" || !lastRun?.error.isNullOrBlank()
    var checkDetailsExpanded by rememberSaveable(source.id) { mutableStateOf(false) }
    val details = buildList {
        if (excluded) {
            add(
                when {
                    source.ready -> "Not counted in the monitored total"
                    source.optional -> "Optional feed · not configured"
                    else -> "Alternate feed · not configured"
                },
            )
        } else {
            lastSuccessAt?.let { add("Updated ${ageAgo(it, now)}") } ?: add("No successful update")
            if (condition == "blocked") add("Add feed in Connections")
            if (condition == "failing") {
                lastRun?.at?.let { add("Attempt ${ageAgo(it, now)}") }
                lastRun?.error?.takeIf { it.isNotBlank() }?.let { add(it) }
            }
            if (condition == "partial") add("Some events were skipped")
        }
    }.joinToString(" · ")
    val savedCheckDetails = buildList {
        lastSuccessAt?.let { add("Last successful update ${Format.dayTime(it)}") }
        lastRun?.let { run ->
            run.at?.let { add("Last attempt ${Format.dayTime(it)}") }
            run.outcome.takeIf { it.isNotBlank() }?.let { add("Result: $it") }
            add("Rows returned: ${run.rows}")
            run.error?.takeIf { it.isNotBlank() }?.let { add("Error: $it") }
            run.meta.forEach { (key, value) -> add("$key: $value") }
        }
    }

    ListItem(
        headlineContent = { Text(source.name.ifBlank { SOURCE_NAMES[source.id] ?: source.id }) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(
                    details,
                    maxLines = if (checkDetailsExpanded) Int.MAX_VALUE else 2,
                    overflow = if (checkDetailsExpanded) TextOverflow.Clip else TextOverflow.Ellipsis,
                )
                if (checkDetailsExpanded) {
                    savedCheckDetails.forEach { detail ->
                        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (hasCheckDetails) {
                    TextButton(
                        onClick = { checkDetailsExpanded = !checkDetailsExpanded },
                        modifier = Modifier.semantics {
                            contentDescription = if (checkDetailsExpanded) {
                                "Hide full check details for ${source.name}"
                            } else {
                                "Show full check details for ${source.name}"
                            }
                        },
                    ) {
                        Text(if (checkDetailsExpanded) "Hide" else "Details")
                    }
                }
            }
        },
        trailingContent = { Text(label, style = MaterialTheme.typography.labelMedium, color = tone) },
        modifier = Modifier.animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
    )
}

private fun ageAgo(since: Long, now: Long): String {
    val age = Format.age(since, now).removeSuffix(" old")
    return if (age == "just now") age else "$age ago"
}

private fun androidx.compose.foundation.lazy.LazyListScope.aboutSettings(onSource: () -> Unit) {
    item {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text("Uni Dashboard", style = MaterialTheme.typography.headlineSmallEmphasized)
            Text("Version ${dev.peteryhs.unidash.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text(
                "A centralized dashboard for calendars, deadlines, dining, and everyday Waterloo student life.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("Created by Peter (Peteryhs)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onSource) { Text("View source on GitHub") }
        }
    }
}

private fun uptime(seconds: Long): String {
    val safe = seconds.coerceAtLeast(0)
    val days = safe / 86_400
    val hours = safe % 86_400 / 3_600
    val minutes = safe % 3_600 / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}m"
        else -> "${minutes}m"
    }
}

private val SOURCE_NAMES = mapOf(
    "uw-food-daily-menu" to "Dining menu",
    "uw-status" to "Campus services",
    "open-meteo" to "Weather",
    "uw-portal-ics" to "Class schedule",
    "google-calendar-ics" to "Google Calendar",
    "uw-learn-ics" to "LEARN deadlines",
    "user-office-hours" to "Office hours",
)
