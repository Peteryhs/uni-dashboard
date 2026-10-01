package dev.peteryhs.unidash.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/** Minimal storage seam keeps token refresh concurrency tests independent of Android DataStore. */
interface OAuthCredentialStore {
    suspend fun current(): Credentials?
    suspend fun compareAndSave(
        value: Credentials,
        expectedAccessToken: String?,
        expectedOwner: Credentials? = null,
    ): Boolean
}

/**
 * Process-wide OAuth token gate. Every RelayApi created by the app points at this one instance so
 * parallel dashboard calls perform at most one refresh and sign-out can never be undone by a late
 * refresh response.
 */
class TokenManager(
    private val credentialStore: OAuthCredentialStore,
    private val oauthClient: OAuthClient,
    private val clock: () -> Long = System::currentTimeMillis,
    private val expiryLeewayMs: Long = DEFAULT_EXPIRY_LEEWAY_MS,
    private val refreshToken: suspend (OAuthCredentials) -> OAuthCredentials = oauthClient::refresh,
) {
    private val mutex = Mutex()

    suspend fun accessToken(
        forceRefresh: Boolean = false,
        expectedOwner: Credentials? = null,
        rejectedToken: String? = null,
    ): String? = mutex.withLock {
        val current = credentialStore.current() ?: return@withLock null
        if (expectedOwner != null && !current.sameOAuthOwner(expectedOwner)) return@withLock null
        val oauth = current.oauth ?: return@withLock null
        val token = oauth.accessToken
        val fresh = token != null && (oauth.expiresAt == null || oauth.expiresAt > clock() + expiryLeewayMs)
        if (!forceRefresh && fresh) return@withLock token
        // A concurrent request may already have rotated the token. Reuse the current owner rather
        // than issuing a second refresh against a now-invalid refresh token.
        if (forceRefresh && rejectedToken != null && token != rejectedToken) return@withLock token

        val refresh = oauth.refreshToken
        if (refresh.isNullOrBlank()) {
            throw RelayError.ReauthRequired("the dashboard session needs sign-in again")
        }
        val refreshed = try {
            refreshToken(oauth)
        } catch (error: OAuthException.InvalidGrant) {
            // Preserve cached data and credentials. The UI can request interactive sign-in without
            // turning a server-side revocation into an implicit sign-out.
            throw RelayError.ReauthRequired("the dashboard session needs sign-in again")
        } catch (error: OAuthException.Network) {
            throw RelayError.Offline(error.cause as? IOException ?: IOException("network unavailable"))
        }
        val updated = current.copy(oauth = refreshed)
        credentialStore.compareAndSave(updated, token, expectedOwner = current)
        val persistedCredentials = credentialStore.current()
        if (persistedCredentials == null || !persistedCredentials.sameOAuthOwner(current)) {
            return@withLock null
        }
        val persisted = persistedCredentials?.oauth
        // A failed CAS means sign-out or another owner won while the network was in flight. Return
        // only the token that is currently owned by storage; never return the late response.
        persisted?.accessToken
    }

    suspend fun clear() = mutex.withLock {
        // Acquiring this lock gives callers a simple synchronization point before sign-out. The
        // store itself remains authoritative for the compare-and-save fence.
    }

    companion object {
        const val DEFAULT_EXPIRY_LEEWAY_MS = 60_000L
    }
}

/** Name used by callers that describe the component by its OAuth role. */
typealias OAuthTokenManager = TokenManager
