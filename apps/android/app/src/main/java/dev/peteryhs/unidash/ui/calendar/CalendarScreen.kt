package dev.peteryhs.unidash.ui.calendar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CalendarChangeAlert
import dev.peteryhs.unidash.data.CalendarSource
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
import dev.peteryhs.unidash.ui.NoticeRow
import dev.peteryhs.unidash.ui.animatedGroupedShape
import dev.peteryhs.unidash.ui.disclosureToggle
import dev.peteryhs.unidash.ui.listItemMotion
import dev.peteryhs.unidash.ui.revealEnter
import dev.peteryhs.unidash.ui.revealExit
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.Layout
import dev.peteryhs.unidash.ui.theme.Spacing
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.LinkOff
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

internal val CALENDAR_SOURCE_NAMES = mapOf(
    "uw-portal-ics" to "Class schedule",
    "google-calendar-ics" to "Google Calendar",
    "uw-learn-ics" to "LEARN calendar",
    "user-office-hours" to "Office hours",
)

internal fun filterWarnedCalendarSources(sources: List<CalendarSource>): List<CalendarSource> {
    val scheduleSources = sources.filter { it.id == "uw-portal-ics" || it.id == "google-calendar-ics" }
    val hasConfiguredSchedule = scheduleSources.any { it.status != "unconfigured" }
    return sources.filter { s ->
        if (s.status == "ok") return@filter false
        if (s.id == "google-calendar-ics" && s.status == "unconfigured") return@filter false
        if (s.id == "uw-portal-ics" && s.status == "unconfigured" && hasConfiguredSchedule) return@filter false
        if (s.optional && s.status == "unconfigured") return@filter false
        s.status == "unconfigured" || s.status == "failed"
    }
}

private enum class Filter(val label: String, val categories: Set<String>) {
    All("All", emptySet()),
    Classes("Classes", setOf("class", "exam", "office_hours")),
    Deadlines("Deadlines", setOf("deadline", "opens")),
}

