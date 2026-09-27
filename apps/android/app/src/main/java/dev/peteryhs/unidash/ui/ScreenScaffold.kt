package dev.peteryhs.unidash.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.theme.Spacing

/**
 * Every tab has the same frame: a medium flexible app bar that collapses on scroll, the connection
 * banner, and pull-to-refresh with the Expressive loading indicator. Content is capped at a
 * readable width on tablets and foldables.
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
    content: LazyListScope.() -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val pull = rememberPullToRefreshState()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        // The navigation bar outside this scaffold already consumes the bottom inset.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                MediumFlexibleTopAppBar(
                    title = { Text(title) },
                    subtitle = subtitle?.let { { Text(it) } },
                    actions = actions,
                    scrollBehavior = scroll,
                )
                ConnectionBanner(snapshot, now)
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = snapshot.refreshing,
            onRefresh = onRefresh,
            state = pull,
            modifier = Modifier.fillMaxSize().padding(padding),
            indicator = {
                PullToRefreshDefaults.LoadingIndicator(
                    state = pull,
                    isRefreshing = snapshot.refreshing,
                    modifier = Modifier.align(Alignment.TopCenter),
                )
            },
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                LazyColumn(
                    modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth(),
                    contentPadding = PaddingValues(bottom = Spacing.xl),
                    content = content,
                )
            }
        }
    }
}

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
