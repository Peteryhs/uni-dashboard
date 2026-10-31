package dev.peteryhs.unidash.ui.today

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import dev.peteryhs.unidash.data.TransitCommute
import dev.peteryhs.unidash.data.TransitView
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.NoticeRow
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.groupedShape
import dev.peteryhs.unidash.ui.listItemMotion
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch
import java.time.Instant

private fun campusDate(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).atZone(CAMPUS_ZONE).toLocalDate().toString()

/**
 * Transit on Today, laid out like the other sections: a gutter header, an optional leave-time
 * panel, then one grouped row per saved commute. Offline, departures fall back to the saved
 * timetable and every mutation is disabled.
 */
fun LazyListScope.transitSection(data: TransitView, now: Long, offline: Boolean, vm: MainViewModel) {
    val today = campusDate(now)
    val target = data.target?.takeIf { it.startsAt > now && campusDate(it.startsAt) == today }
    val activation = data.activation?.takeIf { it.date == today && target != null }
    val guidance = data.guidance?.takeIf { !offline && now < it.expiresAt }

    item(key = "transit-header") { SectionHeader("Transit") }
    if (offline) item(key = "transit-offline") { NoticeRow("Offline · showing the saved timetable", Icons.Outlined.CloudOff) }
    if (data.commutes.isEmpty()) {
        item(key = "transit-empty") {
            EmptyNote(if (data.status == "initializing") "GRT timetables are being prepared." else "Add a bus or ION commute in Settings → Transit.")
        }
    }
    guidance?.let { g ->
        item(key = "transit-guidance") {
            val commute = data.commutes.find { it.id == g.commuteId }
            val leave = g.departure?.departureAt(now)?.minus((commute?.walkToMinutes ?: 5) * 60_000L) ?: g.leaveAt
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                shape = RoundedCornerShape(Corners.group),
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
            ) {
                Column(
                    Modifier.padding(Spacing.inset).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    if (leave != null) {
                        Text("Leave ${Format.relative(leave, now)} for ${g.eventTitle}", style = MaterialTheme.typography.titleMediumEmphasized)
                        val basis = if (g.departure?.isLive(now) == true) "Predicted" else "Scheduled"
                        Text("At ${Format.time(leave)} · $basis", style = MaterialTheme.typography.bodyMedium)
                        // The server's sentence carries the route and stop detail under the headline.
                        if (g.message.isNotBlank()) Text(g.message, style = MaterialTheme.typography.bodySmall)
                    } else {
                        // Without a leave time the message is the headline; showing it twice was redundant.
                        Text(g.message, style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
        }
    }
    val commutes = data.commutes
    itemsIndexed(commutes, key = { _, c -> "transit:${c.id}" }) { index, commute ->
        CommuteRow(
            commute = commute,
            data = data,
            now = now,
            offline = offline,
            active = activation?.commuteId == commute.id,
            canActivate = target != null,
            targetLabel = target?.let { "For ${it.title} · ${Format.time(it.startsAt)}${it.location.takeIf { l -> l.isNotBlank() }?.let { l -> " · $l" } ?: ""}" },
            vm = vm,
            modifier = Modifier.listItemMotion(this).fillMaxWidth()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.joined / 2),
            shape = groupedShape(index, commutes.size),
        )
    }
    item(key = "transit-footer") {
        Column(Modifier.fillMaxWidth().padding(top = Spacing.xs)) {
            data.error?.let { NoticeRow(it, Icons.Outlined.WarningAmber, tint = MaterialTheme.colorScheme.error) }
            data.updatedAt?.let {
                Text(
                    "${if (offline) "Saved" else "Updated"} ${Format.age(it, now)} ago · GRT open data",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
                )
            }
        }
    }
}

@Composable
private fun CommuteRow(
    commute: TransitCommute,
    data: TransitView,
    now: Long,
    offline: Boolean,
    active: Boolean,
    canActivate: Boolean,
    targetLabel: String?,
    vm: MainViewModel,
    modifier: Modifier,
    shape: androidx.compose.ui.graphics.Shape,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val journey = data.journeys.find { it.commuteId == commute.id }
    val departures = journey?.departures.orEmpty()
        .filter { !it.cancelled && it.departureAt(now, offline) - commute.walkToMinutes * 60_000L >= now }
        .take(3)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = shape,
        modifier = modifier,
    ) {
        Column(
            Modifier.padding(horizontal = Spacing.inset, vertical = Spacing.rowVertical),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            Text(commute.name, style = MaterialTheme.typography.titleMedium)
            Text("${commute.originName} → ${commute.destinationName}", style = MaterialTheme.typography.bodySmall, color = muted)
            departures.forEach { departure ->
                val live = departure.isLive(now, offline)
                val basis = when {
                    live && departure.predictedDeparture != null -> "Predicted"
                    offline -> "Saved schedule"
                    else -> "Scheduled"
                }
                val arrivalNote = if (live && departure.predictedArrival == null) " (scheduled)" else ""
                Row(
                    Modifier.fillMaxWidth().padding(top = Spacing.xs).semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(Spacing.ms),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(departure.route, style = MaterialTheme.typography.titleMediumEmphasized)
                    Column(Modifier.weight(1f)) {
                        Text(departure.headsign, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "$basis · arrives ${Format.time(departure.arrivalAt(now, offline))}$arrivalNote",
                            style = MaterialTheme.typography.bodySmall,
                            color = muted,
                        )
                    }
                    Text(Format.time(departure.departureAt(now, offline)), style = MaterialTheme.typography.labelLargeEmphasized)
                }
            }
            if (departures.isEmpty()) {
                Text(
                    if (journey?.scheduleValid == true) "No saved boardable direct departures." else "Timetable unavailable for today.",
                    style = MaterialTheme.typography.bodySmall,
                    color = muted,
                )
            }
            journey?.alerts.orEmpty().forEach { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (active || canActivate) {
                if (!active && targetLabel != null) Text(targetLabel, style = MaterialTheme.typography.bodySmall, color = muted)
                val onClick: () -> Unit = {
                    busy = true; error = null
                    scope.launch {
                        try { vm.setTransitActivation(if (active) null else commute.id).onFailure { error = MainViewModel.describe(it) } }
                        finally { busy = false }
                    }
                }
                if (active) {
                    TextButton(onClick = onClick, enabled = !offline && !busy, shapes = ButtonDefaults.shapes(), contentPadding = PaddingValues(horizontal = 0.dp)) {
                        Text("Cancel today’s trip")
                    }
                } else {
                    FilledTonalButton(onClick = onClick, enabled = !offline && !busy, shapes = ButtonDefaults.shapes(), modifier = Modifier.padding(top = Spacing.xs)) {
                        Text("Going to campus")
                    }
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
