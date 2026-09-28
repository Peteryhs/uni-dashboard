package dev.peteryhs.unidash.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.RoundedPolygon
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.delay

/** A clock that ticks every 30 seconds, so countdowns and ages stay honest without a refresh. */
@Composable
fun rememberNow(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000 - System.currentTimeMillis() % 30_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/**
 * The freshness label. Renders nothing when a card is live: the absence of a label is the signal
 * that the number is current. Stale and dead use the fixed amber plus an icon and words.
 */
@Composable
fun FreshnessLabel(state: CardState, observedAt: Long?, now: Long, modifier: Modifier = Modifier) {
    if (!state.isStale) return
    val stale = LocalStaleColors.current
    val age = observedAt?.let { " · ${Format.age(it, now)}" }.orEmpty()
    Surface(color = stale.container, contentColor = stale.onContainer, shape = MaterialTheme.shapes.small, modifier = modifier) {
        Row(Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.History, contentDescription = null, modifier = Modifier.size(16.dp))
            Text(
                if (state == CardState.Dead) "Out of date$age" else "Stale$age",
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(start = Spacing.xs),
            )
        }
    }
}

/**
 * Whole-app connection state, under the top bar. Zero height when everything is fine, like the
 * web's alert slot, so its appearance means something.
 */
@Composable
fun ConnectionBanner(snapshot: Snapshot, now: Long) {
    val error = snapshot.error
    val stale = LocalStaleColors.current
    AnimatedVisibility(
        visible = error != null && !snapshot.refreshing,
        enter = expandVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
            fadeIn(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
        exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
            fadeOut(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
    ) {
        val auth = error is RelayError.Unauthorized || error is RelayError.NotConfigured
        val (bg, fg) = if (auth) MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        else stale.container to stale.onContainer
        val since = snapshot.fetchedAt?.let { " Showing data from ${Format.time(it)}" } ?: ""
        Row(
            Modifier.fillMaxWidth().background(bg).padding(horizontal = Spacing.m, vertical = Spacing.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Icon(if (auth) Icons.Outlined.Key else Icons.Outlined.CloudOff, contentDescription = null, tint = fg)
            Text(MainViewModel.describe(error ?: return@Row) + since, color = fg, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** An icon on one of the Material Expressive shapes: the leading element of hero rows. */
@Composable
fun ShapedIcon(
    icon: ImageVector,
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    shape: RoundedPolygon = MaterialShapes.Cookie9Sided,
    description: String? = null,
) {
    Box(
        modifier
            .size(size)
            .background(container, shape.toShape())
            .let { m -> if (description != null) m.semantics { contentDescription = description } else m },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(size * 0.5f))
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.padding(start = Spacing.m, end = Spacing.m, top = Spacing.l, bottom = Spacing.s),
    )
}
