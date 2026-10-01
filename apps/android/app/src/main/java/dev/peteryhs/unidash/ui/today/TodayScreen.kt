package dev.peteryhs.unidash.ui.today

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.ui.semantics.contentDescription
import dev.peteryhs.unidash.ui.theme.LocalStaleColors
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.DueSoon
import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendation
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.Spacing
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val HOUR = 3_600_000L

@Composable
fun TodayScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState) {
    val bundle = snapshot.bundle
    val alertCard = bundle?.card("alert")
    val alert = alertCard?.payload<Alert>()
    val nextCard = bundle?.card("next_commitment")
    val next = nextCard?.payload<NextCommitment>()
    val dueCard = bundle?.card("due_soon")
    val due = dueCard?.payload<DueSoon>()
    val recs = snapshot.recommendations
    val subtitle = LocalDate.now(dev.peteryhs.unidash.data.CAMPUS_ZONE)
        .format(DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.CANADA))

    ScreenScaffold("Today", subtitle, snapshot, now, snackbar, onRefresh = vm::refresh) {
        if (!snapshot.hasData) {
            item { EmptyNote(if (snapshot.refreshing) "Loading your dashboard…" else "Nothing loaded yet. Pull to refresh.") }
            return@ScreenScaffold
        }
        if (alert != null && alert.count > 0 && !alert.dismissed) {
            item(key = "alert") { AlertCard(alert, alertCard.state, alertCard.observedAt, now, onDismiss = { vm.dismissAlert(alert.key) }) }
        }
        if (next != null && nextCard.state != CardState.Degraded) {
            item(key = "next") { NextUpCard(next, nextCard.state, nextCard.observedAt, now) }
        } else if (next != null) {
            item(key = "next-missing") { EmptyNote("${next.title}${next.subtitle.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}") }
        }
        recommendations(recs?.headline, recs?.items.orEmpty(), recs?.warnings.orEmpty(), now, vm)
        if (due != null) dueSoon(due, dueCard.state, dueCard.observedAt, now)
    }
}

@Composable
private fun AlertCard(alert: Alert, state: CardState, observedAt: Long?, now: Long, onDismiss: () -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val uri = LocalUriHandler.current
    val notice = alert.notices.firstOrNull()
    val title = notice?.title ?: alert.summary
    // The other notices besides the one whose title is shown.
    val more = (alert.count - 1).coerceAtLeast(0)
    val stale = LocalStaleColors.current
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.m, vertical = Spacing.xs)
            .animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
    ) {
        Column {
            // The strip: one line, title only. Details wait behind a tap.
            Row(
                Modifier.padding(start = Spacing.m, end = Spacing.xs).heightIn(min = 48.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = "Campus notice", modifier = Modifier.size(20.dp))
                Text(
                    title,
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = if (expanded) 3 else 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // Staleness stays visible when collapsed: the fixed amber, with a spoken label.
                if (state.isStale) {
                    Icon(
                        Icons.Outlined.History,
                        contentDescription = "Stale, ${observedAt?.let { Format.age(it, now) } ?: "age unknown"}",
                        tint = stale.accent,
                        modifier = Modifier.size(18.dp),
                    )
                }
                if (more > 0) {
                    Text(
                        "+$more",
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.semantics { contentDescription = "$more more notices" },
                    )
                }
                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                        contentDescription = if (expanded) "Hide notice details" else "Show notice details",
                        modifier = Modifier.size(20.dp),
                    )
                }
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Outlined.Close, contentDescription = "Dismiss notice", modifier = Modifier.size(20.dp))
                }
            }
            if (expanded) {
                Column(
                    Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    alert.notices.forEachIndexed { i, n ->
                        if (i > 0) Text(n.title, style = MaterialTheme.typography.titleSmall)
                        if (n.body.isNotBlank()) Text(n.body, style = MaterialTheme.typography.bodyMedium)
                        if (n.components.isNotEmpty()) Text("Affects ${n.components.joinToString()}", style = MaterialTheme.typography.bodySmall)
                    }
                    FreshnessLabel(state, observedAt, now)
                    notice?.url?.takeIf { it.isNotBlank() }?.let { url ->
                        TextButton(onClick = { uri.openUri(url) }, contentPadding = PaddingValues(0.dp)) { Text("Status page") }
                    }
                }
            }
        }
    }
}

