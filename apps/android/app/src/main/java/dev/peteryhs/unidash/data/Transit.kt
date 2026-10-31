package dev.peteryhs.unidash.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class TransitCommute(
    val id: String = "",
    val name: String = "",
    val origin: String = "",
    val destination: String = "",
    val route: String = "",
    @SerialName("origin_name") val originName: String = "",
    @SerialName("destination_name") val destinationName: String = "",
    @SerialName("walk_to_minutes") val walkToMinutes: Int = 5,
    @SerialName("walk_from_minutes") val walkFromMinutes: Int = 5,
    @SerialName("arrival_buffer_minutes") val arrivalBufferMinutes: Int = 10,
)
@Serializable
data class TransitStop(val id: String, val name: String, val code: String, val mode: String, val routes: List<String> = emptyList(), val hint: String? = null)
@Serializable
data class TransitStopList(val stops: List<TransitStop> = emptyList())
@Serializable
data class TransitCommuteList(val commutes: List<TransitCommute> = emptyList())
@Serializable
data class TransitDeparture(
    val id: String,
    val route: String,
    val headsign: String,
    @SerialName("scheduled_departure") val scheduledDeparture: Long,
    @SerialName("scheduled_arrival") val scheduledArrival: Long,
    @SerialName("predicted_departure") val predictedDeparture: Long? = null,
    @SerialName("predicted_arrival") val predictedArrival: Long? = null,
    @SerialName("prediction_at") val predictionAt: Long? = null,
    val cancelled: Boolean = false,
) {
    fun isLive(now: Long, offline: Boolean = false): Boolean = !offline && predictionAt != null && now >= predictionAt && now - predictionAt <= 90_000
    fun departureAt(now: Long, offline: Boolean = false): Long = predictedDeparture?.takeIf { isLive(now, offline) } ?: scheduledDeparture
    fun arrivalAt(now: Long, offline: Boolean = false): Long = predictedArrival?.takeIf { isLive(now, offline) } ?: scheduledArrival
}
@Serializable
data class TransitJourney(
    @SerialName("commute_id") val commuteId: String,
    val departures: List<TransitDeparture> = emptyList(),
    val alerts: List<String> = emptyList(),
    @SerialName("schedule_valid") val scheduleValid: Boolean = false,
)
@Serializable
data class TransitTarget(val id: String, val title: String, @SerialName("starts_at") val startsAt: Long, val location: String)
@Serializable
data class TransitActivation(@SerialName("commute_id") val commuteId: String, @SerialName("event_id") val eventId: String, val date: String)
@Serializable
data class TransitGuidance(
    @SerialName("commute_id") val commuteId: String,
    @SerialName("event_title") val eventTitle: String,
    @SerialName("leave_at") val leaveAt: Long? = null,
    val departure: TransitDeparture? = null,
    val basis: String,
    val message: String,
    @SerialName("expires_at") val expiresAt: Long,
)
@Serializable
data class TransitView(
    @SerialName("generated_at") val generatedAt: Long,
    val status: String,
    val error: String? = null,
    @SerialName("updated_at") val updatedAt: Long? = null,
    val commutes: List<TransitCommute> = emptyList(),
    val journeys: List<TransitJourney> = emptyList(),
    val activation: TransitActivation? = null,
    val target: TransitTarget? = null,
    val guidance: TransitGuidance? = null,
)
