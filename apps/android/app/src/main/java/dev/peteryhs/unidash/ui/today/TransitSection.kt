package dev.peteryhs.unidash.ui.today

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DirectionsWalk
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.DirectionsBus
import androidx.compose.material.icons.outlined.Tram
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import dev.peteryhs.unidash.data.TransitCommute
import dev.peteryhs.unidash.data.TransitDeparture
import dev.peteryhs.unidash.data.TransitView
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.NoticeRow
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.groupedShape
import dev.peteryhs.unidash.ui.listItemMotion
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch
import java.time.Instant

private fun campusDate(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).atZone(CAMPUS_ZONE).toLocalDate().toString()

/** GRT runs ION light rail as route 301; every other route is a bus. */
internal fun isIon(route: String): Boolean = route.trim() == "301"

internal fun transitIcon(route: String): ImageVector = if (isIon(route)) Icons.Outlined.Tram else Icons.Outlined.DirectionsBus

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
            LeaveCard(
                headline = if (leave != null) "Leave ${Format.relative(leave, now)}" else g.message,
                detail = if (leave != null) {
                    val basis = if (g.departure?.isLive(now) == true) "Predicted" else "Scheduled"
                    "For ${g.eventTitle} · at ${Format.time(leave)} · $basis"
                } else null,
                // The server's sentence carries the route and stop detail under the headline.
                message = g.message.takeIf { leave != null && it.isNotBlank() },
            )
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
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
                )
            }
        }
    }
}

