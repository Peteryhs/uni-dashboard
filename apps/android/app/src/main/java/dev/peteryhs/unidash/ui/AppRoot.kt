package dev.peteryhs.unidash.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.peteryhs.unidash.ui.theme.Layout
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Today
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.ShortNavigationBar
import androidx.compose.material3.ShortNavigationBarItem
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalContext
import dev.peteryhs.unidash.ui.setup.MobileSetupGuide
import dev.peteryhs.unidash.ui.setup.hasSeenMobileGuide
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.ui.calendar.CalendarScreen
import dev.peteryhs.unidash.ui.food.FoodScreen
import dev.peteryhs.unidash.ui.settings.SettingsScreen
import dev.peteryhs.unidash.ui.settings.SettingsDestination
import dev.peteryhs.unidash.ui.setup.SetupScreen
import dev.peteryhs.unidash.ui.today.TodayScreen

enum class Tab(val label: String, val selected: ImageVector, val unselected: ImageVector) {
    Today("Today", Icons.Filled.Today, Icons.Outlined.Today),
    Calendar("Calendar", Icons.Filled.CalendarMonth, Icons.Outlined.CalendarMonth),
    Food("Dining", Icons.Filled.Restaurant, Icons.Outlined.Restaurant),
    Settings("Settings", Icons.Filled.Settings, Icons.Outlined.Settings),
}

@Composable
fun AppRoot(
    vm: MainViewModel,
    onBrowserSignIn: (String) -> Unit,
    onReauthenticate: (String) -> Unit,
) {
    val session by vm.session.collectAsStateWithLifecycle()
    val browser by vm.browserState.collectAsStateWithLifecycle()
    when (session) {
        Session.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            InitialLoadingNote("Checking your sign-in")
        }
        Session.SignedOut -> SetupScreen(vm, browser, onBrowserSignIn)
        Session.SignedIn -> Dashboard(vm, onReauthenticate)
    }
}

@Composable
private fun Dashboard(vm: MainViewModel, onReauthenticate: (String) -> Unit) {
    val context = LocalContext.current
    var guideOpen by rememberSaveable { mutableStateOf(!hasSeenMobileGuide(context)) }
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val baseUrl by vm.baseUrl.collectAsStateWithLifecycle()
    val managedOAuth by vm.managedOAuth.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.Today) }
    val tabStateHolder = rememberSaveableStateHolder()
    var settingsDestination by rememberSaveable { mutableStateOf(SettingsDestination.Overview) }
    var explanationOpen by rememberSaveable { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val now = rememberNow()
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // Live while visible: poll on resume, stop the moment the app leaves the screen.
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { vm.liveLoop() } }
    LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }

    val alert = snapshot.bundle?.card("alert")?.payload<Alert>()
    val alertBadge = alert != null && alert.count > 0 && !alert.dismissed
    val openStatus = {
        explanationOpen = false
        settingsDestination = SettingsDestination.Status
        tab = Tab.Settings
    }
    val selectTab: (Tab) -> Unit = { selected ->
        // Main destinations always reopen at their overview, with list/disclosure state retained.
        explanationOpen = false
        if (selected == Tab.Settings) settingsDestination = SettingsDestination.Overview
        tab = selected
    }

    val content: @Composable () -> Unit = {
        PredictiveNavigation(
            destination = tab,
            backDestination = Tab.Today.takeUnless { tab == Tab.Today },
            onBack = { selectTab(Tab.Today) },
            topLevel = true,
        ) { page ->
            tabStateHolder.SaveableStateProvider(page.name) {
                when (page) {
                    Tab.Today -> TodayScreen(
                        vm, snapshot, now, snackbar, onStatus = openStatus,
                        explanationOpen = explanationOpen,
                        onExplanation = { explanationOpen = it },
                    )
                    Tab.Calendar -> CalendarScreen(vm, snapshot, now, snackbar, onStatus = openStatus)
                    Tab.Food -> FoodScreen(vm, snapshot, now, snackbar, onStatus = openStatus)
                    Tab.Settings -> SettingsScreen(
                        vm, snapshot, now, snackbar, baseUrl, managedOAuth, onReauthenticate,
                        destination = settingsDestination,
                        onDestination = { settingsDestination = it },
                        onStatus = openStatus,
                    )
                }
            }
        }
    }

    if (guideOpen) MobileSetupGuide(dashboardAddress = baseUrl, onDismiss = { guideOpen = false })

    NavigationFrame(selected = tab, onSelect = selectTab, todayBadge = alertBadge, content = content)
}

/**
 * Bar on phones, rail from [Layout.railBreakpoint] (tablets, unfolded foldables, landscape).
 * Each navigation component owns the system insets on its own edge and consumes them, so screens
 * pad only the edges that remain: no double padding beside the rail and nothing under the bar.
 */
@Composable
internal fun NavigationFrame(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    todayBadge: Boolean,
    content: @Composable () -> Unit,
) {
    val label: @Composable (Tab) -> Unit = { t ->
        Text(
            t.label,
            style = if (selected == t) MaterialTheme.typography.labelMediumEmphasized else MaterialTheme.typography.labelMedium,
        )
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        if (maxWidth >= Layout.railBreakpoint) {
            // The rail also covers a start-side camera cutout, which systemBars alone would miss.
            val railInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Start + WindowInsetsSides.Vertical)
            Row(Modifier.fillMaxSize()) {
                NavigationRail(
                    containerColor = MaterialTheme.colorScheme.surfaceContainer,
                    windowInsets = railInsets,
                ) {
                    // Destinations sit in the middle of the rail, within reach of either hand on a tablet.
                    Spacer(Modifier.weight(1f))
                    Tab.entries.forEach { t ->
                        NavigationRailItem(
                            selected = selected == t,
                            onClick = { onSelect(t) },
                            icon = { TabIcon(t, selected == t, t == Tab.Today && todayBadge) },
                            label = { label(t) },
                        )
                    }
                    Spacer(Modifier.weight(1f))
                }
                Box(Modifier.weight(1f).consumeWindowInsets(WindowInsets.safeDrawing.only(WindowInsetsSides.Start))) { content() }
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).consumeWindowInsets(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))) { content() }
                ShortNavigationBar(
                    containerColor = MaterialTheme.colorScheme.surfaceContainer,
                ) {
                    Tab.entries.forEach { t ->
                        ShortNavigationBarItem(
                            selected = selected == t,
                            onClick = { onSelect(t) },
                            icon = { TabIcon(t, selected == t, t == Tab.Today && todayBadge) },
                            label = { label(t) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TabIcon(tab: Tab, selected: Boolean, badge: Boolean) {
    // The dot is spoken with the destination label, so TalkBack users also learn about the notice.
    BadgedBox(badge = { if (badge) Badge(Modifier.semantics { contentDescription = "Campus notice" }) }) {
        Icon(if (selected) tab.selected else tab.unselected, contentDescription = null)
    }
}
