package dev.peteryhs.unidash.ui.food

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.em
import dev.peteryhs.unidash.ui.theme.Spacing
import dev.peteryhs.unidash.ui.theme.UniDashTheme

/**
 * One wrapping text flow keeps marks beside the name instead of reserving an indivisible trailing
 * row. Each icon can wrap independently, and em sizing follows the dish's accessible text scale.
 */
@Composable
internal fun DietaryDishTitle(
    name: String,
    diet: List<String>,
    highlighted: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val labelStyle = MaterialTheme.typography.labelSmall.toSpanStyle()
        .copy(color = MaterialTheme.colorScheme.onSurfaceVariant)
    val inlineContent = diet.mapIndexedNotNull { index, tag ->
        dietIcon(tag)?.let { icon ->
            "diet:$index" to InlineTextContent(
                placeholder = Placeholder(
                    width = 1.15.em,
                    height = 1.15.em,
                    placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter,
                ),
            ) {
                // appendInlineContent's full alternate label is read as part of the dish text.
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }.toMap()
    val title = buildAnnotatedString {
        append(name)
        diet.forEachIndexed { index, tag ->
            val (_, label) = dietTag(tag)
            append(" ") // Normal break opportunities, including between dietary marks.
            if ("diet:$index" in inlineContent) appendInlineContent("diet:$index", label)
            else withStyle(labelStyle) { append(label) }
        }
    }
    Text(
        text = title,
        inlineContent = inlineContent,
        modifier = modifier.fillMaxWidth(),
        style = MaterialTheme.typography.bodyMedium,
        color = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        fontWeight = if (highlighted) FontWeight.SemiBold else FontWeight.Normal,
    )
}

@Preview(name = "Dietary names · narrow", widthDp = 240, showBackground = true)
@Preview(name = "Dietary names · large text", widthDp = 240, fontScale = 2f, showBackground = true)
@Preview(name = "Dietary names · RTL", widthDp = 240, locale = "ar", showBackground = true)
@Composable
private fun DietaryDishTitlePreview() {
    UniDashTheme {
        Surface {
            Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                DietaryDishTitle("Soup", listOf("vegetarian", "vegan", "halal", "gluten", "dairy"))
                DietaryDishTitle(
                    "Roasted Mediterranean vegetables with lemon and herb quinoa",
                    listOf("vegetarian", "vegan", "halal", "gluten", "dairy"),
                    highlighted = true,
                )
                DietaryDishTitle("Sesame noodles", listOf("vegan", "contains sesame and tree nuts", "gluten"))
                DietaryDishTitle("A long dish name with no dietary labels", emptyList())
            }
        }
    }
}
