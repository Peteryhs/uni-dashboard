package dev.peteryhs.unidash.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Errors that the OAuth UI can translate without exposing protocol secrets to the user. */
sealed class OAuthException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Discovery(message: String) : OAuthException(message)
    class Registration(message: String) : OAuthException(message)
    class Exchange(message: String) : OAuthException(message)
    class InvalidGrant(message: String = "the refresh token is no longer valid") : OAuthException(message)
    class Network(cause: IOException) : OAuthException("network unavailable", cause)
}

/**
 * Small, browser-agnostic OAuth client. AppAuth owns the system-browser intent; this class owns
 * discovery, registration, PKCE material, and the code/token HTTP exchanges.
 */
class OAuthClient(
    private val client: OkHttpClient = RelayApi.defaultClient,
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
    /** Unit tests may use MockWebServer's HTTP origin; production callers leave this false. */
    private val allowHttpForTests: Boolean = false,
    /** Explicitly requested scopes; an empty list avoids silently asking for every supported scope. */
    private val requestedScopes: List<String> = emptyList(),
) {
    // OAuth requests carry registration identifiers, codes, and refresh tokens. Never let an
    // authorization server redirect one of these protocol requests to another origin.
    private val httpClient: OkHttpClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun prepare(baseUrl: String, redirectUri: String): OAuthPendingAuthorization = withContext(Dispatchers.IO) {
        val resource = normalizeBase(baseUrl)
        validateRedirect(redirectUri)
        val metadata = discover(resource)
        val config = metadata.configuration
        val registered = register(config, redirectUri)
        val clientId = registered.clientId
            ?: throw OAuthException.Registration("dynamic registration did not return a client_id")
        val state = randomToken(32)
        val verifier = randomToken(32)
        val challenge = sha256Base64Url(verifier)
        val authorization = config.authorizationEndpoint.toHttpUrl().newBuilder()
            .addQueryParameter("response_type", "code")
            .addQueryParameter("client_id", clientId)
            .addQueryParameter("redirect_uri", redirectUri)
            .addQueryParameter("state", state)
            .addQueryParameter("code_challenge", challenge)
            .addQueryParameter("code_challenge_method", "S256")
            .addQueryParameter("resource", config.resource)
            .apply {
                if (config.scopes.isNotEmpty()) addQueryParameter("scope", config.scopes.joinToString(" "))
            }
            .build()
            .toString()
        OAuthPendingAuthorization(
            baseUrl = resource,
            redirectUri = redirectUri,
            state = state,
            codeVerifier = verifier,
            clientId = clientId,
            authorizationUrl = authorization,
            config = config.copy(
                registrationClientUri = registered.registrationClientUri,
                registrationAccessToken = registered.registrationAccessToken,
            ),
        )
    }

    /**
     * Exchanges the authorization code and returns the legacy wrapper with OAuth state attached.
     * The optional state argument is intentionally checked here as a second line of defence for
     * browser callback handlers that pass the returned query parameter through.
     */
    suspend fun exchange(
        pending: OAuthPendingAuthorization,
        code: String,
        returnedState: String = pending.state,
    ): Credentials = withContext(Dispatchers.IO) {
        if (code.isBlank()) throw OAuthException.Exchange("authorization response did not contain a code")
        if (returnedState != pending.state) throw OAuthException.Exchange("authorization response state did not match")
        if (pending.clientId.isBlank() || normalizeBase(pending.baseUrl) != pending.baseUrl ||
            normalizeResource(pending.config.resource) != pending.baseUrl
        ) throw OAuthException.Exchange("authorization state was not issued for this dashboard")
        validateRedirect(pending.redirectUri)
        validateEndpoint(pending.config.authorizationEndpoint, "authorization endpoint", pending.baseUrl, pending.config.issuer)
        validateEndpoint(pending.config.tokenEndpoint, "token endpoint", pending.baseUrl, pending.config.issuer)
        val response = tokenRequest(
            endpoint = pending.config.tokenEndpoint,
            fields = listOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to pending.redirectUri,
                "client_id" to pending.clientId,
                "code_verifier" to pending.codeVerifier,
                "resource" to pending.config.resource,
            ),
        )
        val oauth = response.toCredentials(
            clientId = pending.clientId,
            authorizationEndpoint = pending.config.authorizationEndpoint,
            tokenEndpoint = pending.config.tokenEndpoint,
            resource = pending.config.resource,
            issuer = pending.config.issuer,
            registrationClientUri = pending.config.registrationClientUri,
            registrationAccessToken = pending.config.registrationAccessToken,
            sessionId = randomToken(16),
        )
        Credentials(pending.baseUrl, pending.clientId, "", oauth)
    }

    /** Refreshes a public client's token without sending a client secret. */
    suspend fun refresh(credentials: OAuthCredentials): OAuthCredentials = withContext(Dispatchers.IO) {
        val refreshToken = credentials.refreshToken
            ?: throw OAuthException.InvalidGrant("no refresh token is available")
        if (credentials.tokenEndpointAuthMethod != OAuthCredentials.TOKEN_ENDPOINT_AUTH_NONE) {
            throw OAuthException.Exchange("the registered client is not a public client")
        }
        validateEndpoint(credentials.tokenEndpoint, "token endpoint", credentials.resource, credentials.issuer)
        val response = tokenRequest(
            endpoint = credentials.tokenEndpoint,
            fields = listOf(
                "grant_type" to "refresh_token",
                "refresh_token" to refreshToken,
                "client_id" to credentials.clientId,
                "resource" to credentials.resource,
            ),
        )
        response.toCredentials(
            clientId = credentials.clientId,
            authorizationEndpoint = credentials.authorizationEndpoint,
            tokenEndpoint = credentials.tokenEndpoint,
            resource = credentials.resource,
            issuer = credentials.issuer,
            oldRefreshToken = refreshToken,
            registrationClientUri = credentials.registrationClientUri,
            registrationAccessToken = credentials.registrationAccessToken,
            sessionId = credentials.sessionId,
        )
    }

    private suspend fun discover(resource: String): DiscoveryResult {
        val directUrl = "$resource/.well-known/oauth-authorization-server"
        val direct = getJson(directUrl, allowNotFound = true)
        if (direct != null) {
            val metadata = parse<OAuthAuthorizationServerMetadata>(direct, "authorization server metadata")
            return metadata.toDiscoveryResult(resource)
        }

        val protectedUrl = "$resource/.well-known/oauth-protected-resource"
        val protected = getJson(protectedUrl)
            ?: throw OAuthException.Discovery("protected resource metadata was empty")
        val resourceMetadata = parse<OAuthProtectedResourceMetadata>(protected, "protected resource metadata")
        val declaredResource = resourceMetadata.resource?.let { normalizeResource(it) }
        if (declaredResource != null && declaredResource != resource) {
            throw OAuthException.Discovery("protected resource metadata named a different resource")
        }
        val server = resourceMetadata.authorizationServers.firstOrNull()
            ?: throw OAuthException.Discovery("protected resource metadata did not name an authorization server")
        val serverUri = parseUri(server)
        if (!isSecure(serverUri) || serverUri.userInfo != null ||
            !serverUri.query.isNullOrEmpty() || !serverUri.fragment.isNullOrEmpty()
        ) throw OAuthException.Discovery("protected resource metadata named an invalid authorization server")
        val serverOrigin = origin(serverUri)
        // RFC 8414 inserts the well-known segment before an issuer's path.
        val issuerPath = serverUri.rawPath.orEmpty().trimEnd('/')
        val metadataUrl = "$serverOrigin/.well-known/oauth-authorization-server$issuerPath"
        val metadata = parse<OAuthAuthorizationServerMetadata>(
            getJson(metadataUrl) ?: throw OAuthException.Discovery("authorization server metadata was empty"),
            "authorization server metadata",
        )
        return metadata.toDiscoveryResult(resource, trustedIssuer = canonicalIssuer(serverUri))
    }

    private suspend fun register(config: OAuthClientConfiguration, redirectUri: String): OAuthRegistrationResponse {
        val endpoint = config.registrationEndpoint
            ?: throw OAuthException.Registration("authorization server does not support dynamic registration")
        validateEndpoint(endpoint, "registration endpoint", config.resource, config.issuer)
        val body = buildJsonObject {
            put("redirect_uris", buildJsonArray { add(redirectUri) })
            put("token_endpoint_auth_method", OAuthCredentials.TOKEN_ENDPOINT_AUTH_NONE)
            put("grant_types", buildJsonArray {
                add("authorization_code")
                add("refresh_token")
            })
            put("response_types", buildJsonArray { add("code") })
            if (config.scopes.isNotEmpty()) put("scope", config.scopes.joinToString(" "))
        }.toString()
        val request = Request.Builder()
            .url(endpoint)
            .header("Accept", "application/json")
            .header("Content-Type", JSON_TYPE.toString())
            .post(body.toRequestBody(JSON_TYPE))
            .build()
        val text = execute(request, "dynamic registration")
            ?: throw OAuthException.Registration("dynamic registration response was empty")
        val response = parse<OAuthRegistrationResponse>(text, "dynamic registration response")
        val clientId = response.clientId?.takeIf { it.isNotBlank() }
            ?: throw OAuthException.Registration("dynamic registration did not return a client_id")
        if (response.tokenEndpointAuthMethod != null &&
            response.tokenEndpointAuthMethod != OAuthCredentials.TOKEN_ENDPOINT_AUTH_NONE
        ) {
            throw OAuthException.Registration("authorization server registered a non-public client")
        }
        return response.copy(clientId = clientId, tokenEndpointAuthMethod = OAuthCredentials.TOKEN_ENDPOINT_AUTH_NONE)
    }

    private suspend fun tokenRequest(endpoint: String, fields: List<Pair<String, String>>): OAuthTokenResponse {
        val form = fields.joinToString("&") { (key, value) ->
            "${formEncode(key)}=${formEncode(value)}"
        }
        val request = Request.Builder()
            .url(endpoint)
            .header("Accept", "application/json")
            .header("Content-Type", FORM_TYPE.toString())
            .post(form.toRequestBody(FORM_TYPE))
            .build()
        val result = executeResult(request)
        val text = result.text
        if (result.code !in 200..299 && result.code !in 400..499) {
            throw OAuthException.Exchange("token exchange endpoint returned ${result.code}")
        }
        val response = parse<OAuthTokenResponse>(text, "token response")
        response.error?.let { error ->
            if (error == "invalid_grant") throw OAuthException.InvalidGrant()
            throw OAuthException.Exchange("token exchange failed ($error)")
        }
        if (result.code !in 200..299) {
            throw OAuthException.Exchange("token exchange endpoint rejected the request (${result.code})")
        }
        return response
    }

    private suspend fun getJson(url: String, allowNotFound: Boolean = false): String? {
        val request = Request.Builder().url(url).header("Accept", "application/json").get().build()
        return execute(request, "metadata", allowNotFound)
    }

    private suspend fun execute(request: Request, operation: String, allowNotFound: Boolean = false): String? {
        val result = executeResult(request)
        if (allowNotFound && result.code == 404) return null
        if (result.code !in 200..299) {
            val message = "$operation endpoint returned ${result.code}"
            throw when (operation) {
                "dynamic registration" -> OAuthException.Registration(message)
                "token exchange" -> OAuthException.Exchange(message)
                else -> OAuthException.Discovery(message)
            }
        }
        if (operation != "dynamic registration" && operation != "token exchange" &&
            !result.contentType.contains("json", ignoreCase = true)
        ) {
            throw OAuthException.Discovery("$operation endpoint did not return JSON")
        }
        return result.text
    }

    private suspend fun executeResult(request: Request): HttpResult = withContext(Dispatchers.IO) {
        val response = try {
            httpClient.newCall(request).execute()
        } catch (error: IOException) {
            throw OAuthException.Network(error)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            HttpResult(it.code, text, it.header("content-type").orEmpty())
        }
    }

    private inline fun <reified T> parse(text: String, description: String): T = runCatching {
        ContractJson.decodeFromString<T>(text)
    }.getOrElse { throw OAuthException.Discovery("invalid $description") }

    private fun OAuthAuthorizationServerMetadata.toDiscoveryResult(
        resource: String,
        trustedIssuer: String? = null,
    ): DiscoveryResult {
        val issuer = issuer?.takeIf { it.isNotBlank() }
            ?: throw OAuthException.Discovery("metadata did not provide the required issuer")
        val issuerCanonical = canonicalIssuer(parseUri(issuer))
        if (trustedIssuer != null && issuerCanonical != trustedIssuer) {
            throw OAuthException.Discovery("authorization server issuer did not match protected resource metadata")
        }
        validateEndpoint(issuer, "issuer", resource, issuer)
        val authorization = authorizationEndpoint
            ?: throw OAuthException.Discovery("metadata did not provide an authorization endpoint")
        val token = tokenEndpoint
            ?: throw OAuthException.Discovery("metadata did not provide a token endpoint")
        validateEndpoint(authorization, "authorization endpoint", resource, issuer)
        validateEndpoint(token, "token endpoint", resource, issuer)
        registrationEndpoint?.let { validateEndpoint(it, "registration endpoint", resource, issuer) }
        if (responseTypesSupported.isNotEmpty() && "code" !in responseTypesSupported) {
            throw OAuthException.Discovery("authorization server does not support response_type=code")
        }
        if (grantTypesSupported.isNotEmpty() &&
            !("authorization_code" in grantTypesSupported && "refresh_token" in grantTypesSupported)
        ) {
            throw OAuthException.Discovery("authorization server does not support the required grants")
        }
        if (codeChallengeMethodsSupported.isNotEmpty() && "S256" !in codeChallengeMethodsSupported) {
            throw OAuthException.Discovery("authorization server does not support PKCE S256")
        }
        if (tokenEndpointAuthMethodsSupported.isNotEmpty() &&
            OAuthCredentials.TOKEN_ENDPOINT_AUTH_NONE !in tokenEndpointAuthMethodsSupported
        ) {
            throw OAuthException.Discovery("authorization server does not support public clients")
        }
        val selectedScopes = this@OAuthClient.requestedScopes.distinct()
        if (selectedScopes.any { it !in scopesSupported }) {
            throw OAuthException.Discovery("requested OAuth scope is not supported")
        }
        return DiscoveryResult(
            OAuthClientConfiguration(
                issuer = issuer,
                authorizationEndpoint = authorization,
                tokenEndpoint = token,
                registrationEndpoint = registrationEndpoint,
                resource = resource,
                scopes = selectedScopes,
            ),
        )
    }

    private fun OAuthTokenResponse.toCredentials(
        clientId: String,
        authorizationEndpoint: String,
        tokenEndpoint: String,
        resource: String,
        issuer: String,
        oldRefreshToken: String? = null,
        registrationClientUri: String? = null,
        registrationAccessToken: String? = null,
        sessionId: String = "",
    ): OAuthCredentials {
        val access = accessToken?.takeIf { it.isNotBlank() }
            ?: throw OAuthException.Exchange("token response did not contain an access token")
        if (tokenType != null && !tokenType.equals("bearer", ignoreCase = true)) {
            throw OAuthException.Exchange("token response did not contain a bearer token")
        }
        val expiresAt = expiresIn?.let { seconds ->
            runCatching { Math.addExact(clock(), Math.multiplyExact(seconds, 1_000L)) }
                .getOrElse { clock() }
        }
        return OAuthCredentials(
            clientId = clientId,
            authorizationEndpoint = authorizationEndpoint,
            tokenEndpoint = tokenEndpoint,
            accessToken = access,
            refreshToken = refreshToken ?: oldRefreshToken,
            expiresAt = expiresAt,
            resource = resource,
            issuer = issuer,
            scope = scope,
            registrationClientUri = registrationClientUri,
            registrationAccessToken = registrationAccessToken,
            sessionId = sessionId,
        )
    }

    private fun randomToken(bytes: Int): String {
        val value = ByteArray(bytes)
        random.nextBytes(value)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    }

    private fun sha256Base64Url(input: String): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.US_ASCII)))

    private fun normalizeBase(raw: String): String {
        val uri = parseUri(raw)
        if (uri.userInfo != null || !uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) {
            throw OAuthException.Discovery("dashboard URL must be an origin")
        }
        if (!isSecure(uri)) throw OAuthException.Discovery("dashboard URL must use HTTPS")
        return origin(uri)
    }

    private fun normalizeResource(raw: String): String {
        val uri = parseUri(raw)
        if (uri.userInfo != null || !uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) {
            throw OAuthException.Discovery("resource metadata was not an origin")
        }
        if (!isSecure(uri)) throw OAuthException.Discovery("resource metadata must use HTTPS")
        return origin(uri)
    }

    private fun validateRedirect(value: String) {
        val uri = parseUri(value)
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null ||
            !uri.fragment.isNullOrEmpty()
        ) throw OAuthException.Discovery("redirect URI must be an HTTPS URI without a fragment")
    }

    private fun validateEndpoint(value: String, name: String, resource: String, issuer: String) {
        val uri = parseUri(value)
        if (uri.userInfo != null || !uri.fragment.isNullOrEmpty()) {
            throw OAuthException.Discovery("$name must not contain user info or a fragment")
        }
        if (!isSecure(uri)) throw OAuthException.Discovery("$name must use HTTPS")
        val allowed = setOf(origin(parseUri(resource)), origin(parseUri(issuer)))
        if (origin(uri) !in allowed) throw OAuthException.Discovery("$name is outside the trusted dashboard and issuer origins")
    }

    private fun isSecure(uri: URI): Boolean = uri.scheme.equals("https", ignoreCase = true) ||
        (allowHttpForTests && uri.scheme.equals("http", ignoreCase = true) &&
            uri.host.orEmpty() in setOf("localhost", "127.0.0.1", "10.0.2.2"))

    private fun parseUri(raw: String): URI = runCatching { URI(raw) }.getOrElse {
        throw OAuthException.Discovery("invalid OAuth URI")
    }.also { if (it.host.isNullOrBlank()) throw OAuthException.Discovery("OAuth URI has no host") }

    private fun origin(uri: URI): String {
        val scheme = uri.scheme.lowercase()
        val host = uri.host.lowercase()
        val port = when {
            uri.port == -1 -> ""
            (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80) -> ""
            else -> ":${uri.port}"
        }
        return "$scheme://$host$port"
    }

    private fun canonicalIssuer(uri: URI): String {
        if (!isSecure(uri) || uri.userInfo != null || !uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) {
            throw OAuthException.Discovery("issuer must be an HTTPS URI without user info, query, or fragment")
        }
        return origin(uri) + uri.path.trimEnd('/')
    }

    private fun formEncode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    private data class DiscoveryResult(val configuration: OAuthClientConfiguration)

    private data class HttpResult(val code: Int, val text: String, val contentType: String)

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
        val FORM_TYPE = "application/x-www-form-urlencoded".toMediaType()
    }
}
