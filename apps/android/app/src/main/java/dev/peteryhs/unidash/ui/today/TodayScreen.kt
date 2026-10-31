package dev.peteryhs.unidash.ui.today

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.outlined.Close
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Air
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Umbrella
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import dev.peteryhs.unidash.ui.ChangeBlocks
import dev.peteryhs.unidash.ui.DisclosureIcon
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.InitialLoadingNote
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.ScreenHeaderSize
import dev.peteryhs.unidash.ui.PredictiveNavigation
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.animatedGroupedShape
import dev.peteryhs.unidash.ui.disclosureToggle
import dev.peteryhs.unidash.ui.groupedShape
import dev.peteryhs.unidash.ui.listItemMotion
import dev.peteryhs.unidash.ui.revealEnter
import dev.peteryhs.unidash.ui.revealExit
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.Layout
import dev.peteryhs.unidash.ui.theme.Spacing
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.UriHandler
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

private const val HOUR = 3_600_000L

@Composable
fun TodayScreen(
    vm: MainViewModel,
    snapshot: Snapshot,
    now: Long,
    snackbar: SnackbarHostState,
    onStatus: (() -> Unit)? = null,
    explanationOpen: Boolean,
    onExplanation: (Boolean) -> Unit,
) {
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

    val pageStates = rememberSaveableStateHolder()
    PredictiveNavigation(
        destination = explanationOpen,
        backDestination = false.takeIf { explanationOpen },
        onBack = { onExplanation(false) },
        isRootDestination = { !it },
    ) { explanation ->
        pageStates.SaveableStateProvider(explanation) {
            if (explanation) {
                RecommendationExplanationScreen(
                    diagnostics = recs?.diagnostics,
                    warnings = recs?.warnings.orEmpty(),
                    snapshot = snapshot,
                    now = now,
                    snackbar = snackbar,
                    onBack = { onExplanation(false) },
                    onRefresh = vm::refresh,
                    onStatus = onStatus,
                )
            } else {
                ScreenScaffold("Today", subtitle, snapshot, now, snackbar, onRefresh = vm::refresh, onStatus = onStatus, headerSize = ScreenHeaderSize.Large) {
                    if (!snapshot.hasData) {
                        item {
                            when {
                                snapshot.refreshing && !snapshot.manualRefreshing -> InitialLoadingNote("Loading your dashboard…")
                                snapshot.manualRefreshing -> EmptyNote("Loading your dashboard…")
                                else -> EmptyNote("Nothing loaded yet. Pull to refresh.")
                            }
                        }
                        return@ScreenScaffold
                    }
                    if (alert != null && alert.count > 0 && !alert.dismissed) {
                        item(key = "alert") { AlertCard(alert, alertCard.state, alertCard.observedAt, now, onDismiss = { vm.dismissAlert(alert.key) }) }
                    }
                    val recommended = recs?.items.orEmpty()
                    val nextIsRecommended = next != null && recommended.any { it.represents(next) }
                    if (recommended.isNotEmpty() || next == null) {
                        recommendations(recs?.headline, recommended, now, vm) {
                            onExplanation(true)
                        }
                    }
                    if (next != null && !nextIsRecommended && nextCard.state != CardState.Degraded) {
                        item(key = "next") { NextUpCard(next, nextCard.state, nextCard.observedAt, now, emphasize = recommended.isEmpty()) }
                    } else if (next != null && !nextIsRecommended) {
                        item(key = "next-missing") { EmptyNote("${next.title}${next.subtitle.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}") }
                    }
                    recs?.transit?.let { transit -> transitSection(transit, now, snapshot.error != null, vm) }
                    if (due != null) dueSoon(due, dueCard.state, dueCard.observedAt, now, recommended)
                }
            }
        }
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
            .padding(horizontal = Spacing.gutter, vertical = Spacing.xs)
            .animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
    ) {
        Column {
            // The strip: one line, title only. Details wait behind a tap.
            Row(
                Modifier.padding(start = Spacing.inset, end = Spacing.xs).heightIn(min = Layout.touchTarget),
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
                IconButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.semantics {
                        contentDescription = if (expanded) "Hide notice details" else "Show notice details"
                    },
                ) {
                    DisclosureIcon(
                        expanded = expanded,
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Outlined.Close, contentDescription = "Dismiss notice", modifier = Modifier.size(20.dp))
                }
            }
            if (expanded) {
                Column(
                    // Aligns with the notice title, which follows a 20dp icon and an 8dp gap.
                    Modifier.padding(start = Spacing.inset + 28.dp, end = Spacing.inset, bottom = Spacing.m),
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
private fun NextUpCard(next: NextCommitment, state: CardState, observedAt: Long?, now: Long, emphasize: Boolean) {
    val start = next.startsAt
    val end = next.endsAt
    val progress = next.eventProgress(now)
    val contentColor = if (emphasize) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val happening = start != null && end != null && end > start && now >= start && now < end
    val label = when {
        happening -> "Now · ends ${Format.relative(end!!, now)}"
        start != null -> "Next ${kindLabel(next.kind)} · ${Format.whenLabel(start, now)}"
        else -> "Next up"
    }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (emphasize) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = if (emphasize) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
        ),
        shape = if (emphasize) RoundedCornerShape(Corners.hero) else RoundedCornerShape(Corners.group),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.itemGap),
    ) {
        Column(
            Modifier.padding(if (emphasize) Spacing.heroInset else Spacing.inset),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Text(
                next.title,
                style = if (emphasize) MaterialTheme.typography.headlineMediumEmphasized
                else MaterialTheme.typography.titleLarge,
            )
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
                        // One glyph and a number each, instead of "rain risk" prose.
                        val temp = w.tempC!!.roundToInt()
                        val feels = w.feelsC?.roundToInt()?.takeIf { it != temp }
                        IconText(Icons.Outlined.Thermostat, "$temp°" + (feels?.let { " / $it°" } ?: ""), "Temperature")
                        w.precipProb?.roundToInt()?.takeIf { it >= 20 }?.let { IconText(Icons.Outlined.Umbrella, "$it%", "Chance of rain") }
                        w.windKmh?.roundToInt()?.takeIf { it >= 20 }?.let { IconText(Icons.Outlined.Air, "$it km/h", "Wind") }
                    }
                }
            }
            progress?.let {
                EventTimeline(
                    progress = it,
                    color = contentColor,
                    trackColor = contentColor.copy(alpha = 0.2f),
                    labelColor = contentColor,
                )
            }
            next.following?.let { f ->
                HorizontalDivider(color = contentColor.copy(alpha = 0.2f))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = "Then", modifier = Modifier.size(18.dp))
                    Text(
                        listOfNotNull(f.title, f.startsAt?.let { Format.time(it) }, f.location.takeIf { it.isNotBlank() }).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            FreshnessLabel(state, observedAt, now)
        }
    }
}


