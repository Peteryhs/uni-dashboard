package dev.peteryhs.unidash.ui.setup

import android.content.ClipData
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.ui.BrowserAuthState
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.SignInProblem
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * First-run connection: two fixed steps, address then sign in. Progress and the (non-secret)
 * address survive the app being closed, so the person always returns to the step they left.
 * Secrets are never persisted here.
 */
private const val FLOW_PREFS = "setup_flow_v1"
private const val STEP_ADDRESS = 0
private const val STEP_SIGN_IN = 1

private const val MANAGED_OAUTH_DOCS =
    "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/"

@Composable
fun SetupScreen(
    vm: MainViewModel,
    browser: BrowserAuthState,
    onBrowserSignIn: (String) -> Unit,
) {
    val context = LocalContext.current
    val prefs = remember(context) { context.getSharedPreferences(FLOW_PREFS, Context.MODE_PRIVATE) }
    val savedAddress = remember(prefs) { prefs.getString("address", null).orEmpty() }
    var url by rememberSaveable { mutableStateOf(savedAddress) }
    var step by rememberSaveable {
        mutableIntStateOf(if (Credentials.normaliseUrl(savedAddress) != null) prefs.getInt("step", STEP_ADDRESS) else STEP_ADDRESS)
    }
    val origin = remember(url) { Credentials.normaliseUrl(url) }

    fun goTo(next: Int) {
        if (next == STEP_ADDRESS) vm.clearSignInError()
        step = next
        prefs.edit().putInt("step", next).putString("address", url.trim()).apply()
    }

    BackHandler(enabled = step == STEP_SIGN_IN && !browser.busy) { goTo(STEP_ADDRESS) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.l, vertical = Spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                ShapedIcon(
                    Icons.Outlined.Dashboard,
                    container = MaterialTheme.colorScheme.primaryContainer,
                    content = MaterialTheme.colorScheme.onPrimaryContainer,
                    size = 72.dp,
                    shape = MaterialShapes.Cookie12Sided,
                )
                Text(
                    "Connect your dashboard",
                    style = MaterialTheme.typography.headlineMediumEmphasized,
                    modifier = Modifier.semantics { heading() },
                )
                LinearProgressIndicator(progress = { (step + 1) / 2f }, modifier = Modifier.fillMaxWidth())
                Text(
                    "Step ${step + 1} of 2",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AnimatedContent(
                    targetState = step,
                    transitionSpec = { fadeIn() togetherWith fadeOut() },
                    label = "setup step",
                ) { current ->
                    when (current) {
                        STEP_ADDRESS -> AddressStep(
                            url = url,
                            origin = origin,
                            onUrlChange = { url = it },
                            onContinue = { if (origin != null) goTo(STEP_SIGN_IN) },
                        )
                        else -> SignInStep(
                            vm = vm,
                            url = url,
                            origin = origin.orEmpty(),
                            browser = browser,
                            onSignIn = { onBrowserSignIn(url) },
                            onChangeAddress = { goTo(STEP_ADDRESS) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AddressStep(
    url: String,
    origin: String?,
    onUrlChange: (String) -> Unit,
    onContinue: () -> Unit,
) {
    val invalid = url.isNotBlank() && origin == null
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
        Text("Enter your dashboard address", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        StepText("This is the web address you open UniDash at in a browser. Copy it from your browser's address bar.")
        OutlinedTextField(
            value = url,
            onValueChange = onUrlChange,
            label = { Text("Dashboard address") },
            placeholder = { Text("https://your-dashboard.workers.dev") },
            leadingIcon = { Icon(Icons.Outlined.Language, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Next,
                autoCorrectEnabled = false,
            ),
            keyboardActions = KeyboardActions(onNext = { onContinue() }),
            isError = invalid,
            supportingText = {
                Text(if (invalid) "Enter an address that starts with https://" else "Any page on the dashboard works. Only the site address is used.")
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = onContinue,
            enabled = origin != null,
            modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
            contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
        ) {
            Text("Continue", style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
        }
    }
}

@Composable
private fun SignInStep(
    vm: MainViewModel,
    url: String,
    origin: String,
    browser: BrowserAuthState,
    onSignIn: () -> Unit,
    onChangeAddress: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
        Text("Sign in", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)) {
            Row(
                Modifier.fillMaxWidth().padding(start = Spacing.m, top = Spacing.s, bottom = Spacing.s, end = Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Dashboard", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(origin.removePrefix("https://"), style = MaterialTheme.typography.bodyLarge)
                }
                TextButton(onClick = onChangeAddress, enabled = !browser.busy) { Text("Change") }
            }
        }
        StepText("Your browser opens the same Cloudflare sign-in you use for the web dashboard. When you finish, you come straight back here.")
        StepText("You don't need a token, key or password for this app.")
        Button(
            onClick = onSignIn,
            enabled = !browser.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
            contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
        ) {
            if (browser.busy) {
                LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.onPrimary)
            } else {
                Icon(Icons.Outlined.Lock, contentDescription = null)
            }
            Spacer(Modifier.size(Spacing.s))
            Text(
                when {
                    browser.busy -> "Opening sign-in…"
                    browser.error != null -> "Try again"
                    else -> "Sign in with Cloudflare"
                },
                style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight),
            )
        }
        if (browser.error != null && !browser.busy) {
            SignInError(browser.error, browser.problem, origin, onChangeAddress)
        }
        ServiceTokenOption(vm, url)
    }
}

@Composable
private fun SignInError(message: String, problem: SignInProblem, origin: String, onChangeAddress: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Column(Modifier.padding(Spacing.m), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.Top) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null)
                Text(message, style = MaterialTheme.typography.bodyMedium)
            }
            when (problem) {
                SignInProblem.Address -> OutlinedButton(onClick = onChangeAddress) { Text("Change address") }
                SignInProblem.OwnerSetup -> OwnerFix(origin)
                SignInProblem.Retry -> Unit
            }
        }
    }
}

/** The one-time Cloudflare change, with the exact value to paste. Shown only when it is the cause. */
@Composable
private fun OwnerFix(origin: String) {
    val callback = "$origin/oauth/android/callback"
    val clipboard = LocalClipboard.current
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    Text(
        "The dashboard owner needs to make a one-time change in Cloudflare. If that's you:",
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        "1. Open Zero Trust → Access controls → Applications, and edit the app for this dashboard.\n" +
            "2. Under Advanced settings → Managed OAuth, turn it on.\n" +
            "3. Add this redirect URI, then save:",
        style = MaterialTheme.typography.bodyMedium,
    )
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.small) {
        Row(Modifier.fillMaxWidth().padding(start = Spacing.s), verticalAlignment = Alignment.CenterVertically) {
            Text(callback, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            IconButton(onClick = {
                scope.launch {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Redirect URI", callback)))
                    copied = true
                }
            }) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = if (copied) "Copied" else "Copy redirect URI")
            }
        }
    }
    Text("Then come back and tap Try again.", style = MaterialTheme.typography.bodyMedium)
    TextButton(onClick = { runCatching { uri.openUri(MANAGED_OAUTH_DOCS) } }) { Text("Cloudflare instructions") }
}

