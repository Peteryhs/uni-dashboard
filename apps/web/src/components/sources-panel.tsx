import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useHealth, useNow } from '@/hooks/use-dashboard';
import { healthSummary, sourceCondition } from '@/lib/source-status.mjs';
import type { SourceCondition } from '@/lib/source-status.mjs';
import type { SourceHealth } from '@/lib/contract';
import { triggerPoll } from '@/lib/api';
import { shortAge } from '@/lib/time';
import { RefreshButton } from '@/components/ui/refresh-button';
import './sources-panel.css';

const LABELS: Record<SourceCondition, string> = {
  healthy: 'Up to date',
  stale: 'Stale',
  dead: 'Not updating',
  failing: 'Update failed',
  blocked: 'Needs connection',
  unknown: 'Not checked',
  partial: 'Partial data',
};

const NAMES: Record<string, string> = {
  'uw-food-daily-menu': 'Dining menu',
  'uw-portal-ics': 'Portal schedule',
  'google-calendar-ics': 'Google Calendar',
  'uw-learn-ics': 'LEARN deadlines',
  'uw-status': 'Campus services',
  'user-office-hours': 'Office hours',
  'open-meteo': 'Weather',
};

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.max(0, Math.floor(seconds))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function durationMs(milliseconds: number): string {
  return duration(Math.round(milliseconds / 1000));
}

function sourceName(source: SourceHealth): string {
  return source.name || NAMES[source.id] || source.id;
}

function isMonitored(source: SourceHealth): boolean {
  return source.monitored !== false && !(source.optional && !source.ready);
}

function lastSuccess(source: SourceHealth): number | null {
  if (source.last_success_at != null) return source.last_success_at;
  return ['ok', 'empty'].includes(source.last_run?.outcome ?? '') ? source.last_run?.at ?? null : null;
}

function rowLabel(source: SourceHealth, monitored: boolean, condition: SourceCondition): string {
  if (monitored) return LABELS[condition];
  if (source.ready) return source.role === 'schedule' ? 'Shared schedule' : 'Shared connection';
  return source.optional ? 'Optional · not in use' : 'Unused alternative';
}

function rowAge(source: SourceHealth, monitored: boolean, successAt: number | null, now: number): string {
  if (successAt != null) return `Last success ${shortAge(successAt, now)} ago${monitored ? '' : ' · not monitored'}`;
  if (monitored) return 'Last success not recorded';
  return source.ready ? 'Shared · not monitored' : 'Not monitored';
}

function outcomeLabel(outcome: string): string {
  return outcome === 'ok' ? 'succeeded' : outcome === 'empty' ? 'completed with no items'
    : outcome === 'skipped' ? 'was skipped' : 'failed';
}

function nextAttempt(source: SourceHealth): string | null {
  if (!source.job) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(source.job.next_due_at);
}

function detailsLabel(condition: SourceCondition): string {
  if (condition === 'blocked') return 'Connection details';
  if (condition === 'failing') return 'Failure details';
  if (condition === 'stale' || condition === 'dead') return 'Freshness details';
  if (condition === 'partial') return 'Data details';
  return 'Check details';
}

