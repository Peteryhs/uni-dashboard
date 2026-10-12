package dev.peteryhs.unidash

import androidx.activity.BackEventCompat
import dev.peteryhs.unidash.ui.completeBackGesture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PredictiveBackTest {
    @Test fun cancelledSwipeNeverCommitsNavigation() = runTest {
        val progressSeen = CompletableDeferred<Unit>()
        var committed = false
        val gesture = launch {
            completeBackGesture(
                flow {
                    emit(BackEventCompat(0f, 0f, 0.6f, BackEventCompat.EDGE_LEFT))
                    awaitCancellation()
                },
                onProgress = { progressSeen.complete(Unit) },
                onCommit = { committed = true },
            )
        }
        progressSeen.await()
        gesture.cancel()
        gesture.join()
        assertFalse(committed)
    }

    @Test fun completedSwipeCommitsOnceAfterProgress() = runTest {
        val phases = mutableListOf<String>()
        completeBackGesture(
            flow {
                emit(BackEventCompat(0f, 0f, 0.2f, BackEventCompat.EDGE_RIGHT))
                emit(BackEventCompat(0f, 0f, 0.8f, BackEventCompat.EDGE_RIGHT))
            },
            onProgress = { phases.add("progress:$it") },
            onCommit = { phases.add("commit") },
        )
        assertEquals(listOf("progress:0.2", "progress:0.8", "commit"), phases)
    }

    @Test fun buttonBackCommitsWithoutGestureEvents() = runTest {
        var committed = false
        completeBackGesture(emptyFlow(), onProgress = { error("No swipe progress expected") }, onCommit = { committed = true })
        assertTrue(committed)
    }
}
