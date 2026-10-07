package dev.peteryhs.unidash.ui.today

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import dev.peteryhs.unidash.data.RecommendationDecision
import dev.peteryhs.unidash.data.RecommendationDiagnostics
import dev.peteryhs.unidash.data.Snapshot
import dev.peteryhs.unidash.ui.ChangeBlocks
import dev.peteryhs.unidash.ui.EmptyNote
import dev.peteryhs.unidash.ui.Format
import dev.peteryhs.unidash.ui.ScreenScaffold
import dev.peteryhs.unidash.ui.SectionHeader
import dev.peteryhs.unidash.ui.theme.Spacing
import kotlin.math.roundToInt

@Composable
fun RecommendationExplanationScreen(
    diagnostics: RecommendationDiagnostics?,
    warnings: List<String>,
    snapshot: Snapshot,
    now: Long,
    snackbar: SnackbarHostState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onStatus: (() -> Unit)? = null,
) {
    BackHandler(onBack = onBack)
    ScreenScaffold(
        title = "How suggestions are chosen",
        subtitle = null,
        snapshot = snapshot,
        now = now,
        snackbar = snackbar,
        onRefresh = onRefresh,
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to today")
            }
        },
        onStatus = onStatus,
    ) {
        item {
            Text(
                "See why suggestions were shown, deferred, or suppressed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
            )
        }
        if (warnings.isNotEmpty()) {
            item {
                var warningsExpanded by rememberSaveable { mutableStateOf(false) }
                ListItem(
                    headlineContent = { Text("Warnings · ${warnings.size}") },
                    supportingContent = {
                        if (warningsExpanded) {
                            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                                warnings.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                            }
                        } else Text("Inputs that affected this check")
                    },
                    trailingContent = {
                        TextButton(
                            onClick = { warningsExpanded = !warningsExpanded },
                            modifier = Modifier.semantics {
                                contentDescription = if (warningsExpanded) "Hide recommendation warnings" else "Show recommendation warnings"
                            },
                        ) {
                            Text(if (warningsExpanded) "Hide" else "Details")
                        }
                    },
                    modifier = Modifier.animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
                )
            }
        }
        if (diagnostics == null) {
            item {
                EmptyNote("Detailed decision data is not available in this response. Suggestions remain usable; a newer server response may include the explanation.")
            }
            rankingDisclosure()
            return@ScreenScaffold
        }

        item {
            ListItem(
                headlineContent = { Text("This check") },
                supportingContent = {
                    Text("${diagnostics.summary.shown} shown · ${diagnostics.summary.deferred} deferred · ${diagnostics.summary.suppressed} suppressed")
                },
            )
        }

        item {
            var rulesExpanded by rememberSaveable { mutableStateOf(false) }
            ListItem(
                headlineContent = { Text("Timing rules") },
                supportingContent = {
                    if (rulesExpanded) {
                        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            PolicyDetail("Room, time and cancellation", "${diagnostics.policy.scheduleNoticeHours} hours before the affected time")
                            PolicyDetail("Deadline changes", "${diagnostics.policy.deadlineChangeHours} hours before the affected time")
                            PolicyDetail("Tutorial work", "${diagnostics.policy.tutorialWorkNoticeHours} hours before the session")
                            PolicyDetail("Larger work", "Within ${diagnostics.policy.taskHorizonDays} days of its due date")
                            PolicyDetail("Smaller work", "Enters suggestions ${diagnostics.policy.smallTaskFeedDays} days before it is due")
                            PolicyDetail("Daily feed", "Up to ${diagnostics.policy.maxFeedItems} suggestions")
                        }
                    } else Text("When changes and work can enter suggestions")
                },
                trailingContent = {
                    TextButton(
                        onClick = { rulesExpanded = !rulesExpanded },
                        modifier = Modifier.semantics {
                            contentDescription = if (rulesExpanded) "Hide timing rule details" else "Show timing rule details"
                        },
                    ) {
                        Text(if (rulesExpanded) "Hide" else "Details")
                    }
                },
                modifier = Modifier.animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
            )
        }

        rankingDisclosure()
        item { SectionHeader("Candidate decisions · ${diagnostics.candidates.size}") }
        if (diagnostics.candidates.isEmpty()) item { EmptyNote("No candidates were returned for this check.") }
        diagnostics.candidates.forEach { candidate ->
            item(key = "candidate:${candidate.id}") { CandidateDecisionRow(candidate, diagnostics, now) }
        }
        item {
            Text(
                "Deferred items remain in their calendar or source list. Completing, dismissing, or snoozing a suggestion changes the guidance saved for this account.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.l),
            )
        }
    }
}

