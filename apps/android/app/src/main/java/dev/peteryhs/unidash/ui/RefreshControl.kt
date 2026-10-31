package dev.peteryhs.unidash.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding

/**
 * A visible source-update action for Status, with a named, disabled in-progress state. The
 * labelled form is a tonal button: the page's one action, quieter than a filled primary button.
 */
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
        if (refreshing) {
            stateDescription = "Refreshing"
            liveRegion = LiveRegionMode.Polite
        }
    }
    val mark: @Composable () -> Unit = {
        if (refreshing) {
            CircularProgressIndicator(
                modifier = Modifier.size(ButtonDefaults.IconSize),
                strokeWidth = 2.dp,
                color = LocalContentColor.current,
            )
        } else {
            Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(ButtonDefaults.IconSize))
        }
    }
    if (showLabel) {
        FilledTonalButton(
            onClick = onRefresh,
            enabled = !refreshing,
            shapes = ButtonDefaults.shapes(),
            contentPadding = ButtonDefaults.ButtonWithIconContentPadding,
            modifier = accessible,
        ) {
            mark()
            Text(if (refreshing) "Refreshing…" else label, Modifier.padding(start = ButtonDefaults.IconSpacing))
        }
    } else {
        IconButton(onClick = onRefresh, enabled = !refreshing, modifier = accessible) { mark() }
    }
}