/** The one time-critical transit fact: an emphasized panel led by a walking glyph. */
@Composable
private fun LeaveCard(headline: String, detail: String?, message: String?) {
    val colors = MaterialTheme.colorScheme
    Surface(
        color = colors.tertiaryContainer,
        contentColor = colors.onTertiaryContainer,
        shape = RoundedCornerShape(Corners.hero),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
    ) {
        Row(
            Modifier.padding(Spacing.m).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(Spacing.ms),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ShapedIcon(
                Icons.AutoMirrored.Outlined.DirectionsWalk,
                container = colors.tertiary,
                content = colors.onTertiary,
                size = 48.dp,
                shape = MaterialShapes.Cookie7Sided,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(headline, style = MaterialTheme.typography.titleLargeEmphasized)
                detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
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
    shape: Shape,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val colors = MaterialTheme.colorScheme
    val journey = data.journeys.find { it.commuteId == commute.id }
    val departures = journey?.departures.orEmpty()
        .filter { !it.cancelled && it.departureAt(now, offline) - commute.walkToMinutes * 60_000L >= now }
        .take(3)
    val routeHint = departures.firstOrNull()?.route ?: commute.route
    val container by animateColorAsState(
        targetValue = if (active) colors.secondaryContainer else colors.surfaceContainerLow,
        animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
        label = "Commute container color",
    )
    Surface(
        color = container,
        contentColor = if (active) colors.onSecondaryContainer else colors.onSurface,
        shape = shape,
        modifier = modifier,
    ) {
        Column(
            Modifier.padding(start = Spacing.inset, end = Spacing.inset, top = Spacing.ms, bottom = Spacing.ms),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.ms), verticalAlignment = Alignment.CenterVertically) {
                ShapedIcon(
                    transitIcon(routeHint),
                    container = if (active) colors.secondary else colors.primaryContainer,
                    content = if (active) colors.onSecondary else colors.onPrimaryContainer,
                    size = 40.dp,
                    shape = MaterialShapes.Cookie9Sided,
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(commute.name, style = MaterialTheme.typography.titleMediumEmphasized, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${commute.originName} → ${commute.destinationName}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (active) colors.onSecondaryContainer else colors.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (active) TripChip()
            }
            if (departures.isNotEmpty()) {
                Surface(
                    color = if (active) colors.surfaceContainerLowest.copy(alpha = 0.6f) else colors.surfaceContainer,
                    shape = RoundedCornerShape(Corners.tile + 4.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(horizontal = Spacing.ms, vertical = Spacing.xs)) {
                        departures.forEachIndexed { i, departure ->
                            if (i > 0) HorizontalDivider(color = colors.outlineVariant.copy(alpha = 0.6f))
                            DepartureRow(departure, now, offline, first = i == 0)
                        }
                    }
                }
            } else {
                Text(
                    if (journey?.scheduleValid == true) "No direct departures you can still catch today." else "Timetable unavailable for today.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                )
            }
            journey?.alerts.orEmpty().forEach { alert ->
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.Top) {
                    Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = colors.error, modifier = Modifier.size(18.dp))
                    Text(alert, color = colors.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (active || canActivate) {
                if (!active && targetLabel != null) {
                    Text(targetLabel, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                }
                val onClick: () -> Unit = {
                    busy = true; error = null
                    scope.launch {
                        try { vm.setTransitActivation(if (active) null else commute.id).onFailure { error = MainViewModel.describe(it) } }
                        finally { busy = false }
                    }
                }
                if (active) {
                    OutlinedButton(
                        onClick = onClick,
                        enabled = !offline && !busy,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MinHeight),
                    ) {
                        Icon(Icons.Outlined.Close, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                        Text("Cancel today’s trip", Modifier.padding(start = ButtonDefaults.IconSpacing))
                    }
                } else {
                    FilledTonalButton(
                        onClick = onClick,
                        enabled = !offline && !busy,
                        shapes = ButtonDefaults.shapes(),
                        modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MinHeight),
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.DirectionsWalk, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
                        Text("Going to campus", Modifier.padding(start = ButtonDefaults.IconSpacing))
                    }
                }
            }
            error?.let { Text(it, color = colors.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Route pill, headsign and basis, then the departure time as the row's emphasized figure. */
@Composable
private fun DepartureRow(departure: TransitDeparture, now: Long, offline: Boolean, first: Boolean) {
    val colors = MaterialTheme.colorScheme
    val live = departure.isLive(now, offline)
    val basis = when {
        live && departure.predictedDeparture != null -> "Live"
        offline -> "Saved schedule"
        else -> "Scheduled"
    }
    val departs = departure.departureAt(now, offline)
    val arrivalNote = if (live && departure.predictedArrival == null) " (scheduled)" else ""
    Row(
        Modifier.fillMaxWidth().padding(vertical = Spacing.s).semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(Spacing.ms),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoutePill(departure.route)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(departure.headsign, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                if (live) Box(Modifier.size(6.dp).background(colors.tertiary, CircleShape))
                Text(
                    "$basis · arrives ${Format.time(departure.arrivalAt(now, offline))}$arrivalNote",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (live) colors.tertiary else colors.onSurfaceVariant,
                )
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                Format.time(departs),
                style = if (first) MaterialTheme.typography.titleMediumEmphasized else MaterialTheme.typography.titleSmall,
            )
            Text(Format.relative(departs, now), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        }
    }
}

/** GRT-style route badge: a fully rounded pill, ION in its own container colour. */
@Composable
internal fun RoutePill(route: String) {
    val colors = MaterialTheme.colorScheme
    val ion = isIon(route)
    Surface(
        color = if (ion) colors.tertiary else colors.primary,
        contentColor = if (ion) colors.onTertiary else colors.onPrimary,
        shape = CircleShape,
        modifier = Modifier.widthIn(min = 44.dp).semantics { contentDescription = if (ion) "ION route $route" else "Route $route" },
    ) {
        Text(
            route,
            style = MaterialTheme.typography.labelLargeEmphasized,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun TripChip() {
    Surface(
        color = MaterialTheme.colorScheme.secondary,
        contentColor = MaterialTheme.colorScheme.onSecondary,
        shape = CircleShape,
    ) {
        Text(
            "Trip on",
            style = MaterialTheme.typography.labelMediumEmphasized,
            modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs),
        )
    }
}
