/**
 * Card 1: the next thing that requires the owner to move.
 *
 * Reading order: what, where, how long until, and when to leave.
 * Walk time is folded into leave-by rather than shown as trivia.
 */
import { CalendarClock, CloudRain, Footprints, MapPin, Wind, Clock, Compass, ExternalLink } from 'lucide-react';
import { CardShell, EmptyState } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { mutedIfStale } from '@/components/freshness';
import { useChanged } from '@/hooks/use-dashboard';
import { usePreferences } from '@/lib/preferences-store';
import type { Card as CardT, NextCommitmentData } from '@/lib/contract';
import { countdown, dayOffset, formatTime, formatWeekdayTime } from '@/lib/time';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  class: 'Class',
  exam: 'Exam',
  deadline: 'Deadline',
  event: 'Event',
};

export function NextCommitmentCard({
  card,
  now,
}: {
  card: CardT<NextCommitmentData>;
  now: number;
}) {
  const d = card.data;
  const changed = useChanged([d.title, d.starts_at, d.location]);
  const muted = mutedIfStale(card.state);
  const { preferences } = usePreferences();

  if (card.state === 'empty' || !d.starts_at) {
    return (
      <CardShell
        title="Next Commitment"
        icon={<CalendarClock className="size-3.5" />}
        state={card.state}
        observedAt={card.observed_at}
        sourceId={card.source_id || undefined}
        now={now}
        showFreshness={card.observed_at != null}
      >
        <EmptyState hint="Nothing ahead in the timetable or the deadline feed.">
          {d.title || 'Nothing scheduled'}
        </EmptyState>
      </CardShell>
    );
  }

  const offset = dayOffset(d.starts_at, now);
  const dayWord = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : null;
  const whenLine = dayWord
    ? `${dayWord} ${formatTime(d.starts_at)}`
    : formatWeekdayTime(d.starts_at);

  const leaveNow = d.leave_by != null && d.leave_by - now <= 0;
  const leaveSoon = d.leave_by != null && !leaveNow && d.leave_by - now <= 10 * 60_000;
  const minutesUntilLeave = d.leave_by != null ? Math.round((d.leave_by - now) / 60_000) : null;

  return (
    <CardShell
      title="Next Commitment"
      icon={<CalendarClock className="size-3.5" />}
      state={card.state}
      observedAt={card.observed_at}
      sourceId={card.source_id || undefined}
      now={now}
      action={
        d.kind ? (
          <Badge
            variant="outline"
            className="border-white/10 bg-secondary/30 text-[10px] tracking-wider uppercase font-semibold text-foreground/80"
          >
            {KIND_LABEL[d.kind] ?? d.kind}
          </Badge>
        ) : undefined
      }
    >
      <div className={cn('space-y-3', changed && 'value-changed')}>
        {/* Main Title & Subtitle */}
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className={cn('text-xl font-bold tracking-tight text-foreground sm:text-2xl', muted)}>
              {d.title}
            </h3>
            <span className="shrink-0 rounded-md bg-secondary/50 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-foreground border border-border/60">
              {countdown(d.starts_at, now)}
            </span>
          </div>

          {d.subtitle && <p className="mt-0.5 text-xs text-zinc-400">{d.subtitle}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400">
            <span className={cn('flex items-center gap-1 font-medium text-foreground', muted)}>
              <Clock className="size-3.5 text-live" />
              {whenLine}
            </span>

            {d.location && (
              <>
                <span className="text-zinc-600" aria-hidden>
                  ·
                </span>
                <span className="inline-flex items-center gap-1 rounded-md bg-secondary/40 px-2 py-0.5 font-medium text-foreground border border-border/60">
                  <MapPin className="size-3 text-cyan-400" />
                  {d.location}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Actionable Leave-by Bar */}
        {d.leave_by != null && (
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-2.5 sm:px-3.5 transition-colors',
              leaveNow
                ? 'border-amber/60 bg-amber/15 text-amber-foreground'
                : leaveSoon
                  ? 'border-live/60 bg-live/15 text-foreground'
                  : 'border-border/80 bg-secondary/30 text-foreground hover:border-border',
            )}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={cn(
                  'flex size-7 items-center justify-center rounded-md shrink-0',
                  leaveNow
                    ? 'bg-amber/20 text-amber'
                    : leaveSoon
                      ? 'bg-live/20 text-live'
                      : 'bg-secondary/50 text-zinc-400',
                )}
              >
                <Footprints className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold leading-none">
                  {leaveNow
                    ? 'Leave immediately'
                    : `Leave by ${formatTime(d.leave_by)}`}
                </p>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-400 leading-none">
                  {minutesUntilLeave !== null && !leaveNow && (
                    <span>in {minutesUntilLeave} min{minutesUntilLeave === 1 ? '' : 's'}</span>
                  )}
                  {d.from_source && (
                    <>
                      <span>·</span>
                      <span>From {d.from_source}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {d.walk_minutes != null && d.walk_minutes > 0 && (
              d.nav_url ? (
                <a
                  href={d.nav_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open walking directions in Google Maps (${d.from_source || 'Waterloo Campus'})`}
                  className="group inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-200 bg-card hover:bg-secondary/70 hover:text-foreground px-2.5 py-1.5 rounded-md border border-border/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live shrink-0"
                >
                  <Compass className="size-3.5 text-cyan-400 group-hover:rotate-45 transition-transform" />
                  <span>{d.walk_minutes} min walk</span>
                  <ExternalLink className="size-3 text-zinc-400 opacity-60 group-hover:opacity-100 group-hover:text-cyan-400 transition-opacity" />
                </a>
              ) : (
                <div className="flex items-center gap-1 text-[11px] font-medium text-zinc-300 bg-card px-2 py-1 rounded-md border border-border/60 shrink-0">
                  <Compass className="size-3 text-cyan-400" />
                  <span>{d.walk_minutes} min walk</span>
                </div>
              )
            )}
          </div>
        )}

        {/* Advisory Weather line */}
        {preferences.density === 'detailed' && d.weather && !d.weather.error && d.weather.temp_c != null && (
          <WeatherPill weather={d.weather} />
        )}
      </div>
    </CardShell>
  );
}

function WeatherPill({ weather }: { weather: NonNullable<NextCommitmentData['weather']> }) {
  const notable = weather.show === true;
  const temp = Math.round(weather.temp_c as number);
  const feels = weather.feels_c != null ? Math.round(weather.feels_c) : null;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-xs transition-colors',
        notable
          ? 'border-amber/30 bg-amber/10 text-amber-foreground'
          : 'border-border/60 bg-secondary/30 text-zinc-300',
      )}
    >
      <span className="font-semibold text-foreground">
        {temp}&deg;C
        {feels != null && feels !== temp && (
          <span className="font-normal text-zinc-400"> (feels {feels}&deg;)</span>
        )}
      </span>

      {weather.precip_prob != null && weather.precip_prob > 0 && (
        <span className="inline-flex items-center gap-1 text-cyan-300">
          <CloudRain className="size-3.5" />
          {Math.round(weather.precip_prob)}% precip
        </span>
      )}

      {weather.wind_kmh != null && weather.wind_kmh >= 20 && (
        <span className="inline-flex items-center gap-1 text-zinc-400">
          <Wind className="size-3.5" />
          {Math.round(weather.wind_kmh)} km/h wind
        </span>
      )}

      {notable && weather.reason && (
        <span className="font-medium text-amber-foreground">· {weather.reason}</span>
      )}
    </div>
  );
}