/** An icon and a short value. `label` names the value for TalkBack when the icon carries the meaning. */
@Composable
private fun IconText(icon: ImageVector, text: String, label: String? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        modifier = if (label != null) Modifier.clearAndSetSemantics { contentDescription = "$label $text" } else Modifier,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

private fun LazyListScope.recommendations(
    headline: String?,
    items: List<Recommendation>,
    now: Long,
    vm: MainViewModel,
    onExplain: () -> Unit,
) {
    item(key = "recs-header") {
        SectionHeader(if (items.isEmpty()) "Focus" else "Focus · ${items.size}") {
            TextButton(onClick = onExplain) { Text("How it works") }
        }
    }
    if (items.isEmpty()) item(key = "recs-empty") { EmptyNote(headline?.takeIf { it.isNotBlank() } ?: "Nothing needs you right now.") }
    itemsIndexed(items, key = { _, rec -> "rec:${rec.id}" }) { index, rec ->
        RecommendationCard(
            rec = rec,
            now = now,
            vm = vm,
            modifier = Modifier.listItemMotion(this),
            isLead = index == 0,
            index = index,
            count = items.size,
        )
    }
}

/**
 * The first ranked item is the screen's one emphasized panel; the rest form a connected list.
 * A secondary row is a single disclosure target: tapping anywhere on its summary reveals the
 * body and actions in place, so collapsed rows carry no repeated button set.
 */
@Composable
private fun RecommendationCard(
    rec: Recommendation,
    now: Long,
    vm: MainViewModel,
    modifier: Modifier = Modifier,
    isLead: Boolean,
    index: Int,
    count: Int,
) {
    val presentation = rec.presentation()
    val uri = LocalUriHandler.current
    val haptics = LocalHapticFeedback.current
    var expanded by rememberSaveable(rec.id) { mutableStateOf(false) }
    val progress = rec.eventProgress(now)
    val highlighted = expanded || progress != null
    val containerColor by animateColorAsState(
        targetValue = when {
            isLead -> MaterialTheme.colorScheme.primaryContainer
            highlighted -> MaterialTheme.colorScheme.surfaceContainer
            else -> MaterialTheme.colorScheme.surfaceContainerLow
        },
        animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
        label = "Recommendation container color",
    )
    val contentColor = if (isLead) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val mutedColor = if (isLead) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    val shape = if (isLead) RoundedCornerShape(Corners.hero) else animatedGroupedShape(index - 1, count - 1, open = expanded)
    val snooze = { haptics.performHapticFeedback(HapticFeedbackType.SegmentTick); vm.act(rec, "snooze", now + HOUR) }
    val done = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); vm.act(rec, "done") }
    val dismiss = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); vm.act(rec, "dismiss") }
    val toggle = { expanded = !expanded }
    val swipe = rememberSwipeToDismissBoxState()
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = false,
        onDismiss = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                if (rec.canComplete) snooze() else dismiss()
            }
        },
        backgroundContent = { SwipeBackground(swipe.dismissDirection, shape, rec.canComplete) },
        modifier = modifier.padding(horizontal = Spacing.gutter, vertical = if (isLead) Spacing.itemGap else Spacing.joined / 2),
    ) {
        Surface(
            color = containerColor,
            contentColor = contentColor,
            shape = shape,
            modifier = Modifier.fillMaxWidth().semantics {
                customActions = buildList {
                    if (rec.canComplete) {
                        add(CustomAccessibilityAction("Mark done") { done(); true })
                        add(CustomAccessibilityAction("Snooze for an hour") { snooze(); true })
                    } else {
                        add(CustomAccessibilityAction("Dismiss") { dismiss(); true })
                    }
                }
            },
        ) {
            if (isLead) {
                LeadRecommendation(rec, presentation, now, progress, expanded, toggle, done, snooze, dismiss, uri)
            } else {
                Column(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth()
                            .disclosureToggle(expanded, toggle)
                            .padding(start = Spacing.inset, end = Spacing.s, top = Spacing.rowVertical, bottom = Spacing.rowVertical),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            Text(rec.title, style = MaterialTheme.typography.titleMediumEmphasized)
                            RecommendationMetadata(
                                timing = listOfNotNull(rec.course, recTime(rec, now)).joinToString(" · "),
                                warnings = presentation.warnings,
                                contentColor = mutedColor,
                                warningColor = MaterialTheme.colorScheme.tertiary,
                            )
                            RecommendationEvidence(rec, progress, contentColor, isLead = false)
                        }
                        // The chevron sits in a touch-target-sized box so it lines up with the title.
                        Box(Modifier.size(Layout.touchTarget, 24.dp), contentAlignment = Alignment.Center) {
                            DisclosureIcon(expanded, tint = mutedColor)
                        }
                    }
                    AnimatedVisibility(visible = expanded, enter = revealEnter(), exit = revealExit()) {
                        RecommendationDetails(
                            rec, presentation, isLead = false, done = done, snooze = snooze, dismiss = dismiss, uri = uri,
                            modifier = Modifier.padding(start = Spacing.inset, end = Spacing.inset, bottom = Spacing.rowVertical),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LeadRecommendation(
    rec: Recommendation,
    presentation: RecommendationPresentation,
    now: Long,
    progress: EventProgress?,
    expanded: Boolean,
    toggle: () -> Unit,
    done: () -> Unit,
    snooze: () -> Unit,
    dismiss: () -> Unit,
    uri: UriHandler,
) {
    val colors = MaterialTheme.colorScheme
    val textActionColors = ButtonDefaults.textButtonColors(contentColor = colors.onPrimaryContainer)
    val detailsLabel = if (expanded) "Hide details for ${rec.title}" else "Show details for ${rec.title}"
    Column(
        Modifier.fillMaxWidth().padding(start = Spacing.heroInset, end = Spacing.heroInset, top = Spacing.heroInset, bottom = Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Spacing.ms),
    ) {
        // Kind and course form an overline beside a compact functional icon, not a row of their own.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.ms)) {
            ShapedIcon(
                icon = recommendationIcon(rec.kind),
                container = colors.primary,
                content = colors.onPrimary,
                size = 40.dp,
            )
            Text(
                listOfNotNull(recommendationKindLabel(rec.kind), rec.course).joinToString(" · "),
                style = MaterialTheme.typography.labelLargeEmphasized,
                color = colors.onPrimaryContainer,
                modifier = Modifier.weight(1f),
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(
                rec.title,
                // Long assignment names step down a size instead of wrapping into a wall of display type.
                style = if (rec.title.length > 48) MaterialTheme.typography.headlineSmallEmphasized
                else MaterialTheme.typography.headlineMediumEmphasized,
            )
            RecommendationMetadata(
                timing = recTime(rec, now).orEmpty(),
                warnings = presentation.warnings,
                contentColor = colors.onPrimaryContainer,
                warningColor = colors.onPrimaryContainer,
            )
        }
        RecommendationEvidence(rec, progress, colors.onPrimaryContainer, isLead = true)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (rec.canComplete) {
                Button(onClick = done, shapes = ButtonDefaults.shapes()) {
                    Icon(Icons.Outlined.CheckCircle, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                    Text("Done", Modifier.padding(start = ButtonDefaults.IconSpacing))
                }
            }
            TextButton(
                onClick = toggle,
                shapes = ButtonDefaults.shapes(),
                colors = textActionColors,
                modifier = Modifier.semantics { contentDescription = detailsLabel },
            ) {
                Text(if (expanded) "Hide details" else "Details")
                DisclosureIcon(expanded, Modifier.padding(start = ButtonDefaults.IconSpacing).size(ButtonDefaults.IconSize))
            }
            if (!rec.canComplete && !expanded) rec.action?.let { action ->
                SourceButton(action.label, action.url, uri, textActionColors)
            }
        }
        AnimatedVisibility(visible = expanded, enter = revealEnter(), exit = revealExit()) {
            RecommendationDetails(rec, presentation, isLead = true, done = done, snooze = snooze, dismiss = dismiss, uri = uri)
        }
    }
}

/** Facts that change what to do now: a room or time change, its confidence, live progress, staleness. */
@Composable
private fun RecommendationEvidence(rec: Recommendation, progress: EventProgress?, contentColor: Color, isLead: Boolean) {
    val room = rec.change?.takeUnless { it.roomMoved }?.location?.takeIf { it.isNotBlank() }
    val unconfirmed = rec.change?.takeIf { !it.confirmed }
    if (room == null && rec.change == null && progress == null && !rec.state.isStale) return
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s), modifier = Modifier.padding(top = Spacing.xs)) {
        room?.let { IconText(Icons.Outlined.Place, it) }
        // A change is drawn as blocks; its sentence body would only repeat them.
        rec.change?.let { ChangeBlocks(it) }
        unconfirmed?.let {
            Text(
                if (it.roomMoved) "Room change inferred · check the course source" else "Change needs confirmation · check the course source",
                style = MaterialTheme.typography.labelMedium,
                color = if (isLead) contentColor else MaterialTheme.colorScheme.tertiary,
            )
        }
        progress?.let {
            EventTimeline(it, color = contentColor, trackColor = contentColor.copy(alpha = 0.2f), labelColor = contentColor)
        }
        FreshnessLabel(rec.state, null, 0L)
    }
}

/** Body, reason and the actions that would otherwise repeat under every collapsed row. */
@Composable
private fun RecommendationDetails(
    rec: Recommendation,
    presentation: RecommendationPresentation,
    isLead: Boolean,
    done: () -> Unit,
    snooze: () -> Unit,
    dismiss: () -> Unit,
    uri: UriHandler,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val accent = if (isLead) colors.onPrimaryContainer else colors.primary
    val outlinedColors = ButtonDefaults.outlinedButtonColors(contentColor = accent)
    val outlinedBorder = BorderStroke(1.dp, if (isLead) colors.onPrimaryContainer.copy(alpha = 0.5f) else colors.outlineVariant)
    val time = rec.dueAt ?: rec.startsAt
    val repeatsTime = (time != null && rec.timeLabel != null && presentation.body.startsWith(rec.timeLabel) && presentation.body.length < 48) ||
        (rec.scheduledDate != null && presentation.body == "Listed for ${rec.scheduledDate}.")
    val showBody = presentation.body.isNotBlank() && !repeatsTime && !(rec.kind == "change" && rec.change != null)
    val showReason = rec.reason.isNotBlank() && rec.reason != presentation.body
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.ms)) {
        if (showBody || showReason) {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                if (showBody) Text(presentation.body, style = MaterialTheme.typography.bodyMedium)
                if (showReason) {
                    Text(
                        rec.reason,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (isLead) colors.onPrimaryContainer else colors.onSurfaceVariant,
                    )
                }
            }
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (rec.canComplete) {
                // The lead already shows Done beside its disclosure; secondary rows offer it here.
                if (!isLead) {
                    FilledTonalButton(onClick = done, shapes = ButtonDefaults.shapes()) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                        Text("Done", Modifier.padding(start = ButtonDefaults.IconSpacing))
                    }
                }
                OutlinedButton(
                    onClick = snooze,
                    shapes = ButtonDefaults.shapes(),
                    colors = outlinedColors,
                    border = outlinedBorder,
                ) {
                    Icon(Icons.Outlined.Snooze, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                    Text("1 h", Modifier.padding(start = ButtonDefaults.IconSpacing).semantics { contentDescription = "Snooze for an hour" })
                }
            } else {
                OutlinedButton(onClick = dismiss, shapes = ButtonDefaults.shapes(), colors = outlinedColors, border = outlinedBorder) {
                    Icon(Icons.Outlined.Close, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                    Text("Dismiss", Modifier.padding(start = ButtonDefaults.IconSpacing))
                }
            }
            rec.action?.let { a -> SourceButton(a.label, a.url, uri, ButtonDefaults.textButtonColors(contentColor = accent)) }
        }
    }
}

