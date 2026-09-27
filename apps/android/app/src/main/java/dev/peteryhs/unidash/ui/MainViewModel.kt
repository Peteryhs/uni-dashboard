package dev.peteryhs.unidash.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.peteryhs.unidash.UniDashApp
import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.Recommendation
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.Snapshot
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Signed-in state is tri-state so the first frame never flashes the setup screen. */
enum class Session { Loading, SignedOut, SignedIn }

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as UniDashApp

    val session: StateFlow<Session> = app.credentialStore.credentials
        .map { if (it == null) Session.SignedOut else Session.SignedIn }
        .stateIn(viewModelScope, SharingStarted.Eagerly, Session.Loading)

    val baseUrl: StateFlow<String?> = app.credentialStore.credentials
        .map { it?.baseUrl }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val snapshot: StateFlow<Snapshot> = app.repository.snapshot

    /** One-shot messages for the snackbar. */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages = _messages.asSharedFlow()

    fun refresh() {
        viewModelScope.launch {
            app.repository.refresh().onSuccess { app.notifier.onSnapshot(it) }
        }
    }

    /**
     * Polls while the app is on screen. The Worker's cron runs once a minute, so asking more often
     * than the server suggests (refresh_after_ms, 60 s today) would only re-read the same data.
     */
    suspend fun liveLoop() {
        while (true) {
            app.repository.refresh().onSuccess { app.notifier.onSnapshot(it) }
            val hint = snapshot.value.recommendations?.refreshAfterMs ?: 60_000
            delay(hint.coerceIn(30_000, 5 * 60_000))
        }
    }

    /** Verifies the credentials against the Worker before storing them. */
    suspend fun signIn(url: String, clientId: String, secret: String): Result<Unit> {
        val base = Credentials.normaliseUrl(url, allowEmulatorHost = dev.peteryhs.unidash.BuildConfig.DEBUG)
            ?: return Result.failure(IllegalArgumentException("Enter the dashboard's https address"))
        val creds = Credentials(base, clientId.trim(), secret.trim())
        return runCatching { RelayApi(creds).health() }.map {
            app.credentialStore.save(creds)
            app.scheduleSync()
            refresh()
        }
    }

    fun signOut() {
        viewModelScope.launch {
            app.cancelSync()
            app.notifier.cancelAll()
            app.repository.clear()
            app.credentialStore.clear()
        }
    }

    fun act(item: Recommendation, action: String, until: Long? = null) {
        viewModelScope.launch {
            app.repository.act(item, action, until)
                .onSuccess { _messages.tryEmit(if (action == "done") "Marked done" else "Snoozed") }
                .onFailure { _messages.tryEmit(describe(it)) }
        }
    }

    fun dismissAlert(key: String) {
        viewModelScope.launch {
            app.repository.dismissAlert(key).onFailure { _messages.tryEmit(describe(it)) }
        }
    }

    suspend fun health(): Result<Health> = app.repository.health()

    companion object {
        fun describe(e: Throwable): String = when (e) {
            is RelayError.Offline -> "You're offline. Showing the last saved dashboard."
            is RelayError -> e.message ?: "Something went wrong"
            else -> e.message ?: "Something went wrong"
        }
    }
}
