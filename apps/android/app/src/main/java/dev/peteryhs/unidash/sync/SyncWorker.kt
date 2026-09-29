package dev.peteryhs.unidash.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.peteryhs.unidash.UniDashApp
import dev.peteryhs.unidash.data.RelayError

/**
 * The background check, every 15 minutes (Android's floor for periodic work). Refreshing through
 * the repository means the cache, the reminders and the alert notification all update in one place.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as UniDashApp
        if (app.credentialStore.current() == null) return Result.success()
        val generation = app.repository.currentSessionGeneration()
        return app.repository.refresh(expectedGeneration = generation).fold(
            onSuccess = { snapshot ->
                app.repository.deliverIfCurrent(snapshot) { app.notifier.onSnapshot(snapshot) }
                Result.success()
            },
            onFailure = { e ->
                app.repository.runIfCurrent(generation) {
                    when (e) {
                        is RelayError.Unauthorized, is RelayError.NotConfigured ->
                            app.notifier.onUnauthorized(e.message ?: "Open the app to reconnect.")
                        // Offline or a 5xx: the next periodic run is soon enough; retrying sooner burns battery.
                        else -> Unit
                    }
                }
                Result.success()
            },
        )
    }

    companion object {
        const val NAME = "dashboard-sync"
    }
}
