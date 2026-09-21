/**
 * Card 2: what is due.
 *
 * "Count plus nearest, seven day window, grouped by course. Never a wall of text."
 * Refined with course tags, urgency highlighting for <24h items, and scannable visual hierarchy.
 */
import { ClipboardList, ExternalLink, AlertCircle } from 'lucide-react';
import { CardShell, EmptyState } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { mutedIfStale } from '@/components/freshness';
import { usePreferences } from '@/lib/preferences-store';
import type { Card as CardT, DueSoonData } from '@/lib/contract';
import { countdown, dayOffset, formatShortDay, formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';

// Color map for known course prefixes or courses
const COURSE_TONES: Record<string, { badge: string; text: string }> = {
  ECE: { badge: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300', text: 'text-cyan-300' },
  MATH: { badge: 'border-amber-500/30 bg-amber-500/10 text-amber-300', text: 'text-amber-300' },
  CS: { badge: 'border-purple-500/30 bg-purple-500/10 text-purple-300', text: 'text-purple-300' },
  SE: { badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', text: 'text-emerald-300' },
  STAT: { badge: 'border-rose-500/30 bg-rose-500/10 text-rose-300', text: 'text-rose-300' },
};

function getCourseTone(course: string) {
  const prefix = course.split(/[\s\d]/)[0]?.toUpperCase() ?? '';
  return COURSE_TONES[prefix] ?? {
    badge: 'border-white/10 bg-secondary/30 text-foreground/80',
    text: 'text-foreground/80',
  };
}

export function DueSoonCard({ card, now }: { card: CardT<DueSoonData>; now: number }) {
  const d = card.data;
  const muted = mutedIfStale(card.state);
  const { preferences } = usePreferences();

  // Filter out any expired/past items (defense-in-depth against clock skew or cached bundles)
  const activeCourses = d.courses
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.starts_at >= now),
    }))
    .filter((group) => group.items.length > 0);

  const futureItems = activeCourses.flatMap((g) => g.items);
  const totalActiveCount = activeCourses.reduce((sum, g) => sum + g.items.length, 0);
  const nextItemAt = futureItems.length
    ? Math.min(...futureItems.map((i) => i.starts_at))
    : (d.nearest_at != null && d.nearest_at >= now ? d.nearest_at : null);

  if (activeCourses.length === 0) {
    return (
      <CardShell
        title="Upcoming Deadlines"
        icon={<ClipboardList className="size-3.5" />}
        state={card.state}
        observedAt={card.observed_at}
        sourceId={card.source_id || undefined}
        now={now}
        showFreshness={card.observed_at != null}
      >
        <EmptyState hint={`Nothing due in the next ${d.window_days} days.`}>
          Nothing due
        </EmptyState>
      </CardShell>
    );
  }

  const nearestUrgent = nextItemAt != null && nextItemAt - now <= 24 * 60 * 60_000;

  return (
    <CardShell
      title="Upcoming Deadlines"
      icon={<ClipboardList className="size-3.5" />}
      state={card.state}
      observedAt={card.observed_at}
      sourceId={card.source_id || undefined}
      now={now}
      action={
        <div className="flex items-center gap-1.5">
          {nextItemAt != null && (
            <Badge
              variant="outline"
              className={cn(
                'px-2 py-0 text-[10px] font-medium tracking-wide',
                nearestUrgent
                  ? 'border-amber/50 bg-amber/15 text-amber-foreground'
                  : 'border-white/10 bg-secondary/30 text-muted-foreground',
              )}
            >
              Nearest: {countdown(nextItemAt, now)}
            </Badge>
          )}
          <Badge
            variant="outline"
            className="border-white/10 bg-secondary/30 px-2 py-0 text-[10px] font-semibold tracking-wide text-foreground/90"
          >
            {totalActiveCount} in {d.window_days}d
          </Badge>
        </div>
      }
    >
      <div className="space-y-3">
        {activeCourses.map((group) => {
          const tone = getCourseTone(group.course);
          return (
            <div
              key={group.course}
              className="rounded-lg border border-border/70 bg-card/60 p-3 transition-colors hover:border-border"
            >
              {/* Course Group Header */}
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-md border px-2 py-0.5 font-mono text-xs font-semibold tracking-tight',
                      tone.badge,
                    )}
                  >
                    {group.course}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {group.count} item{group.count === 1 ? '' : 's'}
                  </span>
                </div>

                {group.count > group.items.length && (
                  <span className="text-xs text-zinc-400">
                    Showing {group.items.length}
                  </span>
                )}
              </div>

              {/* Course Items */}
              <ul className={preferences.density === 'compact' ? 'space-y-1' : 'space-y-1.5'}>
                {group.items.map((item) => (
                  <DueItem
                    key={`${item.title}-${item.starts_at}`}
                    item={item}
                    now={now}
                    muted={muted}
                    compact={preferences.density === 'compact'}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

function DueItem({
  item,
  now,
  muted,
  compact,
}: {
  item: DueSoonData['courses'][number]['items'][number];
  now: number;
  muted: string;
  compact?: boolean;
}) {
  const offset = dayOffset(item.starts_at, now);
  const when =
    offset === 0
      ? `Today ${formatTime(item.starts_at)}`
      : offset === 1
        ? `Tomorrow ${formatTime(item.starts_at)}`
        : formatShortDay(item.starts_at);

  const urgent = item.starts_at - now <= 24 * 60 * 60_000;
  const overdue = item.starts_at - now <= 0;

  // Strip redundant course prefix
  const cleanTitle = item.title.replace(/^[A-Z]{2,6}\s?\d{2,3}[A-Z]?\s*[-–]\s*/, '');

  return (
    <li
      className={cn(
        'group flex items-center justify-between gap-3 rounded-lg px-2 transition-colors hover:bg-secondary/40',
        compact ? 'py-0.5' : 'py-1',
        urgent && 'bg-amber/5 border border-amber/20',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {urgent && (
          <AlertCircle className="size-3.5 shrink-0 text-amber" />
        )}
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group/link flex min-w-0 items-baseline gap-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded"
          >
            <span
              className={cn(
                'truncate text-xs transition-colors group-hover/link:text-live-foreground',
                urgent ? 'font-medium text-foreground' : 'text-zinc-200',
                muted,
              )}
            >
              {cleanTitle}
            </span>
            <ExternalLink className="size-2.5 shrink-0 self-center text-zinc-400 opacity-60 transition-opacity group-hover/link:opacity-100" />
          </a>
        ) : (
          <span
            className={cn(
              'truncate text-xs',
              urgent ? 'font-medium text-foreground' : 'text-zinc-200',
              muted,
            )}
          >
            {cleanTitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            'text-right text-xs font-medium tabular-nums whitespace-nowrap',
            overdue
              ? 'text-rose-400 font-semibold'
              : urgent
                ? 'text-amber-foreground font-semibold'
                : 'text-zinc-400',
          )}
        >
          {when}
        </span>
      </div>
    </li>
  );
}
