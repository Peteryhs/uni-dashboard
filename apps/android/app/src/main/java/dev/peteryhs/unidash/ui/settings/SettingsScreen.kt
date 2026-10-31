package dev.peteryhs.unidash.ui.settings

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.HealthAndSafety
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.DirectionsBus
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.SourceHealth
import dev.peteryhs.unidash.data.conditionAt
import dev.peteryhs.unidash.data.freshnessAt
import dev.peteryhs.unidash.data.recoveryTextAt
import dev.peteryhs.unidash.data.summaryAt
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.RefreshControl
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.ScreenHeaderSize
import dev.peteryhs.unidash.ui.PredictiveNavigation
import dev.peteryhs.unidash.ui.LocalNavigationActive
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.setup.MobileSetupGuide
import dev.peteryhs.unidash.ui.DisclosureIcon
import dev.peteryhs.unidash.ui.disclosureToggle
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.LinkOff

enum class SettingsDestination(val title: String) {
    Overview("Settings"),
    Connections("Connections"),
    Notifications("Notifications"),
    Transit("Transit"),
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
    val automaticTracking by vm.automaticTracking.collectAsStateWithLifecycle()
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    var guideOpen by rememberSaveable { mutableStateOf(false) }
    val navigationActive = LocalNavigationActive.current
    var healthRequested by remember(destination) { mutableStateOf(false) }
    LaunchedEffect(destination, navigationActive) {
        if (navigationActive && destination == SettingsDestination.Status && !healthRequested) {
            healthRequested = true
            vm.refreshHealth()
        }
    }