/** The server-built agenda from /v1/calendar, two weeks ahead, grouped by day. */
@Composable
fun CalendarScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState, onStatus: (() -> Unit)? = null) {
    var filter by rememberSaveable { mutableStateOf(Filter.All) }
    var expanded by rememberSaveable { mutableStateOf<String?>(null) }
    val calendar = snapshot.calendar
    val agendaListState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    val selectFilter: (Filter) -> Unit = { selected ->
        if (filter != selected) {
            filter = selected
            expanded = null
            scope.launch { agendaListState.scrollToItem(0) }
        }
    }
    ScreenScaffold(
        "Calendar", "Next two weeks", snapshot, now, snackbar, onRefresh = vm::refresh, onStatus = onStatus,
        listState = agendaListState, headerSize = ScreenHeaderSize.Medium,
        // The category filter stays reachable under the bar, however far down the agenda you are.
        pinnedContent = { CalendarFilter(filter, selectFilter) },
    ) {
        if (calendar == null) {
            item {
                when {
                    snapshot.refreshing && !snapshot.manualRefreshing ->
                        InitialLoadingNote("Loading your calendar…")
                    snapshot.manualRefreshing -> EmptyNote("Loading your calendar…")
                    snapshot.error != null -> EmptyNote("Calendar unavailable. Pull to retry.")
                    else -> EmptyNote("No calendar loaded yet. Pull to refresh.")
                }
            }
            return@ScreenScaffold
        }
        filterWarnedCalendarSources(calendar.sources).forEach { s ->
            val name = CALENDAR_SOURCE_NAMES[s.id] ?: s.id
            val failed = s.status == "failed"
            item(key = "src:${s.id}") {
                NoticeRow(
                    "$name: ${if (failed) "last fetch failed" else "not configured"}",
                    icon = if (failed) Icons.Outlined.ErrorOutline else Icons.Outlined.LinkOff,
                    tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = Spacing.xs),
                )
            }
        }
        var shown = 0
        calendar.alerts.filter { it.kind in setOf("cancelled", "removed") }.forEach { change ->
            item(key = "change:${change.id}") {
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.s),
                    itemVerticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    Text(change.course ?: "Class", style = MaterialTheme.typography.titleSmall)
                    ChangeBlocks(change.detail)
                    Text(Format.dayTime(change.startsAt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        calendar.days.forEach { day ->
            val events = day.events.filter { filter.categories.isEmpty() || it.category in filter.categories }
            val isToday = day.date == campusDay(now).toString()
            if (events.isEmpty() && !isToday) return@forEach
            shown += events.size
            stickyHeader(key = "day:${day.date}") {
                AgendaDayHeader(day.date, events.size, isToday)
            }
            val markerIndex = if (isToday) calendarNowIndex(events, now) else -1
            events.forEachIndexed { index, ev ->
                if (index == markerIndex) item(key = "now:${day.date}") { CalendarNowMarker(now) }
                item(key = "ev:${day.date}:${ev.occurrenceId}") {
                    EventRow(
                        ev, now, expanded == ev.occurrenceId,
                        onToggle = { expanded = if (expanded == ev.occurrenceId) null else ev.occurrenceId },
                        eventIndex = index,
                        groupStart = if (isToday && markerIndex >= 0 && index >= markerIndex) markerIndex else 0,
                        groupEnd = if (isToday && markerIndex >= 0 && index < markerIndex) markerIndex - 1 else events.lastIndex,
                        modifier = Modifier.listItemMotion(this),
                        alerts = calendar.alerts.filter { it.eventId == ev.id },
                    )
                }
            }
            if (markerIndex == events.size) item(key = "now:${day.date}") { CalendarNowMarker(now) }
            if (isToday && events.isEmpty()) item(key = "clear:${day.date}") { EmptyNote("Nothing scheduled today.") }
        }
        if (shown == 0 && calendar.days.none { it.date == campusDay(now).toString() }) item { EmptyNote("Nothing scheduled.") }
    }
}

/** Single-choice category filter: a segmented row, or wrapping chips when labels would truncate. */
@Composable
private fun CalendarFilter(filter: Filter, onSelect: (Filter) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(start = Spacing.gutter, end = Spacing.gutter, top = Spacing.xs, bottom = Spacing.s)) {
        val fontScale = LocalDensity.current.fontScale
        val useWrappingChips = maxWidth < 300.dp || fontScale >= 1.3f
        if (useWrappingChips) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Filter.entries.forEach { f ->
                    FilterChip(
                        selected = filter == f,
                        onClick = { onSelect(f) },
                        label = {
                            Text(f.label, style = if (filter == f) MaterialTheme.typography.labelLargeEmphasized else MaterialTheme.typography.labelLarge)
                        },
                        modifier = Modifier.heightIn(min = Layout.touchTarget),
                    )
                }
            }
        } else {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                Filter.entries.forEachIndexed { index, f ->
                    SegmentedButton(
                        selected = filter == f,
                        onClick = { onSelect(f) },
                        shape = SegmentedButtonDefaults.itemShape(index = index, count = Filter.entries.size),
                        label = {
                            Text(f.label, maxLines = 1, style = if (filter == f) MaterialTheme.typography.labelLargeEmphasized else MaterialTheme.typography.labelLarge)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun AgendaDayHeader(dateValue: String, count: Int, isToday: Boolean) {
    val date = LocalDate.parse(dateValue)
    val colors = MaterialTheme.colorScheme
    val tileColor = if (isToday) colors.primaryContainer else colors.surfaceContainerHigh
    val tileContent = if (isToday) colors.onPrimaryContainer else colors.onSurface
    val weekday = date.format(DateTimeFormatter.ofPattern("EEEE", Locale.CANADA))
    val month = date.format(DateTimeFormatter.ofPattern("MMM", Locale.CANADA))
    val fullDate = date.format(DateTimeFormatter.ofPattern("MMMM d, yyyy", Locale.CANADA))

    Surface(color = colors.surface, contentColor = colors.onSurface, modifier = Modifier.fillMaxWidth()) {
        Row(
            // More room above than below: the header belongs to the events that follow it.
            Modifier.fillMaxWidth().padding(start = Spacing.gutter, end = Spacing.gutter, top = Spacing.m, bottom = Spacing.s)
                .clearAndSetSemantics {
                    contentDescription = "${if (isToday) "Today. " else ""}$weekday, $fullDate. $count ${if (count == 1) "event" else "events"}."
                    heading()
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.ms),
        ) {
            // A fixed-width tile keeps one- and two-digit dates on the same left edge.
            Surface(color = tileColor, contentColor = tileContent, shape = RoundedCornerShape(Corners.tile), modifier = Modifier.widthIn(min = 48.dp)) {
                Column(
                    Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(date.dayOfMonth.toString(), style = MaterialTheme.typography.titleLargeEmphasized)
                    Text(month, style = MaterialTheme.typography.labelSmall)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (isToday) "Today" else weekday, style = MaterialTheme.typography.titleMediumEmphasized)
                Text(
                    "${if (isToday) "$weekday · " else ""}$count ${if (count == 1) "event" else "events"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                )
            }
        }
    }
}

/** The current time, aligned with the rows' text inset and ending on the gutter. */
@Composable
private fun CalendarNowMarker(now: Long) {
    val color = MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier.fillMaxWidth()
            .padding(start = Spacing.gutter + Spacing.inset, end = Spacing.gutter, top = Spacing.s, bottom = Spacing.s)
            .clearAndSetSemantics { contentDescription = "Current time ${Format.time(now)}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text("Now ${Format.time(now)}", style = MaterialTheme.typography.labelMediumEmphasized, color = color)
        Box(Modifier.size(6.dp).background(color, CircleShape))
        HorizontalDivider(modifier = Modifier.weight(1f), color = color)
    }
}

/**
 * One agenda entry. The whole summary is the disclosure target; the chevron only shows state.
 * Time leads: a column of its own when there is room, otherwise the first item of the label line.
 */
@Composable
private fun EventRow(
    ev: CalendarEvent,
    now: Long,
    expanded: Boolean,
    onToggle: () -> Unit,
    eventIndex: Int,
    groupStart: Int,
    groupEnd: Int,
    modifier: Modifier = Modifier,
    alerts: List<CalendarChangeAlert> = emptyList(),
) {
    val past = ev.hasPassed(now)
    val happening = !ev.allDay && ev.startsAt <= now && now < ev.endsAt
    val (accent, label) = categoryStyle(ev)
    val highlighted = expanded || happening
    val containerColor by animateColorAsState(
        targetValue = when {
            expanded -> MaterialTheme.colorScheme.surfaceContainerHigh
            happening -> MaterialTheme.colorScheme.primaryContainer
            else -> MaterialTheme.colorScheme.surfaceContainerLow
        },
        animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
        label = "Calendar event container color",
    )
    val contentColor = if (happening && !expanded) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val mutedColor = if (happening && !expanded) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    val timeColor = when {
        past -> MaterialTheme.colorScheme.onSurfaceVariant
        happening && !expanded -> MaterialTheme.colorScheme.onPrimaryContainer
        else -> MaterialTheme.colorScheme.onSurface
    }
    val roomShownBelow = alerts.any { it.detail.roomMoved }
    val showLocation = ev.location.isNotBlank() && !roomShownBelow && !expanded

    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.joined / 2),
        color = containerColor,
        contentColor = contentColor,
        shape = animatedGroupedShape(eventIndex - groupStart, groupEnd - groupStart + 1, open = highlighted),
    ) {
        Column(Modifier.fillMaxWidth()) {
            BoxWithConstraints(
                Modifier.fillMaxWidth()
                    .disclosureToggle(expanded, onToggle, state = when {
                        past -> "Past event"
                        happening -> "Happening now"
                        else -> null
                    })
                    .padding(start = Spacing.inset, end = Spacing.s, top = Spacing.rowVertical, bottom = Spacing.rowVertical),
            ) {
                // A 411dp phone keeps the time column; 360dp phones and enlarged text stack instead.
                val compact = maxWidth < 320.dp || LocalDensity.current.fontScale >= 1.3f
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Top,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.ms),
                ) {
                    if (!compact) {
                        Column(Modifier.width(76.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            EventTimeContent(ev, timeColor, compact = false)
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                            itemVerticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (compact) EventTimeContent(ev, timeColor, compact = true)
                            EventCategoryLabel(ev, label, past, happening, expanded, accent)
                            if (happening) EventNowLabel(expanded)
                        }
                        EventTitle(ev, past, happening, expanded, contentColor)
                        if (showLocation) {
                            Text(ev.location, style = MaterialTheme.typography.bodyMedium, color = mutedColor)
                        }
                        alerts.forEach { ChangeBlocks(it.detail, Modifier.padding(top = Spacing.xs)) }
                    }
                    Box(Modifier.size(40.dp, 24.dp), contentAlignment = Alignment.Center) {
                        DisclosureIcon(expanded, tint = mutedColor)
                    }
                }
            }
            AnimatedVisibility(visible = expanded, enter = revealEnter(), exit = revealExit()) {
                EventDetails(ev, now, alerts)
            }
        }
    }
}

@Composable
private fun EventCategoryLabel(
    ev: CalendarEvent,
    label: String,
    past: Boolean,
    happening: Boolean,
    expanded: Boolean,
    accent: Color,
) {
    Text(
        listOfNotNull(ev.course?.takeIf { it.isNotBlank() && !ev.title.startsWith(it) }, label).joinToString(" · "),
        style = MaterialTheme.typography.labelMediumEmphasized,
        color = when {
            past -> MaterialTheme.colorScheme.onSurfaceVariant
            happening && !expanded -> MaterialTheme.colorScheme.onPrimaryContainer
            ev.category == "opens" || ev.category == "event" -> MaterialTheme.colorScheme.onSurfaceVariant
            else -> accent
        },
    )
}

@Composable
private fun EventNowLabel(expanded: Boolean) {
    Text(
        "Happening now",
        style = MaterialTheme.typography.labelSmall,
        color = if (expanded) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

@Composable
private fun EventTitle(ev: CalendarEvent, past: Boolean, happening: Boolean, expanded: Boolean, contentColor: Color) {
    Text(
        ev.title,
        style = MaterialTheme.typography.titleMediumEmphasized,
        color = when {
            past -> MaterialTheme.colorScheme.onSurfaceVariant
            happening && !expanded -> contentColor
            ev.phase == "opens" -> MaterialTheme.colorScheme.onSurfaceVariant
            else -> contentColor
        },
    )
}

@Composable
private fun EventTimeContent(ev: CalendarEvent, timeColor: Color, compact: Boolean) {
    when {
        ev.allDay -> Text(
            if (ev.category == "deadline" || ev.category == "exam") "Date only" else "All day",
            style = MaterialTheme.typography.labelLargeEmphasized,
            color = timeColor,
        )
        ev.category == "deadline" -> {
            if (compact) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text("Due", style = MaterialTheme.typography.labelSmall, color = timeColor)
                    Text(Format.time(ev.startsAt), style = MaterialTheme.typography.labelLargeEmphasized, color = timeColor)
                }
            } else {
                Text("Due", style = MaterialTheme.typography.labelSmall, color = timeColor)
                Text(Format.time(ev.startsAt), style = MaterialTheme.typography.labelLargeEmphasized, color = timeColor)
            }
        }
        compact -> Text(
            if (ev.endsAt > ev.startsAt) "${Format.time(ev.startsAt)} – ${Format.time(ev.endsAt)}" else Format.time(ev.startsAt),
            style = MaterialTheme.typography.labelLargeEmphasized,
            color = timeColor,
        )
        else -> {
            Text(Format.time(ev.startsAt), style = MaterialTheme.typography.labelLargeEmphasized, color = timeColor)
            if (ev.endsAt > ev.startsAt) Text(Format.time(ev.endsAt), style = MaterialTheme.typography.labelMedium, color = timeColor)
        }
    }
}

@Composable
private fun EventDetails(ev: CalendarEvent, now: Long, alerts: List<CalendarChangeAlert>) {
    val uri = LocalUriHandler.current
    var showEvidence by rememberSaveable(ev.occurrenceId) { mutableStateOf(false) }
    val description = ev.description.trim()
    val subtitle = ev.subtitle.trim().takeUnless { it.isEmpty() || it == description || description.startsWith(it) }
    val scope = listOfNotNull(
        ev.groupScope?.section?.let { "Section $it" },
        ev.groupScope?.groups?.takeIf { it.size == 2 }?.let { "Groups ${it[0]}–${it[1]}" },
    ).joinToString(" · ")
    val links = (ev.links + listOfNotNull(ev.url?.let { dev.peteryhs.unidash.data.Link("Open source", it) }))
        .filter { it.url.startsWith("https://") || it.url.startsWith("http://") }
        .distinctBy { it.url }

    Column(
        Modifier.fillMaxWidth().padding(start = Spacing.inset, end = Spacing.inset, bottom = Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Spacing.ms),
    ) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (ev.category == "opens" && ev.dueAt != null) DetailLine("Due", Format.dayTime(ev.dueAt))
        if (ev.location.isNotBlank() && alerts.none { it.detail.roomMoved }) DetailLine("Location", ev.location)
        alerts.filterNot { it.detail.confirmed }.forEach { change ->
            val note = if (change.detail.roomMoved) {
                "This room change is inferred from the schedule pattern. Confirm it with the course source."
            } else {
                "This change needs confirmation. Check the course source before relying on it."
            }
            DetailLine("Confidence", note)
        }
        if (scope.isNotBlank()) DetailLine("For", scope)
        if (subtitle != null) DetailLine("Details", subtitle)
        if (description.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text("Description", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            CalendarMarkdown(description)
        }
        if (ev.topics.isNotEmpty()) SyllabusTopics(
            if (ev.syllabusScope == "period") "Topics for this period" else "Topics",
            ev.topics,
        )
        if (ev.readings.isNotEmpty()) SyllabusReadings(ev.readings)
        if (ev.syllabusEvidence.isNotEmpty()) {
            TextButton(
                onClick = { showEvidence = !showEvidence },
                contentPadding = PaddingValues(horizontal = 0.dp, vertical = Spacing.xs),
            ) {
                Text(if (showEvidence) "Hide syllabus source" else "Show syllabus source")
            }
            AnimatedVisibility(
                visible = showEvidence,
                enter = expandVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) +
                    fadeIn(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
                exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) +
                    fadeOut(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    ev.syllabusEvidence.forEach { evidence -> Text(evidence, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Text("From ${ev.sourceLabel}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FreshnessLabel(ev.state, ev.observedAt, now)
        }
        if (links.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                links.forEach { link ->
                    AssistChip(
                        onClick = { uri.openUri(link.url) },
                        label = { Text(link.label, maxLines = 1) },
                        leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) },
                    )
                }
            }
        }
    }
}

@Composable
private fun SyllabusTopics(title: String, topics: List<String>) {
    val cleanTopics = topics.map(String::trim).filter(String::isNotEmpty).distinct()
    if (cleanTopics.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            cleanTopics.forEach { topic ->
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(topic, style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs))
                }
            }
        }
    }
}

@Composable
private fun SyllabusReadings(readings: List<String>) {
    val cleanReadings = readings.map(String::trim).filter(String::isNotEmpty).distinct()
    if (cleanReadings.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Text("Readings", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        cleanReadings.forEach { reading ->
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Text("•", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(reading, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun categoryStyle(ev: CalendarEvent): Pair<Color, String> {
    val c = MaterialTheme.colorScheme
    if (ev.attendance == "replaced") return c.tertiary to "Online work instead"
    return when (ev.category) {
        "class" -> c.primary to classKind(ev.title)
        "exam" -> c.error to "Exam"
        "office_hours" -> c.secondary to "Office hours"
        // The time already reads "Due 5:00 p.m."; the category names the kind instead of repeating it.
        "deadline" -> c.tertiary to "Deadline"
        "opens" -> c.outline to "Opens"
        else -> c.outline to "Event"
    }
}

/** "MATH 115 LEC 001" -> "Lecture". UW section codes are stable enough to name. */
private fun classKind(title: String): String = when (Regex("\\b(LEC|TUT|LAB|SEM|TST|PRJ)\\b").find(title)?.value) {
    "LEC" -> "Lecture"
    "TUT" -> "Tutorial"
    "LAB" -> "Lab"
    "SEM" -> "Seminar"
    "TST" -> "Test"
    "PRJ" -> "Project"
    else -> "Class"
}
