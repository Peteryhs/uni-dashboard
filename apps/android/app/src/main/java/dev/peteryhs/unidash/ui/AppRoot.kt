package dev.peteryhs.unidash.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.LoadingIndicator
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.ui.calendar.CalendarScreen
import dev.peteryhs.unidash.ui.food.FoodScreen
import dev.peteryhs.unidash.ui.settings.SettingsScreen
import dev.peteryhs.unidash.ui.setup.SetupScreen
import dev.peteryhs.unidash.ui.today.TodayScreen

enum class Tab(val label: String, val selected: ImageVector, val unselected: ImageVector) {
    Today("Today", Icons.Filled.Today, Icons.Outlined.Today),
    Calendar("Calendar", Icons.Filled.CalendarMonth, Icons.Outlined.CalendarMonth),
    Food("Food", Icons.Filled.Restaurant, Icons.Outlined.Restaurant),
    Settings("Settings", Icons.Filled.Settings, Icons.Outlined.Settings),
}

@Composable
fun AppRoot(vm: MainViewModel) {
    val session by vm.session.collectAsStateWithLifecycle()
    when (session) {
        Session.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        Session.SignedOut -> SetupScreen(vm)
        Session.SignedIn -> Dashboard(vm)
    }
}

@Composable
private fun Dashboard(vm: MainViewModel) {
    val snapshot by vm.snapshot.collectAsStateWithLifecycle()
    val baseUrl by vm.baseUrl.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.Today) }
    val snackbar = remember { SnackbarHostState() }
    val now = rememberNow()
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // Live while visible: poll on resume, stop the moment the app leaves the screen.
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { vm.liveLoop() } }
    LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }

    val alert = snapshot.bundle?.card("alert")?.payload<Alert>()
    val alertBadge = alert != null && alert.count > 0 && !alert.dismissed

    val enter = MaterialTheme.motionScheme.defaultEffectsSpec<Float>()
    val exit = MaterialTheme.motionScheme.fastEffectsSpec<Float>()
    val content: @Composable () -> Unit = {
        AnimatedContent(
            targetState = tab,
            transitionSpec = { fadeIn(enter) togetherWith fadeOut(exit) },
            label = "tab",
        ) { t ->
            when (t) {
                Tab.Today -> TodayScreen(vm, snapshot, now, snackbar)
                Tab.Calendar -> CalendarScreen(vm, snapshot, now, snackbar)
                Tab.Food -> FoodScreen(vm, snapshot, now, snackbar)
                Tab.Settings -> SettingsScreen(vm, snapshot, now, snackbar, baseUrl)
            }
        }
    }

    // Bar on phones, rail from 600dp (tablets, unfolded foldables, landscape).
    BoxWithConstraints(Modifier.fillMaxSize()) {
        if (maxWidth >= 600.dp) {
            Row(Modifier.fillMaxSize()) {
                NavigationRail {
                    Tab.entries.forEach { t ->
                        NavigationRailItem(
                            selected = tab == t,
                            onClick = { tab = t },
                            icon = { TabIcon(t, tab == t, t == Tab.Today && alertBadge) },
                            label = { Text(t.label) },
                        )
                    }
                }
                Box(Modifier.weight(1f)) { content() }
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f)) { content() }
                ShortNavigationBar {
                    Tab.entries.forEach { t ->
                        ShortNavigationBarItem(
                            selected = tab == t,
                            onClick = { tab = t },
                            icon = { TabIcon(t, tab == t, t == Tab.Today && alertBadge) },
                            label = { Text(t.label) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TabIcon(tab: Tab, selected: Boolean, badge: Boolean) {
    BadgedBox(badge = { if (badge) Badge() }) {
        Icon(if (selected) tab.selected else tab.unselected, contentDescription = null)
    }
}
