package dev.peteryhs.unidash.ui.food

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Dish
import dev.peteryhs.unidash.data.Food
import dev.peteryhs.unidash.data.Highlight
import dev.peteryhs.unidash.data.FoodPick
import dev.peteryhs.unidash.data.FoodRecommendationResponse
import dev.peteryhs.unidash.data.Outlet
import dev.peteryhs.unidash.data.RankedOutlet
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.Spacing
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import java.time.Instant
import java.text.Normalizer
import java.util.Locale

/** The saved dining summary and menus. Ranking and parsing happen on the server; this only renders them. */
@Composable
fun FoodScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState, onStatus: (() -> Unit)? = null) {
    val uri = LocalUriHandler.current
    var menuExpanded by rememberSaveable { mutableStateOf(false) }
    val foodCard = snapshot.bundle?.card("food")
    val food = foodCard?.payload<Food>()
    val pickCard = snapshot.bundle?.card("food_ai_recommendation")
    val ranking = snapshot.foodRanking?.takeIf { food != null &&
        (it.recommendation == null || it.recommendation.serviceDate == food.serviceDate) }
    val pick = ranking?.recommendation ?: pickCard?.payload<FoodPick>()?.takeIf { food == null || it.serviceDate == food.serviceDate }
    val processing = ranking?.isProcessing() == true
    val rankingBusy = snapshot.foodRankingSubmitting || processing
    val generationAllowed = !rankingBusy && ranking?.status != "budget_limited"
    val serviceDate = food?.serviceDate
    val menuIsToday = serviceDate == Instant.ofEpochMilli(now).atZone(CAMPUS_ZONE).toLocalDate().toString()

    ScreenScaffold(
        "Dining", serviceDate?.let { Format.dayHeader(it) }, snapshot, now, snackbar, onRefresh = vm::refresh,
        actions = {
            serviceDate?.let { date ->
                Box {
                    IconButton(
                        onClick = { menuExpanded = true },
                        modifier = Modifier.semantics { stateDescription = if (menuExpanded) "Expanded" else "Collapsed" },
                    ) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = "More dining options")
                    }
                    DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                        if (pick != null) {
                            DropdownMenuItem(
                                text = { Text("Rank again") },
                                enabled = generationAllowed,
                                onClick = {
                                    menuExpanded = false
                                    vm.rankFood(date)
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Open posted menu") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                uri.openUri("https://uwaterloo.ca/food-services/daily-menu?date=$date")
                            },
                        )
                    }
                }
            }
        },
        onStatus = onStatus,
    ) {
        if (food == null || foodCard == null) {
            item {
                EmptyNote(when {
                    snapshot.refreshing -> "Loading the dining menu…"
                    snapshot.error != null -> "Menu unavailable. Pull to retry."
                    else -> "No menu loaded yet. Pull to refresh."
                })
            }
            return@ScreenScaffold
        }
        item(key = "pick") {
            AiSummaryCard(
                pick = pick,
                ranking = ranking,
                state = pickCard?.state,
                observedAt = pickCard?.observedAt,
                now = now,
                submitting = snapshot.foodRankingSubmitting,
                processing = processing,
                canStartRanking = generationAllowed,
                onRank = { vm.rankFood(food.serviceDate) },
            )
        }
        val outlets = food.pinned + food.others
        val serving = outlets.filter { it.serving || it.dishCount > 0 }
            .sortedWith(compareBy<Outlet> { outlet ->
                pick?.rankedOutlets?.firstOrNull { diningNameMatches(it.outlet, outlet.outlet) }?.rank ?: Int.MAX_VALUE
            }.thenByDescending { it.pinned })
        if (serving.isEmpty()) {
            item(key = "none") {
                FreshnessLabel(foodCard.state, foodCard.observedAt, now, Modifier.padding(horizontal = Spacing.m))
                EmptyNote(food.error ?: "No menu published for today.")
            }
        }
        if (serving.isNotEmpty()) {
            item(key = "header") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionHeader(if (menuIsToday) "Serving today" else "Posted menu", Modifier.weight(1f))
                    FreshnessLabel(foodCard.state, foodCard.observedAt, now, Modifier.padding(end = Spacing.m, top = Spacing.m))
                }
            }
        }
        items(serving, key = { "outlet:${it.outlet}" }) { outlet ->
            val ranked = pick?.rankedOutlets?.firstOrNull { diningNameMatches(it.outlet, outlet.outlet) }
            OutletCard(outlet, ranked, isTop = pick?.topOutlet?.let { diningNameMatches(it, outlet.outlet) } == true)
        }
        val closed = outlets - serving.toSet()
        if (closed.isNotEmpty()) {
            item(key = "closed") { EmptyNote("Not serving: ${closed.joinToString { it.outlet.substringBefore(" - ") }}") }
        }
    }
}

