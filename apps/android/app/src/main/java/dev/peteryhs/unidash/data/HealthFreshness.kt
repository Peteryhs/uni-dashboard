package dev.peteryhs.unidash.data

/** Re-evaluates source age on-device so a long-open screen never freezes a prior all-clear. */
fun SourceHealth.conditionAt(now: Long): String {
    if (!ready) return if (optional || monitored == false) "unknown" else "blocked"
    if (job?.circuit == "open") return "failing"
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
