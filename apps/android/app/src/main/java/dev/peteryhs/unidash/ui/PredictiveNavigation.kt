package dev.peteryhs.unidash.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.BackEventCompat
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.LayoutDirection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow

/** Previewed/outgoing pages cannot handle back, receive input, or start page-entry work. */
val LocalNavigationActive = staticCompositionLocalOf { true }

internal suspend fun completeBackGesture(
    events: Flow<BackEventCompat>,
    onProgress: suspend (Float) -> Unit,
    onCommit: suspend () -> Unit,
) {
    events.collect { onProgress(it.progress.coerceIn(0f, 1f)) }
    // A cancelled Flow throws before this point; a button back completes with no progress events.
    onCommit()
}

/**
 * A gesture seeks the real parent page, without changing the saved destination until committed.
 * Cancelling reverses to the current page; buttons/three-button navigation use the same transition.
 * At the root, no callback intercepts Android's own back-to-home animation.
 */
@Composable
fun <T : Any> PredictiveNavigation(
    destination: T,
    backDestination: T?,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    topLevel: Boolean = false,
    isRootDestination: (T) -> Boolean = { false },
    content: @Composable (T) -> Unit,
) {
    val state = remember { SeekableTransitionState(destination) }
    val latestDestination by rememberUpdatedState(destination)
    val transition = rememberTransition(state, label = "Page navigation")
    val parentActive = LocalNavigationActive.current
    val focus = LocalFocusManager.current
    val layoutDirection = LocalLayoutDirection.current
    // Frequent page navigation uses restrained, non-bouncy platform-style motion.
    val motion = MotionScheme.standard()
    var seeking by remember { mutableStateOf(false) }
    var returning by remember { mutableStateOf(false) }
    var contentHasFocus by remember { mutableStateOf(false) }

    LaunchedEffect(destination, seeking) {
        if (!seeking) {
            if (state.currentState != destination && contentHasFocus) focus.clearFocus()
            returning = isRootDestination(destination)
            state.animateTo(destination, motion.slowEffectsSpec())
            returning = false
        }
    }

    // Registered before child content: an active nested page owns back before its main tab.
    PredictiveBackHandler(
        enabled = parentActive && backDestination != null,
    ) { events ->
        // Android may deliver a gesture just after enabled changes. Recheck the live destination.
        val parent = backDestination
        if (parent != null && parentActive && !seeking) {
            seeking = true
            returning = true
            try {
                // A back swipe can start during entry: finish that entry before seeking its parent.
                state.snapTo(destination)
                state.seekTo(0f, parent)
                completeBackGesture(
                    events,
                    onProgress = { state.seekTo(it, parent) },
                    onCommit = {
                        // Commit before settling so another back sees the new navigation hierarchy.
                        // A tab tap that interrupted this gesture takes precedence over its old target.
                        if (latestDestination == destination) {
                            if (contentHasFocus) focus.clearFocus()
                            onBack()
                        }
                    },
                )
            } catch (cancelled: CancellationException) {
                // The effect below reverses the interrupted transition; no navigation is committed.
                throw cancelled
            } finally {
                seeking = false
            }
        } else {
            events.collect { }
        }
    }

    transition.AnimatedContent(
        modifier = modifier.fillMaxSize(),
        transitionSpec = {
            val direction = (if (returning) -1 else 1) * (if (layoutDirection == LayoutDirection.Rtl) -1 else 1)
            val enter = fadeIn(motion.slowEffectsSpec())
            val exit = fadeOut(motion.slowEffectsSpec())
            if (topLevel) (enter togetherWith exit).using(null)
            else ((enter + slideInHorizontally(motion.slowSpatialSpec()) { direction * it / 10 }) togetherWith
                (exit + slideOutHorizontally(motion.slowSpatialSpec()) { -direction * it / 10 })).using(null)
        },
        contentKey = { it },
    ) { page ->
        val settled = state.currentState == destination && state.targetState == destination
        val active = parentActive && !seeking && settled && page == destination
        val blocked = if (active) Modifier else Modifier
            .focusProperties { canFocus = false }
            .onPreviewKeyEvent { true }
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                }
            }
            .clearAndSetSemantics { }
        CompositionLocalProvider(LocalNavigationActive provides active) {
            Box(
                Modifier.fillMaxSize()
                    .graphicsLayer {
                        // Top-level destinations fade through a clean frame, rather than overlapping.
                        alpha = if (!topLevel || seeking || state.currentState == state.targetState) 1f
                        else if (page == state.currentState) (1f - state.fraction * 2f).coerceIn(0f, 1f)
                        else ((state.fraction - 0.5f) * 2f).coerceIn(0f, 1f)
                    }
                    .background(MaterialTheme.colorScheme.surface)
                    .then(blocked)
                    .onFocusChanged { if (page == destination) contentHasFocus = it.hasFocus }
                    .focusGroup(),
            ) { content(page) }
        }
    }
}