export function SourcesPanel({ onManageConnections }: { onManageConnections?: () => void }) {
  const health = useHealth(true);
  const queryClient = useQueryClient();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState('');

  const refreshSources = async () => {
    setRefreshing(true);
    setRefreshResult('');
    try {
      const result = await triggerPoll();
      await Promise.all(['health', 'dashboard', 'recommendations', 'full-calendar', 'posted-menu', 'setup-status'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
      const failures = result.receipts.filter(receipt => !['ok', 'empty', 'skipped'].includes(receipt.outcome));
      const failureCount = failures.length + (result.weather?.status === 'failed' ? 1 : 0);
      const waiting = new Set([...(result.deferred ?? []), ...result.receipts.filter(receipt => receipt.outcome === 'skipped').map(receipt => receipt.source_id)]).size + (result.weather?.status === 'deferred' ? 1 : 0);
      setRefreshResult(failureCount
        ? `${failureCount} ${failureCount === 1 ? 'source did' : 'sources did'} not update. Open a row’s details for the reason.`
        : waiting ? `Refresh requested. ${waiting} ${waiting === 1 ? 'source is' : 'sources are'} waiting for a safe retry.`
          : result.receipts.length || (result.weather?.status === 'ready' && !result.weather.cached) ? 'Source refresh finished.' : 'No updates are due. See the next check time below.');
    } catch {
      setRefreshResult('Could not refresh sources. Check the backend connection and try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const sources = health.data?.sources ?? [];
  const summary = healthSummary(sources, now);
  const runtime = health.data?.runtime;
  const inactiveCount = sources.filter(source => !isMonitored(source)).length;
  const title = health.isError ? 'Status unavailable'
    : !health.data ? 'Checking status…'
      : summary.condition === 'healthy' ? 'Your sources are up to date'
        : summary.condition === 'attention' ? 'Some sources need attention' : 'Some sources have not been checked';
  const subtitle = health.isError
    ? health.data
      ? `Last known status · ${summary.healthy} of ${summary.total} monitored sources up to date · checked ${shortAge(health.data.now, now)} ago. The latest check failed.`
      : 'The backend could not be reached. Saved information may still be available.'
    : health.data
      ? `${summary.healthy} of ${summary.total} monitored sources up to date · checked ${shortAge(health.data.now, now)} ago`
      : 'Reading the latest saved update results.';

  return <section className="service-status" aria-label="Service status">
    <div className="service-status-heading">
      <div>
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </div>
      <RefreshButton label="Refresh sources" refreshing={refreshing} onRefresh={() => void refreshSources()} />
    </div>

    {refreshResult && <p className="service-status-result" role="status">{refreshResult}</p>}
    {health.isError && !health.data && <RefreshButton label="Check backend again" refreshing={health.isFetching} onRefresh={() => void health.refetch()} showLabel />}

    {sources.length > 0 && <>
      <ul className="service-status-list">
        {sources.map(source => <SourceRow key={source.id} source={source} now={now} onManageConnections={onManageConnections} />)}
      </ul>
      {inactiveCount > 0 && <p className="service-status-note">Shared and unused feeds are listed here but excluded from the monitored total.</p>}
      <p className="service-status-note">Ageing means an expected update is due. Stale means more than three update intervals without success; not updating means more than six. Weather uses its own freshness window. Saved data stays available during recovery.</p>
    </>}

    {health.data && <>
      <dl className="service-status-runtime" aria-label="Relay runtime">
        <div><dt>Backend</dt><dd>{health.isError ? 'Unreachable' : 'Reachable'}{runtime ? ` · ${runtime.target === 'cloudflare' ? 'Cloudflare Worker' : 'Local relay'}` : ''}</dd></div>
        {runtime && <div><dt>{runtime.uptime_scope === 'isolate' ? 'Current instance age' : 'Process uptime'}</dt><dd>{duration(runtime.uptime_s)}</dd></div>}
        {runtime && <div><dt>Updates</dt><dd>{runtime.polling === 'scheduled' ? 'Scheduled automatically' : runtime.polling === 'automatic' ? 'Automatic polling' : 'Manual refresh'}</dd></div>}
      </dl>
      {runtime?.uptime_scope === 'isolate' && <p className="service-status-note">Worker instances restart independently. Instance age does not measure service availability.</p>}
      <details className="service-status-technical">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Endpoint</dt><dd>{window.location.host}</dd></div>
          <div><dt>Saved source snapshots</dt><dd>{health.data.snapshots.toLocaleString()}</dd></div>
          <div><dt>Campus timezone</dt><dd>America/Toronto</dd></div>
        </dl>
      </details>
    </>}
  </section>;
}

function SourceRow({ source, now, onManageConnections }: { source: SourceHealth; now: number; onManageConnections?: () => void }) {
  const monitored = isMonitored(source);
  const condition = sourceCondition(source, now);
  const successAt = lastSuccess(source);
  const status = rowLabel(source, monitored, condition);
  const age = rowAge(source, monitored, successAt, now);
  const dataAge = successAt == null ? null : now - successAt;
  const freshnessNote = dataAge == null ? '' : dataAge > (source.dead_after_ms ?? 6 * source.cadence_ms) ? ' · saved data out of date'
    : dataAge > (source.stale_after_ms ?? 3 * source.cadence_ms) ? ' · saved data stale'
      : dataAge > source.cadence_ms ? ' · expected update due' : '';
  const statusKey = monitored ? condition : source.ready ? 'shared' : 'unused';
  const staleAfter = source.stale_after_ms ?? 3 * source.cadence_ms;
  const deadAfter = source.dead_after_ms ?? 6 * source.cadence_ms;
  const skippedEvents = Number(source.last_run?.meta?.skipped_events ?? 0);
  const jobFinished = source.job?.last_finished_at;
  const interrupted = ['failed', 'implausible'].includes(source.job?.last_outcome ?? '') && jobFinished != null && (!source.last_run || jobFinished > source.last_run.at || (jobFinished === source.last_run.at && ['ok', 'empty'].includes(source.last_run.outcome)));
  const detailNeeded = monitored && condition !== 'healthy';
  const summaryLabel = `${sourceName(source)}. ${status}. ${age}.${detailNeeded ? ` ${detailsLabel(condition)}.` : ''}`;
  const summaryContent = <>
    <strong className="service-source-name">{sourceName(source)}</strong>
    <span className={`service-source-state is-${statusKey}`}>{status}</span>
    <span className="service-source-age">{age}{freshnessNote}</span>
    <span className="service-source-detail-hint" aria-hidden="true">{detailNeeded ? 'Details' : ''}</span>
  </>;

  return <li className="service-source">
    {detailNeeded ? <details className="service-source-details">
      <summary className="service-source-summary" aria-label={summaryLabel}>{summaryContent}</summary>
      <div className="service-source-detail-copy">
        {source.recovery && <>
          <p>{source.recovery.reason}</p>
          {source.recovery.next_attempt_at != null && <p>{source.recovery.next_attempt_at <= now ? 'Recovery check due' : 'Next recovery check'}: {new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' }).format(source.recovery.next_attempt_at)}.</p>}
        </>}
        {condition === 'blocked' && <>
          <p>{source.env_var ? `Connection required: ${source.env_var}.` : 'A required connection is missing.'}</p>
          {onManageConnections && <button type="button" className="service-status-open-connections" onClick={onManageConnections}>Open Connections</button>}
        </>}
        {(condition === 'stale' || condition === 'dead') && <p>Expected every {durationMs(source.cadence_ms)}. Marked stale after {durationMs(staleAfter)} and not updating after {durationMs(deadAfter)} without a successful update.</p>}
        {condition === 'partial' && <p>{skippedEvents > 0 ? `${skippedEvents} calendar ${skippedEvents === 1 ? 'entry was' : 'entries were'} skipped while reading the feed.` : 'Some calendar events could not be read.'}</p>}
        {condition === 'unknown' && !source.last_run && <p>No successful check is available yet.</p>}
        {interrupted && <p>Latest update was interrupted before its receipt could be saved. Saved data has been retained.</p>}
        {source.last_run && <p>{interrupted ? 'Last saved attempt' : 'Last attempt'} {shortAge(source.last_run.at, now)} ago · {outcomeLabel(source.last_run.outcome)}{source.last_run.http_status != null ? ` · HTTP ${source.last_run.http_status}` : ''}</p>}
        {source.last_run?.error && <p className="service-source-error">{source.last_run.error}</p>}
        {source.job?.circuit === 'open' && <p>Automatic retries are backing off after {source.job.failures} consecutive failures.</p>}
        {source.job && !source.recovery && <p>{source.job.next_due_at < now ? 'Retry due since' : 'Next retry due'}: {nextAttempt(source)}.</p>}
      </div>
    </details> : <div className="service-source-summary">{summaryContent}</div>}
  </li>;
}
