package dev.peteryhs.unidash.ui.calendar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CalendarEvent
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.muted
import dev.peteryhs.unidash.ui.theme.Spacing

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
        calendar.sources.filter { it.status == "unconfigured" || it.status == "failed" }.forEach { s ->
            item(key = "src:${s.id}") { EmptyNote("${s.id}: ${if (s.status == "failed") "last fetch failed" else "not configured"}") }
        }
        var shown = 0
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
                }, Modifier.animateItem())
            }
        }
        if (shown == 0) item { EmptyNote("Nothing scheduled.") }
    }
}

@Composable
private fun EventRow(ev: CalendarEvent, now: Long, expanded: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val uri = LocalUriHandler.current
    val past = ev.endsAt < now
    val (accent, label) = categoryStyle(ev)
    Column(modifier.muted(past || ev.phase == "opens")) {
        ListItem(
            leadingContent = {
                Box(Modifier.width(4.dp).height(40.dp).background(accent, RoundedCornerShape(2.dp)))
            },
            overlineContent = { Text(label) },
            headlineContent = { Text(ev.title, maxLines = if (expanded) 4 else 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = {
                val time = when {
                    ev.allDay -> "All day"
                    ev.category == "deadline" -> "Due ${Format.time(ev.startsAt)}"
                    else -> "${Format.time(ev.startsAt)} – ${Format.time(ev.endsAt)}"
                }
                Text(listOf(time, ev.location).filter { it.isNotBlank() }.joinToString(" · "))
            },
            trailingContent = {
                if (!past && ev.startsAt > now && ev.startsAt - now < 12 * 3_600_000L) {
                    Text(Format.relative(ev.startsAt, now), style = MaterialTheme.typography.labelMedium)
                }
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.clickable(onClick = onToggle),
        )
        AnimatedVisibility(expanded) {
            Column(Modifier.padding(start = 72.dp, end = Spacing.m, bottom = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                if (ev.subtitle.isNotBlank()) Text(ev.subtitle, style = MaterialTheme.typography.bodyMedium)
                if (ev.description.isNotBlank()) Text(ev.description, style = MaterialTheme.typography.bodyMedium, maxLines = 8, overflow = TextOverflow.Ellipsis)
                Text("From ${ev.sourceLabel}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FreshnessLabel(ev.state, null, now)
                val links = (listOfNotNull(ev.url?.let { dev.peteryhs.unidash.data.Link("Open", it) }) + ev.links).distinctBy { it.url }.take(3)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    links.forEach { l ->
                        AssistChip(onClick = { uri.openUri(l.url) }, label = { Text(l.label, maxLines = 1) }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) })
                    }
                }
            }
        }
    }
}

@Composable
private fun categoryStyle(ev: CalendarEvent): Pair<Color, String> {
    val c = MaterialTheme.colorScheme
    return when (ev.category) {
        "class" -> c.primary to (ev.course ?: "Class")
        "exam" -> c.error to "Exam"
        "office_hours" -> c.secondary to "Office hours"
        "deadline" -> c.tertiary to (ev.course?.let { "$it · Due" } ?: "Due")
        "opens" -> c.outline to (ev.course?.let { "$it · Opens" } ?: "Opens")
        else -> c.outline to "Event"
    }
}
