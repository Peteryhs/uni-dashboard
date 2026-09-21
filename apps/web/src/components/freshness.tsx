/**
 * The age ladder, rendered.
 *
 * From BUILD_SPEC, and this is the whole honesty mechanism, so it is implemented literally:
 *
 *   within 1x cadence : full accent hairline, full foreground numbers
 *   1x to 3x          : hairline fades to 30 percent
 *   beyond 3x         : numbers muted, hairline amber and dashed, all motion stops
 *   beyond 6x         : muted numbers plus an amber dot
 *
 * The descriptor comes from packages/contract, so these four rungs cannot drift from the server or
 * from the Android client.
 */
import { ageDescriptor, type AgeDescriptor, type CardState } from '@/lib/contract';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

export function descriptorFor(state: CardState): AgeDescriptor {
  return ageDescriptor(state);
}

/** Plain-language state, because "ageing" on its own tells a reader nothing actionable. */
export function stateLabel(state: CardState, observedAt: number | null, now: number): string {
  const age = observedAt != null ? shortAge(observedAt, now) : null;
  switch (state) {
    case 'live':
      return age ? `live · ${age} old` : 'live';
    case 'ageing':
      return age ? `${age} old` : 'ageing';
    case 'stale':
      return age ? `stale · ${age} old` : 'stale';
    case 'dead':
      return age ? `not updating · ${age} old` : 'not updating';
    case 'empty':
      return 'nothing to show';
    case 'degraded':
      return 'partial data';
    case 'failed':
      return 'source failed';
    default:
      return state;
  }
}

/**
 * The hairline across the top of a card. Colour and dash carry the age; motion carries liveness.
 * A stale card is visibly different from across the room, which is the requirement.
 */
export function AgeHairline({
  state,
  className,
}: {
  state: CardState;
  className?: string;
}) {
  const d = descriptorFor(state);
  if (d.hairline === 'none') {
    return <div className={cn('h-px w-full bg-border/40', className)} aria-hidden />;
  }

  const tone =
    d.hairline === 'accent'
      ? 'bg-live'
      : d.hairline === 'faded'
        ? 'bg-live/30'
        : 'bg-amber';

  if (d.dash) {
    // Dashed via a repeating gradient so it stays a 1px rule rather than a border box.
    return (
      <div
        aria-hidden
        className={cn('h-px w-full', className)}
        style={{
          backgroundImage:
            'repeating-linear-gradient(to right, var(--amber) 0 6px, transparent 6px 12px)',
        }}
      />
    );
  }

  return <div aria-hidden className={cn('h-px w-full', tone, d.motion && 'hairline-live', className)} />;
}

/** The amber dot for a dead source or a tripped circuit breaker. */
export function StaleDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full bg-amber', className)}
      aria-hidden
    />
  );
}

/**
 * The freshness line at the foot of a card. Always rendered when there is an envelope, because a
 * number with no age beside it is the thing this project exists to avoid.
 */
export function FreshnessLine({
  state,
  observedAt,
  now,
  sourceId,
  className,
}: {
  state: CardState;
  observedAt: number | null;
  now: number;
  sourceId?: string;
  className?: string;
}) {
  const d = descriptorFor(state);
  const label = stateLabel(state, observedAt, now);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-xs tracking-wide',
        d.hairline === 'amber' ? 'text-amber-foreground' : 'text-zinc-400',
        className,
      )}
    >
      {d.dot && <StaleDot />}
      {state === 'live' && (
        <span
          className={cn(
            'inline-block size-1.5 shrink-0 rounded-full bg-live',
            d.motion && 'hairline-live',
          )}
          aria-hidden
        />
      )}
      <span>{label}</span>
      {sourceId && (
        <>
          <span className="text-border" aria-hidden>
            ·
          </span>
          <span className="font-mono text-xs text-zinc-400">{sourceId}</span>
        </>
      )}
    </div>
  );
}

/** Numbers go muted past 3x cadence. Cards pass this to whatever holds their primary values. */
export function mutedIfStale(state: CardState): string {
  return descriptorFor(state).muted ? 'text-muted-foreground' : 'text-foreground';
}
