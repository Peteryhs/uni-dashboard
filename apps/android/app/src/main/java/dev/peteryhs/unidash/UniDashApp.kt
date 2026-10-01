package dev.peteryhs.unidash

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dev.peteryhs.unidash.data.CredentialStore
import dev.peteryhs.unidash.data.DashboardRepository
import dev.peteryhs.unidash.data.OAuthClient
import dev.peteryhs.unidash.data.RelayApi
import dev.peteryhs.unidash.data.TokenManager
import dev.peteryhs.unidash.notify.Notifier
import dev.peteryhs.unidash.sync.SyncWorker
import java.io.File
import java.util.concurrent.TimeUnit

/** Manual dependency container: three singletons do not justify a DI framework. */
class UniDashApp : Application() {
    lateinit var credentialStore: CredentialStore
        private set
    lateinit var repository: DashboardRepository
        private set
    lateinit var notifier: Notifier
        private set
    lateinit var oauthClient: OAuthClient
        private set
    lateinit var tokenManager: TokenManager
        private set

    override fun onCreate() {
        super.onCreate()
        credentialStore = CredentialStore(this)
        oauthClient = OAuthClient()
        tokenManager = TokenManager(credentialStore, oauthClient)
        repository = DashboardRepository(
            cacheDir = File(filesDir, "dashboard"),
            apiFor = { credentialStore.current()?.let { RelayApi(it, tokenManager = tokenManager) } },
        )
        notifier = Notifier(this).also { it.createChannels() }
    }

    fun scheduleSync() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(SyncWorker.NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancelSync() {
        WorkManager.getInstance(this).cancelUniqueWork(SyncWorker.NAME)
    }
}
