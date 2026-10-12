package dev.peteryhs.unidash

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import dev.peteryhs.unidash.ui.AppRoot
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.Session
import dev.peteryhs.unidash.ui.theme.UniDashTheme
import net.openid.appauth.AuthorizationService
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private lateinit var authorizationService: AuthorizationService
    private var launchedAuthorizationState: String? = null
    private val browserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val state = launchedAuthorizationState
        launchedAuthorizationState = null
        vm.completeBrowserSignIn(result.resultCode, result.data, state)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        launchedAuthorizationState = savedInstanceState?.getString(AUTHORIZATION_STATE)
        authorizationService = AuthorizationService(this)
        setContent {
            UniDashTheme {
                AppRoot(
                    vm = vm,
                    onBrowserSignIn = vm::startBrowserSignIn,
                    onReauthenticate = vm::startBrowserSignIn,
                )
            }
        }

        lifecycleScope.launch {
            vm.authorizationRequests.collectLatest { request ->
                if (!vm.canLaunchBrowserRequest(request.state)) return@collectLatest
                runCatching { authorizationService.getAuthorizationRequestIntent(request) }
                    .onSuccess { intent ->
                        launchedAuthorizationState = request.state
                        runCatching { browserLauncher.launch(intent) }
                            .onFailure { vm.completeBrowserSignIn(RESULT_CANCELED, null, request.state) }
                    }
                    .onFailure { vm.completeBrowserSignIn(RESULT_CANCELED, null, request.state) }
            }
        }

        // Start background sync and restore eligible notifications after sign-in. Notification
        // permission remains an explicit choice in Settings → Notifications.
        lifecycleScope.launch {
            vm.session.first { it == Session.SignedIn }
            val app = application as UniDashApp
            val snapshot = app.repository.snapshot.value
            val generation = app.repository.currentSessionGeneration()
            app.repository.runIfCurrent(generation) {
                app.scheduleSync()
                app.repository.deliverIfCurrent(snapshot) { app.notifier.ensurePersistent(snapshot) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (vm.session.value == Session.SignedIn) {
            val app = application as UniDashApp
            val snapshot = app.repository.snapshot.value
            val generation = app.repository.currentSessionGeneration()
            app.repository.runIfCurrent(generation) {
                app.scheduleSync()
                app.repository.deliverIfCurrent(snapshot) { app.notifier.ensurePersistent(snapshot) }
            }
        }
    }

    override fun onDestroy() {
        if (::authorizationService.isInitialized) authorizationService.dispose()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(AUTHORIZATION_STATE, launchedAuthorizationState)
        super.onSaveInstanceState(outState)
    }

    private companion object {
        const val AUTHORIZATION_STATE = "launched_authorization_state"
    }
}
