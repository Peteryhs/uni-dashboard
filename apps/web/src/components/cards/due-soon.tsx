/**
 * Card 2: what is due & what opens.
 *
 * Overhauled with Unified Calendar, Inline Description & Color Coding:
 * - Distinct color codes for courses (ECE 105, 150, 190, 198, MATH 117, COMMST, CFE).
 * - Due items render with "proper colours"; Opens items render in "the faded colour".
 * - Combined into ONE chronological calendar timeline grouped by day.
 * - In detailed view mode (and all views), task descriptions open INLINE right beneath the item.
 * - If there is no description, nothing is displayed (no empty boxes, no expanders).
 * - Descriptions are limited to 20 words; if longer, omits the rest and expands on click (ANTISLOP).
 * - Single-click "X" dismiss in both detailed and compact modes (no two-step menu).
 * - Floating Undo toast notification for recovery.
 * - Non-nested, accessible buttons and clean typography.
 */
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList,
  ExternalLink,
  AlertCircle,
  X,
  RotateCcw,
  ChevronRight,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  FileUp,
  GraduationCap,
  MapPin,
  MessageSquare,
} from 'lucide-react';
import { CardShell, EmptyState } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { mutedIfStale } from '@/components/freshness';
import { usePreferences } from '@/lib/preferences-store';
import type { Card as CardT, DueSoonData, DueSoonItem } from '@/lib/contract';
import { countdown, dayOffset, formatShortDay, formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';

// Color map for known courses and course prefixes
export const COURSE_TONES: Record<string, { badge: string; text: string; dot: string }> = {
  // Course specific
  'ECE 105': {
    badge: 'border-sky-500/40 bg-sky-500/15 text-sky-300 shadow-sm shadow-sky-950/40',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
  },
  'ECE 150': {
    badge: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 shadow-sm shadow-emerald-950/40',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
  },
  'ECE 190': {
    badge: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300 shadow-sm shadow-indigo-950/40',
    text: 'text-indigo-300',
    dot: 'bg-indigo-400',
  },
  'ECE 198': {
    badge: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300 shadow-sm shadow-cyan-950/40',
    text: 'text-cyan-300',
    dot: 'bg-cyan-400',
  },
  'MATH 117': {
    badge: 'border-amber-500/40 bg-amber-500/15 text-amber-300 shadow-sm shadow-amber-950/40',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
  },
  'COMMST 191/COMMST 192': {
    badge: 'border-rose-500/40 bg-rose-500/15 text-rose-300 shadow-sm shadow-rose-950/40',
    text: 'text-rose-300',
    dot: 'bg-rose-400',
  },
  CFE: {
    badge: 'border-violet-500/40 bg-violet-500/15 text-violet-300 shadow-sm shadow-violet-950/40',
    text: 'text-violet-300',
    dot: 'bg-violet-400',
  },

  // Prefix fallbacks
  ECE: { badge: 'border-cyan-500/35 bg-cyan-500/15 text-cyan-300', text: 'text-cyan-300', dot: 'bg-cyan-400' },
  MATH: { badge: 'border-amber-500/35 bg-amber-500/15 text-amber-300', text: 'text-amber-300', dot: 'bg-amber-400' },
  CS: { badge: 'border-purple-500/35 bg-purple-500/15 text-purple-300', text: 'text-purple-300', dot: 'bg-purple-400' },
  SE: { badge: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  STAT: { badge: 'border-rose-500/35 bg-rose-500/15 text-rose-300', text: 'text-rose-300', dot: 'bg-rose-400' },
  COMMST: { badge: 'border-rose-500/35 bg-rose-500/15 text-rose-300', text: 'text-rose-300', dot: 'bg-rose-400' },
};

export function getCourseTone(course: string) {
  const normalized = course.trim().toUpperCase();
  if (COURSE_TONES[normalized]) return COURSE_TONES[normalized];

  const prefix = normalized.split(/[\s\d]/)[0] ?? '';
  return COURSE_TONES[prefix] ?? {
    badge: 'border-white/10 bg-secondary/30 text-foreground/80',
    text: 'text-foreground/80',
    dot: 'bg-zinc-400',
  };
}

const LINK_ICONS: Record<string, typeof ExternalLink> = {
  submit: FileUp,
  quiz: ClipboardCheck,
  module: BookOpen,
  discussion: MessageSquare,
  grade: GraduationCap,
  event: CalendarDays,
  link: ExternalLink,
};

/** One key per task, used by the row so they cannot disagree. */
export function taskKey(item: DueSoonItem) {
  return item.occurrence_id || `${item.title}@${item.starts_at}`;
}

function cleanDisplayTitle(title: string) {
  return title
    .replace(/^[A-Z]{2,6}\s?\d{2,3}[A-Z]?\s*[-–]\s*/, '')
    .replace(/\s+-\s+(?:Due|Available)$/i, '')
    .replace(/\s+due$/i, '')
    .trim();
}

function matchesGroupScope(item: DueSoonItem, section: number | null, groupNumber: number | null) {
  if (section === null || groupNumber === null) return true;
  if (item.group_scope) {
    if (item.group_scope.groups != null) {
      const [lo, hi] = item.group_scope.groups;
      if (groupNumber < lo || groupNumber > hi) return false;
    }
    if (item.group_scope.section != null) {
      if (item.group_scope.section !== section) return false;
    }
  }
  return true;
}

function getDayGroupKey(startsAt: number, now: number): { key: string; label: string } {
  const offset = dayOffset(startsAt, now);
  const date = new Date(startsAt);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
  const monthName = date.toLocaleDateString('en-US', { month: 'short' });
  const dayNum = date.getDate();

  if (offset === 0) {
    return { key: 'today', label: `Today · ${dayName} ${monthName} ${dayNum}` };
  }
  if (offset === 1) {
    return { key: 'tomorrow', label: `Tomorrow · ${dayName} ${monthName} ${dayNum}` };
  }
  return {
    key: `${date.getFullYear()}-${date.getMonth() + 1}-${dayNum}`,
    label: `${dayName} · ${monthName} ${dayNum}`,
  };
}

export function DueSoonCard({
  card,
  now,
  selectedKey,
  onSelectTask,
}: {
  card: CardT<DueSoonData>;
  now: number;
  selectedKey?: string | null;
  onSelectTask?: (item: DueSoonItem, course: string) => void;
}) {
  const d = card.data;
  const muted = mutedIfStale(card.state);
  const { preferences, dismissTask, undismissTask, isDismissed } = usePreferences();
  const [showHidden, setShowHidden] = useState(false);
  const [toast, setToast] = useState<{ id: string; title: string; key: string } | null>(null);

  // Track which tasks have their inline description open
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // Track which tasks have their 20-word description expanded to full
  const [expandedTextKeys, setExpandedTextKeys] = useState<Set<string>>(new Set());

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleText = (key: string) => {
    setExpandedTextKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Auto-dismiss undo toast after 4.5 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleDismiss = (item: DueSoonItem) => {
    const key = item.occurrence_id || taskKey(item);
    dismissTask(key);
    setToast({
      id: String(Date.now()),
      title: cleanDisplayTitle(item.title),
      key,
    });
  };

  const handleUndo = () => {
    if (toast) {
      undismissTask(toast.key);
      setToast(null);
    }
  };

  // Error and Degraded states
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
          <p className="text-[15px] font-semibold text-rose-400">Unable to fetch deadlines</p>
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
          <p className="text-[15px] font-medium text-amber-300">LEARN feed not configured</p>
          <p className="mt-1 text-xs text-zinc-400">
            Add your Waterloo LEARN ICS link in Settings to see upcoming assignments.
          </p>
        </div>
      </CardShell>
    );
  }

  // Raw data with back-compat fallback for legacy bundles
  const rawDue: DueSoonItem[] = d.due ?? d.items ?? [];
  const rawOpens: DueSoonItem[] = d.opens ?? [];
  const rawAhead = d.ahead ?? [];
  const nextMajor = d.next_major ?? null;

  // Filter helper for dismissals
  const checkDismissed = (item: DueSoonItem) => {
    if (item.occurrence_id && isDismissed(item.occurrence_id)) return true;
    if (item.uid && isDismissed(item.uid)) return true;
    const fallback = `${item.title}@${item.starts_at}`;
    if (isDismissed(fallback)) return true;
    return false;
  };

  // Group scope & active time filtering
  const section = preferences.section;
  const groupNumber = preferences.groupNumber;

  // Track all visible items
  const allVisibleItems = [
    ...rawDue,
    ...rawOpens,
    ...rawAhead.flatMap((g) => g.items),
  ].filter((i) => i.starts_at >= now - 5 * 60_000 && matchesGroupScope(i, section, groupNumber));

  // Filtered lists
  const filteredDue = rawDue.filter(
    (i) =>
      i.starts_at >= now - 5 * 60_000 &&
      matchesGroupScope(i, section, groupNumber) &&
      !checkDismissed(i),
  );

  const filteredOpens = rawOpens.filter(
    (i) =>
      i.starts_at >= now - 5 * 60_000 &&
      matchesGroupScope(i, section, groupNumber) &&
      !checkDismissed(i),
  );

  const filteredAhead = rawAhead
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.starts_at >= now - 5 * 60_000 &&
          matchesGroupScope(i, section, groupNumber) &&
          !checkDismissed(i),
      ),
    }))
    .filter((g) => g.items.length > 0);

  // Combined this-week calendar items: chronologically merged
  const combinedThisWeek: DueSoonItem[] = [
    ...filteredDue.map((it) => ({ ...it, phase: 'due' as const })),
    ...filteredOpens.map((it) => ({ ...it, phase: 'opens' as const })),
  ].sort((a, b) => a.starts_at - b.starts_at);

  // Group combined items by day
  const dayGroups: { key: string; label: string; items: DueSoonItem[] }[] = [];
  const dayGroupMap = new Map<string, { key: string; label: string; items: DueSoonItem[] }>();
  for (const item of combinedThisWeek) {
    const { key, label } = getDayGroupKey(item.starts_at, now);
    if (!dayGroupMap.has(key)) {
      const g = { key, label, items: [] };
      dayGroupMap.set(key, g);
      dayGroups.push(g);
    }
    dayGroupMap.get(key)!.items.push(item);
  }

  // Hidden items in the active bundle for restore affordance
  const hiddenItems = allVisibleItems.filter(checkDismissed);
  const hiddenUniqueMap = new Map<string, DueSoonItem>();
  for (const it of hiddenItems) {
    const key = taskKey(it);
    if (!hiddenUniqueMap.has(key)) hiddenUniqueMap.set(key, it);
  }
  const uniqueHidden = [...hiddenUniqueMap.values()];

  // Glancing metrics
  const nextDueItem = filteredDue.length ? filteredDue[0] : null;
  const nearestUrgent = nextDueItem != null && nextDueItem.starts_at - now <= 24 * 60 * 60_000;
  const isCompact = preferences.density === 'compact';

  // Empty state check
  if (combinedThisWeek.length === 0 && filteredAhead.length === 0) {
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
        <EmptyState hint={`Nothing scheduled in the next ${d.window_days || 7} days.`}>
          Nothing scheduled
        </EmptyState>
        {uniqueHidden.length > 0 && (
          <div className="mt-3 border-t border-border/40 pt-2 text-center">
            <button
              type="button"
              onClick={() => setShowHidden(!showHidden)}
              className="text-xs text-zinc-400 hover:text-zinc-200 underline transition-colors cursor-pointer"
            >
              {uniqueHidden.length} hidden task{uniqueHidden.length === 1 ? '' : 's'} ·{' '}
              {showHidden ? 'hide' : 'show'}
            </button>
            {showHidden && (
              <ul className="mt-2 space-y-1.5 text-left">
                {uniqueHidden.map((item) => (
                  <li
                    key={taskKey(item)}
                    className="flex items-center justify-between gap-2 rounded bg-secondary/30 p-1.5 text-xs text-zinc-300"
                  >
                    <span className="truncate">{item.title}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (item.occurrence_id) undismissTask(item.occurrence_id);
                        if (item.uid) undismissTask(item.uid);
                        undismissTask(`${item.title}@${item.starts_at}`);
                      }}
                      className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-live hover:bg-secondary transition-colors cursor-pointer"
                    >
                      <RotateCcw className="size-2.5" /> Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Floating Undo Toast Portal */}
        {renderUndoToast(toast, handleUndo, () => setToast(null))}
      </CardShell>
    );
  }

  // Compact Mode footer computation
  const moreTotal = Math.max(0, combinedThisWeek.length - 3);
  const compactFooterParts: string[] = [];
  if (moreTotal > 0) {
    compactFooterParts.push(`+${moreTotal} more this week (${filteredDue.length} due · ${filteredOpens.length} opens)`);
  } else if (filteredOpens.length > 0) {
    compactFooterParts.push(`${filteredDue.length} due · ${filteredOpens.length} opens`);
  }
  if (nextMajor) {
    const days = Math.max(1, Math.round((nextMajor.starts_at - now) / (24 * 3600_000)));
    const shortTitle = cleanDisplayTitle(nextMajor.title);
    compactFooterParts.push(`next big: ${shortTitle} in ${days}d`);
  }

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
          {nextDueItem != null && (
            <Badge
              variant="outline"
              className={cn(
                'py-0 font-medium tracking-wide',
                isCompact ? 'px-1.5 text-[9px]' : 'px-2 text-[10px]',
                nearestUrgent
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-white/10 bg-secondary/30 text-muted-foreground',
              )}
            >
              Nearest: {countdown(nextDueItem.starts_at, now)}
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn(
              'border-white/10 bg-secondary/30 py-0 font-semibold tracking-wide text-foreground/90',
              isCompact ? 'px-1.5 text-[9px]' : 'px-2 text-[10px]',
            )}
          >
            {filteredDue.length} due
          </Badge>
          {filteredOpens.length > 0 && (
            <Badge
              variant="outline"
              className={cn(
                'border-white/10 bg-secondary/20 py-0 font-medium tracking-wide text-zinc-400',
                isCompact ? 'px-1.5 text-[9px]' : 'px-2 text-[10px]',
              )}
            >
              {filteredOpens.length} opens
            </Badge>
          )}
        </div>
      }
    >
      {isCompact ? (
        /* Compact Mode: Immediate 3 calendar items with single-click dismiss and separate detail card selection */
        <div className="space-y-2">
          <ul className="space-y-1.5">
            {combinedThisWeek.slice(0, 3).map((item) => {
              const key = taskKey(item);
              const isSelected = selectedKey === key;
              return (
                <DueItem
                  key={key}
                  item={item}
                  now={now}
                  muted={muted}
                  compact={true}
                  showDayInTime={true}
                  course={item.course}
                  isSelected={isSelected}
                  onSelect={() => onSelectTask?.(item, item.course || '')}
                  onDismiss={() => handleDismiss(item)}
                />
              );
            })}
          </ul>
          {compactFooterParts.length > 0 && (
            <p className="pt-1 text-[11px] font-medium text-zinc-400 truncate">
              {compactFooterParts.join(' · ')}
            </p>
          )}
        </div>
      ) : (
        /* Detailed Mode: Combined This Week Calendar (grouped by day) with inline descriptions */
        <div className="space-y-4">
          {/* Combined Calendar: Due + Opens grouped by day */}
          {dayGroups.length > 0 && (
            <div className="space-y-3">
              {dayGroups.map((group) => (
                <div key={group.key} className="space-y-1">
                  {/* Subtle, elegant Day Divider */}
                  <div className="flex items-center gap-2 pt-1 pb-0.5 px-1">
                    <span className="text-[11px] font-semibold text-zinc-400 tracking-wide uppercase">
                      {group.label}
                    </span>
                    <div className="h-px bg-border/40 flex-1" />
                  </div>

                  <ul className="space-y-1">
                    {group.items.map((item) => {
                      const key = taskKey(item);
                      return (
                        <DueItem
                          key={key}
                          item={item}
                          now={now}
                          muted={muted}
                          compact={false}
                          showDayInTime={false}
                          course={item.course}
                          isExpanded={expandedKeys.has(key)}
                          isTextExpanded={expandedTextKeys.has(key)}
                          onToggleExpand={() => toggleExpand(key)}
                          onToggleText={() => toggleText(key)}
                          onDismiss={() => handleDismiss(item)}
                        />
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* Ahead in Term (milestones & deliverables, grouped by week) */}
          {filteredAhead.length > 0 && (
            <div className="border-t border-border/40 pt-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Ahead in Term
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">milestones & deliverables</span>
              </div>

              {filteredAhead.slice(0, 5).map((group) => (
                <div key={group.week_start} className="space-y-1">
                  <h4 className="text-[11px] font-medium text-zinc-400 px-1">
                    {group.label}
                  </h4>
                  <ul className="space-y-1">
                    {group.items.map((item) => {
                      const key = taskKey(item);
                      return (
                        <DueItem
                          key={key}
                          item={item}
                          now={now}
                          muted={muted}
                          compact={false}
                          showDayInTime={true}
                          course={item.course}
                          isAhead={true}
                          isExpanded={expandedKeys.has(key)}
                          isTextExpanded={expandedTextKeys.has(key)}
                          onToggleExpand={() => toggleExpand(key)}
                          onToggleText={() => toggleText(key)}
                          onDismiss={() => handleDismiss(item)}
                        />
                      );
                    })}
                  </ul>
                </div>
              ))}

              {filteredAhead.length > 5 && (
                <p className="text-[11px] text-zinc-500 pt-1 px-1">
                  +{filteredAhead.length - 5} more weeks of milestone work ahead
                </p>
              )}
            </div>
          )}

          {/* Hidden tasks restore toggle in detailed mode */}
          {uniqueHidden.length > 0 && (
            <div className="border-t border-border/40 pt-2">
              <button
                type="button"
                onClick={() => setShowHidden(!showHidden)}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                {uniqueHidden.length} hidden · {showHidden ? 'hide' : 'show'}
              </button>
              {showHidden && (
                <ul className="mt-2 space-y-1">
                  {uniqueHidden.map((item) => (
                    <li
                      key={taskKey(item)}
                      className="flex items-center justify-between gap-2 rounded bg-secondary/30 p-1.5 text-xs text-zinc-300"
                    >
                      <span className="truncate">{item.title}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (item.occurrence_id) undismissTask(item.occurrence_id);
                          if (item.uid) undismissTask(item.uid);
                          undismissTask(`${item.title}@${item.starts_at}`);
                        }}
                        className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-live hover:bg-secondary transition-colors cursor-pointer"
                      >
                        <RotateCcw className="size-2.5" /> Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Floating Undo Toast Portal */}
      {renderUndoToast(toast, handleUndo, () => setToast(null))}
    </CardShell>
  );
}

function renderUndoToast(
  toast: { id: string; title: string; key: string } | null,
  onUndo: () => void,
  onClose: () => void,
) {
  if (!toast || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/95 px-4 py-2.5 shadow-2xl backdrop-blur-md ring-1 ring-white/10 animate-in fade-in slide-in-from-bottom-4 duration-200"
    >
      <div className="flex items-center gap-2 max-w-xs sm:max-w-sm truncate text-xs text-zinc-200">
        <span className="font-medium text-zinc-400">Hidden</span>
        <span className="text-zinc-600" aria-hidden="true">·</span>
        <span className="truncate font-semibold text-foreground">{toast.title}</span>
      </div>
      <button
        type="button"
        onClick={onUndo}
        className="flex items-center gap-1.5 rounded-lg bg-live/15 hover:bg-live/25 px-2.5 py-1 text-xs font-semibold text-live transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live shrink-0 cursor-pointer"
      >
        <RotateCcw className="size-3" />
        <span>Undo</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        className="rounded p-1 text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live cursor-pointer shrink-0"
      >
        <X className="size-3.5" />
      </button>
    </div>,
    document.body,
  );
}

/**
 * Inline Description component:
 * - If no description exists, renders nothing.
 * - Limits description to 20 words.
 * - If longer than 20 words, omits the rest and expands on click ("Show more" / "Show less").
 */
function InlineDescription({
  description,
  isTextExpanded,
  onToggleText,
}: {
  description: string;
  isTextExpanded: boolean;
  onToggleText: (e: React.MouseEvent) => void;
}) {
  const trimmed = description.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/);
  const isLonger = words.length > 20;

  if (!isLonger) {
    return (
      <p className="leading-relaxed whitespace-pre-wrap break-words text-zinc-300 text-xs font-normal">
        {trimmed}
      </p>
    );
  }

  const truncatedText = words.slice(0, 20).join(' ');

  return (
    <div className="leading-relaxed text-zinc-300 text-xs font-normal">
      {isTextExpanded ? (
        <div>
          <p className="whitespace-pre-wrap break-words">{trimmed}</p>
          <button
            type="button"
            onClick={onToggleText}
            className="mt-1.5 inline-block text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            Show less
          </button>
        </div>
      ) : (
        <p
          onClick={onToggleText}
          className="break-words cursor-pointer group/desc"
          title="Click to expand full description"
        >
          <span>{truncatedText}… </span>
          <span className="inline-block text-xs font-semibold text-live group-hover/desc:underline transition-colors">
            Show more
          </span>
        </p>
      )}
    </div>
  );
}

function DueItem({
  item,
  now,
  muted,
  compact,
  showDayInTime = false,
  course,
  isAhead = false,
  isSelected = false,
  isExpanded = false,
  isTextExpanded = false,
  onToggleExpand,
  onToggleText,
  onSelect,
  onDismiss,
}: {
  item: DueSoonItem;
  now: number;
  muted: string;
  compact?: boolean;
  showDayInTime?: boolean;
  course?: string;
  isAhead?: boolean;
  isSelected?: boolean;
  isExpanded?: boolean;
  isTextExpanded?: boolean;
  onToggleExpand?: () => void;
  onToggleText?: () => void;
  onSelect?: () => void;
  onDismiss?: () => void;
}) {
  const isOpens = item.phase === 'opens';
  const offset = dayOffset(item.starts_at, now);

  // Time & All-day formatting
  let when: string;
  if (showDayInTime) {
    if (item.all_day) {
      const dayStr =
        offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : formatShortDay(item.starts_at);
      when = `${dayStr} · all day`;
    } else {
      when =
        offset === 0
          ? `Today ${formatTime(item.starts_at)}`
          : offset === 1
            ? `Tomorrow ${formatTime(item.starts_at)}`
            : formatShortDay(item.starts_at);
    }
  } else {
    when = item.all_day ? 'all day' : formatTime(item.starts_at);
  }
  if (isOpens && item.due_at) {
    when = `${when} · Due ${formatShortDay(item.due_at)}`;
  }

  const urgent = !isOpens && !isAhead && item.starts_at - now <= 24 * 60 * 60_000 && item.starts_at - now > 0;
  const overdue = !isOpens && !isAhead && item.starts_at - now <= 0;

  // Clean title & course tone
  const cleanTitle = cleanDisplayTitle(item.title);
  const courseTone = course ? getCourseTone(course) : null;
  const hasDesc = Boolean(item.description && item.description.trim().length > 0);
  const hasLinks = Boolean(item.links && item.links.length > 0);
  const isExpandable = hasDesc || hasLinks;
  const isClickable = compact ? Boolean(onSelect) : isExpandable;

  const shared = cn(
    'group/row relative flex w-full items-center justify-between gap-2.5 text-left transition-colors rounded-lg',
    compact ? 'py-0.5 px-1.5' : 'py-1 px-2',
    urgent && 'bg-amber-500/5 border border-amber-500/20',
    compact && isSelected && 'bg-secondary/60 ring-1 ring-live/40',
    !compact && isExpanded && 'bg-secondary/40 ring-1 ring-white/10',
  );

  return (
    <li className={cn('relative', isOpens && 'opacity-85 hover:opacity-100 transition-opacity')}>
      <div className={shared}>
        {/* Main row header click target */}
        {isClickable ? (
          <button
            type="button"
            onClick={compact ? onSelect : onToggleExpand}
            aria-expanded={compact ? isSelected : isExpanded}
            aria-label={
              compact
                ? `${isSelected ? 'Close detail' : 'Show detail'} for ${cleanTitle}`
                : `${isExpanded ? 'Collapse' : 'Expand'} details for ${cleanTitle}`
            }
            className="flex-1 flex min-w-0 items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded cursor-pointer hover:opacity-95"
          >
            <div className="flex min-w-0 items-center gap-2">
              {urgent && <AlertCircle className="size-3.5 shrink-0 text-amber-400" />}

              {/* Course Badge: proper colors for Due; faded for Opens */}
              {course && (
                <span
                  className={cn(
                    'rounded-md border px-1.5 py-0.2 font-mono text-[10px] font-semibold shrink-0 transition-colors',
                    isOpens
                      ? 'border-zinc-700/50 bg-secondary/30 text-zinc-400 opacity-75'
                      : courseTone?.badge ?? 'border-white/10 bg-secondary/30 text-zinc-300',
                  )}
                >
                  {course}
                </span>
              )}

              {/* Phase Badge: Due / Opens */}
              {!compact && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.2 font-mono text-[9px] uppercase tracking-wider shrink-0',
                    isOpens
                      ? 'border border-border/40 bg-secondary/30 text-zinc-400 font-medium'
                      : urgent
                        ? 'border border-amber-500/30 bg-amber-500/15 text-amber-300 font-bold'
                        : overdue
                          ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300 font-bold'
                          : 'border border-white/10 bg-secondary/50 text-zinc-200 font-semibold',
                  )}
                >
                  {isOpens ? 'Opens' : urgent ? 'Due Soon' : overdue ? 'Overdue' : 'Due'}
                </span>
              )}

              {/* Title: high contrast for Due, soft faded for Opens */}
              <span
                className={cn(
                  'truncate text-xs',
                  isOpens
                    ? 'text-zinc-400 text-[11px] font-normal'
                    : urgent
                      ? 'font-medium text-foreground'
                      : 'text-zinc-100 font-medium',
                  muted,
                )}
              >
                {cleanTitle}
              </span>

              {/* Chevron icon indicating expandable description or detail card */}
              <ChevronRight
                className={cn(
                  'size-3.5 text-zinc-500 transition-transform duration-200 shrink-0',
                  compact
                    ? isSelected && 'rotate-90 text-live'
                    : isExpanded && 'rotate-90 text-zinc-300',
                )}
                aria-hidden="true"
              />
            </div>

            {!isAhead && (
              <div className={cn('flex shrink-0 items-center gap-1.5', compact ? 'pr-5' : 'pr-6')}>
                <span
                  className={cn(
                    'text-right text-xs tabular-nums whitespace-nowrap',
                    isOpens
                      ? 'text-zinc-500 text-[11px] font-normal'
                      : overdue
                        ? 'text-rose-400 font-semibold'
                        : urgent
                          ? 'text-amber-300 font-semibold'
                          : 'text-zinc-300 font-medium',
                  )}
                >
                  {when}
                </span>
              </div>
            )}
          </button>
        ) : (
          /* Item with no description: don't show expander, render clean direct row */
          <div className="flex-1 flex min-w-0 items-center justify-between gap-2 text-left">
            <div className="flex min-w-0 items-center gap-2">
              {urgent && <AlertCircle className="size-3.5 shrink-0 text-amber-400" />}

              {/* Course Badge */}
              {course && (
                <span
                  className={cn(
                    'rounded-md border px-1.5 py-0.2 font-mono text-[10px] font-semibold shrink-0 transition-colors',
                    isOpens
                      ? 'border-zinc-700/50 bg-secondary/30 text-zinc-400 opacity-75'
                      : courseTone?.badge ?? 'border-white/10 bg-secondary/30 text-zinc-300',
                  )}
                >
                  {course}
                </span>
              )}

              {/* Phase Badge */}
              {!compact && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.2 font-mono text-[9px] uppercase tracking-wider shrink-0',
                    isOpens
                      ? 'border border-border/40 bg-secondary/30 text-zinc-400 font-medium'
                      : urgent
                        ? 'border border-amber-500/30 bg-amber-500/15 text-amber-300 font-bold'
                        : overdue
                          ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300 font-bold'
                          : 'border border-white/10 bg-secondary/50 text-zinc-200 font-semibold',
                  )}
                >
                  {isOpens ? 'Opens' : urgent ? 'Due Soon' : overdue ? 'Overdue' : 'Due'}
                </span>
              )}

              {/* Title */}
              <span
                className={cn(
                  'truncate text-xs',
                  isOpens
                    ? 'text-zinc-400 text-[11px] font-normal'
                    : urgent
                      ? 'font-medium text-foreground'
                      : 'text-zinc-100 font-medium',
                  muted,
                )}
              >
                {cleanTitle}
              </span>

              {/* External direct link if present */}
              {item.url && !compact && !isAhead && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Open ${cleanTitle} in LEARN`}
                  className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live"
                >
                  <ExternalLink className="size-2.5 shrink-0" aria-hidden="true" />
                </a>
              )}
            </div>

            {!isAhead && (
              <div className={cn('flex shrink-0 items-center gap-1.5', compact ? 'pr-5' : 'pr-6')}>
                <span
                  className={cn(
                    'text-right text-xs tabular-nums whitespace-nowrap',
                    isOpens
                      ? 'text-zinc-500 text-[11px] font-normal'
                      : overdue
                        ? 'text-rose-400 font-semibold'
                        : urgent
                          ? 'text-amber-300 font-semibold'
                          : 'text-zinc-300 font-medium',
                  )}
                >
                  {when}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Single-click Dismiss button */}
        {onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            aria-label={`Hide ${cleanTitle}`}
            title={`Hide ${cleanTitle}`}
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:text-zinc-200 hover:bg-secondary/70 transition-all rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live cursor-pointer',
              compact ? 'p-0.5' : 'p-1',
            )}
          >
            <X className={cn(compact ? 'size-3' : 'size-3.5')} />
          </button>
        )}
      </div>

      {/* Inline Description & Links (only in detailed view, never nested inside button) */}
      {!compact && isExpanded && isExpandable && (
        <div className="mt-1.5 mb-1 mx-1 rounded-lg border border-white/5 bg-secondary/35 p-3 text-xs space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-150 shadow-inner">
          {item.due_at && (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
              <ClipboardList className="size-3 text-amber-400 shrink-0" />
              <span>Due {formatShortDay(item.due_at)} at {formatTime(item.due_at)}</span>
            </div>
          )}
          {hasDesc && (
            <InlineDescription
              description={item.description!}
              isTextExpanded={isTextExpanded}
              onToggleText={(e) => {
                e.stopPropagation();
                onToggleText?.();
              }}
            />
          )}

          {/* Action Links (if any) */}
          {hasLinks && (
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-white/5">
              {item.links!.map((link) => {
                const Icon = LINK_ICONS[link.kind] ?? ExternalLink;
                return (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-secondary/60 hover:bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground hover:border-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live cursor-pointer"
                  >
                    <Icon className="size-3 text-live shrink-0" />
                    <span>{link.label}</span>
                  </a>
                );
              })}
            </div>
          )}

          {/* Location (if any) */}
          {item.location && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 pt-0.5">
              <MapPin className="size-3 text-cyan-400 shrink-0" />
              <span className="truncate">{item.location}</span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
