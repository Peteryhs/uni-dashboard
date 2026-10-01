package dev.peteryhs.unidash.ui.setup

import android.content.Context
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.peteryhs.unidash.data.Credentials
import dev.peteryhs.unidash.ui.theme.Spacing

private const val GUIDE_PREFS = "setup_guide_v1"
fun hasSeenMobileGuide(context: Context): Boolean = context.getSharedPreferences(GUIDE_PREFS, Context.MODE_PRIVATE).getBoolean("seen", false)

/** A resumable instruction surface. No credential or URL is persisted with guide progress. */
@Composable
fun MobileSetupGuide(
    dashboardAddress: String?,
    onDismiss: () -> Unit,
    onUseAddress: ((String) -> Unit)? = null,
    onNotifications: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val prefs = remember(context) { context.getSharedPreferences(GUIDE_PREFS, Context.MODE_PRIVATE) }
    var step by rememberSaveable { mutableIntStateOf(prefs.getInt("step", 0).coerceIn(0, 3)) }
    var address by remember { mutableStateOf(dashboardAddress.orEmpty()) }
    var linkError by remember { mutableStateOf<String?>(null) }
    val origin = remember(address) { Credentials.normaliseUrl(address) }
    val uriHandler = LocalUriHandler.current
    val effects = MaterialTheme.motionScheme.defaultEffectsSpec<Float>()
    val exit = MaterialTheme.motionScheme.fastEffectsSpec<Float>()
    LaunchedEffect(step) { prefs.edit().putBoolean("seen", true).putInt("step", step).apply() }

    fun openLink(url: String) {
        try { uriHandler.openUri(url); linkError = null }
        catch (_: Exception) { linkError = "No browser could open this link. Open it in a browser on another device." }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.safeDrawingPadding().padding(Spacing.l)) {
            Surface(
                modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth().heightIn(max = maxHeight),
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
            ) {
                Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Setup guide", style = MaterialTheme.typography.titleMedium)
                        TextButton(onClick = onDismiss) { Text("Pause") }
                    }
                    LinearProgressIndicator(progress = { (step + 1) / 4f }, modifier = Modifier.fillMaxWidth())
                    Text("Step ${step + 1} of 4", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                        AnimatedContent(
                            targetState = step,
                            transitionSpec = { fadeIn(effects) togetherWith fadeOut(exit) },
                            label = "setup instruction",
                        ) { current ->
                            Column(verticalArrangement = Arrangement.spacedBy(Spacing.m), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                                Text(
                                    listOf("Set up the web dashboard", "Enable Cloudflare sign-in", "Connect this phone", "Choose your reminders")[current],
                                    style = MaterialTheme.typography.headlineSmallEmphasized,
                                    modifier = Modifier.semantics { heading() },
                                )
                                when (current) {
                                    0 -> {
                                        GuideText("Your phone reads the same dashboard as the web app. Configure feeds once in the web app’s Settings → Setup guide.")
                                        GuideText("For classes, use a Portal or Google Calendar iCal subscription. For deadlines, enable calendar feeds in LEARN, then copy its Subscribe URL. Never enter your university password into UniDash.")
                                        GuideText("Dining preferences, course details and office hours are optional. Keep checking course pages for deadlines that are not in LEARN’s calendar.")
                                    }
                                    1 -> {
                                        GuideText("The dashboard owner enables Managed OAuth and dynamic client registration in the Cloudflare Access application’s Advanced settings. It must protect the full dashboard hostname and allow its /oauth/android/callback HTTPS address.")
                                        GuideText("The web guide’s owner setup lets you request a refresh session of 1, 2, or 3 weeks. Three weeks is 504 hours. The owner must apply it in Cloudflare; selecting a duration in the guide does not extend a phone’s current sign-in.")
                                        GuideText("Access tokens renew automatically, normally every 15 minutes. Policies, revocation or an expired refresh session can require an earlier sign-in. Sign in again after the owner changes the session setting.")
                                        TextButton(onClick = { openLink("https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/") }) { Text("Cloudflare instructions") }
                                        GuideText("If you do not manage Cloudflare, ask the dashboard owner to complete this step. No Cloudflare account API token or service secret is needed on your phone for browser sign-in.")
                                    }
                                    2 -> {
                                        GuideText("Use the dashboard’s public HTTPS address below. A pasted page address is reduced to its origin. The dashboard must be reachable from this phone.")
                                        GuideText("Return to Connect your dashboard, then tap Sign in. Complete Cloudflare Access in the system browser and allow it to return to UniDash. Wait for the app to verify the connection.")
                                        GuideText("If you cancel, you can try again. If sign-in is unavailable, check the address and ask the owner to enable Managed OAuth. Advanced service tokens are only for older deployments.")
                                        if (onUseAddress == null) GuideText("This phone is already configured. Use Sign in again in Settings if Cloudflare requests a new login.")
                                    }
                                    3 -> {
                                        GuideText("After connecting, open Settings → Notifications to turn on reminders and choose channels. On supported Android versions, allow on-time reminders if offered.")
                                        GuideText("The dashboard refreshes while open and periodically in the background. Android battery settings and network availability can delay background updates.")
                                        GuideText("If sign-in expires while offline, cached information stays readable. Connect to the internet and use Sign in again in Settings to resume updates.")
                                        if (onNotifications != null) TextButton(onClick = { onNotifications(); onDismiss() }) { Text("Open notification settings") }
                                        GuideText("Reopen this walkthrough with Setup guide in Settings. Finishing the guide does not confirm that feeds or Cloudflare have been configured.")
                                    }
                                }
                            }
                        }
                        if (step < 3) {
                            OutlinedTextField(
                                value = address,
                                onValueChange = { address = it; linkError = null },
                                label = { Text("Dashboard address") },
                                placeholder = { Text("https://dash.example.com") },
                                singleLine = true,
                                isError = address.isNotBlank() && origin == null,
                                supportingText = { Text(if (address.isNotBlank() && origin == null) "Enter a valid HTTPS dashboard address." else "Your web dashboard address, not the Cloudflare admin console.") },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (step == 2 && onUseAddress != null) Button(onClick = { origin?.let { onUseAddress(it); onDismiss() } }, enabled = origin != null) { Text("Use this address") }
                            TextButton(onClick = { origin?.let { openLink("$it/?setup=mobile") } }, enabled = origin != null) { Text("Open web setup guide") }
                        }
                        linkError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { step-- }, enabled = step > 0) { Text("Back") }
                        Button(onClick = { if (step < 3) { step++; linkError = null } else onDismiss() }) { Text(if (step < 3) "Continue" else "Finish guide") }
                    }
                }
            }
        }
    }
}

@Composable
private fun GuideText(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
