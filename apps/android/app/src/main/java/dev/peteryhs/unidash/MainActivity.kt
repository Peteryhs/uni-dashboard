package dev.peteryhs.unidash

import android.Manifest
import android.os.Build
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            val app = application as UniDashApp
            val snapshot = app.repository.snapshot.value
            app.repository.deliverIfCurrent(snapshot) { app.notifier.ensurePersistent(snapshot) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { UniDashTheme { AppRoot(vm) } }

        // Ask for notifications once there is something to notify about: after the first sign-in.
        lifecycleScope.launch {
            vm.session.first { it == Session.SignedIn }
            val app = application as UniDashApp
            val snapshot = app.repository.snapshot.value
            val generation = app.repository.currentSessionGeneration()
            app.repository.runIfCurrent(generation) {
                app.scheduleSync()
                app.repository.deliverIfCurrent(snapshot) { app.notifier.ensurePersistent(snapshot) }
            }
            if (Build.VERSION.SDK_INT >= 33 && savedInstanceState == null) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
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
}
