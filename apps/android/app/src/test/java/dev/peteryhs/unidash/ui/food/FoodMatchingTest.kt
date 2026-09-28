package dev.peteryhs.unidash.ui.food

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FoodMatchingTest {
    @Test fun `ranked outlet names match menu variants without matching one shared word`() {
        assertTrue(diningNameMatches("Village 1", "Village 1 - Residence Dining Hall"))
        assertTrue(diningNameMatches("Brubakers Food Court", "Brubaker's Food Court"))
        assertFalse(diningNameMatches("Village 1", "Village 2 - Residence Dining Hall"))
        assertFalse(diningNameMatches("Campus", "Campus Pizza"))
    }
}
