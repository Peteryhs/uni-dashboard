package dev.peteryhs.unidash.ui.food

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import dev.peteryhs.unidash.data.Food
import dev.peteryhs.unidash.data.FoodPick
import dev.peteryhs.unidash.data.Outlet
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.FreshnessLabel
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.muted
import dev.peteryhs.unidash.ui.theme.Spacing

/** Today's pick and the menus. Ranking and parsing happen on the server; this only renders them. */
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
        if (food == null) {
            item { EmptyNote("No menu loaded yet.") }
            return@ScreenScaffold
        }
        if (pick != null) item(key = "pick") { PickCard(pick, pickCard.state, pickCard.observedAt, now) }
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
            OutletCard(outlet, pick?.rankedOutlets?.firstOrNull { it.outlet == outlet.outlet }?.verdict, isTop = pick?.topOutlet == outlet.outlet)
        }
        val closed = outlets - serving.toSet()
        if (closed.isNotEmpty()) {
            item(key = "closed") { EmptyNote("Not serving: ${closed.joinToString { it.outlet.substringBefore(" - ") }}") }
        }
    }
}

@Composable
private fun PickCard(pick: FoodPick, state: dev.peteryhs.unidash.data.CardState, observedAt: Long?, now: Long) {
    val top = pick.rankedOutlets.firstOrNull { it.outlet == pick.topOutlet }
    ElevatedCard(
        colors = CardDefaults.elevatedCardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
        shape = MaterialTheme.shapes.extraLarge,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s).muted(state.isStale),
    ) {
        Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                ShapedIcon(Icons.Outlined.Restaurant, MaterialTheme.colorScheme.tertiary, MaterialTheme.colorScheme.onTertiary, shape = MaterialShapes.Cookie7Sided)
                Column {
                    Text("Today's pick", style = MaterialTheme.typography.labelLarge)
                    Text(pick.topOutlet.substringBefore(" - "), style = MaterialTheme.typography.headlineSmallEmphasized)
                }
            }
            Text(pick.headline, style = MaterialTheme.typography.bodyLarge)
            top?.highlights?.takeIf { it.isNotEmpty() }?.let { hs ->
                hs.forEach { h ->
                    Text(
                        buildString { append(h.dish); if (h.why.isNotBlank()) append(" — ").append(h.why) },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            if (pick.tip.isNotBlank()) Text(pick.tip, style = MaterialTheme.typography.bodySmall)
            FreshnessLabel(state, observedAt, now)
        }
    }
}

@Composable
private fun OutletCard(outlet: Outlet, verdict: String?, isTop: Boolean) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.xs),
    ) {
        ListItem(
            headlineContent = { Text(outlet.outlet.substringBefore(" - "), fontWeight = if (isTop) FontWeight.SemiBold else null) },
            supportingContent = verdict?.let { v -> { Text(v, color = MaterialTheme.colorScheme.primary) } },
            trailingContent = { if (isTop) Badge { Text("Top pick") } else Text("${outlet.dishCount} dishes", style = MaterialTheme.typography.labelMedium) },
            colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        )
        if (outlet.dishes.isNotEmpty()) {
            FlowRow(
                Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                outlet.dishes.forEach { d ->
                    // Static labels, not chips: a chip that does nothing on tap misleads touch and TalkBack.
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.padding(vertical = Spacing.xs),
                    ) {
                        Text(
                            d.dish + d.diet.takeIf { it.isNotEmpty() }?.joinToString(prefix = " · ").orEmpty(),
                            style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.padding(horizontal = Spacing.m, vertical = Spacing.s),
                        )
                    }
                }
                if (outlet.hiddenDishes > 0) {
                    Text("+${outlet.hiddenDishes} more", style = MaterialTheme.typography.labelMedium, modifier = Modifier.align(Alignment.CenterVertically))
                }
            }
        }
    }
}
