package dev.peteryhs.unidash.ui.food

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Food
import dev.peteryhs.unidash.data.FoodPick
import dev.peteryhs.unidash.data.Highlight
import dev.peteryhs.unidash.data.Outlet
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.Spacing

/** The saved dining summary and menus. Ranking and parsing happen on the server; this only renders them. */
@Composable
fun FoodScreen(vm: MainViewModel, snapshot: Snapshot, now: Long, snackbar: SnackbarHostState) {
    val uri = LocalUriHandler.current
    val foodCard = snapshot.bundle?.card("food")
    val food = foodCard?.payload<Food>()
    val pickCard = snapshot.bundle?.card("food_ai_recommendation")
    val pick = pickCard?.payload<FoodPick>()?.takeIf { food == null || it.serviceDate == food.serviceDate }

    ScreenScaffold(
        "Food", food?.serviceDate?.let { date -> Format.dayHeader(date).let { d -> if (d == "Today" || d == "Tomorrow") "Menus for ${d.lowercase()}" else "Menus for $d" } }, snapshot, now, snackbar, onRefresh = vm::refresh,
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
        if (pick != null && pickCard != null) item(key = "pick") { AiSummaryCard(pick, pickCard.state, pickCard.observedAt, now) }
        else item(key = "pick-unavailable") { EmptyNote("No saved dining picks for this menu.") }
        val outlets = food.pinned + food.others
        val serving = outlets.filter { it.serving || it.dishCount > 0 }
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
            val ranked = pick?.rankedOutlets?.firstOrNull { it.outlet == outlet.outlet }
            OutletCard(outlet, ranked?.verdict, ranked?.highlights.orEmpty(), isTop = pick?.topOutlet == outlet.outlet)
        }
        val closed = outlets - serving.toSet()
        if (closed.isNotEmpty()) {
            item(key = "closed") { EmptyNote("Not serving: ${closed.joinToString { it.outlet.substringBefore(" - ") }}") }
        }
    }
}

@Composable
private fun AiSummaryCard(pick: FoodPick, state: dev.peteryhs.unidash.data.CardState, observedAt: Long?, now: Long) {
    val top = pick.rankedOutlets.firstOrNull { it.outlet == pick.topOutlet }
        ?: pick.rankedOutlets.firstOrNull { it.rank == 1 }
        ?: pick.rankedOutlets.firstOrNull()
    val outletName = (top?.outlet ?: pick.topOutlet).substringBefore(" - ").trim()
    val reason = top?.verdict?.trim().orEmpty().let { verdict ->
        when {
            verdict.isNotBlank() -> Regex("^.*?[.!?](?=\\s|$)").find(verdict)?.value ?: verdict
            pick.headline.isNotBlank() -> pick.headline
            else -> "No explanation was saved for this ranking."
        }
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
    ) {
        Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("AI dining summary", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(outletName.ifBlank { "No saved outlet recommendation" }, style = MaterialTheme.typography.headlineSmallEmphasized)
                }
                FreshnessLabel(state, observedAt, now)
            }
            Text(reason, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
            if (pick.tip.isNotBlank()) Text(pick.tip, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun OutletCard(outlet: Outlet, verdict: String?, highlights: List<Highlight>, isTop: Boolean) {
    val highlightsByDish = highlights.associateBy { dishKey(it.dish) }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
    ) {
        ListItem(
            headlineContent = { Text(outlet.outlet.substringBefore(" - "), fontWeight = if (isTop) FontWeight.SemiBold else null) },
            supportingContent = verdict?.let { v -> { Text(v, color = MaterialTheme.colorScheme.primary) } },
            trailingContent = {
                Text(
                    if (isTop) "Top pick" else "${outlet.dishCount} dishes",
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
                outlet.dishes.forEach { d ->
                    val highlight = highlightsByDish[dishKey(d.dish)]
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    ) {
                        if (highlight == null) Spacer(Modifier.width(4.dp))
                        else Box(Modifier.width(4.dp).height(40.dp).background(MaterialTheme.colorScheme.primary, MaterialTheme.shapes.extraSmall))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            Text(
                                d.dish,
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (highlight == null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
                                fontWeight = if (highlight == null) FontWeight.Normal else FontWeight.SemiBold,
                            )
                            if (d.diet.isNotEmpty()) Text(d.diet.joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            highlight?.why?.takeIf { it.isNotBlank() }?.let { why ->
                                Text(why, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
                if (outlet.hiddenDishes > 0) {
                    Text("+${outlet.hiddenDishes} more dishes", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

private fun dishKey(value: String): String = value.trim().replace(Regex("\\s+"), " ").lowercase()
