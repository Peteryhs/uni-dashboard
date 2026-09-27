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
) {
    suspend fun dashboard(): Pair<Bundle, String> = getParsed("/v1/dashboard")
    suspend fun recommendations(): Pair<Recommendations, String> = getParsed("/v1/recommendations")
    suspend fun calendar(start: String, days: Int): Pair<Calendar, String> = getParsed("/v1/calendar?start=$start&days=$days")
    suspend fun health(): Pair<Health, String> = getParsed("/v1/health/sources")

    suspend fun recommendationAction(id: String, action: String, until: Long? = null) {
        post("/v1/recommendations/actions", buildJsonObject {
            put("id", id)
            put("action", action)
            if (until != null) put("until", until)
        }.toString())
    }

    suspend fun dismissAlert(key: String) {
        post("/v1/alerts/dismiss", buildJsonObject { put("key", key) }.toString())
    }

    private suspend inline fun <reified T> getParsed(path: String): Pair<T, String> {
        val body = execute(request(path).get().build())
        val parsed = runCatching { ContractJson.decodeFromString<T>(body) }.getOrElse {
            throw RelayError.BadResponse("unexpected reply from $path: ${it.message?.take(120)}")
        }
        return parsed to body
    }

    private suspend fun post(path: String, json: String) {
        execute(request(path).post(json.toRequestBody(JSON)).build())
    }

    private fun request(path: String) = Request.Builder()
        .url(credentials.baseUrl + path)
        .header("CF-Access-Client-Id", credentials.clientId)
        .header("CF-Access-Client-Secret", credentials.clientSecret)
        .header("Accept", "application/json")

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw RelayError.Offline(e)
        }
        response.use {
            val text = it.body.string()
            val type = it.header("content-type").orEmpty()
            when {
                it.code == 401 || it.code == 403 || it.code in 300..399 -> throw RelayError.Unauthorized(
                    "Cloudflare Access refused the service token (${it.code}). Check the client ID, secret, and the Service Auth policy.",
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
