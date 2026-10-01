package dev.peteryhs.unidash.ui.setup

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.ui.BrowserAuthState
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * First-run connection surface. Managed Cloudflare Access OAuth is the short path; the service
 * token fields remain available for deployments that have not enabled browser sign-in.
 */
@Composable
fun SetupScreen(
    vm: MainViewModel,
    browser: BrowserAuthState,
    onBrowserSignIn: (String) -> Unit,
) {
    val context = LocalContext.current
    var guideOpen by rememberSaveable { mutableStateOf(!hasSeenMobileGuide(context)) }
    var url by rememberSaveable { mutableStateOf("") }
    var clientId by rememberSaveable { mutableStateOf("") }
    // Secrets and transient work must not be copied into saved instance state. A recreated screen
    // starts idle and the view model remains the authority for a browser transaction.
    var secret by remember { mutableStateOf("") }
    var showSecret by rememberSaveable { mutableStateOf(false) }
    var advanced by rememberSaveable { mutableStateOf(false) }
    var serviceBusy by remember { mutableStateOf(false) }
    var serviceError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val hasAddress = url.isNotBlank()
    val normalizedAddress = remember(url) { Credentials.normaliseUrl(url) }
    val browserReady = normalizedAddress != null && !browser.busy
    val serviceReady = hasAddress && clientId.isNotBlank() && secret.isNotBlank() && !serviceBusy

    fun connectWithServiceToken() {
        if (!serviceReady) return
        serviceBusy = true
        serviceError = null
        scope.launch {
            vm.signIn(url, clientId, secret).onFailure { serviceError = MainViewModel.describe(it) }
            serviceBusy = false
        }
    }

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
                    size = 88.dp,
                    shape = MaterialShapes.Cookie12Sided,
                )
                Text("Connect your dashboard", style = MaterialTheme.typography.displaySmallEmphasized)
                Text(
                    "Enter your dashboard address, then sign in through Cloudflare Access in your browser.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { guideOpen = true }) { Text("Setup guide") }
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        serviceError = null
                    },
                    label = { Text("Dashboard address") },
                    placeholder = { Text("dash.example.com") },
                    leadingIcon = { Icon(Icons.Outlined.Language, contentDescription = null) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done,
                        autoCorrectEnabled = false,
                    ),
                    keyboardActions = KeyboardActions(onDone = { if (normalizedAddress != null && !browser.busy) onBrowserSignIn(url) }),
                    isError = hasAddress && normalizedAddress == null,
                    supportingText = {
                        when {
                            browser.busy -> Text("Opening secure sign-in…")
                            browser.error != null -> Text(browser.error!!)
                            hasAddress && normalizedAddress == null -> Text("Enter a valid HTTPS address.")
                            else -> Text("Use the HTTPS address for the dashboard you were given.")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { onBrowserSignIn(url) },
                    enabled = browserReady,
                    modifier = Modifier.fillMaxWidth().height(ButtonDefaults.MediumContainerHeight),
                    contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                ) {
                    if (browser.busy) {
                        LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Icon(Icons.Outlined.Lock, contentDescription = null)
                        Spacer(Modifier.size(Spacing.s))
                        Text("Sign in", style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
                    }
                }
                if (browser.error != null && !browser.busy) {
                    Text(
                        "Check the address and try again. If your dashboard administrator has not enabled managed sign-in, use Advanced below.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                HorizontalDivider(Modifier.padding(vertical = Spacing.s))
                TextButton(onClick = { advanced = !advanced }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (advanced) "Hide Advanced" else "Advanced: use a service token")
                }
                AnimatedVisibility(
                    visible = advanced,
                    enter = expandVertically() + fadeIn(),
                    exit = shrinkVertically() + fadeOut(),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                        Text(
                            "For deployments without browser sign-in, enter a Cloudflare Access service token. It is stored encrypted on this phone.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = clientId,
                            onValueChange = { clientId = it },
                            label = { Text("Client ID") },
                            placeholder = { Text("…access") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
                        )
                        OutlinedTextField(
                            value = secret,
                            onValueChange = { secret = it },
                            label = { Text("Client secret") },
                            singleLine = true,
                            visualTransformation = if (showSecret) VisualTransformation.None else PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Password,
                                imeAction = ImeAction.Done,
                                autoCorrectEnabled = false,
                            ),
                            keyboardActions = KeyboardActions(onDone = { connectWithServiceToken() }),
                            trailingIcon = {
                                IconButton(onClick = { showSecret = !showSecret }) {
                                    Icon(
                                        if (showSecret) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                        contentDescription = if (showSecret) "Hide secret" else "Show secret",
                                    )
                                }
                            },
                            isError = serviceError != null,
                            supportingText = { Text(serviceError ?: "The token is checked before anything is saved.") },
                            modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                        )
                        Button(
                            onClick = ::connectWithServiceToken,
                            enabled = serviceReady,
                            modifier = Modifier.fillMaxWidth().height(ButtonDefaults.MediumContainerHeight),
                            contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                        ) {
                            if (serviceBusy) LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.onPrimary)
                            else Text("Connect with service token", style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
                        }
                    }
                }
            }
        }
    }
    if (guideOpen) MobileSetupGuide(dashboardAddress = url, onDismiss = { guideOpen = false }, onUseAddress = { url = it })
}
