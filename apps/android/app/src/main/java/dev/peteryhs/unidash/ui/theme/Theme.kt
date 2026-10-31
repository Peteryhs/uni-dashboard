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
    // Product fallback palette: keep every tonal surface in the same cool neutral family.
    surfaceBright = Color(0xFFF5FAFC), surfaceDim = Color(0xFFD5DBDE),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFEEF4F6),
    surfaceContainer = Color(0xFFE8EEF0), surfaceContainerHigh = Color(0xFFE2E8EA),
    surfaceContainerHighest = Color(0xFFDCE2E4), onSurfaceVariant = Color(0xFF3F484B),
    outline = Color(0xFF6F797C), outlineVariant = Color(0xFFBEC8CB),
)
private val CyanDark = darkColorScheme(
    primary = Color(0xFF83D2E3), onPrimary = Color(0xFF00363E),
    primaryContainer = Color(0xFF004E59), onPrimaryContainer = Color(0xFFA1EFFF),
    secondary = Color(0xFFB1CBD1), secondaryContainer = Color(0xFF334A50), onSecondaryContainer = Color(0xFFCDE7ED),
    tertiary = Color(0xFFBCC5EB), tertiaryContainer = Color(0xFF3C4665), onTertiaryContainer = Color(0xFFDBE1FF),
    surface = Color(0xFF0E1415), onSurface = Color(0xFFDEE3E5),
    onSecondary = Color(0xFF1C343A), onTertiary = Color(0xFF27304E),
    surfaceBright = Color(0xFF343B3D), surfaceDim = Color(0xFF0E1415),
    surfaceContainerLowest = Color(0xFF090F10), surfaceContainerLow = Color(0xFF171D1E),
    surfaceContainer = Color(0xFF1B2123), surfaceContainerHigh = Color(0xFF252B2D),
    surfaceContainerHighest = Color(0xFF303638), onSurfaceVariant = Color(0xFFBEC9CC),
    outline = Color(0xFF889396), outlineVariant = Color(0xFF3F494C),
)

/**
 * The 4dp/8dp spacing grid. Screens use [gutter] for their outer edge and [inset] inside a
 * container, so every list, card and header shares the same two left edges.
 */
object Spacing {
    val xs = 4.dp
    val s = 8.dp
    val ms = 12.dp
    val m = 16.dp
    val l = 24.dp
    val xl = 32.dp

    /** Horizontal edge of every screen's content. */
    val gutter = m
    /** Horizontal padding inside list rows and cards. */
    val inset = m
    /** Vertical padding inside dense list rows. */
    val rowVertical = ms
    /** Padding inside the one emphasized panel per screen. */
    val heroInset = l
    /** Gap between rows of one connected group; the joins read as one list. */
    val joined = 2.dp
    /** Gap between separate items, such as a hero panel and the list that follows. */
    val itemGap = s
    /** Space after the last list item, so it clears the navigation bar or gesture area. */
    val listEnd = xl
}

/**
 * Corner radii. One emphasized panel per screen uses [hero]; connected groups use [group] on
 * their outer corners and [join] where rows meet, widening to [joinOpen] when a row is expanded.
 */
object Corners {
    val hero = 28.dp
    val group = 20.dp
    val join = 4.dp
    val joinOpen = 8.dp
    val tile = 12.dp
}

/** Layout limits shared by the app's screens. */
object Layout {
    /** A readable column on tablets and landscape; body text stays under ~80 characters. */
    val contentMaxWidth = 680.dp
    /** Width at which navigation moves from a bottom bar to a side rail. */
    val railBreakpoint = 600.dp
    /** Below this window height, large headers collapse to a compact bar (landscape phones). */
    val compactHeaderHeight = 480.dp
    /** Minimum touch target for every interactive element. */
    val touchTarget = 48.dp
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
