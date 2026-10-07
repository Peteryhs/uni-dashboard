package dev.peteryhs.unidash.ui.food

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
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
import java.text.Normalizer
import java.util.Locale

/** The saved dining summary and menus. Ranking and parsing happen on the server; this only renders them. */
@Composable
fun FoodScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState) {
    val uri = LocalUriHandler.current
    val foodCard = snapshot.bundle?.card("food")
    val food = foodCard?.payload<Food>()
    val pickCard = snapshot.bundle?.card("food_ai_recommendation")
    val ranking = snapshot.foodRanking?.takeIf { food != null &&
        (it.recommendation == null || it.recommendation.serviceDate == food.serviceDate) }
    val pick = ranking?.recommendation ?: pickCard?.payload<FoodPick>()?.takeIf { food == null || it.serviceDate == food.serviceDate }

    ScreenScaffold(
        "Food", food?.serviceDate?.let { Format.dayHeader(it) }, snapshot, now, snackbar, onRefresh = vm::refresh,
        actions = {
            food?.serviceDate?.let { date ->
                IconButton(onClick = { uri.openUri("https://uwaterloo.ca/food-services/daily-menu?date=$date") }) {
                    Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open the daily menu on uwaterloo.ca")
                }
            }
        },
    ) {
        if (food == null || foodCard == null) {
            item { EmptyNote("No menu loaded yet.") }
            return@ScreenScaffold
        }
        item(key = "pick") {
            AiSummaryCard(pick, ranking, pickCard?.state, pickCard?.observedAt, now) {
                vm.rankFood(food.serviceDate)
            }
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
                    SectionHeader("Serving today", Modifier.weight(1f))
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
    onRank: () -> Unit,
) {
    val top = pick?.rankedOutlets?.firstOrNull { it.outlet == pick?.topOutlet }
        ?: pick?.rankedOutlets?.firstOrNull { it.rank == 1 }
        ?: pick?.rankedOutlets?.firstOrNull()
    val outletName = (top?.outlet ?: pick?.topOutlet.orEmpty()).substringBefore(" - ").trim()
    val reason = top?.verdict?.trim().orEmpty().let { verdict ->
        when {
            verdict.isNotBlank() -> Regex("^.*?[.!?](?=\\s|$)").find(verdict)?.value ?: verdict
            pick?.headline?.isNotBlank() == true -> pick?.headline.orEmpty()
            else -> "No explanation was saved for this ranking."
        }
    }
    val processing = ranking?.rankingJob?.status == "processing" || ranking?.status == "processing"
    val statusText = when {
        processing -> "Ranking dining picks…"
        ranking?.status == "budget_limited" -> "Dining picks are paused until the shared AI allowance resets."
        ranking?.status == "attempt_limited" || ranking?.status == "limited" -> "Automatic ranking is paused at its daily limit."
        ranking?.status == "failed" -> ranking.error.ifBlank { "Dining ranking is unavailable right now." }
        else -> "No saved dining picks for this menu."
    }
    val colors = if (pick != null) CardDefaults.cardColors(
        containerColor = MaterialTheme.colorScheme.primaryContainer,
        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
    ) else CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)
    Card(
        colors = colors,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
    ) {
        Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Dining pick", style = MaterialTheme.typography.labelLarge)
                    Text(
                        if (pick != null) outletName.ifBlank { "Saved recommendation" } else statusText,
                        style = if (pick != null) MaterialTheme.typography.headlineSmallEmphasized else MaterialTheme.typography.bodyMedium,
                    )
                }
                if (state != null && pick != null && ranking?.recommendation == null) FreshnessLabel(state, observedAt, now)
            }
            if (pick != null) {
                Text(reason, style = MaterialTheme.typography.bodyLarge)
                if (pick.tip.isNotBlank()) Text(pick.tip, style = MaterialTheme.typography.bodySmall)
                if (ranking?.stale == true || processing) Text(
                    if (processing) "Showing saved picks while a new ranking runs."
                    else "Showing saved picks; an updated ranking is unavailable.",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            if (!processing && ranking?.status != "budget_limited") {
                FilledTonalButton(onClick = onRank) { Text(if (pick == null) "Rank menu" else "Rank again") }
            }
        }
    }
}

@Composable
private fun OutletCard(outlet: Outlet, ranked: RankedOutlet?, isTop: Boolean) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
    ) {
        ListItem(
            headlineContent = { Text(outlet.outlet.substringBefore(" - "), fontWeight = if (isTop) FontWeight.SemiBold else null) },
            supportingContent = ranked?.verdict?.takeIf { it.isNotBlank() }?.let { v -> { Text(v, color = MaterialTheme.colorScheme.primary) } },
            trailingContent = {
                Text(
                    if (isTop) "Top pick" else ranked?.rank?.let { "#$it pick" } ?: "${outlet.dishCount} dishes",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (isTop) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        )
        if (outlet.dishes.isNotEmpty()) {
            Column(
                Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                stationGroups(outlet.dishes).forEachIndexed { index, (station, dishes) ->
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = MaterialTheme.colorScheme.outlineVariant)
                    if (station.isNotBlank()) StationHeader(station, dishes.size)
                    dishes.forEach { d -> DishRow(d, ranked?.highlights?.firstOrNull { diningNameMatches(it.dish, d.dish) }) }
                }
            }
        }
    }
}

/** Icon, "THE CARVERY", count: the counter inside the hall, so the list reads like the room does. */
@Composable
private fun StationHeader(station: String, count: Int) {
    Row(
        Modifier.fillMaxWidth().padding(top = Spacing.s, bottom = Spacing.xs).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(stationIcon(station), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Text(station.uppercase(Locale.CANADA), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
        Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.semantics { contentDescription = "$count dishes" })
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
            Text(
                d.dish,
                style = MaterialTheme.typography.bodyMedium,
                color = if (highlight == null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
                fontWeight = if (highlight == null) FontWeight.Normal else FontWeight.SemiBold,
            )
            if (d.diet.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    d.diet.forEach { tag ->
                        val (short, label) = dietTag(tag)
                        Surface(
                            color = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                            shape = MaterialTheme.shapes.extraSmall,
                            modifier = Modifier.semantics { contentDescription = label },
                        ) {
                            Text(short, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                        }
                    }
                }
            }
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
