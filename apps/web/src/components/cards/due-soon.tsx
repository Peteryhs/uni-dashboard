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

export function DueSoonCard({
  card,
  now,
  selectedKey = null,
  onSelectTask,
}: {
  card: CardT<DueSoonData>;
  now: number;
  /** key of the task whose detail panel is open, so the row can show it is the selected one */
  selectedKey?: string | null;
  onSelectTask?: (item: DueSoonData['courses'][number]['items'][number], course: string) => void;
}) {
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

  if (card.state === 'failed') {
    return (
      <CardShell
        title="Upcoming Deadlines"
        icon={<ClipboardList className="size-3.5" />}
        state="failed"
        observedAt={card.observed_at}
        sourceId={card.source_id || undefined}
        now={now}
        showFreshness={false}
      >
        <div className="py-2">
          <p className="text-[15px] font-semibold text-rose-400">
            Unable to fetch deadlines
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {d.error || 'Failed to sync with Waterloo LEARN feed. Deadlines could not be loaded.'}
          </p>
        </div>
      </CardShell>
    );
  }

  if (card.state === 'degraded') {
    return (
      <CardShell
        title="Upcoming Deadlines"
        icon={<ClipboardList className="size-3.5" />}
        state="degraded"
        observedAt={card.observed_at}
        sourceId={card.source_id || undefined}
        now={now}
        showFreshness={false}
      >
        <div className="py-2">
          <p className="text-[15px] font-medium text-amber-300">
            LEARN feed not configured
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Add your Waterloo LEARN ICS link in Settings to see upcoming assignments.
          </p>
        </div>
      </CardShell>
    );
  }

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

  const isCompact = preferences.density === 'compact';
  /**
   * One chronological list, not a list per course.
   *
   * A grouped card answered "what does this course want" when the question is "what is next". The
   * flat list comes from the server already sorted; older bundles without it are flattened here so a
   * stale cache still renders.
   */
  const timeline = (d.items?.length
    ? d.items
    : activeCourses.flatMap((g) => g.items.map((i) => ({ ...i, course: i.course ?? g.course })))
  )
    .filter((i) => i.starts_at >= now)
    .sort((a, b) => a.starts_at - b.starts_at);

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
                'py-0 font-medium tracking-wide',
                isCompact ? 'px-1.5 text-[9px]' : 'px-2 text-[10px]',
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
            className={cn(
              'border-white/10 bg-secondary/30 py-0 font-semibold tracking-wide text-foreground/90',
              isCompact ? 'px-1.5 text-[9px]' : 'px-2 text-[10px]',
            )}
          >
            {totalActiveCount} in {d.window_days}d
          </Badge>
        </div>
      }
    >
      {isCompact ? (
        /* Reduced info density: Just the immediate 3 nearest upcoming deadlines */
        <div className="space-y-2">
          <ul className="space-y-1.5">
            {timeline.slice(0, 3).map((item) => (
              <DueItem
                key={taskKey(item)}
                item={item}
                now={now}
                muted={muted}
                compact={true}
                course={item.course}
                selected={selectedKey === taskKey(item)}
                onSelect={onSelectTask}
              />
            ))}
          </ul>
          {timeline.length > 3 && (
            <p className="pt-1 text-[11px] text-zinc-400">
              +{timeline.length - 3} more later this week · <span className="text-zinc-300">Detailed view has full breakdown</span>
            </p>
          )}
        </div>
      ) : (
        /* Detailed view: one chronological list, soonest first */
        <ul className="space-y-1">
          {timeline.map((item) => (
            <DueItem
              key={taskKey(item)}
              item={item}
              now={now}
              muted={muted}
              course={item.course}
              selected={selectedKey === taskKey(item)}
              onSelect={onSelectTask}
            />
          ))}
        </ul>
      )}
    </CardShell>
  );
}

/** One key per task, used by the row and by the detail panel so they cannot disagree. */
export function taskKey(item: DueSoonData['courses'][number]['items'][number]) {
  return `${item.title}@${item.starts_at}`;
}

function DueItem({
  item,
  now,
  muted,
  compact,
  course,
  selected,
  onSelect,
}: {
  item: DueSoonData['courses'][number]['items'][number];
  now: number;
  muted: string;
  compact?: boolean;
  course?: string;
  selected?: boolean;
  onSelect?: (item: DueSoonData['courses'][number]['items'][number], course: string) => void;
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
  const courseTone = course ? getCourseTone(course) : null;
  const hasDetail = Boolean(item.description || (item.links?.length ?? 0) > 0);
  const clickable = Boolean(onSelect);

  const row = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {urgent && <AlertCircle className="size-3.5 shrink-0 text-amber" />}
        {course && (
          <span
            className={cn(
              'rounded-md border px-1.5 py-0.2 font-mono text-[10px] font-semibold shrink-0',
              courseTone?.badge ?? 'border-white/10 bg-secondary/30 text-zinc-300',
            )}
          >
            {course}
          </span>
        )}
        <span
          className={cn(
            'truncate text-xs',
            urgent ? 'font-medium text-foreground' : 'text-zinc-200',
            muted,
          )}
        >
          {cleanTitle}
        </span>
        {/* a hint that this task has somewhere to go, without stealing the row's click */}
        {hasDetail && (
          <ExternalLink className="size-2.5 shrink-0 text-zinc-500" aria-hidden="true" />
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
    </>
  );

  const shared = cn(
    'group flex w-full items-center justify-between gap-2.5 text-left transition-colors',
    compact ? 'py-0.5 px-1.5 rounded' : 'py-1 px-2 rounded-lg',
    urgent && 'bg-amber/5 border border-amber/20',
    clickable && 'hover:bg-secondary/40 cursor-pointer',
    selected && 'bg-secondary/60 ring-1 ring-live/40',
  );

  return (
    <li>
      {clickable ? (
        <button
          type="button"
          onClick={() => onSelect?.(item, course ?? '')}
          aria-expanded={selected}
          aria-label={`Show detail for ${cleanTitle}`}
          className={cn(shared, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live')}
        >
          {row}
        </button>
      ) : (
        <div className={shared}>{row}</div>
      )}
    </li>
  );
}
