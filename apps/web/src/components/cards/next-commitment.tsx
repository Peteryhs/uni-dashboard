/**
 * Card 1: the next thing that requires the owner to move.
 *
 * Reading order: what, where, how long until.
 *
 * There is no leave-by bar: the walk table behind it was never measured, and the owner commutes by
 * bus, so a "leave by" time was a number nobody acted on. What, where and when is the whole card.
 */
import { CalendarClock, CloudRain, MapPin, Wind, Clock } from 'lucide-react';
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
