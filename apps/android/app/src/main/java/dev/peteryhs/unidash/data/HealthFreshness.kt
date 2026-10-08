package dev.peteryhs.unidash.data

/** Saved-data age is independent of a failed attempt or a pending retry. */
fun SourceHealth.freshnessAt(now: Long): String {
    val at = lastSuccessAt ?: lastRun?.takeIf { it.outcome in setOf("ok", "empty") }?.at ?: return "unknown"
    if (cadenceMs <= 0) return "unknown"
    val age = (now - at).coerceAtLeast(0)
    return when {
        age > (deadAfterMs ?: cadenceMs * 6) -> "dead"
        age > (staleAfterMs ?: cadenceMs * 3) -> "stale"
        age > cadenceMs -> "ageing"
        else -> "live"
    }
}

/** Re-evaluate a saved recovery deadline as time advances, without pretending a fetch ran. */
fun SourceHealth.recoveryTextAt(now: Long): String? {
    val value = recovery ?: return job?.nextDueAt?.let { "Next check ${dev.peteryhs.unidash.ui.Format.dayTime(it)}" }
    val next = value.nextAttemptAt
    val due = next != null && next <= now
    return when (value.state) {
        "inactive" -> null
        "blocked" -> "Add or repair the connection in Connections."
        "manual" -> "Automatic polling is off. Use Refresh sources to check again."
        "refreshing" -> if (job?.leaseExpiresAt?.let { it <= now } == true) {
            if (value.automatic) "The interrupted check will be retried automatically."
            else "The check ended or was interrupted. Use Refresh sources to check again."
        } else "An update is in progress."
        "backoff" -> if (due) "Retry is due and waiting for the next polling tick." else "Automatic retry ${next?.let(dev.peteryhs.unidash.ui.Format::dayTime) ?: "is scheduled"}."
        "scheduled" -> if (due) "Update is due and waiting for the next polling tick." else "Next automatic check ${next?.let(dev.peteryhs.unidash.ui.Format::dayTime) ?: "is scheduled"}."
        "due" -> "Update is due and waiting for the next polling tick."
        else -> value.reason.takeIf { it.isNotBlank() }
    }
}

/** Re-evaluates source age on-device so a long-open screen never freezes a prior all-clear. */
fun SourceHealth.conditionAt(now: Long): String {
    if (!ready) return if (optional || monitored == false) "unknown" else "blocked"
    if (job?.circuit == "open") return "failing"
    val savedJob = job
    if (!savedJob?.lastOutcome.isNullOrBlank() && savedJob?.lastFinishedAt?.let { it >= (lastRun?.at ?: Long.MIN_VALUE) } == true) {
        when (savedJob.lastOutcome) {
            "partial" -> return "partial"
            "skipped" -> return "unknown"
            "ok", "empty" -> Unit
            else -> return "failing"
        }
    }
    val run = lastRun ?: return "unknown"
    if (run.outcome == "skipped") return "unknown"
    if (run.outcome !in setOf("ok", "empty")) return "failing"
    val skipped = run.meta["skipped_events"]?.toString()?.trim('"')?.toDoubleOrNull() ?: 0.0
    if (skipped > 0) return "partial"

    val successAt = lastSuccessAt ?: run.at ?: return "unknown"
    if (cadenceMs <= 0) return "unknown"
    val age = (now - successAt).coerceAtLeast(0)
    val deadThreshold = deadAfterMs ?: cadenceMs * 6
    val staleThreshold = staleAfterMs ?: cadenceMs * 3
    if (age > deadThreshold) return "dead"
    if (age > staleThreshold) return "stale"
    return "healthy"
}

/** Counts only monitored feeds and keeps unchecked sources distinct from failures. */
fun Health.summaryAt(now: Long): HealthSummary {
    val monitored = sources.filter { it.monitored != false && !(it.optional && !it.ready) }
    val conditions = monitored.map { it.conditionAt(now) }
    val healthy = conditions.count { it == "healthy" }
    val unchecked = conditions.count { it == "unknown" }
    val issues = conditions.size - healthy - unchecked
    val condition = when {
        issues > 0 -> "attention"
        unchecked > 0 || monitored.isEmpty() -> "unknown"
        else -> "healthy"
    }
    val warning = when {
        issues > 0 -> "$issues ${if (issues == 1) "source needs" else "sources need"} attention. Your dashboard may be incomplete."
        unchecked > 0 -> "$unchecked ${if (unchecked == 1) "source has" else "sources have"} not been checked successfully."
        monitored.isEmpty() -> "Source status is unavailable."
        else -> null
    }
    return HealthSummary(condition, healthy, monitored.size, issues, unchecked, warning)
}
