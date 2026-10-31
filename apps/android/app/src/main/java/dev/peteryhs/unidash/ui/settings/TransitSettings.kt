package dev.peteryhs.unidash.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.ContractJson
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.TransitCommute
import dev.peteryhs.unidash.data.TransitStop
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.NoticeRow
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.groupedShape
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val commuteSaver = Saver<TransitCommute, String>(save = { ContractJson.encodeToString(it) }, restore = { ContractJson.decodeFromString<TransitCommute>(it) })

/**
 * Saved GRT commutes. Uses the same building blocks as the other settings pages: gutter section
 * headers, connected rows for saved items, an action group, and a panel around the editor form.
 */
@Composable
fun TransitSettings(vm: MainViewModel, snapshot: Snapshot) {
    val scope = rememberCoroutineScope()
    var commutes by remember(snapshot.sessionGeneration) { mutableStateOf(snapshot.recommendations?.transit?.commutes.orEmpty()) }
    var draft by rememberSaveable(stateSaver = commuteSaver) { mutableStateOf(TransitCommute()) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<TransitCommute?>(null) }
    val offline = snapshot.error != null
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    LaunchedEffect(snapshot.sessionGeneration) {
        try { commutes = vm.transitCommutes() }
        catch (e: CancellationException) { throw e }
        catch (e: Throwable) { error = MainViewModel.describe(e) }
    }
    Column(Modifier.fillMaxWidth()) {
        Text(
            "Direct GRT bus and ION commutes. Set your walking and arrival buffers, then tap Going to campus on Today when you leave your saved origin.",
            style = MaterialTheme.typography.bodyMedium,
            color = muted,
            modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.s),
        )
        if (offline) NoticeRow("Saved information. Connect to change commutes.", Icons.Outlined.CloudOff)
        if (!editing) {
            SectionHeader("Saved commutes")
            if (commutes.isEmpty()) {
                Text(
                    "No saved commutes. Timetables may take a few minutes to prepare after first deployment.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = muted,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs),
                )
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter),
                verticalArrangement = Arrangement.spacedBy(Spacing.joined),
            ) {
                commutes.forEachIndexed { index, commute ->
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                        shape = groupedShape(index, commutes.size),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(start = Spacing.inset, end = Spacing.xs, top = Spacing.rowVertical, bottom = Spacing.xs)) {
                            Text(commute.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${commute.originName} → ${commute.destinationName}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = muted,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                                TextButton(
                                    enabled = !offline && !busy,
                                    onClick = { draft = commute; editing = true; error = null },
                                    shapes = ButtonDefaults.shapes(),
                                    contentPadding = PaddingValues(horizontal = 0.dp),
                                ) { Text("Edit") }
                                TextButton(
                                    enabled = !offline && !busy,
                                    onClick = { removing = commute },
                                    shapes = ButtonDefaults.shapes(),
                                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                                ) { Text("Remove") }
                            }
                        }
                    }
                }
            }
            SectionHeader("Actions")
            SettingsActionGroup(
                listOf(
                    SettingsAction(
                        title = "Add commute",
                        detail = if (commutes.size >= 6) "You can save up to six commutes." else "Pick a boarding stop, a destination and your buffers.",
                        icon = Icons.Outlined.Add,
                        onClick = { draft = TransitCommute(); editing = true; error = null },
                        enabled = !offline && !busy && commutes.size < 6,
                    ),
                    SettingsAction(
                        title = "Update transit",
                        detail = "Fetch the latest GRT timetables and predictions.",
                        icon = Icons.Outlined.Refresh,
                        onClick = {
                            busy = true; error = null; notice = null
                            scope.launch {
                                try {
                                    vm.refreshTransit()
                                        .onSuccess { notice = "Transit update queued. Timetables and predictions will update shortly." }
                                        .onFailure { error = MainViewModel.describe(it) }
                                } finally { busy = false }
                            }
                        },
                        enabled = !offline && !busy,
                    ),
                ),
            )
        } else {
            SectionHeader(if (draft.id.isBlank()) "Add commute" else "Edit commute")
            SettingsPanel {
                Column(
                    Modifier.padding(horizontal = Spacing.inset, vertical = Spacing.rowVertical),
                    verticalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    val fieldsEnabled = !offline && !busy
                    OutlinedTextField(value = draft.name, onValueChange = { draft = draft.copy(name = it.take(80)) }, label = { Text("Name") }, enabled = fieldsEnabled, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    StopSearch("Boarding stop", draft.originName, "", fieldsEnabled, vm) { stop -> draft = draft.copy(origin = stop.id, originName = stop.name, destination = "", destinationName = "") }
                    StopSearch("Destination stop", draft.destinationName, draft.origin, fieldsEnabled && draft.origin.isNotBlank(), vm) { stop -> draft = draft.copy(destination = stop.id, destinationName = stop.name) }
                    OutlinedTextField(value = draft.route, onValueChange = { draft = draft.copy(route = it.take(40)) }, label = { Text("Route filter (optional)") }, enabled = fieldsEnabled, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    MinuteField("Walk to stop (min)", draft.walkToMinutes, fieldsEnabled) { draft = draft.copy(walkToMinutes = it) }
                    MinuteField("Walk after arrival (min)", draft.walkFromMinutes, fieldsEnabled) { draft = draft.copy(walkFromMinutes = it) }
                    MinuteField("Arrive early (min)", draft.arrivalBufferMinutes, fieldsEnabled) { draft = draft.copy(arrivalBufferMinutes = it) }
                    Row(Modifier.padding(top = Spacing.xs), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        Button(
                            enabled = fieldsEnabled && draft.name.isNotBlank() && draft.origin.isNotBlank() && draft.destination.isNotBlank(),
                            shapes = ButtonDefaults.shapes(),
                            onClick = {
                                busy = true; error = null
                                scope.launch {
                                    try {
                                        vm.saveTransit(draft).onSuccess {
                                            editing = false
                                            try { commutes = vm.transitCommutes() }
                                            catch (e: CancellationException) { throw e }
                                            catch (e: Throwable) { error = "Saved, but the list could not refresh. ${MainViewModel.describe(e)}" }
                                        }.onFailure { error = MainViewModel.describe(it) }
                                    } finally { busy = false }
                                }
                            },
                        ) { Text(if (busy) "Saving…" else "Save commute") }
                        TextButton(enabled = !busy, onClick = { editing = false }, shapes = ButtonDefaults.shapes()) { Text("Cancel") }
                    }
                }
            }
        }
        Column(Modifier.fillMaxWidth().padding(top = Spacing.s).semantics { liveRegion = LiveRegionMode.Polite }) {
            error?.let { NoticeRow(it, Icons.Outlined.WarningAmber, tint = MaterialTheme.colorScheme.error) }
            notice?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.xs))
            }
        }
        Text(
            "Contains information provided by the Regional Municipality of Waterloo under its open data licence. Predictions are estimates.",
            style = MaterialTheme.typography.bodySmall,
            color = muted,
            modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.m),
        )
    }
    removing?.let { commute ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${commute.name}?") },
            text = { Text("This removes the saved commute from all your devices.") },
            confirmButton = {
                TextButton(enabled = !offline && !busy, onClick = {
                    removing = null; busy = true
                    scope.launch {
                        try {
                            vm.deleteTransit(commute.id)
                                .onSuccess { commutes = commutes.filterNot { it.id == commute.id } }
                                .onFailure { error = MainViewModel.describe(it) }
                        } finally { busy = false }
                    }
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun MinuteField(label: String, value: Int, enabled: Boolean, onChange: (Int) -> Unit) {
    OutlinedTextField(value = value.toString(), onValueChange = { text -> if (text.isEmpty()) onChange(0) else text.toIntOrNull()?.takeIf { it in 0..120 }?.let(onChange) }, label = { Text(label) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = enabled, singleLine = true, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun StopSearch(label: String, selected: String, origin: String, enabled: Boolean, vm: MainViewModel, onSelect: (TransitStop) -> Unit) {
    var query by rememberSaveable(origin) { mutableStateOf("") }
    var stops by remember { mutableStateOf(emptyList<TransitStop>()) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query, origin) {
        stops = emptyList(); message = null
        if (query.trim().length < 2 || !enabled) return@LaunchedEffect
        delay(250); message = "Searching…"
        try { stops = vm.transitStops(query, origin); message = if (stops.isEmpty()) "No matching stops. Timetables may still be importing." else null }
        catch (e: CancellationException) { throw e }
        catch (e: Throwable) { message = MainViewModel.describe(e) }
    }
    OutlinedTextField(value = query, onValueChange = { query = it.take(80) }, label = { Text(label) }, placeholder = { Text("Search name or stop number") }, enabled = enabled, modifier = Modifier.fillMaxWidth(), singleLine = true)
    if (selected.isNotBlank()) Text("Selected: $selected", style = MaterialTheme.typography.bodySmall)
    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    stops.forEach { stop ->
        TextButton(enabled = enabled, onClick = { onSelect(stop); query = ""; stops = emptyList() }, shapes = ButtonDefaults.shapes()) {
            val routes = if (stop.mode == "ion" || stop.routes.isEmpty()) "" else " · " + (if (stop.routes.size == 1) "Route " else "Routes ") + stop.routes.joinToString(", ")
            val kind = if (stop.mode == "ion") "ION station" else "Bus stop ${stop.code}"
            Text("${stop.name} · $kind$routes" + (stop.hint?.let { "\n$it" } ?: ""))
        }
    }
}
