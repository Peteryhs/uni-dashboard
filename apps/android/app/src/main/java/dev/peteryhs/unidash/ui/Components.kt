package dev.peteryhs.unidash.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.RoundedPolygon
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.summaryAt
import dev.peteryhs.unidash.ui.theme.Layout
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
fun ConnectionBanner(snapshot: Snapshot, now: Long, onStatus: (() -> Unit)? = null) {
    val error = snapshot.error
    val healthError = snapshot.healthError
    val healthSummary = snapshot.health?.summaryAt(now)
    val feedWarning = error?.let { MainViewModel.describe(it) }
    val healthWarning = when {
        healthError != null -> "Source status could not be checked."
        healthSummary?.condition == "attention" -> healthSummary.warning ?: "Some sources need attention."
        healthSummary?.condition == "unknown" -> healthSummary.warning ?: "Some sources have not been checked successfully."
        else -> null
    }
    val warning = feedWarning ?: healthWarning
    val failure = error ?: healthError
    val stale = LocalStaleColors.current
    AnimatedVisibility(
        // A quiet background poll should not make a visible warning flicker. Hide it only while
        // the person has asked for a refresh and the result is in flight.
        visible = warning != null && !snapshot.manualRefreshing,
        enter = revealEnter(),
        exit = revealExit(),
    ) {
        val auth = failure is RelayError.Unauthorized || failure is RelayError.NotConfigured || failure is RelayError.ReauthRequired
        val (bg, fg) = if (auth) MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        else stale.container to stale.onContainer
        val since = if (error != null) snapshot.fetchedAt?.let { " Showing data from ${Format.time(it)}" } ?: "" else ""
        Row(
            Modifier.fillMaxWidth().background(bg).heightIn(min = Layout.touchTarget)
                .padding(start = Spacing.gutter, end = if (onStatus != null) Spacing.xs else Spacing.gutter, top = Spacing.s, bottom = Spacing.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            val icon = when {
                auth -> Icons.Outlined.Key
                error is RelayError.Offline || healthError is RelayError.Offline -> Icons.Outlined.CloudOff
                else -> Icons.Outlined.History
            }
            Icon(icon, contentDescription = null, tint = fg)
            Text(warning.orEmpty() + since, color = fg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            onStatus?.let { TextButton(onClick = it) { Text("Status", color = fg) } }
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

/**
 * A section title on the screen gutter, with an optional trailing action or status on the same
 * line. The row is always one touch target tall, so headers with and without an action share the
 * same rhythm: more space above (separating sections) than below (binding to the content).
 */
@Composable
fun SectionHeader(
    text: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            // A trailing text button carries its own 12dp inner padding; this keeps its label on the gutter.
            .padding(start = Spacing.gutter, end = if (trailing != null) Spacing.xs else Spacing.gutter, top = Spacing.m)
            .heightIn(min = Layout.touchTarget),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.titleMediumEmphasized,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        trailing?.invoke(this)
    }
}

/**
 * Whole-row disclosure: the summary area is one large target that toggles details in place.
 * TalkBack reads the merged row, its expanded state, and a "show/hide details" action label.
 * Pair with a trailing [DisclosureIcon]; the icon itself is decorative.
 */
fun Modifier.disclosureToggle(expanded: Boolean, onToggle: () -> Unit, state: String? = null): Modifier = this
    .clickable(
        role = Role.Button,
        onClickLabel = if (expanded) "Hide details" else "Show details",
        onClick = onToggle,
    )
    .semantics(mergeDescendants = true) {
        stateDescription = listOfNotNull(state, if (expanded) "Expanded" else "Collapsed").joinToString(", ")
    }

/** A quiet, single-line notice on the gutter: a source warning or a reason something is missing. */
@Composable
fun NoticeRow(
    text: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
    }
}
