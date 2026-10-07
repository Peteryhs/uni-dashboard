package dev.peteryhs.unidash.ui.food

import dev.peteryhs.unidash.data.Dish
import org.junit.Assert.assertEquals
import org.junit.Test

class StationsTest {
    @Test fun `real UW station names map to the same kinds as the web client`() {
        assertEquals(StationKind.Stove, stationKind("Hot Dish"))
        assertEquals(StationKind.Stove, stationKind("Mom's Counter"))
        assertEquals(StationKind.Grill, stationKind("The Carvery"))
        assertEquals(StationKind.Grill, stationKind("BBQ Stand"))
        assertEquals(StationKind.Build, stationKind("Creation Station"))
        assertEquals(StationKind.Other, stationKind("Station 57"))
    }

    @Test fun `groups keep page order for stations and dishes`() {
        val dishes = listOf(Dish("A", "Hot Dish"), Dish("B", "Carvery"), Dish("C", "Hot Dish"))
        assertEquals(listOf("Hot Dish" to listOf("A", "C"), "Carvery" to listOf("B")),
            stationGroups(dishes).map { (station, list) -> station to list.map { it.dish } })
    }

    @Test fun `made-without tags read as free-from`() {
        assertEquals("GF" to "Gluten-free", dietTag("gluten"))
        assertEquals("DF" to "Dairy-free", dietTag("dairy"))
    }
}
