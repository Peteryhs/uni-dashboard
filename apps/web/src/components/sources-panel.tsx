/**
 * The admin & diagnostic surface.
 *
 * "When a scraper rots you see it before you notice the missing data."
 * Tracks per-source outcome, age, circuit state, and missing token URLs.
 */
import { AlertTriangle, CheckCircle2, ChevronDown, Database, KeyRound, RefreshCw, Server, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StaleDot } from '@/components/freshness';
import { useHealth, useNow } from '@/hooks/use-dashboard';
import type { SourceHealth } from '@/lib/contract';
import { ageState } from '@/lib/contract';
import { sourceCondition } from '@/lib/source-status.mjs';
import type { SourceCondition } from '@/lib/source-status.mjs';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

export function SourcesPanel({
  onRefresh,
  isFetching,
}: {
  onRefresh: () => void;
  isFetching: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The collapsed status badge still needs current telemetry; otherwise its cached green state can
  // survive long after the source crossed its freshness threshold.
  const health = useHealth(true);
  const now = useNow();

  const sources = health.data?.sources ?? [];
  const conditions = sources.map((source) => ({ source, condition: sourceCondition(source, now) }));
  const blocked = conditions.filter(({ condition }) => condition === 'blocked');
  const failing = conditions.filter(({ condition }) => condition === 'failing');
  const stale = conditions.filter(({ condition }) => condition === 'stale' || condition === 'dead');
  const partial = conditions.filter(({ condition }) => condition === 'partial');
  const unknown = conditions.filter(({ condition }) => condition === 'unknown');
  const allHealthy = sources.length > 0 && conditions.every(({ condition }) => condition === 'healthy');

  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-card transition-colors hover:border-border">
      <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5 text-left text-[11px] font-semibold tracking-[0.14em] text-zinc-400 uppercase transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded"
        >
          <Server className="size-3.5 text-cyan-400" />
          <span className="shrink-0">Relay Sources</span>

          {/* Status badges */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {health.isLoading && !health.data && (
              <Badge variant="outline" className="border-border/80 px-2 py-0 text-[10px] text-zinc-400">checking</Badge>
            )}
            {health.isError && (
              <Badge variant="outline" className="border-amber/40 bg-amber/10 px-2 py-0 text-[10px] text-amber-foreground">health unavailable</Badge>
            )}
            {!health.isLoading && !health.isError && unknown.length > 0 && (
              <Badge variant="outline" className="border-border/80 px-2 py-0 text-[10px] text-zinc-400">{unknown.length} unknown</Badge>
            )}
            {blocked.length > 0 && (
              <Badge variant="outline" className="border-amber/40 bg-amber/10 px-2 py-0 text-[10px] text-amber-foreground">
                {blocked.length} blocked
              </Badge>
            )}
            {failing.length > 0 && (
              <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 px-2 py-0 text-[10px] text-rose-400">
                {failing.length} failing
              </Badge>
            )}
            {stale.length > 0 && (
              <Badge variant="outline" className="border-amber/40 bg-amber/10 px-2 py-0 text-[10px] text-amber-foreground">
                {stale.length} stale
              </Badge>
            )}
            {partial.length > 0 && (
              <Badge variant="outline" className="border-amber/40 bg-amber/10 px-2 py-0 text-[10px] text-amber-foreground">
                {partial.length} partial
              </Badge>
            )}
            {allHealthy && !health.isError && (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 px-2 py-0 text-[10px] text-emerald-400">
                all systems nominal
              </Badge>
            )}
          </div>

          <ChevronDown
            className={cn(
              'ml-auto size-4 text-zinc-400 transition-transform duration-200',
              open && 'rotate-180 text-foreground',
            )}
          />
          <span className="settings-source-toggle-label">{open ? 'Close' : 'Open'}</span>
        </button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isFetching}
          className="h-7 gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300 hover:border-white/10 hover:bg-secondary/40 hover:text-foreground border border-transparent focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin text-live')} />
          <span>Refresh</span>
        </Button>
      </div>

      {open && (
        <div className="border-t border-border/60 bg-secondary/20 px-4 py-3.5 sm:px-5">
          {health.isLoading && (
            <p className="text-xs text-zinc-400 animate-pulse">Reading relay source telemetry…</p>
          )}

          {health.isError && (
            <div className="rounded-lg border border-amber/30 bg-amber/10 p-3 text-xs text-amber-foreground">
              Could not reach <code className="font-mono">/v1/health/sources</code>. Ensure the relay process is running.
            </div>
          )}

          {sources.length > 0 && (
            <>
              <ul className="space-y-2.5">
                {sources.map((s) => (
                  <SourceRow key={s.id} source={s} now={now} />
                ))}
              </ul>

              {health.data && (
                <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-2.5 text-xs text-zinc-400">
                  <span className="flex items-center gap-1.5">
                    <Database className="size-3 text-cyan-400" />
                    <span>{health.data.snapshots} raw snapshots in SQLite/D1 store</span>
                  </span>
                  <span>Dialect: SQLite / Cloudflare D1</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SourceRow({ source, now }: { source: SourceHealth; now: number }) {
  const run = source.last_run;
  const circuitOpen = source.job?.circuit === 'open';
  const outcome = run?.outcome ?? 'never run';
  const condition = sourceCondition(source, now);
  const age = run ? ageState(run.at, source.cadence_ms, now) : null;

  const tone = condition === 'blocked'
    ? 'text-amber-foreground'
    : condition === 'failing'
      ? 'text-rose-400'
      : condition === 'stale' || condition === 'dead' || condition === 'partial'
        ? 'text-amber-foreground'
        : 'text-zinc-400';

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon condition={condition} />
          <span className="truncate font-mono text-xs font-semibold text-foreground">
            {source.id}
          </span>
        </div>

        <span className={cn('shrink-0 text-xs tabular-nums font-medium', tone)}>
          {source.ready && run
            ? `${outcome} · ${run.rows} rows · ${shortAge(run.at, now)}${age === 'stale' || age === 'dead' ? ` · ${age === 'dead' ? 'not updating' : 'stale'}` : condition === 'partial' ? ' · partial data' : ''}`
            : outcome}
        </span>
      </div>

      {/* Actionable unblock line */}
      {!source.ready && source.env_var && (
        <div className="mt-2 rounded-lg bg-amber/10 border border-amber/20 p-2 text-xs text-amber-foreground">
          <div className="flex items-start gap-1.5">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            <div>
              <p className="font-medium">Missing credential</p>
              <p className="mt-0.5 text-zinc-300 text-xs">
                Copy URL from Portal/LEARN and set <code className="font-mono font-semibold text-amber-foreground">{source.env_var}</code> in your environment, then restart.
              </p>
            </div>
          </div>
        </div>
      )}

      {source.ready && run?.error && (
        <p className="mt-1.5 font-mono text-xs break-words text-rose-400 bg-rose-500/10 p-1.5 rounded-md border border-rose-500/20">
          {run.error}
        </p>
      )}

      {circuitOpen && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-rose-400">
          <StaleDot />
          <span>Circuit breaker open after {source.job?.failures} failures. Backing off automatically.</span>
        </p>
      )}
    </li>
  );
}

function StatusIcon({ condition }: { condition: SourceCondition }) {
  if (condition === 'blocked') return <KeyRound className="size-3.5 shrink-0 text-amber" />;
  if (condition === 'failing')
    return <XCircle className="size-3.5 shrink-0 text-rose-400" />;
  if (condition === 'healthy') return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />;
  if (condition === 'stale' || condition === 'dead') return <StaleDot />;
  return <AlertTriangle className="size-3.5 shrink-0 text-zinc-400" />;
}
