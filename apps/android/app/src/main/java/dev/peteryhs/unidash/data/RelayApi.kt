package dev.peteryhs.unidash.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Why a request failed, in terms the UI can act on. */
sealed class RelayError(message: String) : Exception(message) {
    /** Access refused the service token, or the Worker refused the Access JWT. */
    class Unauthorized(message: String) : RelayError(message)
    /** OAuth refresh reported invalid_grant; cached dashboard data remains usable. */
    class ReauthRequired(message: String) : RelayError(message)
    /** The Worker is up but not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD unset). */
    class NotConfigured(message: String) : RelayError(message)
    /** A reply that is not the contract: usually an Access login page served instead of JSON. */
    class BadResponse(message: String) : RelayError(message)
    class Http(val code: Int, message: String) : RelayError(message)
    class Offline(cause: IOException) : RelayError(cause.message ?: "network unavailable")
}

/**
 * The Worker's /v1 API. Every request carries the Access service token headers; Access turns them
 * into the signed JWT the Worker verifies. Responses are kept as raw strings as well as parsed, so
 * the repository can cache exactly what the server sent.
 */
class RelayApi(
    private val credentials: Credentials,
    private val client: OkHttpClient = defaultClient,
    /** Shared app-wide gate for OAuth access-token refresh and its compare-and-save fence. */
    private val tokenManager: TokenManager? = null,
    /** Optional provider for callers whose credentials can change while a repository is alive. */
    private val credentialsProvider: (suspend () -> Credentials?)? = null,
    /** Lightweight callback alternative for tests or hosts that own token refresh themselves. */
    private val accessTokenProvider: (suspend (forceRefresh: Boolean) -> String?)? = null,
) {
    private val httpClient: OkHttpClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun dashboard(): Pair<Bundle, String> = getParsed("/v1/dashboard")
    suspend fun recommendations(): Pair<Recommendations, String> = getParsed("/v1/recommendations")
    suspend fun calendar(start: String, days: Int): Pair<Calendar, String> = getParsed("/v1/calendar?start=$start&days=$days")
    suspend fun foodRecommendation(date: String): Pair<FoodRecommendationResponse, String> =
        getParsed("/v1/food/recommendation?date=$date")
    suspend fun health(): Pair<Health, String> = getParsed("/v1/health/sources")

    suspend fun refreshSources(): SourcePollResult {
        val body = execute("/v1/poll", "POST", "{}")
        return runCatching { ContractJson.decodeFromString<SourcePollResult>(body) }.getOrElse {
            throw RelayError.BadResponse("unexpected reply from source refresh")
        }
    }

    suspend fun recommendationAction(id: String, action: String, until: Long? = null) {
        post("/v1/recommendations/actions", buildJsonObject {
            put("id", id)
            put("action", action)
            if (until != null) put("until", until)
        }.toString())
    }

    suspend fun rankFood(date: String) {
        post("/v1/ai/rank-food", buildJsonObject { put("date", date) }.toString())
    }

    suspend fun dismissAlert(key: String) {
        post("/v1/alerts/dismiss", buildJsonObject { put("key", key) }.toString())
    }

    private suspend inline fun <reified T> getParsed(path: String): Pair<T, String> {
        val body = execute(path, "GET")
        val parsed = runCatching { ContractJson.decodeFromString<T>(body) }.getOrElse {
            throw RelayError.BadResponse("unexpected reply from $path: ${it.message?.take(120)}")
        }
        return parsed to body
    }

    private suspend fun post(path: String, json: String) {
        execute(path, "POST", json)
    }

    /**
     * Builds a fresh request for every attempt. GET/HEAD may be replayed once after a 401 when the
     * shared manager can force a refresh; writes are deliberately never replayed.
     */
    private suspend fun execute(path: String, method: String, json: String? = null): String = withContext(Dispatchers.IO) {
        val safeToReplay = method == "GET" || method == "HEAD"
        var active: Credentials = if (credentialsProvider != null) {
            credentialsProvider.invoke() ?: throw RelayError.Unauthorized("not signed in")
        } else credentials
        var bearer = bearerFor(active, forceRefresh = false, rejectedToken = null)
        if (active.oauth != null && bearer.isNullOrBlank()) {
            throw RelayError.Unauthorized("the dashboard access token is unavailable")
        }
        var response = call(active, path, method, json, bearer)
        if (response.code == 401 && safeToReplay &&
            (tokenManager != null || accessTokenProvider != null) && active.oauth != null
        ) {
            response.close()
            val retryCredentials = if (credentialsProvider != null) {
                credentialsProvider.invoke() ?: throw RelayError.Unauthorized("not signed in")
            } else {
                active
            }
            // A repository may outlive an account/dashboard switch. Do not send a bearer from
            // the old request to the replacement owner or replay against the replacement origin.
            if (credentialsProvider != null && !retryCredentials.sameOAuthOwner(active)) {
                throw RelayError.Unauthorized("dashboard session changed during the request")
            }
            active = retryCredentials
            bearer = bearerFor(active, forceRefresh = true, rejectedToken = bearer)
            if (bearer != null) response = call(active, path, method, json, bearer) else {
                throw RelayError.Unauthorized("the dashboard access token was refused")
            }
        }
        response.use {
            val text = it.body?.string().orEmpty()
            val type = it.header("content-type").orEmpty()
            when {
                it.code == 401 || it.code == 403 || it.code in 300..399 -> throw RelayError.Unauthorized(
                    if (active.oauth != null) "the dashboard access token was refused (${it.code})"
                    else "Cloudflare Access refused the service token (${it.code}). Check the client ID, secret, and the Service Auth policy.",
                )
                it.code == 503 && "access not configured" in text -> throw RelayError.NotConfigured(
                    "The Worker has no ACCESS_TEAM_DOMAIN or ACCESS_AUD set yet.",
                )
                !it.isSuccessful -> throw RelayError.Http(it.code, "server returned ${it.code}")
                // Access answers an unauthenticated request with its HTML login page and a 200.
                !type.contains("json") -> throw RelayError.Unauthorized(
                    "Got a login page instead of data. The service token is not accepted by this Access application.",
                )
                else -> text
            }
        }
    }

    private suspend fun bearerFor(active: Credentials, forceRefresh: Boolean, rejectedToken: String?): String? {
        if (active.oauth == null) return null
        if (tokenManager != null) {
            return tokenManager.accessToken(
                forceRefresh = forceRefresh,
                expectedOwner = active,
                rejectedToken = rejectedToken,
            )
        }
        if (accessTokenProvider != null) return accessTokenProvider.invoke(forceRefresh)
        return active.oauth.accessToken
    }

    private suspend fun call(
        active: Credentials,
        path: String,
        method: String,
        json: String?,
        bearer: String?,
    ): okhttp3.Response {
        val builder = Request.Builder()
            .url(active.baseUrl.trimEnd('/') + path)
            .header("Accept", "application/json")
        if (active.oauth != null) {
            if (!bearer.isNullOrBlank()) builder.header("Authorization", "Bearer $bearer")
        } else {
            builder.header("CF-Access-Client-Id", active.clientId)
            builder.header("CF-Access-Client-Secret", active.clientSecret)
        }
        when (method) {
            "GET" -> builder.get()
            "HEAD" -> builder.head()
            "POST" -> builder.post((json ?: "").toRequestBody(JSON))
            else -> error("unsupported relay method")
        }
        return try {
            httpClient.newCall(builder.build()).execute()
        } catch (e: IOException) {
            throw RelayError.Offline(e)
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // A redirect to the Access login page must surface as an auth error, not be followed.
            .followRedirects(false)
            .build()
    }
}