/** Older deployments without browser sign-in. Kept out of the way of the normal path. */
@Composable
private fun ServiceTokenOption(vm: MainViewModel, url: String) {
    var open by rememberSaveable { mutableStateOf(false) }
    var clientId by rememberSaveable { mutableStateOf("") }
    // Secrets must not be copied into saved instance state.
    var secret by remember { mutableStateOf("") }
    var showSecret by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ready = clientId.isNotBlank() && secret.isNotBlank() && !busy

    fun connect() {
        if (!ready) return
        busy = true
        error = null
        scope.launch {
            vm.signIn(url, clientId, secret).onFailure { error = MainViewModel.describe(it) }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
        HorizontalDivider(Modifier.padding(top = Spacing.s))
        TextButton(onClick = { open = !open }, modifier = Modifier.fillMaxWidth()) {
            Text(if (open) "Hide service token" else "Use a service token instead")
        }
        AnimatedVisibility(
            visible = open,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                StepText("Only for dashboards that don't offer browser sign-in. Paste a Cloudflare Access service token's Client ID and Client secret. They are stored encrypted on this phone.")
                OutlinedTextField(
                    value = clientId,
                    onValueChange = { clientId = it; error = null },
                    label = { Text("Client ID") },
                    placeholder = { Text("…access") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
                )
                OutlinedTextField(
                    value = secret,
                    onValueChange = { secret = it; error = null },
                    label = { Text("Client secret") },
                    singleLine = true,
                    visualTransformation = if (showSecret) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                        autoCorrectEnabled = false,
                    ),
                    keyboardActions = KeyboardActions(onDone = { connect() }),
                    trailingIcon = {
                        IconButton(onClick = { showSecret = !showSecret }) {
                            Icon(
                                if (showSecret) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = if (showSecret) "Hide secret" else "Show secret",
                            )
                        }
                    },
                    isError = error != null,
                    supportingText = { Text(error ?: "The token is checked before anything is saved.") },
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                )
                Button(
                    onClick = ::connect,
                    enabled = ready,
                    modifier = Modifier.fillMaxWidth().heightIn(min = ButtonDefaults.MediumContainerHeight),
                    contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                ) {
                    if (busy) {
                        LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.onPrimary)
                        Spacer(Modifier.size(Spacing.s))
                    }
                    Text(if (busy) "Connecting…" else "Connect with service token", style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
                }
            }
        }
    }
}

@Composable
private fun StepText(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
