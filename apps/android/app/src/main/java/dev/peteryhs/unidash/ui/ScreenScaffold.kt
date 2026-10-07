package dev.peteryhs.unidash.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.summaryAt
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing

/**
 * Every tab has the same frame: a medium flexible app bar that collapses on scroll, one compact
 * source-status action, a feed-error banner when needed, and pull-to-refresh. Content is capped at
 * a readable width on tablets and foldables.
 */
@Composable
fun ScreenScaffold(
    title: String,
    subtitle: String?,
    snapshot: Snapshot,
    now: Long,
    snackbar: SnackbarHostState,
    onRefresh: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    navigationIcon: @Composable () -> Unit = {},
    onStatus: (() -> Unit)? = null,
    showConnectionBanner: Boolean = true,
    refreshing: Boolean = snapshot.refreshing,
    content: LazyListScope.() -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val pull = rememberPullToRefreshState()
    val listState = rememberLazyListState()
    val showBanner = showConnectionBanner && (onStatus == null || snapshot.error != null)
    // A collapsed app bar owns the first downward drag. Disable the pull modifier itself until
    // both scroll positions are at rest so it cannot consume that drag before the bar expands.
    val canRefresh = !refreshing &&
        scroll.state.collapsedFraction == 0f &&
        listState.firstVisibleItemIndex == 0 &&
        listState.firstVisibleItemScrollOffset == 0
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        // The navigation bar outside this scaffold already consumes the bottom inset.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        containerColor = MaterialTheme.colorScheme.surface,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                MediumFlexibleTopAppBar(
                    title = { Text(title) },
                    subtitle = subtitle?.let { { Text(it) } },
                    actions = {
                        actions()
                        onStatus?.let { StatusAction(snapshot, now, onClick = it) }
                    },
                    navigationIcon = navigationIcon,
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        scrolledContainerColor = MaterialTheme.colorScheme.surface,
                    ),
                    scrollBehavior = scroll,
                )
                if (showBanner) ConnectionBanner(snapshot, now, onStatus = null)
            }
        },
    ) { padding ->
        PullToRefreshBox(
            enabled = canRefresh,
            isRefreshing = refreshing,
            onRefresh = { if (canRefresh) onRefresh() },
            state = pull,
            modifier = Modifier.fillMaxSize().padding(padding),
            indicator = {
                PullToRefreshDefaults.LoadingIndicator(
                    state = pull,
                    isRefreshing = refreshing,
                    modifier = Modifier.align(Alignment.TopCenter),
                )
            },
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth(),
                    contentPadding = PaddingValues(bottom = Spacing.xl),
                    content = content,
                )
            }
        }
    }
}

@Composable
private fun StatusAction(snapshot: Snapshot, now: Long, onClick: () -> Unit) {
    val summary = snapshot.health?.summaryAt(now)
    val checkFailed = snapshot.healthError != null
    val checkFailureDetails = snapshot.healthError?.let(MainViewModel::describe)
    val warning = checkFailed || summary?.condition != "healthy"
    val count = when {
        checkFailed -> "?"
        summary != null && summary.condition == "attention" && summary.issues > 0 -> badgeCount(summary.issues)
        summary != null && summary.condition == "unknown" && summary.unchecked > 0 -> badgeCount(summary.unchecked)
        warning -> "?"
        else -> null
    }
    val description = when {
        checkFailed && snapshot.health != null ->
            "Source status check failed${checkFailureDetails?.let { ": $it" }.orEmpty()} Showing last known status. Open Status to retry."
        checkFailed ->
            "Source status check failed${checkFailureDetails?.let { ": $it" }.orEmpty()} Affected-source count is unknown. Open Status to retry."
        summary != null && summary.condition == "attention" ->
            summary.warning ?: "${summary.issues} monitored sources need attention. Open Status for details."
        summary != null && summary.condition == "unknown" ->
            summary.warning ?: "Source status is unknown. Open Status to check."
        summary != null && summary.condition == "healthy" -> "View status"
        else -> "Source status has not been checked; the affected-source count is unknown. Open Status to check."
    }
    val accessibleLabel = if (warning) "View status. $description" else "View status"
    val stale = LocalStaleColors.current
    val unknown = summary == null || summary.condition == "unknown"
    val badgeColors = when {
        checkFailed -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        unknown -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
        warning -> stale.container to stale.onContainer
        else -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
    }
    if (warning) {
        IconButton(
            onClick = onClick,
            modifier = Modifier
                .padding(end = Spacing.s)
                .semantics(mergeDescendants = true) { contentDescription = accessibleLabel },
        ) {
            BadgedBox(badge = {
                Badge(containerColor = badgeColors.first, contentColor = badgeColors.second) {
                    Text(count ?: "?")
                }
            }) {
                Icon(
                    imageVector = Icons.Outlined.Warning,
                    contentDescription = null,
                    tint = if (checkFailed) MaterialTheme.colorScheme.error else if (unknown) MaterialTheme.colorScheme.tertiary else stale.accent,
                )
            }
        }
    } else {
        TextButton(
            onClick = onClick,
            modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = accessibleLabel },
        ) {
            Text("View status")
        }
    }
}

private fun badgeCount(count: Int): String = if (count > 999) "999+" else count.toString()

/** Shown in place of a section when there is nothing, with the reason when the server gave one. */
@Composable
fun EmptyNote(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(horizontal = Spacing.m, vertical = Spacing.s),
    )
}
