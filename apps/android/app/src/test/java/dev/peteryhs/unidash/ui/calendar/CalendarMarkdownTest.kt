package dev.peteryhs.unidash.ui.calendar

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarMarkdownTest {
    @Test fun `calendar description separates markdown blocks without dropping text`() {
        val blocks = parseCalendarMarkdown("# Lab notes\nBring **laptop**.\n\n- Read [guide](https://example.org/guide)\n2. Submit work\n> Room may change")
        assertEquals(listOf(MarkdownKind.Heading, MarkdownKind.Paragraph, MarkdownKind.ListItem,
            MarkdownKind.ListItem, MarkdownKind.Quote), blocks.map { it.kind })
        assertEquals(listOf("", "", "•", "2", ""), blocks.map { it.marker })
        assertEquals("Read [guide](https://example.org/guide)", blocks[2].text)
    }

    @Test fun `inline markdown styles text and keeps unsafe schemes as plain text`() {
        val styled = calendarMarkdownInline("**Important** and [read more](https://example.org) and [unsafe](javascript:alert(1))", Color.Blue)
        assertTrue(styled.text.contains("Important and read more"))
        assertTrue(styled.text.contains("[unsafe](javascript:alert(1))"))
    }
}
