package dev.peteryhs.unidash.ui.setup

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
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.ui.MainViewModel
import dev.peteryhs.unidash.ui.ShapedIcon
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * One-time connection: the Worker address and the Access service token. The token is checked
 * against the Worker before anything is saved, so a typo fails here and not at 3 a.m.
 */
@Composable
fun SetupScreen(vm: MainViewModel) {
    var url by rememberSaveable { mutableStateOf("") }
    var clientId by rememberSaveable { mutableStateOf("") }
    // The secret is deliberately not rememberSaveable: it should not land in saved instance state.
    var secret by androidx.compose.runtime.remember { mutableStateOf("") }
    var showSecret by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ready = url.isNotBlank() && clientId.isNotBlank() && secret.isNotBlank() && !busy

    fun connect() {
        if (!ready) return
        busy = true
        error = null
        scope.launch {
            vm.signIn(url, clientId, secret).onFailure { error = MainViewModel.describe(it) }
            busy = false
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.l, vertical = Spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 480.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                ShapedIcon(
                    Icons.Outlined.Dashboard,
                    container = MaterialTheme.colorScheme.primaryContainer,
                    content = MaterialTheme.colorScheme.onPrimaryContainer,
                    size = 88.dp,
                    shape = MaterialShapes.Cookie12Sided,
                )
                Text("Connect your dashboard", style = MaterialTheme.typography.displaySmallEmphasized)
                Text(
                    "Use a Cloudflare Access service token for this phone. Create one in Zero Trust with a " +
                        "non-expiring duration, and add a Service Auth policy for it to the dashboard's Access app.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(Spacing.s))
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Dashboard address") },
                    placeholder = { Text("dash.example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
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
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
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
                    supportingText = { Text(error ?: "Stored encrypted on this phone only.") },
                    modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
                )
                Button(
                    onClick = ::connect,
                    enabled = ready,
                    modifier = Modifier.fillMaxWidth().height(ButtonDefaults.MediumContainerHeight),
                    contentPadding = ButtonDefaults.contentPaddingFor(ButtonDefaults.MediumContainerHeight),
                ) {
                    if (busy) LoadingIndicator(Modifier.size(24.dp), color = MaterialTheme.colorScheme.onPrimary)
                    else Text("Connect", style = ButtonDefaults.textStyleFor(ButtonDefaults.MediumContainerHeight))
                }
            }
        }
    }
}