@Composable
private fun SourceButton(label: String, url: String, uri: UriHandler, colors: androidx.compose.material3.ButtonColors) {
    TextButton(onClick = { uri.openUri(url) }, shapes = ButtonDefaults.shapes(), colors = colors) {
        Text(label)
        Icon(
            Icons.AutoMirrored.Outlined.OpenInNew,
            contentDescription = null,
            modifier = Modifier.padding(start = ButtonDefaults.IconSpacing).size(ButtonDefaults.IconSize),
        )
    }
}

private fun recommendationKindLabel(kind: String): String = when (kind) {
    "task" -> "Task"
    "change" -> "Schedule change"
    "class" -> "Class"
    "deadline" -> "Deadline"
    "exam" -> "Exam"
    else -> kind.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

private fun recommendationIcon(kind: String): ImageVector = when (kind) {
    "task", "deadline", "exam" -> Icons.Outlined.CheckCircle
    "change" -> Icons.Outlined.History
    else -> Icons.Outlined.Schedule
}

/** Revealed under a row being swiped; it matches the row's own shape so no corner shows through. */
@Composable
private fun SwipeBackground(direction: SwipeToDismissBoxValue, shape: Shape, canComplete: Boolean = true) {
    if (direction != SwipeToDismissBoxValue.EndToStart) return
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        shape = shape,
        modifier = Modifier.fillMaxSize(),
    ) {
        Box(Modifier.fillMaxSize().padding(horizontal = Spacing.l), contentAlignment = Alignment.CenterEnd) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Icon(if (canComplete) Icons.Outlined.Snooze else Icons.Outlined.Close, contentDescription = null)
                Text(if (canComplete) "Snooze" else "Dismiss", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

private fun LazyListScope.dueSoon(
    due: DueSoon,
    state: CardState,
    observedAt: Long?,
    now: Long,
    recommendations: List<Recommendation>,
) {
    val items = due.items.filter { item -> item.isDue && recommendations.none { it.represents(item) } }
    if (items.isEmpty() && due.error.isNullOrBlank()) return
    val shown = items.take(6)
    item(key = "due-header") {
        SectionHeader("Due · next ${due.windowDays} days", trailing = if (state.isStale) {
            { FreshnessLabel(state, observedAt, now, Modifier.padding(end = Spacing.ms)) }
        } else null)
    }
    if (items.isEmpty()) item(key = "due-empty") { EmptyNote(due.error ?: "Nothing due this week.") }
    itemsIndexed(shown, key = { _, item -> "due:${item.key}" }) { index, item ->
        val uri = LocalUriHandler.current
        val url = item.url ?: item.links.firstOrNull()?.url
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            shape = groupedShape(index, shown.size),
            modifier = Modifier.listItemMotion(this).fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.joined / 2),
        ) {
            BoxWithConstraints(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.inset, vertical = Spacing.rowVertical),
            ) {
                // Narrow or enlarged text: the countdown wraps under the title instead of squeezing it.
                val compact = maxWidth < 320.dp || LocalDensity.current.fontScale >= 1.3f
                val sourceLabel = item.links.firstOrNull { it.url == url }?.label ?: "LEARN"
                val relativeColor = if (item.startsAt - now < 24 * HOUR) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
                val summary: @Composable () -> Unit = {
                    Text(item.title, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        listOfNotNull(item.course, Format.dayTime(item.startsAt)).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (compact) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        summary()
                        Text(Format.relative(item.startsAt, now), style = MaterialTheme.typography.labelLargeEmphasized, color = relativeColor)
                        if (url != null) DueSourceButton(item.title, url, sourceLabel, uri)
                    }
                } else {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            summary()
                            if (url != null) DueSourceButton(item.title, url, sourceLabel, uri)
                        }
                        Text(
                            Format.relative(item.startsAt, now),
                            style = MaterialTheme.typography.labelLargeEmphasized,
                            color = relativeColor,
                            modifier = Modifier.padding(top = Spacing.xs),
                        )
                    }
                }
            }
        }
    }
    if (items.size > 6) item(key = "due-more") { EmptyNote("+${items.size - 6} more in Calendar") }
}

