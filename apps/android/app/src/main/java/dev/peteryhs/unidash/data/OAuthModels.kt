package dev.peteryhs.unidash.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** OAuth state persisted while the system browser owns the authorization interaction. */
@Serializable
data class OAuthPendingAuthorization(
    val baseUrl: String,
    /** The exact HTTPS redirect URI registered with the authorization server. */
    val redirectUri: String,
    val state: String,
    val codeVerifier: String,
    val clientId: String,
    val authorizationUrl: String,
    val config: OAuthClientConfiguration,
) {
    /** Alias used by browser integrations that call the PKCE secret a verifier. */
    val verifier: String get() = codeVerifier
}

/** The provider values needed both to build the browser URL and to exchange the code. */
@Serializable
data class OAuthClientConfiguration(
    val issuer: String,
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val registrationEndpoint: String?,
    val resource: String,
    val scopes: List<String> = emptyList(),
    val registrationClientUri: String? = null,
    val registrationAccessToken: String? = null,
) 

/**
 * Managed OAuth credentials. The optional registration fields are retained only when a provider
 * returns them; a public client never stores a client secret.
 */
@Serializable
data class OAuthCredentials(
    val clientId: String,
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    /** Epoch milliseconds. Null means the provider did not expose an expiry. */
    val expiresAt: Long? = null,
    /** RFC 8707 resource indicator, normally the selected dashboard origin. */
    val resource: String,
    val issuer: String,
    val scope: String? = null,
    val registrationClientUri: String? = null,
    val registrationAccessToken: String? = null,
    val tokenEndpointAuthMethod: String = TOKEN_ENDPOINT_AUTH_NONE,
    /** Per-sign-in fence, allowing the same provider/client to be replaced safely. */
    val sessionId: String = "",
) {
    companion object {
        const val TOKEN_ENDPOINT_AUTH_NONE = "none"
    }
}

/** OAuth Authorization Server Metadata (RFC 8414), deliberately separate from OIDC metadata. */
@Serializable
internal data class OAuthAuthorizationServerMetadata(
    val issuer: String? = null,
    @SerialName("authorization_endpoint") val authorizationEndpoint: String? = null,
    @SerialName("token_endpoint") val tokenEndpoint: String? = null,
    @SerialName("registration_endpoint") val registrationEndpoint: String? = null,
    @SerialName("response_types_supported") val responseTypesSupported: List<String> = emptyList(),
    @SerialName("grant_types_supported") val grantTypesSupported: List<String> = emptyList(),
    @SerialName("code_challenge_methods_supported") val codeChallengeMethodsSupported: List<String> = emptyList(),
    @SerialName("scopes_supported") val scopesSupported: List<String> = emptyList(),
    @SerialName("token_endpoint_auth_methods_supported") val tokenEndpointAuthMethodsSupported: List<String> = emptyList(),
)

/** Protected Resource Metadata (RFC 9728), used when the resource points at a separate AS. */
@Serializable
internal data class OAuthProtectedResourceMetadata(
    val resource: String? = null,
    @SerialName("authorization_servers") val authorizationServers: List<String> = emptyList(),
)

@Serializable
internal data class OAuthRegistrationResponse(
    @SerialName("client_id") val clientId: String? = null,
    @SerialName("token_endpoint_auth_method") val tokenEndpointAuthMethod: String? = null,
    @SerialName("registration_client_uri") val registrationClientUri: String? = null,
    @SerialName("registration_access_token") val registrationAccessToken: String? = null,
)

@Serializable
internal data class OAuthTokenResponse(
    @SerialName("access_token") val accessToken: String? = null,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("token_type") val tokenType: String? = null,
    @SerialName("expires_in") val expiresIn: Long? = null,
    val scope: String? = null,
    val error: String? = null,
    @SerialName("error_description") val errorDescription: String? = null,
)
