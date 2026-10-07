# Service status

Settings → Status is the monitoring destination on web and Android. Connections manages calendar feeds and credentials; About contains app information. A dashboard warning links directly to Status when sources need attention or their status cannot be checked. Recommendation-specific context and parsing warnings remain available in the advanced recommendation explanation view.

Both relay targets return the same `GET /v1/health/sources` policy. The response includes human-readable source names, the latest attempt, `last_success_at`, data age, retry state, a source condition, a monitored-source summary, and runtime details. Weather participates through its saved forecast and latest attempt. Reading status does not fetch upstream feeds; the web Status page has a separate Refresh sources action, while Android Status refresh reads monitoring independently of the dashboard feeds.

Configured sources without a successful check are unknown. Successful empty feeds are healthy. Partial parses and failed or implausible attempts need attention. Freshness follows successful data, so a recent failed attempt never makes old data look new. Default source thresholds use the shared age ladder; weather follows its forecast cache thresholds of stale after 60 minutes and dead after 180 minutes. Clients age status locally between checks, and failed checks visibly label cached telemetry as last known information.

An unused optional feed or alternative schedule connection is excluded from totals. Two entries using the same Google Calendar subscription count as one monitored source. Each visible row still explains whether its connection is in use.

Runtime information describes the backend that answered, rather than inferring deployment from the browser hostname. Local relays expose process uptime and whether polling is automatic or manual. Cloudflare Workers expose scheduled polling and current isolate age. Isolate age is not an availability or uptime percentage. Historical service availability is not measured by this endpoint.

Regression tests cover failed attempts preserving successful-data age, configured but unchecked sources, valid empty feeds, alternative and shared connections, cached weather failures, local status ageing, D1 receipt parity, and Worker runtime reporting.