/** A link aligned with the row text: no leading inset, but still a full-height touch target. */
@Composable
private fun DueSourceButton(title: String, url: String, sourceLabel: String, uri: UriHandler) {
    TextButton(
        onClick = { uri.openUri(url) },
        shapes = ButtonDefaults.shapes(),
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = Spacing.xs),
        modifier = Modifier.semantics { contentDescription = "Open $title in $sourceLabel" },
    ) {
        Text(sourceLabel)
        Icon(
            Icons.AutoMirrored.Outlined.OpenInNew,
            contentDescription = null,
            modifier = Modifier.padding(start = ButtonDefaults.IconSpacing).size(ButtonDefaults.IconSize),
        )
    }
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
    if (rec.kind == "change") return rec.startsAt?.let { Format.whenLabel(it, now) }
    rec.dueAt?.let { return "${rec.timeLabel ?: "Due"} ${Format.whenLabel(it, now)}" }
    val start = rec.startsAt ?: return rec.scheduledDate?.let {
        "Listed ${LocalDate.parse(it).format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.CANADA))}"
    }
    val end = rec.endsAt
    return when {
        end != null && end <= now -> "Ended"
        start <= now && end != null -> "Now · until ${Format.time(end)}"
        start <= now -> "Started ${Format.relative(start, now)}"
        else -> "${rec.timeLabel ?: "Starts"} ${Format.whenLabel(start, now)}"
    }
}
