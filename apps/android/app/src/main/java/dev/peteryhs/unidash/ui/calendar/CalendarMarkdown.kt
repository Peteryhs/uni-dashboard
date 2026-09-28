package dev.peteryhs.unidash.ui.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.peteryhs.unidash.ui.theme.Spacing

internal enum class MarkdownKind { Paragraph, Heading, ListItem, Quote }
internal data class MarkdownBlock(val kind: MarkdownKind, val text: String, val marker: String = "")

/** Calendar feeds commonly contain Markdown headings, lists, emphasis, and links. */
internal fun parseCalendarMarkdown(source: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) {
            blocks += MarkdownBlock(MarkdownKind.Paragraph, paragraph.joinToString(" "))
            paragraph.clear()
        }
    }
    for (raw in source.replace("\r\n", "\n").split('\n')) {
        val line = raw.trim()
        if (line.isEmpty()) { flush(); continue }
        val heading = Regex("^#{1,3}\\s+(.+)$").matchEntire(line)
        val bullet = Regex("^[-*+]\\s+(.+)$").matchEntire(line)
        val numbered = Regex("^(\\d+)[.)]\\s+(.+)$").matchEntire(line)
        when {
            heading != null -> { flush(); blocks += MarkdownBlock(MarkdownKind.Heading, heading.groupValues[1]) }
            bullet != null -> { flush(); blocks += MarkdownBlock(MarkdownKind.ListItem, bullet.groupValues[1], "•") }
            numbered != null -> { flush(); blocks += MarkdownBlock(MarkdownKind.ListItem, numbered.groupValues[2], numbered.groupValues[1]) }
            line.startsWith(">") -> { flush(); blocks += MarkdownBlock(MarkdownKind.Quote, line.removePrefix(">").trim()) }
            else -> paragraph += line
        }
    }
    flush()
    return blocks
}

private val inlinePattern = Regex("""\[([^]]+)]\((https?://[^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_""")

/** Build styled text without interpreting raw HTML or allowing non-web link schemes. */
internal fun calendarMarkdownInline(source: String, linkColor: Color): AnnotatedString = buildAnnotatedString {
    var offset = 0
    for (match in inlinePattern.findAll(source)) {
        append(source.substring(offset, match.range.first))
        val group = match.groupValues
        when {
            group[1].isNotEmpty() -> withLink(LinkAnnotation.Url(group[2])) {
                withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(group[1]) }
            }
            group[3].isNotEmpty() || group[4].isNotEmpty() ->
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(group[3].ifEmpty { group[4] }) }
            group[5].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(group[5]) }
            else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(group[6].ifEmpty { group[7] }) }
        }
        offset = match.range.last + 1
    }
    append(source.substring(offset))
}

@Composable
internal fun CalendarMarkdown(description: String) {
    val blocks = remember(description) { parseCalendarMarkdown(description) }
    val scheme = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        blocks.forEach { block ->
            val text = calendarMarkdownInline(block.text,
                if (block.kind == MarkdownKind.Quote) scheme.onTertiaryContainer else scheme.primary)
            when (block.kind) {
                MarkdownKind.Heading -> Text(text, style = MaterialTheme.typography.titleMediumEmphasized)
                MarkdownKind.Paragraph -> Text(text, style = MaterialTheme.typography.bodyMedium)
                MarkdownKind.Quote -> Surface(color = scheme.tertiaryContainer, contentColor = scheme.onTertiaryContainer,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                    Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(Spacing.m))
                }
                MarkdownKind.ListItem -> Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Surface(color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer,
                        shape = CircleShape, modifier = Modifier.widthIn(min = 28.dp)) {
                        Text(block.marker, style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(horizontal = Spacing.s, vertical = Spacing.xs))
                    }
                    Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
