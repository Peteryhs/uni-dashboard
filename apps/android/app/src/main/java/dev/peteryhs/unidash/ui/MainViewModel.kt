package dev.peteryhs.unidash.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.peteryhs.unidash.UniDashApp
import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.OAuthClient
import dev.peteryhs.unidash.data.OAuthException
import dev.peteryhs.unidash.data.Recommendation
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.RelayError
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.data.StaleSessionException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.ResponseTypeValues
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicLong

/** Signed-in state is tri-state so the first frame never flashes the setup screen. */
enum class Session { Loading, SignedOut, SignedIn }

/** State owned by the view model so rotation cannot leave the browser action looking stuck. */
data class BrowserAuthState(
    val busy: Boolean = false,
    val error: String? = null,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as UniDashApp
    private val sessionTransition = Mutex()
    private val oauthClient: OAuthClient get() = app.oauthClient
    private val browserAttempt = AtomicLong(0L)
    private var browserJob: Job? = null
    private var browserCompletionJob: Job? = null

    private val _browserState = MutableStateFlow(BrowserAuthState())
    val browserState: StateFlow<BrowserAuthState> = _browserState.asStateFlow()
    // Keep a prepared request across the brief gap between collectors during rotation.
    private val _authorizationRequests = Channel<AuthorizationRequest>(Channel.BUFFERED)
    /** MainActivity owns AuthorizationService and launches these requests in a Custom Tab. */
    val authorizationRequests = _authorizationRequests.receiveAsFlow()

    suspend fun canLaunchBrowserRequest(state: String?): Boolean {
        val pending = app.credentialStore.currentPending()
        return _browserState.value.busy && state != null && pending?.state == state
    }

    val session: StateFlow<Session> = app.credentialStore.credentials
        .map { if (it == null) Session.SignedOut else Session.SignedIn }
        .stateIn(viewModelScope, SharingStarted.Eagerly, Session.Loading)

    val baseUrl: StateFlow<String?> = app.credentialStore.credentials
        .map { it?.baseUrl }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val managedOAuth: StateFlow<Boolean> = app.credentialStore.credentials
        .map { it?.oauth != null }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    val snapshot: StateFlow<Snapshot> = app.repository.snapshot

    /** One-shot messages for the snackbar. */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages = _messages.asSharedFlow()

    fun refresh() {
        viewModelScope.launch {
            app.repository.refresh().onSuccess { snapshot ->
                app.repository.deliverIfCurrent(snapshot) { app.notifier.onSnapshot(snapshot) }
            }
        }
    }

    /**
     * Polls while the app is on screen. The Worker's cron runs once a minute, so asking more often
     * than the server suggests (refresh_after_ms, 60 s today) would only re-read the same data.
     */
    suspend fun liveLoop() {
        while (true) {
            app.repository.refresh().onSuccess { snapshot ->
                app.repository.deliverIfCurrent(snapshot) { app.notifier.onSnapshot(snapshot) }
            }
            val hint = snapshot.value.recommendations?.refreshAfterMs ?: 60_000
            delay(hint.coerceIn(30_000, 5 * 60_000))
        }
    }

    /** Verifies the credentials against the Worker before storing them. */
    suspend fun signIn(url: String, clientId: String, secret: String): Result<Unit> {
        // The manual path replaces any browser attempt. Fence it before validation so an old
        // callback cannot save OAuth credentials after this connection wins.
        val attempt = browserAttempt.incrementAndGet()
        browserJob?.cancel()
        browserCompletionJob?.cancel()
        _browserState.value = BrowserAuthState()
        app.credentialStore.clearPending()
        val base = Credentials.normaliseUrl(url, allowEmulatorHost = dev.peteryhs.unidash.BuildConfig.DEBUG)
            ?: return Result.failure(IllegalArgumentException("Enter the dashboard's https address"))
        val creds = Credentials(base, clientId.trim(), secret.trim())
        return try {
            sessionTransition.withLock {
                if (attempt != browserAttempt.get()) throw StaleSessionException
                RelayApi(creds).health()
                if (attempt != browserAttempt.get()) throw StaleSessionException
                app.repository.invalidateSession()
                app.credentialStore.save(creds)
                app.repository.beginSession()
                app.scheduleSync()
            }
            refresh()
            Result.success(Unit)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    /**
     * Discovers the dashboard's managed OAuth metadata, persists PKCE state, then asks the
     * activity to launch AppAuth's system-browser request. The HTTPS bridge is derived from the
     * entered dashboard origin; no deployment hostname is assumed by the APK.
     */
    fun startBrowserSignIn(url: String) {
        val attempt = browserAttempt.incrementAndGet()
        browserJob?.cancel()
        browserCompletionJob?.cancel()
        browserJob = viewModelScope.launch {
            _browserState.value = BrowserAuthState(busy = true)
            try {
                // Replacing an attempt cannot leave its encrypted state eligible for a later
                // callback after the user changes the dashboard address.
                app.credentialStore.clearPending()
                val base = Credentials.normaliseUrl(url)
                    ?: throw OAuthException.Discovery("enter the dashboard's HTTPS address")
                val redirect = "$base/oauth/android/callback"
                val pending = oauthClient.prepare(base, redirect)
                if (attempt != browserAttempt.get()) return@launch
                app.credentialStore.savePending(pending)
                if (attempt != browserAttempt.get()) {
                    app.credentialStore.clearPending()
                    return@launch
                }
                val configuration = AuthorizationServiceConfiguration(
                    Uri.parse(pending.config.authorizationEndpoint),
                    Uri.parse(pending.config.tokenEndpoint),
                )
                val request = AuthorizationRequest.Builder(
                    configuration,
                    pending.clientId,
                    ResponseTypeValues.CODE,
                    // The authorization server sees the HTTPS bridge URI registered by the
                    // deployment. The bridge returns only code/state to this fixed local scheme.
                    Uri.parse(pending.redirectUri),
                )
                    .setState(pending.state)
                    .setCodeVerifier(pending.codeVerifier)
                    .setScopes(pending.config.scopes)
                    .setAdditionalParameters(mapOf("resource" to pending.config.resource))
                    .build()
                if (attempt == browserAttempt.get()) _authorizationRequests.send(request)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (attempt == browserAttempt.get()) {
                    _browserState.value = BrowserAuthState(error = describe(error))
                    app.credentialStore.clearPending()
                }
            }
        }
    }

    /** Completes the one browser attempt that is currently fenced in encrypted pending state. */
    fun completeBrowserSignIn(resultCode: Int, data: Intent?, launchedState: String? = null) {
        // A process may be recreated while the system browser is open. The encrypted pending
        // record is the source of truth in that case, so adopt a fresh local attempt fence.
        val attempt = browserAttempt.updateAndGet { if (it == 0L) 1L else it }
        val previousJob = browserJob
        val completionJob = viewModelScope.launch {
            try {
                if (resultCode != android.app.Activity.RESULT_OK || data == null) {
                    // Read storage before fencing the job so a stale result cannot race a newer
                    // pending record. Cancellation still clears the browser state immediately.
                    val pending = app.credentialStore.currentPending()
                    if (launchedState != null && pending != null && launchedState != pending.state) return@launch
                    previousJob?.cancel()
                    // A process-recreated callback has no local launch state. Keeping pending in
                    // that ambiguous cancellation case is safe; the next attempt replaces it.
                    if (pending != null && launchedState == pending.state) {
                        app.credentialStore.clearPending()
                    }
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in was cancelled.")
                    return@launch
                }
                val pending = app.credentialStore.currentPending()
                if (pending == null) {
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "This sign-in attempt has expired. Try again.")
                    return@launch
                }
                val callback = data.data
                if (callback == null) {
                    if (launchedState != null && launchedState != pending.state) return@launch
                    if (launchedState == null || launchedState == pending.state) app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in returned without a callback address.")
                    return@launch
                }
                val authorizationError = AuthorizationException.fromIntent(data)
                val callbackResult = OAuthCallbackValidator.validate(
                    rawUri = callback.toString(),
                    expectedState = pending.state,
                    expectedIssuer = pending.config.issuer,
                )
                if (callbackResult.isFailure) {
                    // A late callback from an older browser attempt must never clear or cancel the
                    // current encrypted pending record. Leave the latest browser flow alone.
                    if (OAuthCallbackValidator.stateFrom(callback.toString()) != pending.state) return@launch
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in returned an unexpected callback.")
                    return@launch
                }
                previousJob?.cancel()
                val callbackValue = callbackResult.getOrThrow()
                if (callbackValue is OAuthCallback.ProviderError || authorizationError != null) {
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "The identity provider did not complete sign-in.")
                    return@launch
                }
                val response = AuthorizationResponse.fromIntent(data)
                val code = response?.authorizationCode
                val returnedState = response?.state
                if (code.isNullOrBlank() || returnedState.isNullOrBlank()) {
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in did not return an authorization code.")
                    return@launch
                }
                if (returnedState != pending.state) {
                    // AppAuth also verifies this state; keep the latest attempt intact if a stale
                    // result made it this far.
                    return@launch
                }
                if (callbackValue !is OAuthCallback.Code || callbackValue.code != code) {
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in verification failed. Try again.")
                    return@launch
                }
                if (response.request.clientId != pending.clientId || response.request.redirectUri.toString() != pending.redirectUri) {
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in verification failed. Try again.")
                    return@launch
                }
                val returnedIssuer = response.additionalParameters["iss"]
                if (returnedIssuer != null && returnedIssuer != pending.config.issuer) {
                    app.credentialStore.clearPending()
                    if (attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = "Sign-in returned from an unexpected identity provider.")
                    return@launch
                }
                val credentials = oauthClient.exchange(pending, code, returnedState)
                if (attempt != browserAttempt.get()) return@launch
                // Prove this token can reach the dashboard before making it the durable session.
                // A successful provider exchange alone does not mean this resource accepts it.
                RelayApi(credentials).health()
                if (attempt != browserAttempt.get()) return@launch
                sessionTransition.withLock {
                    if (attempt != browserAttempt.get()) return@withLock
                    app.repository.invalidateSession()
                    app.credentialStore.save(credentials)
                    app.repository.beginSession()
                    app.scheduleSync()
                }
                if (attempt != browserAttempt.get()) return@launch
                app.credentialStore.clearPending()
                _browserState.value = BrowserAuthState()
                refresh()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val callbackState = data?.data?.toString()?.let(OAuthCallbackValidator::stateFrom)
                val pending = app.credentialStore.currentPending()
                val stale = pending != null &&
                    ((callbackState != null && callbackState != pending.state) ||
                        (callbackState == null && launchedState != null && launchedState != pending.state))
                val ownsPending = pending != null &&
                    ((callbackState != null && callbackState == pending.state) ||
                        (callbackState == null && launchedState != null && launchedState == pending.state))
                if (!stale && ownsPending) app.credentialStore.clearPending()
                if (!stale && attempt == browserAttempt.get()) _browserState.value = BrowserAuthState(error = describe(error))
            }
        }
        // Keep callback handling separate from the prepare job. A stale callback can finish while
        // a newer prepare job is active; overwriting browserJob here would make that new attempt
        // impossible to cancel from sign-in, disconnect, or rotation.
        browserCompletionJob = completionJob
        completionJob.invokeOnCompletion {
            if (browserCompletionJob === completionJob) browserCompletionJob = null
        }
    }

    fun signOut() {
        // Fence callbacks and in-flight refreshes synchronously; the cleanup below suspends on
        // WorkManager/DataStore and must not leave a window for an old result to be delivered.
        browserAttempt.incrementAndGet()
        browserJob?.cancel()
        browserCompletionJob?.cancel()
        _browserState.value = BrowserAuthState()
        app.repository.invalidateSession()
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            sessionTransition.withLock {
                // A sign-in may have been waiting on the transition mutex when signOut was
                // requested. Fence that attempt again before clearing credentials and state.
                val invalidatedGeneration = app.repository.invalidateSession()
                app.cancelSync()
                app.notifier.cancelAll()
                // Clear the owner before any in-flight refresh can complete. TokenManager's CAS
                // fence then rejects a late response; waiting on its network-held mutex here
                // would make disconnect take as long as the refresh timeout.
                app.credentialStore.clear()
                app.credentialStore.clearPending()
                app.repository.clearInvalidated(invalidatedGeneration)
            }
        }
    }

    fun act(item: Recommendation, action: String, until: Long? = null) {
        viewModelScope.launch {
            app.repository.act(item, action, until)
                .onSuccess {
                    _messages.tryEmit(
                        when (action) {
                            "done" -> "Marked done"
                            "dismiss" -> "Dismissed"
                            else -> "Snoozed"
                        }
                    )
                }
                .onFailure { if (it !== StaleSessionException) _messages.tryEmit(describe(it)) }
        }
    }

    fun dismissAlert(key: String) {
        viewModelScope.launch {
            app.repository.dismissAlert(key).onFailure { if (it !== StaleSessionException) _messages.tryEmit(describe(it)) }
        }
    }

    fun rankFood(date: String) {
        viewModelScope.launch {
            app.repository.rankFood(date)
                .onFailure { if (it !== StaleSessionException) _messages.tryEmit(describe(it)) }
        }
    }

    suspend fun health(): Result<Health> = app.repository.health()

    companion object {
        fun describe(e: Throwable): String = when (e) {
            is RelayError.Offline -> "Can't reach the dashboard."
            is RelayError.ReauthRequired -> "Your dashboard session needs sign-in again."
            is OAuthException.Network -> "Can't reach the dashboard."
            is OAuthException.Discovery -> e.message ?: "Managed sign-in isn't configured for this dashboard."
            is OAuthException.Registration -> e.message ?: "Managed sign-in isn't configured for this dashboard."
            is OAuthException.Exchange -> e.message ?: "Sign-in could not be completed."
            is RelayError -> e.message ?: "Something went wrong"
            else -> e.message ?: "Something went wrong"
        }

    }
}
