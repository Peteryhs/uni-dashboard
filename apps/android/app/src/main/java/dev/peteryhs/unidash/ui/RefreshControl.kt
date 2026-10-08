package dev.peteryhs.unidash.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.ui.theme.Spacing

/** The same refresh affordance in every screen, with a named, disabled in-progress state. */
@Composable
fun RefreshControl(
    label: String,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    showLabel: Boolean = false,
) {
    val accessible = modifier.semantics(mergeDescendants = true) {
        if (!showLabel) contentDescription = label
        if (refreshing) stateDescription = "Refreshing"
        liveRegion = LiveRegionMode.Polite
    }
    val mark: @Composable () -> Unit = {
        if (refreshing) CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        else Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(24.dp))
    }
    if (showLabel) {
        TextButton(onClick = onRefresh, enabled = !refreshing, modifier = accessible) {
            mark()
            Spacer(Modifier.width(Spacing.s))
            Text(label)
        }
    } else {
        IconButton(onClick = onRefresh, enabled = !refreshing, modifier = accessible) { mark() }
    }
}
