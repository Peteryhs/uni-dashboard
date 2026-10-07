package dev.peteryhs.unidash.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.EventBusy
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.ChangeDetail
import dev.peteryhs.unidash.ui.theme.Spacing

/**
 * A schedule change as blocks instead of a sentence: [E7 2409] → [RCH 101], [10:30 AM] → [11:30 AM].
 * Each row reads as one sentence to TalkBack. Confidence belongs in the detail view rather than
 * repeated glyphs around an already legible before-and-after pair.
 */
@Composable
fun ChangeBlocks(change: ChangeDetail, modifier: Modifier = Modifier) {
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        if (change.roomMoved) {
            ArrowRow(
                if (change.kind == "unusual_room") "Different room" else "Room changed",
                change.previousLocation,
                change.location.ifBlank { "—" },
            )
        }
        change.previousAt?.let { before ->
            val after = change.currentAt
            ArrowRow("Time changed", stamp(before, change.allDay, after), after?.let { stamp(it, change.allDay, before) } ?: "—")
        }
        when (change.kind) {
            "cancelled", "removed" -> LabelRow(Icons.Outlined.EventBusy, if (change.kind == "cancelled") "Cancelled" else "Not in calendar", gone = true)
            "tutorial_work" -> LabelRow(Icons.Outlined.Laptop, "Online work")
        }
    }
}

private fun stamp(at: Long, allDay: Boolean, other: Long?): String = when {
    allDay -> Format.shortDay(at)
    // The day only matters when the change crosses days; otherwise the time alone says it.
    other != null && !Format.sameDay(at, other) -> "${Format.shortDay(at)} ${Format.time(at)}"
    else -> Format.time(at)
}

@Composable
private fun ArrowRow(label: String, before: String, after: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        modifier = Modifier.clearAndSetSemantics { contentDescription = "$label: $before to $after" },
    ) {
        Block(before, MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.colorScheme.onSurfaceVariant, struck = true)
        Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Block(after, MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.onTertiaryContainer)
    }
}

@Composable
private fun LabelRow(icon: ImageVector, label: String, gone: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Icon(icon, contentDescription = null, tint = if (gone) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(18.dp))
        if (gone) Block(label, MaterialTheme.colorScheme.errorContainer, MaterialTheme.colorScheme.onErrorContainer)
        else Block(label, MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.onTertiaryContainer)
    }
}

@Composable
private fun Block(text: String, container: Color, content: Color, struck: Boolean = false) {
    Surface(color = container, contentColor = content, shape = MaterialTheme.shapes.small) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            textDecoration = if (struck) TextDecoration.LineThrough else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = Spacing.s, vertical = 2.dp),
        )
    }
}
