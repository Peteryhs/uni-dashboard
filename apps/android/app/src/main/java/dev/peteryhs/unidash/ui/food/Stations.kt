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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp
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

/** Small non-interactive menu marks; content descriptions are supplied by the dish row. */
internal fun dietIcon(tag: String): ImageVector? = when (tag.lowercase()) {
    "vegetarian" -> DIET_VEGETARIAN
    "vegan" -> DIET_VEGAN
    "halal" -> DIET_HALAL
    "gluten" -> DIET_GLUTEN_FREE
    "dairy" -> DIET_DAIRY_FREE
    else -> null
}

private fun dietVector(name: String, draw: ImageVector.Builder.() -> Unit): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply(draw).build()

private fun ImageVector.Builder.outlinePath(draw: PathBuilder.() -> Unit) {
    path(
        fill = null,
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathFillType = PathFillType.NonZero,
        pathBuilder = draw,
    )
}

private val DIET_VEGETARIAN = dietVector("DietVegetarian") {
    outlinePath {
        moveTo(3f, 21f)
        cubicTo(5f, 15f, 8f, 10f, 11f, 8f)
        cubicTo(14f, 6f, 18f, 9f, 16f, 12f)
        cubicTo(13f, 16f, 7f, 19f, 3f, 21f)
        close()
    }
    outlinePath {
        moveTo(13f, 8f)
        cubicTo(13f, 5f, 15f, 3f, 19f, 3f)
        cubicTo(19f, 6f, 17f, 8f, 13f, 8f)
        moveTo(14f, 8f)
        cubicTo(12f, 5f, 10f, 4f, 8f, 5f)
        cubicTo(9f, 7f, 11f, 8f, 14f, 8f)
    }
    outlinePath {
        moveTo(7f, 17f)
        lineTo(9f, 15f)
        moveTo(11f, 14f)
        lineTo(13f, 12f)
    }
}

private val DIET_VEGAN = dietVector("DietVegan") {
    outlinePath {
        moveTo(12f, 21f)
        lineTo(12f, 12f)
        moveTo(12f, 14f)
        cubicTo(12f, 9f, 8f, 6f, 4f, 7f)
        cubicTo(4f, 11f, 7f, 14f, 12f, 14f)
        moveTo(12f, 10f)
        cubicTo(12f, 6f, 15f, 3f, 20f, 3f)
        cubicTo(20f, 7f, 17f, 10f, 12f, 10f)
        moveTo(6f, 21f)
        lineTo(18f, 21f)
    }
}

private val DIET_HALAL = dietVector("DietHalal") {
    outlinePath {
        moveTo(17f, 4f)
        cubicTo(12f, 5f, 9f, 9f, 10f, 14f)
        cubicTo(11f, 18f, 15f, 21f, 19f, 19f)
        cubicTo(15f, 20f, 11f, 17f, 10f, 13f)
        cubicTo(9f, 9f, 12f, 5f, 17f, 4f)
    }
    outlinePath {
        moveTo(19f, 3.5f)
        lineTo(19.8f, 4.7f)
        lineTo(21f, 5f)
        lineTo(19.8f, 5.3f)
        lineTo(19f, 6.5f)
        lineTo(18.2f, 5.3f)
        lineTo(17f, 5f)
        lineTo(18.2f, 4.7f)
        close()
    }
}

private val DIET_GLUTEN_FREE = dietVector("DietGlutenFree") {
    outlinePath {
        moveTo(12f, 21f)
        lineTo(12f, 5f)
        moveTo(12f, 9f)
        cubicTo(9f, 9f, 7f, 7f, 7f, 5f)
        cubicTo(10f, 5f, 12f, 7f, 12f, 9f)
        moveTo(12f, 13f)
        cubicTo(15f, 13f, 17f, 11f, 17f, 9f)
        cubicTo(14f, 9f, 12f, 11f, 12f, 13f)
        moveTo(12f, 17f)
        cubicTo(9f, 17f, 7f, 15f, 7f, 13f)
        cubicTo(10f, 13f, 12f, 15f, 12f, 17f)
    }
    outlinePath {
        moveTo(4f, 4f)
        lineTo(20f, 20f)
    }
}

private val DIET_DAIRY_FREE = dietVector("DietDairyFree") {
    outlinePath {
        moveTo(8f, 3f)
        lineTo(16f, 3f)
        lineTo(18f, 7f)
        lineTo(18f, 20f)
        lineTo(6f, 20f)
        lineTo(6f, 7f)
        close()
        moveTo(8f, 3f)
        lineTo(10f, 7f)
        lineTo(18f, 7f)
        moveTo(7f, 13f)
        lineTo(16f, 13f)
    }
    outlinePath {
        moveTo(4f, 4f)
        lineTo(20f, 20f)
    }
}

/** Stations in page order, each with its dishes in page order. `groupBy` keeps first-seen order. */
internal fun stationGroups(dishes: List<Dish>): List<Pair<String, List<Dish>>> =
    dishes.groupBy { it.station }.toList()

/** Existing short fallback and full spoken label for diet tags. Gluten and dairy mean "made without". */
internal fun dietTag(tag: String): Pair<String, String> = when (tag.lowercase()) {
    "vegan" -> "VG" to "Vegan"
    "vegetarian" -> "V" to "Vegetarian"
    "halal" -> "H" to "Halal"
    "gluten" -> "GF" to "Made without gluten"
    "dairy" -> "DF" to "Made without dairy"
    else -> tag.take(3).uppercase() to tag.replaceFirstChar { it.uppercase() }
}
