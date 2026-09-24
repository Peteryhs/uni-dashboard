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
import { useHealth } from '@/hooks/use-dashboard';
import type { SourceHealth } from '@/lib/contract';
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
  const health = useHealth(open);

  const sources = health.data?.sources ?? [];
  const blocked = sources.filter((s) => !s.ready);
  const failing = sources.filter(
    (s) => s.ready && s.last_run && !['ok', 'empty', 'skipped'].includes(s.last_run.outcome),
  );
  const healthyCount = sources.filter((s) => s.ready && s.last_run?.outcome === 'ok').length;

  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-card transition-colors hover:border-border">
      <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2.5 text-left text-[11px] font-semibold tracking-[0.14em] text-zinc-400 uppercase transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded"
        >
          <Server className="size-3.5 text-cyan-400" />
          <span>Relay Sources</span>

          {/* Status badges */}
          <div className="flex items-center gap-1.5">
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
            {blocked.length === 0 && failing.length === 0 && healthyCount > 0 && (
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
                  <SourceRow key={s.id} source={s} />
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

function SourceRow({ source }: { source: SourceHealth }) {
  const run = source.last_run;
  const circuitOpen = source.job?.circuit === 'open';
  const outcome = run?.outcome ?? 'never run';

  const tone = !source.ready
    ? 'text-amber-foreground'
    : circuitOpen || ['failed', 'implausible'].includes(outcome)
      ? 'text-rose-400'
      : 'text-zinc-400';

  return (
    <li className="rounded-lg border border-border/60 bg-secondary/30 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon ready={source.ready} outcome={outcome} circuitOpen={circuitOpen} />
          <span className="truncate font-mono text-xs font-semibold text-foreground">
            {source.id}
          </span>
        </div>

        <span className={cn('shrink-0 text-xs tabular-nums font-medium', tone)}>
          {source.ready && run ? `${outcome} · ${run.rows} rows · ${shortAge(run.at)}` : outcome}
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

function StatusIcon({
  ready,
  outcome,
  circuitOpen,
}: {
  ready: boolean;
  outcome: string;
  circuitOpen: boolean;
}) {
  if (!ready) return <KeyRound className="size-3.5 shrink-0 text-amber" />;
  if (circuitOpen || ['failed', 'implausible'].includes(outcome))
    return <XCircle className="size-3.5 shrink-0 text-rose-400" />;
  if (outcome === 'ok') return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />;
  return <AlertTriangle className="size-3.5 shrink-0 text-zinc-400" />;
}
