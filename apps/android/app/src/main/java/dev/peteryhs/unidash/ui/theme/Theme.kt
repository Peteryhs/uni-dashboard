package dev.peteryhs.unidash.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * The one colour the wallpaper never picks. The dashboard's rule is that amber means stale and
 * nothing else; dynamic colour can produce a warm palette, so staleness is a fixed amber and is
 * always paired with an icon and words, never colour alone.
 */
@Immutable
data class StaleColors(val container: Color, val onContainer: Color, val accent: Color)

private val StaleLight = StaleColors(container = Color(0xFFFFE08A), onContainer = Color(0xFF3D2E00), accent = Color(0xFF7A5900))
private val StaleDark = StaleColors(container = Color(0xFF5A4300), onContainer = Color(0xFFFFE08A), accent = Color(0xFFF5C33B))

val LocalStaleColors = staticCompositionLocalOf { StaleLight }

/** Fallback before Android 12: the web client's cool cyan, as a Material scheme. */
private val CyanLight = lightColorScheme(
    primary = Color(0xFF006876), onPrimary = Color.White,
    primaryContainer = Color(0xFFA1EFFF), onPrimaryContainer = Color(0xFF001F25),
    secondary = Color(0xFF4A6268), secondaryContainer = Color(0xFFCDE7ED), onSecondaryContainer = Color(0xFF051F23),
    tertiary = Color(0xFF545D7E), tertiaryContainer = Color(0xFFDBE1FF), onTertiaryContainer = Color(0xFF101A37),
    surface = Color(0xFFF5FAFC), onSurface = Color(0xFF171D1E),
)
private val CyanDark = darkColorScheme(
    primary = Color(0xFF83D2E3), onPrimary = Color(0xFF00363E),
    primaryContainer = Color(0xFF004E59), onPrimaryContainer = Color(0xFFA1EFFF),
    secondary = Color(0xFFB1CBD1), secondaryContainer = Color(0xFF334A50), onSecondaryContainer = Color(0xFFCDE7ED),
    tertiary = Color(0xFFBCC5EB), tertiaryContainer = Color(0xFF3C4665), onTertiaryContainer = Color(0xFFDBE1FF),
    surface = Color(0xFF0E1415), onSurface = Color(0xFFDEE3E5),
)

/** The 8dp spacing grid. */
object Spacing {
    val xs = 4.dp
    val s = 8.dp
    val m = 16.dp
    val l = 24.dp
    val xl = 32.dp
}

@Composable
fun UniDashTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> CyanDark
        else -> CyanLight
    }
    CompositionLocalProvider(LocalStaleColors provides if (dark) StaleDark else StaleLight) {
        MaterialExpressiveTheme(colorScheme = scheme, motionScheme = MotionScheme.expressive(), content = content)
    }
}
