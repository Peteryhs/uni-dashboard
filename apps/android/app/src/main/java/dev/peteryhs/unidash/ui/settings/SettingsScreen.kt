package dev.peteryhs.unidash.ui.settings

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AlarmOn
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing
import dev.peteryhs.unidash.ui.setup.MobileSetupGuide

@Composable
fun SettingsScreen(
    vm: MainViewModel,
    snapshot: Snapshot,
    now: Long,
    snackbar: SnackbarHostState,
    baseUrl: String?,
    managedOAuth: Boolean,
    onReauthenticate: (String) -> Unit,
) {
    val context = LocalContext.current
    val browser by vm.browserState.collectAsStateWithLifecycle()
    var health by remember { mutableStateOf<Result<Health>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var guideOpen by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(reload) { health = vm.health() }
    val healthError = health?.exceptionOrNull()
    val needsReauthentication = managedOAuth && (snapshot.error is RelayError.ReauthRequired || healthError is RelayError.ReauthRequired)
    val dashboardOffline = snapshot.error is RelayError.Offline || healthError is RelayError.Offline

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
                headlineContent = { Text("Setup guide") },
                supportingContent = { Text("Web calendar feeds, Cloudflare sign-in and phone reminders") },
                trailingContent = { TextButton(onClick = { guideOpen = true }) { Text("Open guide") } },
            )
        }
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
                leadingContent = { Icon(Icons.Outlined.Lock, null) },
                headlineContent = {
                    Text(
                        when {
                            needsReauthentication -> "Sign-in required"
                            dashboardOffline -> "Dashboard unavailable"
                            managedOAuth -> "Managed sign-in"
                            else -> "Browser sign-in"
                        },
                    )
                },
                supportingContent = {
                    Text(
                        when {
                            browser.error != null -> "${browser.error} Try again when you are ready."
                            needsReauthentication -> "Your dashboard needs a new sign-in. Sign in again to keep it current."
                            dashboardOffline -> "The dashboard could not be reached. Cached data remains available; try again when you are online."
                            !managedOAuth -> "Switch this phone to your browser login when your dashboard supports it. Your current connection stays available until sign-in succeeds."
                            else -> "This phone uses Cloudflare Access in the system browser. No service token is stored."
                        },
                    )
                },
                trailingContent = {
                    TextButton(
                        onClick = { baseUrl?.let(onReauthenticate) },
                        enabled = baseUrl != null && !browser.busy,
                    ) { Text(if (browser.busy) "Opening…" else if (managedOAuth) "Sign in again" else "Use browser") }
                },
            )
        }
        item {
            ListItem(
                leadingContent = { Icon(Icons.Outlined.Logout, null) },
                headlineContent = { Text("Disconnect this phone") },
                    supportingContent = {
                        Text(
                            if (managedOAuth) "Removes this phone's saved sign-in and cached dashboard data. Your Cloudflare browser login stays active."
                            else "Removes the service token and saved dashboard data. Revoke the token in Zero Trust to lock it out entirely."
                        )
                    },
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

        item { AboutSection(baseUrl, health) }
    }

    if (guideOpen) MobileSetupGuide(
        dashboardAddress = baseUrl,
        onDismiss = { guideOpen = false },
        onNotifications = { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) },
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

/** App identity and the compact instance details shown by the web settings panel. */
@Composable
private fun AboutSection(baseUrl: String?, health: Result<Health>?) {
    val uri = LocalUriHandler.current
    val sourceHealth = health?.getOrNull()
    val sources = sourceHealth?.sources.orEmpty()
    val nominal = sources.count { source ->
        source.ready && (source.lastRun == null || source.lastRun.outcome == "ok")
    }
    // Health success means the relay answered; feed health below remains a separate signal.
    val status = when {
        health == null -> "Checking…"
        health.isSuccess -> "Operational"
        else -> "Unreachable"
    }
    val statusColor = when (status) {
        "Operational" -> MaterialTheme.colorScheme.primary
        "Checking…" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.error
    }
    val runtimeTarget = when (Uri.parse(baseUrl.orEmpty()).host?.lowercase()) {
        "localhost", "127.0.0.1", "10.0.2.2" -> "Local Relay Engine (Node)"
        null -> "Unknown runtime"
        else -> "Cloudflare Workers (Edge)"
    }

    Column(
        Modifier.fillMaxWidth().padding(start = Spacing.m, top = Spacing.xl, end = Spacing.m, bottom = Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(
            "About",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(top = Spacing.l, bottom = Spacing.s),
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Uni Dashboard", style = MaterialTheme.typography.headlineSmallEmphasized)
                Text("v${dev.peteryhs.unidash.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }
            Text(status, style = MaterialTheme.typography.labelMedium, color = statusColor)
        }
        Text(
            "A centralized dashboard for calendars, deadlines, dining, and everyday Waterloo student life.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "Created by Peter (Peteryhs)",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = { uri.openUri("https://github.com/Peteryhs/uni-dashboard") }) {
            Text("View source on GitHub")
        }

        Text("Instance status", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        AboutMetric("Runtime target", runtimeTarget)
        AboutMetric("Feed health", if (sources.isNotEmpty()) "$nominal / ${sources.size} nominal" else "Unavailable")
        AboutMetric("Host endpoint", baseUrl ?: "Not connected")
        AboutMetric("Campus timezone", "America/Toronto")

        Text("Acknowledgements & sources", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "Built on official University of Waterloo campus systems and open telemetry feeds.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ABOUT_SOURCES.forEach { (name, description, format) ->
            AboutSourceRow(name, description, format)
        }
    }
}

@Composable
private fun AboutMetric(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = Spacing.xs)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AboutSourceRow(name: String, description: String, format: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyMedium)
            Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(format, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }
}

private val ABOUT_SOURCES = listOf(
    Triple("Waterloo LEARN (D2L)", "Schedule & deliverables", "iCal / API"),
    Triple("UW Portal & Open Data", "Timetable & locations", "iCal / REST"),
    Triple("UW Food Services", "Cafeteria daily menus", "Daily HTML"),
    Triple("UW IST Campus Status", "IT infrastructure health", "Status API"),
    Triple("Open-Meteo", "Campus weather models", "Forecast API"),
    Triple("Cloudflare", "Workers, D1 & Workers AI", "Edge Platform"),
)

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
        headlineContent = { Text(SOURCE_NAMES[s.id] ?: s.id) },
        supportingContent = {
            Text(
                when {
                    !s.ready -> "Not set up · ${s.blockedBy.ifBlank { "needs configuration" }}"
                    run?.at == null -> "Not fetched yet"
                    else -> buildString {
                        append(OUTCOMES[run.outcome] ?: run.outcome.ifBlank { "OK" }).append(" · updated ").append(Format.age(run.at, now).removeSuffix(" old").let { if (it == "just now") it else "$it ago" })
                        if (old) append(" · overdue")
                        run.error?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                    }
                },
            )
        },
    )
}

private val SOURCE_NAMES = mapOf(
    "uw-food-daily-menu" to "Daily menus",
    "uw-status" to "Campus and IT status",
    "open-meteo" to "Weather",
    "uw-portal-ics" to "Class schedule",
    "google-calendar-ics" to "Google Calendar",
    "uw-learn-ics" to "LEARN deadlines",
    "user-office-hours" to "Office hours",
)

private val OUTCOMES = mapOf("ok" to "OK", "empty" to "Nothing published", "failed" to "Failed")