@Composable
private fun NextUpCard(next: NextCommitment, state: CardState, observedAt: Long?, now: Long) {
    val start = next.startsAt
    val end = next.endsAt
    val progress = next.eventProgress(now)
    val happening = start != null && end != null && end > start && now >= start && now < end
    val label = when {
        happening -> "Now · ends ${Format.relative(end!!, now)}"
        start != null -> "Next ${kindLabel(next.kind)} · ${Format.whenLabel(start, now)}"
        else -> "Next up"
    }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        ),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
    ) {
        Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Text(next.title, style = MaterialTheme.typography.headlineMediumEmphasized)
            if (next.subtitle.isNotBlank()) Text(next.subtitle, style = MaterialTheme.typography.bodyLarge)
            val weather = next.weather?.takeIf { it.show && it.tempC != null }
            if ((start != null && progress == null) || next.location.isNotBlank() || weather != null) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    if (start != null && progress == null) {
                        Text(
                            Format.time(start) + (end?.let { " – ${Format.time(it)}" } ?: ""),
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                    if (next.location.isNotBlank()) IconText(Icons.Outlined.Place, next.location)
                    weather?.let { w ->
                        IconText(Icons.Outlined.Thermostat, "${w.tempC!!.toInt()}°" + (w.reason.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""))
                    }
                }
            }
            progress?.let {
                EventTimeline(
                    progress = it,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    trackColor = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.2f),
                    labelColor = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            next.following?.let { f ->
                HorizontalDivider(color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.2f))
                Text(
                    "Then ${f.title}" + (f.startsAt?.let { " at ${Format.time(it)}" } ?: "") +
                        (f.location.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            FreshnessLabel(state, observedAt, now)
        }
    }
}

@Composable
private fun IconText(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Icon(icon, contentDescription = null, modifier = Modifier.padding(top = 1.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

private fun LazyListScope.recommendations(headline: String?, items: List<Recommendation>, warnings: List<String>, now: Long, vm: MainViewModel) {
    item(key = "recs-header") { SectionHeader(if (items.isEmpty()) "Focus" else "Focus · ${items.size}") }
    if (items.isEmpty()) item(key = "recs-empty") { EmptyNote("Nothing needs you right now.") }
    items(items, key = { "rec:${it.id}" }) { rec -> RecommendationCard(rec, now, vm, Modifier.animateItem()) }
    warnings.forEach { w -> item { EmptyNote(w) } }
}

@Composable
private fun RecommendationCard(rec: Recommendation, now: Long, vm: MainViewModel, modifier: Modifier = Modifier) {
    val uri = LocalUriHandler.current
    val haptics = LocalHapticFeedback.current
    val snooze = { haptics.performHapticFeedback(HapticFeedbackType.SegmentTick); vm.act(rec, "snooze", now + HOUR) }
    val done = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); vm.act(rec, "done") }
    val swipe = rememberSwipeToDismissBoxState()
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        onDismiss = { value -> if (value == SwipeToDismissBoxValue.EndToStart) snooze() },
        backgroundContent = { SwipeBackground(swipe.dismissDirection) },
        modifier = modifier.padding(horizontal = Spacing.m, vertical = Spacing.xs),
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            shape = MaterialTheme.shapes.large,
            modifier = Modifier.fillMaxWidth().semantics {
                customActions = buildList {
                    if (rec.canComplete) add(CustomAccessibilityAction("Mark done") { done(); true })
                    add(CustomAccessibilityAction("Snooze for an hour") { snooze(); true })
                }
            },
        ) {
            Row(Modifier.padding(Spacing.m), horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text(rec.title, style = MaterialTheme.typography.titleMedium)
                    val time = rec.dueAt ?: rec.startsAt
                    val meta = listOfNotNull(
                        rec.course,
                        recTime(rec, now),
                    ).joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val repeatsTime = time != null && rec.timeLabel != null && rec.body.startsWith(rec.timeLabel) && rec.body.length < 48
                    if (rec.body.isNotBlank() && !repeatsTime) Text(rec.body, style = MaterialTheme.typography.bodyMedium)
                    rec.eventProgress(now)?.let { EventTimeline(it, Modifier.padding(vertical = Spacing.xs)) }
                    // Why this was picked: the web shows it as blue text; here it is the primary role.
                    if (rec.reason.isNotBlank()) Text(rec.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    FreshnessLabel(rec.state, null, now)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), modifier = Modifier.padding(top = Spacing.xs)) {
                        if (rec.canComplete) FilledTonalButton(onClick = done) {
                            Icon(Icons.Outlined.CheckCircle, contentDescription = null)
                            Text("Done", Modifier.padding(start = Spacing.s))
                        }
                        OutlinedButton(onClick = snooze) { Text("Snooze 1 h") }
                        rec.action?.let { a ->
                            TextButton(onClick = { uri.openUri(a.url) }) {
                                Text(a.label)
                                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.padding(start = Spacing.xs))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue) {
    if (direction != SwipeToDismissBoxValue.EndToStart) return
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxSize(),
    ) {
        Box(Modifier.fillMaxSize().padding(horizontal = Spacing.l), contentAlignment = Alignment.CenterEnd) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(Icons.Outlined.Snooze, contentDescription = null)
                Text("Snooze", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

private fun LazyListScope.dueSoon(due: DueSoon, state: CardState, observedAt: Long?, now: Long) {
    item(key = "due-header") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionHeader("Due in the next ${due.windowDays} days", Modifier.weight(1f))
            FreshnessLabel(state, observedAt, now, Modifier.padding(end = Spacing.m, top = Spacing.m))
        }
    }
    val items = due.items.filter { it.isDue }
    if (items.isEmpty()) item(key = "due-empty") { EmptyNote(due.error ?: "Nothing due this week.") }
    items(items.take(6), key = { "due:${it.key}" }) { item ->
        val uri = LocalUriHandler.current
        val url = item.url ?: item.links.firstOrNull()?.url
        ListItem(
            headlineContent = { Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text(listOfNotNull(item.course, Format.dayTime(item.startsAt)).joinToString(" · ")) },
            trailingContent = {
                Text(
                    Format.relative(item.startsAt, now),
                    style = MaterialTheme.typography.labelLarge,
                    color = if (item.startsAt - now < 24 * HOUR) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier
                .padding(horizontal = Spacing.s)
                .animateItem(),
        )
        if (url != null) {
            Row(Modifier.fillMaxWidth().padding(start = Spacing.m, bottom = Spacing.xs)) {
                AssistChip(onClick = { uri.openUri(url) }, label = { Text("Open in LEARN") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) })
            }
        }
    }
    if (items.size > 6) item { EmptyNote("${items.size - 6} more in Calendar") }
}

private fun kindLabel(kind: String?): String = when (kind) {
    "exam" -> "exam"
    "office_hours" -> "office hours"
    "deadline" -> "deadline"
    "event" -> "event"
    else -> "class"
}

/** A deadline counts down; a window says whether it is on now, ahead, or already over. */
private fun recTime(rec: Recommendation, now: Long): String? {
    if (rec.kind == "change") return rec.startsAt?.let { "Affects ${Format.whenLabel(it, now)}" }
    rec.dueAt?.let { return "${rec.timeLabel ?: "Due"} ${Format.whenLabel(it, now)}" }
    val start = rec.startsAt ?: return null
    val end = rec.endsAt
    return when {
        end != null && end <= now -> "Ended"
        start <= now && end != null -> "Now · until ${Format.time(end)}"
        start <= now -> "Started ${Format.relative(start, now)}"
        else -> "${rec.timeLabel ?: "Starts"} ${Format.whenLabel(start, now)}"
    }
}
