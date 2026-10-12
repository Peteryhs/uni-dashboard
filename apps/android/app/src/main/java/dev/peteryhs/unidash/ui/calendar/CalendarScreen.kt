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
import dev.peteryhs.unidash.ui.theme.Spacing
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

    ScreenScaffold("Calendar", "Next two weeks", snapshot, now, snackbar, onRefresh = vm::refresh, onStatus = onStatus, listState = agendaListState, headerSize = ScreenHeaderSize.Medium) {
        item(key = "filters") {
            val selectFilter: (Filter) -> Unit = { selected ->
                if (filter != selected) {
                    filter = selected
                    expanded = null
                    scope.launch { agendaListState.scrollToItem(0) }
                }
            }
            BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs)) {
                val fontScale = LocalDensity.current.fontScale
                val useWrappingChips = maxWidth < 300.dp || fontScale >= 1.2f
                if (useWrappingChips) {
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                    ) {
                        Filter.entries.forEach { f ->
                            FilterChip(
                                selected = filter == f,
                                onClick = { selectFilter(f) },
                                label = {
                                    Text(f.label, style = if (filter == f) MaterialTheme.typography.labelLargeEmphasized else MaterialTheme.typography.labelLarge)
                                },
                            )
                        }
                    }
                } else {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        Filter.entries.forEachIndexed { index, f ->
                            SegmentedButton(
                                selected = filter == f,
                                onClick = { selectFilter(f) },
                                shape = SegmentedButtonDefaults.itemShape(index = index, count = Filter.entries.size),
                                icon = {},
                                label = {
                                    Text(f.label, maxLines = 1, style = if (filter == f) MaterialTheme.typography.labelLargeEmphasized else MaterialTheme.typography.labelLarge)
                                },
                            )
                        }
                    }
                }
            }
        }
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
            item(key = "src:${s.id}") { EmptyNote("$name: ${if (s.status == "failed") "last fetch failed" else "not configured"}") }
        }
        var shown = 0
        calendar.alerts.filter { it.kind in setOf("cancelled", "removed") }.forEach { change ->
            item(key = "change:${change.id}") {
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
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
                    EventRow(ev, now, expanded == ev.occurrenceId, onToggle = {
                        expanded = if (expanded == ev.occurrenceId) null else ev.occurrenceId
                    }, eventIndex = index,
                        groupStart = if (isToday && markerIndex >= 0 && index >= markerIndex) markerIndex else 0,
                        groupEnd = if (isToday && markerIndex >= 0 && index < markerIndex) markerIndex - 1 else events.lastIndex,
                        modifier = Modifier.animateItem(
                        fadeInSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
                        placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
                        fadeOutSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
                    ), alerts = calendar.alerts.filter { it.eventId == ev.id })
                }
            }
            if (markerIndex == events.size) item(key = "now:${day.date}") { CalendarNowMarker(now) }
            if (isToday && events.isEmpty()) item(key = "clear:${day.date}") { EmptyNote("Nothing scheduled today.") }
        }
        if (shown == 0 && calendar.days.none { it.date == campusDay(now).toString() }) item { EmptyNote("Nothing scheduled.") }
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
            Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s)
                .clearAndSetSemantics {
                    contentDescription = "${if (isToday) "Today. " else ""}$weekday, $fullDate. $count ${if (count == 1) "event" else "events"}."
                    heading()
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Surface(color = tileColor, contentColor = tileContent, shape = RoundedCornerShape(12.dp)) {
                Column(
                    Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    Text(date.dayOfMonth.toString(), style = MaterialTheme.typography.titleLargeEmphasized)
                    Text(month, style = MaterialTheme.typography.labelSmall)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
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

@Composable
private fun CalendarNowMarker(now: Long) {
    val color = MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s)
            .clearAndSetSemantics { contentDescription = "Current time ${Format.time(now)}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text("Now ${Format.time(now)}", style = MaterialTheme.typography.labelMedium, color = color)
        Box(Modifier.size(6.dp).background(color, CircleShape))
        HorizontalDivider(modifier = Modifier.weight(1f), color = color)
    }
}

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
    val outerRadius = 20.dp
    val innerRadius by animateDpAsState(
        targetValue = if (highlighted) 8.dp else 4.dp,
        animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
        label = "Calendar event join corner",
    )
    val contentColor = if (happening && !expanded) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface
    val timeColor = when {
        past -> MaterialTheme.colorScheme.onSurfaceVariant
        happening && !expanded -> MaterialTheme.colorScheme.onPrimaryContainer
        else -> MaterialTheme.colorScheme.onSurface
    }
    val roomShownBelow = alerts.any { it.detail.roomMoved }

    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = 1.dp),
        color = containerColor,
        contentColor = contentColor,
        shape = eventGroupShape(
            isGroupStart = eventIndex == groupStart,
            isGroupEnd = eventIndex == groupEnd,
            outer = outerRadius,
            inner = innerRadius,
        ),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.s, vertical = Spacing.s)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Column(
                    Modifier.width(88.dp),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    when {
                        ev.allDay -> Text(
                            if (ev.category == "deadline" || ev.category == "exam") "Date only" else "All day",
                            style = MaterialTheme.typography.labelLargeEmphasized,
                            color = timeColor,
                        )
                        ev.category == "deadline" -> {
                            Text("Due", style = MaterialTheme.typography.labelSmall, color = timeColor)
                            Text(Format.time(ev.startsAt), style = MaterialTheme.typography.labelLargeEmphasized, color = timeColor)
                        }
                        else -> {
                            Text(Format.time(ev.startsAt), style = MaterialTheme.typography.labelLargeEmphasized, color = timeColor)
                            if (ev.endsAt > ev.startsAt) Text(Format.time(ev.endsAt), style = MaterialTheme.typography.labelMedium, color = timeColor)
                        }
                    }
                }
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
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
                    if (happening) Text(
                        "Happening now",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (expanded) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onPrimaryContainer,
                    )
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
                    if (ev.location.isNotBlank() && !roomShownBelow) {
                        Text(ev.location, style = MaterialTheme.typography.bodySmall, color = if (happening && !expanded) contentColor else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    alerts.forEach { ChangeBlocks(it.detail) }
                }
                FilledTonalIconButton(
                    onClick = onToggle,
                    shapes = IconButtonDefaults.shapes(),
                    modifier = Modifier.semantics {
                        contentDescription = if (expanded) "Hide details for ${ev.title}" else "Show details for ${ev.title}"
                        stateDescription = listOfNotNull(
                            if (past) "Past event" else null,
                            if (happening) "Happening now" else null,
                            if (expanded) "Expanded" else "Collapsed",
                        ).joinToString(", ")
                    },
                ) {
                    DisclosureIcon(expanded = expanded, tint = MaterialTheme.colorScheme.onSecondaryContainer)
                }
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeIn(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
                exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeOut(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
            ) { EventDetails(ev, now, alerts) }
        }
    }
}

private fun eventGroupShape(
    isGroupStart: Boolean,
    isGroupEnd: Boolean,
    outer: androidx.compose.ui.unit.Dp,
    inner: androidx.compose.ui.unit.Dp,
): RoundedCornerShape {
    val top = if (isGroupStart) outer else inner
    val bottom = if (isGroupEnd) outer else inner
    return RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
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
        Modifier.fillMaxWidth().padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (ev.category == "opens" && ev.dueAt != null) DetailLine("Due", Format.dayTime(ev.dueAt))
        if (ev.location.isNotBlank()) DetailLine("Location", ev.location)
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
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text("From ${ev.sourceLabel}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FreshnessLabel(ev.state, ev.observedAt, now)
        }
        if (links.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
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
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(80.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
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
        "deadline" -> c.tertiary to "Due"
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
