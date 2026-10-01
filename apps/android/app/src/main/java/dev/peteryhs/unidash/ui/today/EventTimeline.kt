package dev.peteryhs.unidash.ui.today

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlin.math.roundToInt

/** Labels sit above the full-width track so text scaling never squeezes the timeline. */
@Composable
internal fun EventTimeline(
    progress: EventProgress,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    trackColor: Color = MaterialTheme.colorScheme.secondaryContainer,
    labelColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    // Effects springs do not overshoot a measured value; system animation scale is respected.
    val fraction by animateFloatAsState(
        targetValue = progress.fraction,
        animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
        label = "event elapsed time",
    )
    val start = Format.time(progress.startsAt)
    val end = Format.time(progress.endsAt)
    Column(
        modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            contentDescription = "Event progress"
            progressBarRangeInfo = ProgressBarRangeInfo(progress.fraction, 0f..1f)
            stateDescription = "${(progress.fraction * 100).roundToInt()} percent elapsed, started at $start, ends at $end"
        },
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Row(
            Modifier.fillMaxWidth().clearAndSetSemantics {},
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(start, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = labelColor)
            Text(end, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = labelColor, textAlign = TextAlign.End)
        }
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
            color = color,
            trackColor = trackColor,
        )
    }
}
