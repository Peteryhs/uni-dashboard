package dev.peteryhs.unidash.ui.food

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconToggleButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.CAMPUS_ZONE
import dev.peteryhs.unidash.data.Dish
import dev.peteryhs.unidash.data.Food
import dev.peteryhs.unidash.data.Highlight
import dev.peteryhs.unidash.data.FoodPick
import dev.peteryhs.unidash.data.FoodRecommendationResponse
import dev.peteryhs.unidash.data.Outlet
import dev.peteryhs.unidash.data.RankedOutlet
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.DisclosureIcon
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.InitialLoadingNote
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.ScreenHeaderSize
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.theme.Spacing
import java.text.Normalizer
import java.time.Instant
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
    val generationAllowed = food != null && !rankingBusy && ranking?.status != "budget_limited"
    val serviceDate = food?.serviceDate ?: pick?.serviceDate
    val recommendedOutlet = pick?.topOutlet?.takeIf(String::isNotBlank)
        ?: pick?.rankedOutlets?.minByOrNull { it.rank }?.outlet
    var manuallyExpandedOutlets by rememberSaveable(
        serviceDate,
        stateSaver = listSaver<Set<String>, String>(save = { it.toList() }, restore = { it.toSet() }),
    ) { mutableStateOf(emptySet<String>()) }
    var manuallyCollapsedOutlets by rememberSaveable(
        serviceDate,
        stateSaver = listSaver<Set<String>, String>(save = { it.toList() }, restore = { it.toSet() }),
    ) { mutableStateOf(emptySet<String>()) }
    val menuIsToday = serviceDate == Instant.ofEpochMilli(now).atZone(CAMPUS_ZONE).toLocalDate().toString()

    ScreenScaffold(
        "Dining", serviceDate?.let { Format.dayHeader(it) }, snapshot, now, snackbar, onRefresh = vm::refresh,
        headerSize = ScreenHeaderSize.Large,
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
        if (food != null || pick != null || rankingBusy) {
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
                    onRank = { food?.serviceDate?.let(vm::rankFood) },
                )
            }
        }
        if (food == null || foodCard == null) {
            item {
                when {
                    snapshot.error != null -> EmptyNote("Menu unavailable. Pull to retry.")
                    snapshot.refreshing && !snapshot.manualRefreshing -> InitialLoadingNote("Loading the dining menu…")
                    snapshot.refreshing -> EmptyNote("Loading the dining menu…")
                    else -> EmptyNote("No menu loaded yet. Pull to refresh.")
                }
            }
            return@ScreenScaffold
        }
        val outlets = food.pinned + food.others
        val serving = outlets.filter { it.serving || it.dishCount > 0 }
            .sortedWith(compareBy<Outlet> { outlet ->
                pick?.rankedOutlets?.firstOrNull { diningNameMatches(it.outlet, outlet.outlet) }?.rank ?: Int.MAX_VALUE
            }.thenByDescending { it.pinned })
        val recommendedServingOutlet = recommendedOutlet?.let { name ->
            serving.firstOrNull { diningNameMatches(name, it.outlet) }?.outlet
        } ?: pick?.rankedOutlets?.minByOrNull { it.rank }?.outlet?.let { name ->
            serving.firstOrNull { diningNameMatches(name, it.outlet) }?.outlet
        }
        val initiallyExpandedOutlet = serving.firstOrNull { outlet ->
            outlet.outlet == recommendedServingOutlet
        }?.outlet ?: serving.firstOrNull()?.outlet
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
            val expanded = when {
                outlet.outlet in manuallyExpandedOutlets -> true
                outlet.outlet in manuallyCollapsedOutlets -> false
                else -> outlet.outlet == initiallyExpandedOutlet
            }
            OutletCard(
                outlet,
                ranked,
                isTop = outlet.outlet == recommendedServingOutlet,
                expanded = expanded,
                onExpandedChange = { nextExpanded ->
                    if (nextExpanded) {
                        manuallyCollapsedOutlets = manuallyCollapsedOutlets - outlet.outlet
                        manuallyExpandedOutlets = manuallyExpandedOutlets + outlet.outlet
                    } else {
                        manuallyExpandedOutlets = manuallyExpandedOutlets - outlet.outlet
                        manuallyCollapsedOutlets = manuallyCollapsedOutlets + outlet.outlet
                    }
                },
                modifier = Modifier.animateItem(
                    fadeInSpec = MaterialTheme.motionScheme.fastEffectsSpec(),
                    placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
                    fadeOutSpec = MaterialTheme.motionScheme.fastEffectsSpec(),
                ),
            )
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
    val pickSaveKey = pick?.let { "${it.serviceDate}:${it.generatedAt}:${it.topOutlet}" }
    var detailsExpanded by rememberSaveable(pickSaveKey) { mutableStateOf(false) }

    val statusKey = when {
        processing -> "processing"
        submitting -> "submitting"
        ranking?.status == "budget_limited" -> "budget-limited"
        ranking?.status == "attempt_limited" || ranking?.status == "limited" -> "attempt-limited"
        ranking?.status == "failed" -> "failed"
        ranking?.stale == true || state?.isStale == true -> "stale"
        else -> "ready"
    }
    val pickIdentity = pick?.let {
        "${it.serviceDate}:${it.generatedAt ?: "saved"}:${it.topOutlet}"
    }
    val cardContent = DiningPickContent(
        pick = pick,
        pickIdentity = pickIdentity,
        statusKey = statusKey,
        outletName = outletName,
        reason = reason,
        longerReason = longerReason,
        tip = tip,
        hasDetails = hasDetails,
        statusText = statusText,
        submitting = submitting,
        processing = processing,
        canStartRanking = canStartRanking,
    )
    val colors = MaterialTheme.colorScheme
    val motionScheme = MaterialTheme.motionScheme
    val containerColor by animateColorAsState(
        targetValue = if (pick != null) colors.secondaryContainer else colors.surfaceContainerLow,
        animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
        label = "Dining pick container color",
    )
    val corner by animateDpAsState(
        targetValue = if (pick != null) 28.dp else 16.dp,
        animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
        label = "Dining pick container shape",
    )

    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s)
            .semantics {
                stateDescription = when {
                    pick != null && processing -> "Saved dining pick. Updating."
                    pick != null && submitting -> "Saved dining pick. Requesting an update."
                    pick != null -> "Saved dining pick"
                    processing || submitting -> "No saved dining pick yet. Ranking in progress."
                    else -> "No saved dining pick"
                }
            },
        color = containerColor,
        contentColor = if (pick != null) colors.onSecondaryContainer else colors.onSurface,
        shape = RoundedCornerShape(corner),
    ) {
        AnimatedContent(
            targetState = cardContent,
            contentKey = { it.pickIdentity to it.statusKey },
            transitionSpec = {
                fadeIn(motionScheme.fastEffectsSpec()) togetherWith
                    fadeOut(motionScheme.fastEffectsSpec()) using
                    SizeTransform(clip = false) { _, _ -> motionScheme.defaultSpatialSpec() }
            },
            label = "Dining pick content",
        ) { content ->
            Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                if (content.pick != null) {
                    Row(
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
                    ) {
                        ShapedIcon(
                            icon = Icons.Outlined.Restaurant,
                            container = colors.secondary,
                            content = colors.onSecondary,
                            size = 52.dp,
                            shape = MaterialShapes.Cookie12Sided,
                        )
                        Column(
                            Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                        ) {
                            Text(
                                "Your pick",
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.onSecondaryContainer,
                            )
                            Text(
                                content.outletName.ifBlank { "Saved recommendation" },
                                style = MaterialTheme.typography.headlineMediumEmphasized,
                                color = colors.onSecondaryContainer,
                            )
                            Text(
                                content.reason,
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.onSecondaryContainer,
                            )
                        }
                    }
                    if (state != null && ranking?.recommendation == null) {
                        FreshnessLabel(state, observedAt, now)
                    }
                } else {
                    Text(
                        if (content.processing) "No saved pick yet" else "No saved dining pick",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.onSurface,
                    )
                }
                if (content.statusText != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        if (content.processing) {
                            LinearWavyProgressIndicator(
                                modifier = Modifier.fillMaxWidth().semantics {
                                    progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
                                    stateDescription = content.statusText
                                },
                            )
                        } else if (content.submitting) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                                modifier = Modifier.semantics(mergeDescendants = true) {
                                    progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
                                    stateDescription = content.statusText
                                },
                            ) {
                                LoadingIndicator(Modifier.size(24.dp))
                                Text(content.statusText, style = MaterialTheme.typography.labelMedium)
                            }
                        } else {
                            Text(
                                content.statusText,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (content.pick != null) colors.onSecondaryContainer else colors.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (content.hasDetails && content.pick != null) {
                    PickDetailsDisclosure(
                        expanded = detailsExpanded,
                        onClick = { detailsExpanded = !detailsExpanded },
                        longerReason = content.longerReason,
                        tip = content.tip,
                        contentColor = if (content.pick != null) colors.onSecondaryContainer else colors.onSurface,
                    )
                }
                if (content.pick == null && content.canStartRanking) {
                    Button(
                        onClick = onRank,
                        enabled = canStartRanking,
                        modifier = Modifier.heightIn(min = ButtonDefaults.MediumContainerHeight),
                        contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                        shapes = ButtonDefaults.shapesFor(ButtonDefaults.MediumContainerHeight),
                    ) { Text("Find dining pick") }
                }
            }
        }
    }
}

