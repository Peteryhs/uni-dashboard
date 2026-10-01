package dev.peteryhs.unidash.ui

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** Result of validating the URI returned by the AppAuth redirect receiver. */
sealed interface OAuthCallback {
    val state: String

    data class Code(
        val code: String,
        override val state: String,
        val issuer: String?,
    ) : OAuthCallback

    data class ProviderError(
        val error: String,
        override val state: String,
        val description: String?,
        val issuer: String?,
    ) : OAuthCallback
}

/**
 * Pure URI validation for the fixed local leg of the HTTPS dashboard callback. Keeping this away
 * from Android Uri/Intent APIs makes the protocol boundary easy to test and review.
 */
object OAuthCallbackValidator {
    const val SCHEME = "dev.peteryhs.unidash"
    const val PATH = "/oauth/callback"

    fun validate(
        rawUri: String,
        expectedState: String,
        expectedIssuer: String,
    ): Result<OAuthCallback> = runCatching {
        val uri = URI(rawUri)
        require(uri.scheme.equals(SCHEME, ignoreCase = true)) { "unexpected callback scheme" }
        // A custom-scheme callback is intentionally authority-free (`scheme:/path`). Checking
        // host/userInfo alone is insufficient because java.net.URI can retain malformed raw
        // authorities whose parsed host is null.
        require(uri.rawAuthority == null) { "callback authority is not allowed" }
        require(uri.host == null) { "callback host is not allowed" }
        require(uri.userInfo == null) { "callback user info is not allowed" }
        require(uri.fragment == null) { "callback fragment is not allowed" }
        require(uri.path == PATH) { "unexpected callback path" }

        val query = parseQuery(uri.rawQuery)
        val grouped = query.groupingBy { it.first }.eachCount()
        require(grouped.values.all { it == 1 }) { "duplicate callback parameter" }

        val state = query.singleValue("state")
        require(!state.isNullOrBlank()) { "callback state is missing" }
        require(state.length <= MAX_STATE_LENGTH && state.hasNoControlCharacters()) { "callback state is invalid" }
        require(state == expectedState) { "callback state does not match" }

        val issuer = query.singleValue("iss")
        require(issuer == null || (issuer.length <= MAX_ISSUER_LENGTH && issuer.hasNoControlCharacters())) {
            "callback issuer is invalid"
        }
        if (issuer != null) require(issuer == expectedIssuer) { "callback issuer does not match" }

        val code = query.singleValue("code")
        val error = query.singleValue("error")
        require(code == null || (code.length <= MAX_CODE_LENGTH && code.hasNoControlCharacters())) {
            "callback code is invalid"
        }
        require(error == null || (error.length <= MAX_ERROR_LENGTH && error.hasNoControlCharacters())) {
            "callback error is invalid"
        }
        require(code == null || code.isNotBlank()) { "callback code is empty" }
        require(error == null || error.isNotBlank()) { "callback error is empty" }
        require(code == null || error == null) { "callback contains both code and error" }

        when {
            code != null -> OAuthCallback.Code(code, state, issuer)
            error != null -> OAuthCallback.ProviderError(
                error = error,
                state = state,
                description = query.singleValue("error_description"),
                issuer = issuer,
            )
            else -> error("callback contains neither code nor error")
        }
    }

    /** Reads a state value without accepting the callback. Used only to fence stale attempts. */
    fun stateFrom(rawUri: String): String? = runCatching {
        parseQuery(URI(rawUri).rawQuery).singleValue("state")
    }.getOrNull()

    private fun parseQuery(raw: String?): List<Pair<String, String>> {
        if (raw.isNullOrEmpty()) return emptyList()
        return raw.split('&').map { part ->
            val separator = part.indexOf('=')
            val rawName = if (separator < 0) part else part.substring(0, separator)
            val rawValue = if (separator < 0) "" else part.substring(separator + 1)
            URLDecoder.decode(rawName, StandardCharsets.UTF_8.name()) to
                URLDecoder.decode(rawValue, StandardCharsets.UTF_8.name())
        }
    }

    private fun List<Pair<String, String>>.singleValue(name: String): String? =
        firstOrNull { it.first == name }?.second

    private fun String.hasNoControlCharacters(): Boolean = none { it.code < 0x20 || it.code == 0x7f }

    private const val MAX_STATE_LENGTH = 1024
    private const val MAX_CODE_LENGTH = 8192
    private const val MAX_ERROR_LENGTH = 512
    private const val MAX_ISSUER_LENGTH = 2048
}