private fun LazyListScope.rankingDisclosure() {
    item {
        var rankingExpanded by rememberSaveable { mutableStateOf(false) }
        ListItem(
            headlineContent = { Text("Ranking") },
            supportingContent = {
                if (rankingExpanded) {
                    Text(
                        "Urgency and item type set priority. Within 70 priority points, each earlier suggestion from the same course applies a 35-point course-balance adjustment. Priorities of 900 or higher are unchanged. These points rank suggestions; they do not measure your performance.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else Text("Urgency, item type and course balance")
            },
            trailingContent = {
                TextButton(
                    onClick = { rankingExpanded = !rankingExpanded },
                    modifier = Modifier.semantics {
                        contentDescription = if (rankingExpanded) "Hide ranking details" else "Show ranking details"
                    },
                ) {
                    Text(if (rankingExpanded) "Hide" else "Details")
                }
            },
            modifier = Modifier.animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
        )
    }
}

@Composable
private fun PolicyDetail(label: String, value: String) {
    Text("$label · $value", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun CandidateDecisionRow(candidate: RecommendationDecision, diagnostics: RecommendationDiagnostics, now: Long) {
    var detailsExpanded by rememberSaveable(candidate.id) { mutableStateOf(false) }
    val (status, tone) = when (candidate.status) {
        "shown" -> "In today’s feed" to MaterialTheme.colorScheme.primary
        "suppressed" -> "Suppressed" to MaterialTheme.colorScheme.onSurfaceVariant
        else -> "Deferred" to MaterialTheme.colorScheme.tertiary
    }
    val timing = candidate.dueAt?.let { "Due ${Format.dayTime(it)}" }
        ?: candidate.startsAt?.let { "Starts ${Format.dayTime(it)}" }
        ?: candidate.scheduledDate?.let {
            if (candidate.kind == "task") "Due ${Format.dayHeader(it)} · time not supplied"
            else "Scheduled ${Format.dayHeader(it)}"
        }
    val placement = candidate.position?.let {
        if (it > diagnostics.policy.maxFeedItems) "Pre-cap rank $it · beyond the daily limit"
        else "Pre-cap rank $it · limit ${diagnostics.policy.maxFeedItems}"
    } ?: "No current feed rank"
    val rankDetails = buildString {
        append("Priority ${candidate.priority.roundToInt()}")
        if (candidate.coursePenalty > 0) append(" · course balance −${candidate.coursePenalty.roundToInt()}")
        candidate.rankingScore?.let { append(" · adjusted rank ${it.roundToInt()}") }
        append(" · ").append(placement)
    }

    ListItem(
        overlineContent = { Text(status, color = tone, fontWeight = FontWeight.Medium) },
        headlineContent = { Text(candidate.title) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                val context = listOfNotNull(candidate.course?.takeIf { it.isNotBlank() }, timing).joinToString(" · ")
                if (context.isNotBlank()) Text(context, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(candidate.reason, style = MaterialTheme.typography.bodyMedium)
                if (detailsExpanded) {
                    candidate.eligibleAt?.let { Text("Eligible ${Format.dayTime(it)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Text(rankDetails, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    candidate.change?.let { ChangeBlocks(it) }
                }
            }
        },
        trailingContent = {
            TextButton(
                onClick = { detailsExpanded = !detailsExpanded },
                modifier = Modifier.semantics {
                    contentDescription = if (detailsExpanded) "Hide details for ${candidate.title}" else "Show details for ${candidate.title}"
                },
            ) {
                Text(if (detailsExpanded) "Hide" else "Details")
            }
        },
        modifier = Modifier.animateContentSize(MaterialTheme.motionScheme.defaultSpatialSpec()),
    )
}