    var notificationsOn by remember { mutableStateOf(true) }
    var exactAlarms by remember { mutableStateOf(true) }
    var promotedNotifications by remember { mutableStateOf(true) }
    val promotionIntent = remember(context) {
        if (Build.VERSION.SDK_INT >= 36) Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .takeIf { it.resolveActivity(context.packageManager) != null }
        else null
    }
    LifecycleResumeEffect(Unit) {
        notificationsOn = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
        exactAlarms = Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        promotedNotifications = Build.VERSION.SDK_INT < 36 ||
            context.getSystemService(android.app.NotificationManager::class.java).canPostPromotedNotifications()
        onPauseOrDispose {}
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsOn = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    val destinationStates = rememberSaveableStateHolder()
    PredictiveNavigation(
        destination = destination,
        backDestination = SettingsDestination.Overview.takeUnless { destination == SettingsDestination.Overview },
        onBack = { onDestination(SettingsDestination.Overview) },
        isRootDestination = { it == SettingsDestination.Overview },
    ) { page ->
        destinationStates.SaveableStateProvider(page.name) {
            ScreenScaffold(
                title = page.title,
                subtitle = null,
                snapshot = snapshot,
                now = now,
                snackbar = snackbar,
                refreshing = snapshot.manualRefreshing,
                pullToRefreshEnabled = false,
                navigationIcon = {
                    if (page != SettingsDestination.Overview) {
                        IconButton(onClick = { onDestination(SettingsDestination.Overview) }) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to settings")
                        }
                    }
                },
                onStatus = if (page == SettingsDestination.Status) null else onStatus,
                showConnectionBanner = false,
                onRefresh = if (page == SettingsDestination.Status) vm::refreshSources else vm::refresh,
                headerSize = if (page == SettingsDestination.Overview) ScreenHeaderSize.Large else ScreenHeaderSize.Compact,
                tintHeaderOnScroll = false,
            ) {
                when (page) {
                    SettingsDestination.Overview -> settingsOverview(snapshot, now, onDestination)
                    SettingsDestination.Connections -> connectionsSettings(
                        baseUrl, managedOAuth, browser.error, browser.busy, onReauthenticate,
                        onOpenGuide = { guideOpen = true },
                        onDisconnect = { confirmSignOut = true },
                    )
                    SettingsDestination.Notifications -> notificationsSettings(
                        notificationsOn = notificationsOn,
                        exactAlarms = exactAlarms,
                        automaticTracking = automaticTracking,
                        onAutomaticTracking = vm::setAutomaticTracking,
                        onPromotedNotifications = promotionIntent?.takeIf { !promotedNotifications }?.let { intent ->
                            { context.startActivity(intent) }
                        },
                        onNotifications = {
                            if (!notificationsOn && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                        },
                        onExactAlarms = {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))
                                if (intent.resolveActivity(context.packageManager) != null) context.startActivity(intent)
                            }
                        },
                    )
                    SettingsDestination.Status -> statusSettings(snapshot, now, vm::refreshSources)
                    SettingsDestination.Transit -> item(key = "settings:transit") { TransitSettings(vm, snapshot) }
                    SettingsDestination.About -> aboutSettings { uri.openUri("https://github.com/Peteryhs/uni-dashboard") }
                }
            }
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
    val rows = listOf(
        SettingsOverviewRow(
            SettingsDestination.Connections,
            "Connections",
            "Dashboard address, sign-in and setup guide",
            Icons.Outlined.Link,
        ),
        SettingsOverviewRow(
            SettingsDestination.Notifications,
            "Notifications",
            "Class reminders and app alerts",
            Icons.Outlined.NotificationsActive,
        ),
        SettingsOverviewRow(
            SettingsDestination.Transit,
            "Transit",
            "Saved commutes and walking buffers",
            Icons.Outlined.DirectionsBus,
        ),
        SettingsOverviewRow(
            SettingsDestination.Status,
            "Status",
            statusTeaser(snapshot, now),
            Icons.Outlined.HealthAndSafety,
        ),
        SettingsOverviewRow(
            SettingsDestination.About,
            "About",
            "App version and project information",
            Icons.AutoMirrored.Outlined.Article,
        ),
    )
    item(key = "settings:overview") {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
            verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap),
        ) {
            rows.forEachIndexed { index, row ->
                SegmentedListItem(
                    onClick = { onDestination(row.destination) },
                    shapes = ListItemDefaults.segmentedShapes(index, rows.size),
                    content = { Text(row.label, style = MaterialTheme.typography.titleMedium) },
                    supportingContent = { Text(row.detail, style = MaterialTheme.typography.bodyMedium) },
                    leadingContent = {
                        SettingsIconBacking(row.destination, row.icon)
                    },
                    trailingContent = {
                        Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    },
                    colors = ListItemDefaults.segmentedColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

private data class SettingsOverviewRow(
    val destination: SettingsDestination,
    val label: String,
    val detail: String,
    val icon: ImageVector,
)

@Composable
private fun SettingsIconBacking(destination: SettingsDestination, icon: ImageVector) {
    val colors = MaterialTheme.colorScheme
    val (container, content) = when (destination) {
        SettingsDestination.Connections -> colors.primaryContainer to colors.onPrimaryContainer
        SettingsDestination.Notifications -> colors.secondaryContainer to colors.onSecondaryContainer
        // Neighbours never share a backing colour: primary, secondary, primary, tertiary, neutral.
        SettingsDestination.Transit -> colors.primaryContainer to colors.onPrimaryContainer
        SettingsDestination.Status -> colors.tertiaryContainer to colors.onTertiaryContainer
        SettingsDestination.About -> colors.surfaceContainerHighest to colors.onSurface
        SettingsDestination.Overview -> colors.surfaceContainerHighest to colors.onSurface
    }
    Surface(
        modifier = Modifier.size(48.dp),
        shape = CircleShape,
        color = container,
        contentColor = content,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
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

/** What a row does when tapped; the trailing icon tells people before they tap. */
internal enum class SettingsActionKind {
    /** Opens a sheet or dialog inside the app: no trailing icon. */
    InApp,
    /** Leaves the app for the browser or Android settings. */
    External,
}

internal data class SettingsAction(
    val title: String,
    val detail: String,
    val icon: ImageVector,
    val onClick: () -> Unit,
    val enabled: Boolean = true,
    val destructive: Boolean = false,
    val kind: SettingsActionKind = SettingsActionKind.InApp,
)

@Composable
internal fun SettingsActionGroup(rows: List<SettingsAction>) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter),
        verticalArrangement = Arrangement.spacedBy(ListItemDefaults.SegmentedGap),
    ) {
        rows.forEachIndexed { index, row ->
            SegmentedListItem(
                onClick = row.onClick,
                shapes = ListItemDefaults.segmentedShapes(index, rows.size),
                enabled = row.enabled,
                content = {
                    if (row.destructive) {
                        Text(row.title, style = MaterialTheme.typography.titleMedium, color = colors.error)
                    } else {
                        Text(row.title, style = MaterialTheme.typography.titleMedium)
                    }
                },
                supportingContent = { Text(row.detail, style = MaterialTheme.typography.bodyMedium) },
                leadingContent = {
                    if (row.destructive) Icon(row.icon, contentDescription = null, tint = colors.error)
                    else Icon(row.icon, contentDescription = null)
                },
                trailingContent = if (row.kind == SettingsActionKind.External) {
                    {
                        Icon(
                            Icons.AutoMirrored.Outlined.OpenInNew,
                            contentDescription = "Opens outside the app",
                            tint = colors.onSurfaceVariant,
                        )
                    }
                } else null,
                colors = ListItemDefaults.segmentedColors(containerColor = colors.surfaceContainerLow),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** A single grouped surface for content that is not itself a tap target. */
@Composable
internal fun SettingsPanel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = RoundedCornerShape(Corners.group),
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.gutter),
        content = content,
    )
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
    item { SectionHeader("Connection") }
    item {
        SettingsPanel {
            Column(
                Modifier.padding(horizontal = Spacing.inset, vertical = Spacing.rowVertical),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Text("Dashboard address", style = MaterialTheme.typography.titleMedium)
                // Selectable, so the address can be copied into a browser or shared with the owner.
                SelectionContainer {
                    Text(baseUrl ?: "Not connected", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    item { SectionHeader("Setup and sign-in") }
    item {
        SettingsActionGroup(
            listOf(
                SettingsAction(
                    title = "Setup guide",
                    detail = "Connect calendar feeds in the web app and finish phone setup.",
                    icon = Icons.AutoMirrored.Outlined.Article,
                    onClick = onOpenGuide,
                ),
                SettingsAction(
                    title = if (managedOAuth) "Managed sign-in" else "Browser sign-in",
                    detail = when {
                        baseUrl == null -> "Connect from the setup screen first."
                        browserBusy -> "Opening the system browser…"
                        browserError != null -> "$browserError Try again when you are ready."
                        managedOAuth -> "This phone uses Cloudflare Access in the system browser. No service token is stored."
                        else -> "Use browser sign-in when it is enabled for this dashboard."
                    },
                    icon = Icons.Outlined.Link,
                    onClick = { baseUrl?.let(onReauthenticate) },
                    enabled = baseUrl != null && !browserBusy,
                    kind = SettingsActionKind.External,
                ),
            ),
        )
    }
    item { SectionHeader("Disconnect") }
    item {
        SettingsActionGroup(
            listOf(
                SettingsAction(
                    title = "Disconnect this phone",
                    detail = if (managedOAuth) {
                        "Removes this phone’s saved sign-in and cached dashboard data. Your browser login stays active."
                    } else {
                        "Removes the saved service token and cached dashboard data."
                    },
                    icon = Icons.Outlined.LinkOff,
                    onClick = onDisconnect,
                    destructive = true,
                ),
            ),
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.notificationsSettings(
    notificationsOn: Boolean,
    exactAlarms: Boolean,
    automaticTracking: Boolean,
    onAutomaticTracking: (Boolean) -> Unit,
    onPromotedNotifications: (() -> Unit)?,
    onNotifications: () -> Unit,
    onExactAlarms: () -> Unit,
) {
    item { SectionHeader("Activity tracking") }
    item {
        SettingsPanel {
            ListItem(
                headlineContent = { Text("Track imminent or current activity", style = MaterialTheme.typography.titleMedium) },
                supportingContent = {
                    Text(
                        "Show upcoming and active classes, exams and office hours with their room and countdown. Unpin to hide until the activity ends.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                trailingContent = {
                    Switch(
                        checked = automaticTracking,
                        onCheckedChange = null,
                        enabled = true,
                        modifier = Modifier.clearAndSetSemantics {},
                    )
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                modifier = Modifier.fillMaxWidth()
                    .toggleable(value = automaticTracking, role = Role.Switch, onValueChange = onAutomaticTracking)
                    .semantics { stateDescription = if (automaticTracking) "On" else "Off" },
            )
        }
    }
    item { SectionHeader("Delivery permissions") }
    item {
        SettingsActionGroup(
            buildList {
                if (automaticTracking && onPromotedNotifications != null) {
                    add(
                        SettingsAction(
                            title = "Status-bar live updates",
                            detail = "Allow the countdown in the status bar. Class updates still appear as regular notifications while this is off.",
                            icon = Icons.Outlined.NotificationsActive,
                            onClick = onPromotedNotifications,
                            kind = SettingsActionKind.External,
                        ),
                    )
                }
                add(
                    SettingsAction(
                        title = "Reminders and alerts",
                        detail = if (notificationsOn) {
                            "On. Choose channels in system settings."
                        } else {
                            "Off. Class reminders, deadlines and outages will not reach you."
                        },
                        icon = Icons.Outlined.NotificationsActive,
                        onClick = onNotifications,
                        // The first request is an in-app permission prompt; afterwards it opens system settings.
                        kind = if (notificationsOn || Build.VERSION.SDK_INT < 33) SettingsActionKind.External else SettingsActionKind.InApp,
                    ),
                )
                if (!exactAlarms) {
                    add(
                        SettingsAction(
                            title = "On-time class reminders",
                            detail = "Without exact-alarm access, reminders can arrive a few minutes late.",
                            icon = Icons.Outlined.Schedule,
                            onClick = onExactAlarms,
                            kind = SettingsActionKind.External,
                        ),
                    )
                }
            },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.statusSettings(snapshot: Snapshot, now: Long, onRefreshSources: () -> Unit) {
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
        health == null -> "A missing status check is unknown, not an all clear. Use Refresh sources below to try again."
        else -> "Some sources have not been checked successfully yet."
    }

    item { SectionHeader("Source health") }
    snapshot.error?.let { error ->
        item(key = "dashboard-error") {
            Text(
                "Dashboard update failed: ${MainViewModel.describe(error)}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
            )
        }
    }
    item {
        val colors = MaterialTheme.colorScheme
        val (container, onContainer, stateIcon) = when {
            snapshot.healthError != null -> Triple(colors.errorContainer, colors.onErrorContainer, Icons.Outlined.ErrorOutline)
            summary?.condition == "healthy" -> Triple(colors.primaryContainer, colors.onPrimaryContainer, Icons.Outlined.CheckCircle)
            summary?.condition == "attention" -> Triple(colors.errorContainer, colors.onErrorContainer, Icons.Outlined.WarningAmber)
            else -> Triple(colors.tertiaryContainer, colors.onTertiaryContainer, Icons.Outlined.HelpOutline)
        }
        Surface(
            color = container,
            contentColor = onContainer,
            shape = RoundedCornerShape(Corners.group),
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(Spacing.inset),
                horizontalArrangement = Arrangement.spacedBy(Spacing.m),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(stateIcon, contentDescription = null, modifier = Modifier.padding(top = Spacing.xs).size(28.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Text(title, style = MaterialTheme.typography.titleMediumEmphasized, color = onContainer)
                    Text(detail, style = MaterialTheme.typography.bodyMedium, color = onContainer)
                    if (snapshot.healthRefreshing) {
                        Text("Checking for updates…", style = MaterialTheme.typography.labelMedium, color = onContainer)
                    }
                    if (summary != null && summary.total > 0) {
                        Text(
                            "${summary.healthy} of ${summary.total} monitored sources within their freshness window · ${summary.issues} ${if (summary.issues == 1) "needs" else "need"} attention · ${summary.unchecked} unchecked",
                            style = MaterialTheme.typography.labelLarge,
                            color = onContainer,
                        )
                    }
                    health?.let {
                        Text(
                            "Checked ${Format.age(it.now, now).removeSuffix(" old").let { age -> if (age == "just now") age else "$age ago" }}",
                            style = MaterialTheme.typography.labelMedium,
                            color = onContainer,
                        )
                    }
                }
            }
        }
    }

    // The page's one source-update action sits with the list it updates.
    item {
        SectionHeader("Sources") {
            RefreshControl(label = "Refresh sources", refreshing = snapshot.manualRefreshing,
                onRefresh = onRefreshSources, showLabel = true, modifier = Modifier.padding(end = Spacing.ms))
        }
    }
    snapshot.sourceRefreshResult?.let { result ->
        item(key = "source-refresh-result") {
            Text(
                result,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            )
        }
    }
    if (health != null && health.sources.isEmpty()) {
        item { EmptyNote("No source details were returned.") }
    } else {
        health?.sources.orEmpty().forEach { source -> item(key = "health:${source.id}") { HealthSourceRow(source, now) } }
    }
    item {
        var detailsExpanded by rememberSaveable { mutableStateOf(false) }
        Column(
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.s)
                .animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
        ) {
            ListItem(
                headlineContent = { Text("How source status works") },
                supportingContent = { Text("Runtime details and freshness windows") },
                trailingContent = { DisclosureIcon(detailsExpanded) },
                modifier = Modifier.disclosureToggle(detailsExpanded, { detailsExpanded = !detailsExpanded }),
            )
            if (detailsExpanded) {
                health?.runtime?.let { runtime ->
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
                Text(
                    "Ageing means an expected update is due. Stale means more than three update intervals without success; out of date means more than six. Weather uses its own freshness window. Saved data stays available while recovery runs. Optional and shared feeds are not counted in the monitored total.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
                )
            }
        }
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
    val interrupted = source.job?.lastOutcome in setOf("failed", "implausible") && source.job?.lastFinishedAt?.let {
        lastRun?.at == null || it > lastRun.at || (it == lastRun.at && lastRun.outcome in setOf("ok", "empty"))
    } == true
    val lastSuccessAt = source.lastSuccessAt ?: lastRun?.takeIf { it.outcome in setOf("ok", "empty") }?.at
    val hasCheckDetails = condition != "healthy" || !lastRun?.error.isNullOrBlank() || source.recovery?.state == "backoff"
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
            when (source.freshnessAt(now)) {
                "ageing" -> add("Expected update is due")
                "stale" -> add("Saved data is stale")
                "dead" -> add("Saved data is out of date")
            }
            if (condition == "blocked") add("Add feed in Connections")
            if (condition == "failing") {
                (if (interrupted) source.job?.lastFinishedAt else lastRun?.at)?.let { add("Attempt ${ageAgo(it, now)}") }
                if (interrupted) add("Update interrupted; saved data retained")
                else lastRun?.error?.takeIf { it.isNotBlank() }?.let { add(it) }
            }
            if (condition == "partial") add("Some events were skipped")
        }
    }.joinToString(" · ")
    val savedCheckDetails = buildList {
        lastSuccessAt?.let { add("Last successful update ${Format.dayTime(it)}") }
        if (interrupted) source.job?.lastFinishedAt?.let { add("Update interrupted ${Format.dayTime(it)} before saving a receipt") }
        lastRun?.let { run ->
            run.at?.let { add("Last saved attempt ${Format.dayTime(it)}") }
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
                if (!excluded) source.recoveryTextAt(now)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (checkDetailsExpanded) {
                    source.recovery?.reason?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    savedCheckDetails.forEach { detail ->
                        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
        // Status reads at a glance; rows with saved check details expand in place on tap.
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = tone)
                if (hasCheckDetails) DisclosureIcon(checkDetailsExpanded, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        modifier = Modifier
            .let { if (hasCheckDetails) it.disclosureToggle(checkDetailsExpanded, { checkDetailsExpanded = !checkDetailsExpanded }) else it }
            .animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
    )
}

private fun ageAgo(since: Long, now: Long): String {
    val age = Format.age(since, now).removeSuffix(" old")
    return if (age == "just now") age else "$age ago"
}

private fun androidx.compose.foundation.lazy.LazyListScope.aboutSettings(onSource: () -> Unit) {
    item {
        SettingsPanel(Modifier.padding(vertical = Spacing.s)) {
            Row(
                Modifier.fillMaxWidth().padding(Spacing.inset),
                horizontalArrangement = Arrangement.spacedBy(Spacing.m),
                verticalAlignment = Alignment.Top,
            ) {
                SettingsIconBacking(SettingsDestination.About, Icons.Outlined.Dashboard)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Text("Uni Dashboard", style = MaterialTheme.typography.headlineSmallEmphasized)
                    Text("Version ${dev.peteryhs.unidash.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        "A centralized dashboard for calendars, deadlines, dining, and everyday Waterloo student life.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("Created by Peter (Peteryhs)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    // Text-aligned link: no leading inset, still a full touch target.
                    TextButton(onClick = onSource, contentPadding = PaddingValues(horizontal = 0.dp, vertical = Spacing.s)) {
                        Text("View source on GitHub")
                        Icon(
                            Icons.AutoMirrored.Outlined.OpenInNew,
                            contentDescription = null,
                            modifier = Modifier.padding(start = Spacing.s).size(18.dp),
                        )
                    }
                }
            }
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