@Composable
private fun AiSummaryCard(
    pick: FoodPick?,
    ranking: FoodRecommendationResponse?,
    state: dev.peteryhs.unidash.data.CardState?,
    observedAt: Long?,
    now: Long,
    submitting: Boolean,
    processing: Boolean,
    canStartRanking: Boolean,
    onRank: () -> Unit,
) {
    val top = pick?.rankedOutlets?.firstOrNull { it.outlet == pick?.topOutlet }
        ?: pick?.rankedOutlets?.firstOrNull { it.rank == 1 }
        ?: pick?.rankedOutlets?.firstOrNull()
    val outletName = (top?.outlet ?: pick?.topOutlet.orEmpty()).substringBefore(" - ").trim()
    val fullReason = top?.verdict?.trim().orEmpty().ifBlank { pick?.headline?.trim().orEmpty() }
    val reason = firstSentence(fullReason).ifBlank { "No explanation was saved for this ranking." }
    val longerReason = fullReason.removePrefix(reason).trim().trimStart(' ', '—', '-', ':')
    val tip = pick?.tip?.trim().orEmpty()
    val hasDetails = longerReason.isNotBlank() || tip.isNotBlank()
    val statusText = diningPickStatus(pick, ranking, submitting, processing, state)
    var detailsExpanded by rememberSaveable(pick?.serviceDate) { mutableStateOf(false) }

    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (pick != null) "Your pick" else "Dining pick", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        if (pick != null) outletName.ifBlank { "Saved recommendation" } else if (processing) "No saved pick yet" else "No saved dining pick",
                        style = if (pick != null) MaterialTheme.typography.titleLargeEmphasized else MaterialTheme.typography.titleMedium,
                    )
                }
                if (state != null && pick != null && ranking?.recommendation == null) FreshnessLabel(state, observedAt, now)
            }
            if (pick != null) {
                Text(reason, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (statusText != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    if (submitting) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(statusText, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (hasDetails && pick != null) {
                PickDetailsDisclosure(
                    expanded = detailsExpanded,
                    onClick = { detailsExpanded = !detailsExpanded },
                    longerReason = longerReason,
                    tip = tip,
                )
            }
            if (pick == null && canStartRanking) {
                FilledTonalButton(onClick = onRank) { Text("Find dining pick") }
            }
        }
    }
}

private fun FoodRecommendationResponse.isProcessing(): Boolean =
    rankingJob?.status == "processing" || status == "processing"

private fun firstSentence(value: String): String =
    Regex("^.*?[.!?](?=\\s|$)").find(value)?.value ?: value

private fun diningPickStatus(
    pick: FoodPick?,
    ranking: FoodRecommendationResponse?,
    submitting: Boolean,
    processing: Boolean,
    state: dev.peteryhs.unidash.data.CardState?,
): String? = when {
    submitting -> "Requesting pick…"
    processing && pick != null -> "Updating pick…"
    processing -> "Ranking pick…"
    ranking?.status == "budget_limited" && pick != null -> "New picks paused at the shared limit. Showing saved pick."
    ranking?.status == "budget_limited" -> "New picks paused at the shared limit."
    ranking?.status == "attempt_limited" || ranking?.status == "limited" ->
        "Automatic ranking has reached its daily limit."
    ranking?.status == "failed" && pick != null -> ranking.error.ifBlank { "Latest ranking failed. Showing saved pick." }
    ranking?.status == "failed" -> ranking.error.ifBlank { "Dining ranking is unavailable right now." }
    ranking?.stale == true && pick != null -> "Showing saved pick while an update is unavailable."
    state?.isStale == true && pick != null -> "Showing a saved pick from an older menu update."
    else -> null
}

@Composable
private fun PickDetailsDisclosure(
    expanded: Boolean,
    onClick: () -> Unit,
    longerReason: String,
    tip: String,
) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(),
        label = "Dining pick details chevron",
    )
    ListItem(
        headlineContent = { Text(if (expanded) "Hide pick details" else "More about this pick") },
        trailingContent = { Icon(Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.graphicsLayer { rotationZ = rotation }) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        modifier = Modifier.clickable(role = Role.Button, onClick = onClick)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
    )
    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) + fadeIn(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
        exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) + fadeOut(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            if (longerReason.isNotBlank()) Text(longerReason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (tip.isNotBlank()) Text(tip, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun OutletCard(outlet: Outlet, ranked: RankedOutlet?, isTop: Boolean) {
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column {
            ListItem(
                headlineContent = { Text(outlet.outlet.substringBefore(" - "), fontWeight = if (isTop) FontWeight.SemiBold else FontWeight.Medium) },
                trailingContent = {
                    Text(
                        when {
                            isTop -> "Recommended"
                            ranked != null -> "#${ranked.rank}"
                            else -> "${outlet.dishCount} dishes"
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            )
            if (outlet.dishes.isNotEmpty()) {
                Column(
                    Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    stationGroups(outlet.dishes).forEachIndexed { index, (station, dishes) ->
                        if (index > 0) HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = MaterialTheme.colorScheme.outlineVariant)
                        if (station.isNotBlank()) StationHeader(station)
                        dishes.forEach { d -> DishRow(d, ranked?.highlights?.firstOrNull { diningNameMatches(it.dish, d.dish) }) }
                    }
                }
            }
        }
    }
}

/** A quiet landmark for the counter inside the hall, distinct from the highlighted dishes. */
@Composable
private fun StationHeader(station: String) {
    Row(
        Modifier.fillMaxWidth().padding(top = Spacing.s, bottom = Spacing.xs).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(stationIcon(station), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Text(station, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun DishRow(d: Dish, highlight: Highlight?) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        // The AI pick is marked by a bar and the primary colour, not by words.
        if (highlight == null) Spacer(Modifier.width(4.dp))
        else Box(Modifier.width(4.dp).height(36.dp).background(MaterialTheme.colorScheme.primary, MaterialTheme.shapes.extraSmall))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            DietaryDishTitle(d.dish, d.diet, highlighted = highlight != null)
            highlight?.why?.takeIf { it.isNotBlank() }?.let { why ->
                Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

private fun diningTokens(value: String): Set<String> = Normalizer.normalize(value, Normalizer.Form.NFKD)
    .replace(Regex("\\p{M}+"), "")
    .lowercase(Locale.ROOT)
    .replace("&", " and ")
    .replace(Regex("[^a-z0-9]+"), " ")
    .trim()
    .split(Regex("\\s+"))
    .filter(String::isNotBlank)
    .map { token ->
        when {
            token.length > 4 && token.endsWith("ies") -> token.dropLast(3) + "y"
            token.length > 3 && token.endsWith("s") && !token.endsWith("ss") -> token.dropLast(1)
            else -> token
        }
    }.toSet()

/** Match web's dining names without treating a shared single word as the same outlet or dish. */
internal fun diningNameMatches(aiName: String, menuName: String): Boolean {
    val ai = diningTokens(aiName)
    val menu = diningTokens(menuName)
    if (ai.isEmpty() || menu.isEmpty()) return false
    if (ai == menu) return true
    val shorter = if (ai.size < menu.size) ai else menu
    val longer = if (ai.size < menu.size) menu else ai
    return shorter.size >= 2 && longer.containsAll(shorter)
}
