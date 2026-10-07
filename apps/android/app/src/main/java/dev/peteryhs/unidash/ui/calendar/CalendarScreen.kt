package dev.peteryhs.unidash.ui.calendar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.CalendarChangeAlert
import dev.peteryhs.unidash.data.CalendarSource
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.theme.Spacing

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
fun CalendarScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState) {
    var filter by rememberSaveable { mutableStateOf(Filter.All) }
    var expanded by rememberSaveable { mutableStateOf<String?>(null) }
    val calendar = snapshot.calendar

    ScreenScaffold("Calendar", "Next two weeks", snapshot, now, snackbar, onRefresh = vm::refresh) {
        item(key = "filters") {
            Row(Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Filter.entries.forEach { f ->
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }
        }
        if (calendar == null) {
            item { EmptyNote("No calendar loaded yet.") }
            return@ScreenScaffold
        }
        filterWarnedCalendarSources(calendar.sources).forEach { s ->
            val name = CALENDAR_SOURCE_NAMES[s.id] ?: s.id
            item(key = "src:${s.id}") { EmptyNote("$name: ${if (s.status == "failed") "last fetch failed" else "not configured"}") }
        }
        var shown = 0
        calendar.alerts.filter { it.kind in setOf("cancelled", "removed") }.forEach { change ->
            item(key = "change:${change.id}") { EmptyNote("${change.title}. ${change.body}") }
        }
        calendar.days.forEach { day ->
            val events = day.events.filter { filter.categories.isEmpty() || it.category in filter.categories }
            if (events.isEmpty()) return@forEach
            shown += events.size
            stickyHeader(key = "day:${day.date}") {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        Format.dayHeader(day.date),
                        style = MaterialTheme.typography.titleMediumEmphasized,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = Spacing.m, end = Spacing.m, top = Spacing.m, bottom = Spacing.s),
                    )
                }
            }
            items(events, key = { "ev:${day.date}:${it.occurrenceId}" }) { ev ->
                EventRow(ev, now, expanded == ev.occurrenceId, onToggle = {
                    expanded = if (expanded == ev.occurrenceId) null else ev.occurrenceId
                }, Modifier.animateItem(), calendar.alerts.filter { it.eventId == ev.id })
            }
        }
        if (shown == 0) item { EmptyNote("Nothing scheduled.") }
    }
}

@Composable
private fun EventRow(ev: CalendarEvent, now: Long, expanded: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier, alerts: List<CalendarChangeAlert> = emptyList()) {
    val past = ev.endsAt < now
    val happening = !ev.allDay && now in ev.startsAt..ev.endsAt
    val (accent, label) = categoryStyle(ev)
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(),
        label = "Calendar detail chevron",
    )
    val time = when {
        ev.allDay -> "All day · no exact time"
        ev.category == "deadline" -> "Due ${Format.time(ev.startsAt)}"
        else -> "${Format.time(ev.startsAt)} – ${Format.time(ev.endsAt)}"
    }
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
        color = if (expanded || happening) MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surface,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column {
            ListItem(
                leadingContent = {
                    Box(Modifier.width(4.dp).height(40.dp).background(accent, RoundedCornerShape(2.dp)))
                },
                overlineContent = {
                    Text(label, color = if (ev.category == "opens" || ev.category == "event") MaterialTheme.colorScheme.onSurfaceVariant else accent)
                },
                headlineContent = { Text(ev.title, maxLines = if (expanded) 4 else 1, overflow = TextOverflow.Ellipsis) },
                supportingContent = {
                    Column {
                        Text(listOf(time, ev.location).filter { it.isNotBlank() }.joinToString(" · "))
                        alerts.forEach { Text(if (expanded) it.body else it.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
                    }
                },
                trailingContent = {
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        when {
                            happening -> Text("Now", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            !past && ev.startsAt > now && ev.startsAt - now < 12 * 3_600_000L ->
                                Text(Format.relative(ev.startsAt, now), style = MaterialTheme.typography.labelMedium)
                        }
                        Icon(Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.graphicsLayer { rotationZ = rotation })
                    }
                },
                colors = ListItemDefaults.colors(
                    containerColor = Color.Transparent,
                    headlineColor = if (past || ev.phase == "opens") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                ),
                modifier = Modifier.clickable(role = Role.Button, onClick = onToggle)
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            )
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeIn(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
                exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeOut(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
            ) { EventDetails(ev, now) }
        }
    }
}

@Composable
private fun EventDetails(ev: CalendarEvent, now: Long) {
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
    if (ev.attendance == "replaced") return c.tertiary to "Replaced by online work"
    return when (ev.category) {
        // The course is usually the start of the title already ("MATH 115 LEC 001"); say what it is instead.
        "class" -> c.primary to (ev.course?.takeUnless { ev.title.startsWith(it) } ?: classKind(ev.title))
        "exam" -> c.error to "Exam"
        "office_hours" -> c.secondary to "Office hours"
        "deadline" -> c.tertiary to (ev.course?.let { "$it · Due" } ?: "Due")
        "opens" -> c.outline to (ev.course?.let { "$it · Opens" } ?: "Opens")
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
