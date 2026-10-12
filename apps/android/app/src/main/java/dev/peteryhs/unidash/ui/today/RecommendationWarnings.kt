package dev.peteryhs.unidash.ui.today

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.RichTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch

@Composable
internal fun RecommendationMetadata(
    timing: String,
    warnings: List<RecommendationWarning>,
    modifier: Modifier = Modifier,
    contentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    warningColor: Color = MaterialTheme.colorScheme.tertiary,
) {
    if (timing.isBlank() && warnings.isEmpty()) return
    FlowRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        if (timing.isNotBlank()) {
            Text(
                timing,
                modifier = Modifier.align(Alignment.CenterVertically),
                style = MaterialTheme.typography.labelLarge,
                color = contentColor,
            )
        }
        val centeredIconModifier = Modifier.align(Alignment.CenterVertically)
        warnings.forEach { warning ->
            key(warning.code) {
                RecommendationWarningButton(warning, centeredIconModifier, warningColor)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RecommendationWarningButton(warning: RecommendationWarning, modifier: Modifier, tint: Color) {
    val state = rememberTooltipState(isPersistent = false)
    val scope = rememberCoroutineScope()
    val detailed = warning.detail.count { it == '.' } > 1
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = {
            if (detailed) {
                RichTooltip(title = { Text(warning.label) }) {
                    Text(warning.detail)
                }
            } else {
                PlainTooltip { Text(warning.detail) }
            }
        },
        state = state,
        modifier = modifier,
    ) {
        IconButton(
            onClick = { scope.launch { state.show() } },
            modifier = Modifier.semantics {
                contentDescription = "${warning.label}. ${warning.detail}"
            },
        ) {
            Icon(
                when (warning) {
                    RecommendationWarning.TimeUnknown -> Icons.Outlined.Schedule
                    RecommendationWarning.CoverageUnknown -> Icons.AutoMirrored.Outlined.HelpOutline
                    else -> Icons.Outlined.WarningAmber
                },
                contentDescription = null,
                tint = tint,
            )
        }
    }
}
