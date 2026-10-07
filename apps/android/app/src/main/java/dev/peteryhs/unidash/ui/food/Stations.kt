package dev.peteryhs.unidash.ui.food

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BakeryDining
import androidx.compose.material.icons.outlined.LocalPizza
import androidx.compose.material.icons.outlined.LunchDining
import androidx.compose.material.icons.outlined.OutdoorGrill
import androidx.compose.material.icons.outlined.RamenDining
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.RiceBowl
import androidx.compose.material.icons.outlined.SoupKitchen
import androidx.compose.ui.graphics.vector.ImageVector
import dev.peteryhs.unidash.data.Dish

/** Mirrors apps/web/src/lib/menu.ts so both clients draw the same icon for the same counter. */
internal enum class StationKind { Grill, Build, Pizza, Deli, Soup, Bakery, Stove, Other }

private val STATION_RULES = listOf(
    StationKind.Grill to Regex("grill|bbq|barbe?cue|carvery|smoke|rotisserie|burger", RegexOption.IGNORE_CASE),
    StationKind.Build to Regex("creation|build|salad|bowl|fresh", RegexOption.IGNORE_CASE),
    StationKind.Pizza to Regex("pizza|oven|flatbread", RegexOption.IGNORE_CASE),
    StationKind.Deli to Regex("deli|sandwich|sub\\b|wrap", RegexOption.IGNORE_CASE),
    StationKind.Soup to Regex("soup|noodle|wok|ramen|pho", RegexOption.IGNORE_CASE),
    StationKind.Bakery to Regex("bake|bakery|dessert|sweet|pastry", RegexOption.IGNORE_CASE),
    StationKind.Stove to Regex("hot dish|stove|mom|comfort|entr[eé]e|home|kitchen|counter", RegexOption.IGNORE_CASE),
)

internal fun stationKind(station: String): StationKind =
    STATION_RULES.firstOrNull { (_, re) -> re.containsMatchIn(station) }?.first ?: StationKind.Other

internal fun stationIcon(station: String): ImageVector = when (stationKind(station)) {
    StationKind.Grill -> Icons.Outlined.OutdoorGrill
    StationKind.Build -> Icons.Outlined.RiceBowl
    StationKind.Pizza -> Icons.Outlined.LocalPizza
    StationKind.Deli -> Icons.Outlined.LunchDining
    StationKind.Soup -> Icons.Outlined.RamenDining
    StationKind.Bakery -> Icons.Outlined.BakeryDining
    StationKind.Stove -> Icons.Outlined.SoupKitchen
    StationKind.Other -> Icons.Outlined.Restaurant
}

/** Stations in page order, each with its dishes in page order. `groupBy` keeps first-seen order. */
internal fun stationGroups(dishes: List<Dish>): List<Pair<String, List<Dish>>> =
    dishes.groupBy { it.station }.toList()

/** Short chip and spoken label for a diet tag. The page only marks gluten and dairy as "made without". */
internal fun dietTag(tag: String): Pair<String, String> = when (tag.lowercase()) {
    "vegan" -> "VG" to "Vegan"
    "vegetarian" -> "V" to "Vegetarian"
    "halal" -> "H" to "Halal"
    "gluten" -> "GF" to "Gluten-free"
    "dairy" -> "DF" to "Dairy-free"
    else -> tag.take(3).uppercase() to tag.replaceFirstChar { it.uppercase() }
}
