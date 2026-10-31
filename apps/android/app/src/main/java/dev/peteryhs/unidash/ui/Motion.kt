package dev.peteryhs.unidash.ui

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.unit.Dp
import dev.peteryhs.unidash.ui.theme.Corners
import dev.peteryhs.unidash.ui.theme.Spacing

/*
 * One motion vocabulary for the app, built on the theme's expressive motion scheme:
 * spatial springs move geometry (size, position, corners), effects springs change colour and
 * opacity. Exits use the fast specs so dismissing content never waits on an animation. Compose
 * scales every spring by the system animator duration, so "Remove animations" settles instantly.
 */

/** Detail revealed in place inside its own container: grows from the top edge and fades in. */
@Composable
fun revealEnter(): EnterTransition =
    expandVertically(animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(), expandFrom = Alignment.Top) +
        fadeIn(animationSpec = MaterialTheme.motionScheme.defaultEffectsSpec())

/** The reverse of [revealEnter], a little faster so collapsing feels immediate. */
@Composable
fun revealExit(): ExitTransition =
    shrinkVertically(animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(), shrinkTowards = Alignment.Top) +
        fadeOut(animationSpec = MaterialTheme.motionScheme.fastEffectsSpec())

/** Lazy list insertion, removal and reordering, for rows that change while the page is open. */
@Composable
fun Modifier.listItemMotion(scope: LazyItemScope): Modifier = with(scope) { this@listItemMotion.animateItem(
    fadeInSpec = MaterialTheme.motionScheme.defaultEffectsSpec(),
    placementSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
    fadeOutSpec = MaterialTheme.motionScheme.fastEffectsSpec(),
) }

/** A connected-group row: outer corners at the group's ends, tight joins in between. */
fun groupedShape(index: Int, count: Int, outer: Dp = Corners.group, inner: Dp = Corners.join): RoundedCornerShape {
    val top = if (index <= 0) outer else inner
    val bottom = if (index >= count - 1) outer else inner
    return RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
}

/** [groupedShape] whose joins open up while the row is expanded, so it reads as lifted out of the list. */
@Composable
fun animatedGroupedShape(index: Int, count: Int, open: Boolean): RoundedCornerShape {
    val inner by animateDpAsState(
        targetValue = if (open) Corners.joinOpen else Corners.join,
        animationSpec = MaterialTheme.motionScheme.defaultSpatialSpec(),
        label = "Grouped row join corner",
    )
    return groupedShape(index, count, Corners.group, inner)
}

/** A disclosure affordance; callers provide the accessibility label on its control. */
@Composable
fun DisclosureIcon(
    expanded: Boolean,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current,
) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(),
        label = "Disclosure icon rotation",
    )
    Icon(
        imageVector = Icons.Filled.ExpandMore,
        contentDescription = null,
        tint = tint,
        modifier = modifier.graphicsLayer { rotationZ = rotation },
    )
}

/** A short, indeterminate loading state with a clear description of what is being loaded. */
@Composable
fun InitialLoadingNote(text: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = Spacing.xl)
            .clearAndSetSemantics {
                contentDescription = text
                progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        LoadingIndicator()
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
