package dev.peteryhs.unidash.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The Worker's origin plus either a legacy service token or managed OAuth state. */
@Serializable
data class Credentials(
    val baseUrl: String,
    val clientId: String,
    val clientSecret: String,
    /** Present for managed OAuth; null keeps the original service-token format intact. */
    val oauth: OAuthCredentials? = null,
) {
    companion object {
        /**
         * Normalises what a person pastes: trims, adds https://, drops a trailing slash or path.
         * Plain http is refused: the service token would travel in clear text.
         */
        fun normaliseUrl(raw: String, allowEmulatorHost: Boolean = false): String? {
            val trimmed = raw.trim().ifEmpty { return null }
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            val url = runCatching { java.net.URI(withScheme) }.getOrNull() ?: return null
            if (url.host.isNullOrBlank()) return null
            // Debug builds only: a relay on the development machine, via 10.0.2.2 or `adb reverse`.
            val localHttp = allowEmulatorHost && url.scheme == "http" && url.host in DEV_HOSTS
            if (url.scheme != "https" && !localHttp) return null
            val port = if (url.port == -1) "" else ":${url.port}"
            return "${url.scheme}://${url.host}$port"
        }

        val DEV_HOSTS = setOf("10.0.2.2", "127.0.0.1")
    }
}

private val Context.credentialStore by preferencesDataStore(name = "credentials")

/**
 * Stores the credentials encrypted with an AES-GCM key held in the Android Keystore. The key never
 * leaves secure hardware, so the stored bytes are useless off this device, and backups are
 * excluded in data_extraction_rules.xml.
 */
class CredentialStore(private val context: Context) : OAuthCredentialStore {
    private val blobKey = stringPreferencesKey("blob")
    private val pendingBlobKey = stringPreferencesKey("pending_blob")

    val credentials: Flow<Credentials?> = context.credentialStore.data.map { prefs ->
        prefs[blobKey]?.let { decrypt(it) }
    }

    override suspend fun current(): Credentials? = credentials.first()

    suspend fun save(value: Credentials) {
        val blob = encrypt(ContractJson.encodeToString(value))
        context.credentialStore.edit { it[blobKey] = blob }
    }

    /**
     * Atomically replaces an OAuth credential set only when the token that prompted the refresh is
     * still the one in storage. A sign-out or a newer refresh therefore cannot be resurrected by a
     * delayed network response.
     */
    override suspend fun compareAndSave(
        value: Credentials,
        expectedAccessToken: String?,
        expectedOwner: Credentials?,
    ): Boolean {
        val blob = encrypt(ContractJson.encodeToString(value))
        var saved = false
        context.credentialStore.edit { prefs ->
            val current = prefs[blobKey]?.let(::decrypt)
            // A nullable expected token is meaningful only for an existing OAuth owner. It must
            // never turn an empty store, a signed-out store, or a legacy service-token record
            // into a newly persisted OAuth session after a delayed refresh returns.
            if (current != null && current.oauth != null &&
                current.oauth.accessToken == expectedAccessToken &&
                (expectedOwner == null || current.sameOAuthOwner(expectedOwner))
            ) {
                prefs[blobKey] = blob
                saved = true
            }
        }
        return saved
    }

    suspend fun compareAndSave(value: Credentials, expectedAccessToken: String?): Boolean =
        compareAndSave(value, expectedAccessToken, null)

    suspend fun savePending(value: OAuthPendingAuthorization) {
        val blob = encrypt(ContractJson.encodeToString(value))
        context.credentialStore.edit { it[pendingBlobKey] = blob }
    }

    suspend fun currentPending(): OAuthPendingAuthorization? = context.credentialStore.data
        .map { prefs -> prefs[pendingBlobKey]?.let(::decryptPending) }
        .first()

    suspend fun clearPending() {
        context.credentialStore.edit { it.remove(pendingBlobKey) }
    }

    suspend fun clear() {
        context.credentialStore.edit { it.clear() }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = cipher.iv + cipher.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** A blob that no longer decrypts (key wiped, app data restored) reads as signed out. */
    private fun decrypt(blob: String): Credentials? = runCatching {
        val bytes = Base64.decode(blob, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
        val plain = cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)
        ContractJson.decodeFromString<Credentials>(String(plain))
    }.getOrNull()

    private fun decryptPending(blob: String): OAuthPendingAuthorization? = runCatching {
        val bytes = Base64.decode(blob, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
        val plain = cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)
        ContractJson.decodeFromString<OAuthPendingAuthorization>(String(plain))
    }.getOrNull()

    private companion object {
        const val ALIAS = "unidash-credentials"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/** Stable account/resource identity used to fence token refreshes across account switches. */
internal fun Credentials.sameOAuthOwner(other: Credentials): Boolean =
    baseUrl == other.baseUrl &&
        clientId == other.clientId &&
        oauth?.clientId == other.oauth?.clientId &&
        oauth?.resource == other.oauth?.resource &&
        oauth?.issuer == other.oauth?.issuer &&
        oauth?.sessionId == other.oauth?.sessionId
