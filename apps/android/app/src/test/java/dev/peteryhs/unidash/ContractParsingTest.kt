package dev.peteryhs.unidash

import dev.peteryhs.unidash.data.Alert
import dev.peteryhs.unidash.data.Bundle
import dev.peteryhs.unidash.data.Calendar
import dev.peteryhs.unidash.data.CardState
import dev.peteryhs.unidash.data.ContractJson
import dev.peteryhs.unidash.data.DueSoon
import dev.peteryhs.unidash.data.Food
import dev.peteryhs.unidash.data.Health
import dev.peteryhs.unidash.data.NextCommitment
import dev.peteryhs.unidash.data.Recommendations
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

fun fixture(name: String): String =
    requireNotNull(object {}.javaClass.getResource("/fixtures/$name")) { "missing fixture $name" }.readText()

/**
 * The fixtures are real responses captured from the relay (apps/relay) serving the repo's ICS and
 * status fixtures. If the server contract changes shape, regenerate them and these tests say what broke.
 */
class ContractParsingTest {
    @Test
    fun `dashboard bundle parses and every known card payload decodes`() {
        val bundle = ContractJson.decodeFromString<Bundle>(fixture("dashboard.json"))
        assertEquals(1, bundle.schemaVersion)
        assertTrue(bundle.minClientVersion <= Bundle.CLIENT_VERSION)

        val next = bundle.card("next_commitment")!!.payload<NextCommitment>()!!
        assertEquals("MATH 115 LEC 001", next.title)
        assertNotNull(next.startsAt)
        assertEquals("ECE 150 LEC 001", next.following?.title)

        val alertCard = bundle.card("alert")!!
        val alert = alertCard.payload<Alert>()!!
        assertTrue(alert.count > 0)
        assertTrue(alert.key.isNotBlank())
        assertEquals(CardState.Live, alertCard.state)

        val due = bundle.card("due_soon")!!.payload<DueSoon>()!!
        assertTrue(due.items.isNotEmpty())
        assertTrue(due.items.all { it.key.isNotBlank() })

        val foodCard = bundle.card("food")!!
        assertNotNull(foodCard.payload<Food>())
        assertEquals(CardState.Empty, foodCard.state)
        assertNull("an empty card has no observation time", foodCard.observedAt)
    }

    @Test
    fun `food dishes carry their station, and unpinned outlets carry dishes too`() {
        val food = ContractJson.decodeFromString<Food>(
            """{"service_date":"2026-10-06","pinned":[{"outlet":"REVelation - Residence Dining Hall","pinned":true,"serving":true,
              "dish_count":2,"dishes":[{"dish":"Chili","station":"Hot Dish","diet":["vegan"],"url":""},
              {"dish":"Pasta","station":"Creation Station","diet":[],"url":""}],"hidden_dishes":0}],
              "others":[{"outlet":"Pop-up","pinned":false,"serving":true,"dish_count":1,"dishes":[{"dish":"Burger","station":"Grill"}]}],
              "others_count":1,"total_dishes":3}""",
        )
        assertEquals(listOf("Hot Dish", "Creation Station"), food.pinned.single().dishes.map { it.station })
        assertEquals("Grill", food.others.single().dishes.single().station)
    }

    @Test
    fun `an unknown card type is skipped and counted, not fatal`() {
        val json = fixture("dashboard.json").replaceFirst("\"type\": \"food\"", "\"type\": \"transit_v9\"")
        val bundle = ContractJson.decodeFromString<Bundle>(json)
        assertEquals(1, bundle.skippedCount)
        assertNull(bundle.card("food"))
    }

    @Test
    fun `a payload that does not match its schema decodes to null instead of throwing`() {
        val json = fixture("dashboard.json").replaceFirst("\"title\": \"MATH 115 LEC 001\"", "\"title\": {\"nested\": true}")
        val bundle = ContractJson.decodeFromString<Bundle>(json)
        assertNull(bundle.card("next_commitment")!!.payload<NextCommitment>())
        assertNotNull("other cards are unaffected", bundle.card("alert")!!.payload<Alert>())
    }

    @Test
    fun `recommendations, calendar and health parse`() {
        val recs = ContractJson.decodeFromString<Recommendations>(fixture("recommendations.json"))
        assertTrue(recs.items.isNotEmpty())
        assertTrue(recs.refreshAfterMs > 0)
        assertTrue(recs.items.any { it.canComplete })

        val cal = ContractJson.decodeFromString<Calendar>(fixture("calendar.json"))
        assertEquals(cal.count, cal.days.sumOf { it.events.size })
        assertTrue(cal.days.flatMap { it.events }.any { it.category == "class" })
        val scheduledClass = cal.days.flatMap { it.events }.first { it.title == "MATH 115 LEC 001" }
        assertNotNull(scheduledClass.groupScope)
        assertNotNull(scheduledClass.observedAt)

        val health = ContractJson.decodeFromString<Health>(fixture("health_sources.json"))
        assertTrue(health.sources.any { it.id == "uw-status" })
    }

    @Test
    fun `a new server field or card state never breaks parsing`() {
        val json = fixture("recommendations.json").replaceFirst("{", "{\"added_in_v2\": [1,2,3],")
        assertNotNull(ContractJson.decodeFromString<Recommendations>(json))
        val bundle = fixture("dashboard.json").replaceFirst("\"state\": \"live\"", "\"state\": \"quantum\"")
        // coerceInputValues maps an unknown enum to the field default rather than failing the bundle.
        assertNotNull(ContractJson.decodeFromString<Bundle>(bundle))
    }
}