private data class DiningPickContent(
    val pick: FoodPick?,
    val pickIdentity: String?,
    val statusKey: String,
    val outletName: String,
    val reason: String,
    val longerReason: String,
    val tip: String,
    val hasDetails: Boolean,
    val statusText: String?,
    val submitting: Boolean,
    val processing: Boolean,
    val canStartRanking: Boolean,
)

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
    processing && pick != null -> "Updating pick…"
    processing -> "Ranking pick…"
    submitting -> "Requesting pick…"
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
    contentColor: Color,
) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(vertical = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (expanded) "Hide pick details" else "More about this pick",
            style = MaterialTheme.typography.labelLarge,
            color = contentColor,
            modifier = Modifier.weight(1f),
        )
        DisclosureIcon(expanded, modifier = Modifier.size(24.dp), tint = contentColor)
    }
    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) + fadeIn(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
        exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec()) + fadeOut(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec()),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            if (longerReason.isNotBlank()) Text(longerReason, style = MaterialTheme.typography.bodySmall, color = contentColor)
            if (tip.isNotBlank()) Text(tip, style = MaterialTheme.typography.bodySmall, color = contentColor)
        }
    }
}

@Composable
private fun OutletCard(
    outlet: Outlet,
    ranked: RankedOutlet?,
    isTop: Boolean,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(),
        label = "Dining outlet disclosure",
    )
    val corner by animateDpAsState(
        targetValue = if (expanded) 20.dp else 16.dp,
        animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
        label = "Dining outlet container shape",
    )
    val outletName = outlet.outlet.substringBefore(" - ")
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
        color = colors.surfaceContainerLow,
        contentColor = colors.onSurface,
        shape = RoundedCornerShape(corner),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().padding(start = Spacing.m, end = Spacing.s, top = Spacing.s, bottom = Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Column(
                    Modifier.weight(1f).padding(vertical = Spacing.xs),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    Text(
                        outletName,
                        style = MaterialTheme.typography.titleMediumEmphasized,
                        color = if (isTop) colors.primary else colors.onSurface,
                        modifier = Modifier.semantics(mergeDescendants = true) { heading() },
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                    ) {
                        if (isTop) {
                            Text("Recommended", style = MaterialTheme.typography.labelMedium, color = colors.primary)
                            Text("·", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                        } else if (ranked != null) {
                            Text("Rank ${ranked.rank}", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                            Text("·", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                        }
                        Text(
                            "${outlet.dishCount} posted ${if (outlet.dishCount == 1) "dish" else "dishes"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
                FilledTonalIconToggleButton(
                    checked = expanded,
                    onCheckedChange = onExpandedChange,
                    modifier = Modifier.size(48.dp).semantics {
                        contentDescription = if (expanded) "Collapse $outletName menu" else "Expand $outletName menu"
                        stateDescription = if (expanded) "Expanded" else "Collapsed"
                    },
                ) {
                    Icon(
                        Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        modifier = Modifier.graphicsLayer { rotationZ = rotation },
                    )
                }
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeIn(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
                exit = shrinkVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec()) +
                    fadeOut(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec()),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    if (outlet.dishes.isEmpty()) {
                        Text("No posted dishes.", style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                    } else {
                        stationGroups(outlet.dishes).forEachIndexed { index, (station, dishes) ->
                            if (index > 0) HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = colors.outlineVariant)
                            if (station.isNotBlank()) StationHeader(station)
                            dishes.forEach { dish ->
                                DishRow(dish, ranked?.highlights?.firstOrNull { diningNameMatches(it.dish, dish.dish) })
                            }
                        }
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
                Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
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
