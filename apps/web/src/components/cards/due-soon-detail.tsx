/**
 * The task detail panel.
 *
 * Opens below the commitments card, full width, when a deadline row is clicked. The order is the
 * point: which course and where to go at the top, the feed's own instructions underneath. A student
 * clicking a task wants the link, not a wall of text, and the text is what tells them what to do
 * once they are there.
 *
 * Everything here comes from the feed. When the feed carries no description the panel says so
 * instead of showing an empty box.
 */
import { useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  Clock,
  ExternalLink,
  FileUp,
  GraduationCap,
  MapPin,
  MessageSquare,
  X,
} from 'lucide-react';
import { CardShell } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Card as CardT, DueSoonData, DueSoonItem, DueSoonLink } from '@/lib/contract';
import { countdown, dayOffset, formatShortDay, formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { getCourseTone } from './due-soon';

const LINK_ICONS: Record<string, typeof ExternalLink> = {
  submit: FileUp,
  quiz: ClipboardCheck,
  module: BookOpen,
  discussion: MessageSquare,
  grade: GraduationCap,
  event: CalendarDays,
  link: ExternalLink,
};

const LINK_LABELS: Record<string, string> = {
  submit: 'Dropbox',
  quiz: 'Quiz',
  module: 'Module',
  discussion: 'Discussion',
  grade: 'Grades',
  event: 'LEARN calendar',
  link: 'Link',
};

function whenLabel(startsAt: number, now: number) {
  const offset = dayOffset(startsAt, now);
  if (offset === 0) return `Today at ${formatTime(startsAt)}`;
  if (offset === 1) return `Tomorrow at ${formatTime(startsAt)}`;
  return `${formatShortDay(startsAt)} at ${formatTime(startsAt)}`;
}

export function DueSoonDetail({
  card,
  item,
  course,
  now,
  onClose,
}: {
  card: CardT<DueSoonData>;
  item: DueSoonItem;
  course: string;
  now: number;
  onClose: () => void;
}) {
  const isOpens = item.phase === 'opens';
  const courseTone = getCourseTone(course);
  const links: DueSoonLink[] = item.links ?? [];
  const overdue = !isOpens && item.starts_at - now <= 0;
  const urgent = !isOpens && item.starts_at - now <= 24 * 60 * 60_000 && item.starts_at - now > 0;
  const cleanTitle = item.title
    .replace(/^[A-Z]{2,6}\s?\d{2,3}[A-Z]?\s*[-–]\s*/, '')
    .replace(/\s+-\s+(?:Due|Available)$/i, '')
    .replace(/\s+due$/i, '')
    .trim();

  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const trimmedDesc = item.description?.trim() ?? '';
  const hasDesc = trimmedDesc.length > 0;
  const words = trimmedDesc.split(/\s+/);
  const isLonger = words.length > 20;
  const truncatedDesc = isLonger ? words.slice(0, 20).join(' ') : trimmedDesc;

  return (
    <CardShell
      title="Task detail"
      icon={<ClipboardCheck className="size-3.5" />}
      state={card.state}
      observedAt={card.observed_at}
      sourceId={card.source_id || undefined}
      now={now}
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close task detail"
          className="size-6 p-0 text-zinc-400 hover:text-foreground"
        >
          <X className="size-3.5" />
        </Button>
      }
    >
      <div className="space-y-3">
        {/* Top: which course, which task, and when it is due or opens. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {course && (
            <span
              className={cn(
                'rounded-md border px-2 py-0.5 font-mono text-xs font-semibold tracking-tight',
                isOpens
                  ? 'border-zinc-700/50 bg-secondary/30 text-zinc-400 opacity-75'
                  : courseTone.badge,
              )}
            >
              {course}
            </span>
          )}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider font-semibold shrink-0',
              isOpens
                ? 'border border-border/40 bg-secondary/30 text-zinc-400 font-medium'
                : urgent
                  ? 'border border-amber-500/30 bg-amber-500/15 text-amber-300'
                  : overdue
                    ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300'
                    : 'border border-white/10 bg-secondary/50 text-zinc-200',
            )}
          >
            {isOpens ? 'Opens' : urgent ? 'Due Soon' : overdue ? 'Overdue' : 'Due'}
          </span>
          <h3 className="text-[15px] font-semibold text-foreground">{cleanTitle}</h3>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs tabular-nums',
              isOpens
                ? 'text-zinc-400'
                : overdue
                  ? 'text-rose-400 font-semibold'
                  : urgent
                    ? 'text-amber-300 font-semibold'
                    : 'text-zinc-400',
            )}
          >
            <Clock className="size-3" />
            {whenLabel(item.starts_at, now)}
          </span>
          {!overdue && (
            <Badge
              variant="outline"
              className={cn(
                'py-0 px-2 text-[10px] font-medium tracking-wide',
                urgent
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-white/10 bg-secondary/30 text-muted-foreground',
              )}
            >
              {isOpens ? 'opens in ' : 'in '}
              {countdown(item.starts_at, now)}
            </Badge>
          )}
          {item.location && (
            <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
              <MapPin className="size-3" />
              {item.location}
            </span>
          )}
        </div>

        {/* The links the feed carried, best first. This is what a click on the real calendar gives. */}
        {links.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {links.map((link, i) => {
              const Icon = LINK_ICONS[link.kind] ?? ExternalLink;
              return (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={cn(
                    'inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live',
                    i === 0
                      ? 'border-live/50 bg-live/10 font-medium text-live-foreground hover:bg-live/20'
                      : 'border-border bg-secondary/30 text-zinc-300 hover:border-border hover:bg-secondary/50 hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="font-medium">{LINK_LABELS[link.kind] ?? 'Link'}</span>
                  <span className="max-w-[22ch] truncate text-muted-foreground">{link.label}</span>
                  <ExternalLink className="size-3 shrink-0 opacity-60" />
                </a>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-zinc-400">
            This task carries no link in the feed. Open LEARN and find it under the course calendar.
          </p>
        )}

        {/* Bottom: what the feed says. In all views, if there is no desc, dont display; limit to 20 words, expand on click. */}
        {hasDesc && (
          <div className="rounded-lg border border-border/70 bg-card/60 p-3">
            <h4 className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
              Description
            </h4>
            {isLonger ? (
              <div className="text-[13px] leading-relaxed text-zinc-200">
                {isTextExpanded ? (
                  <div>
                    <p className="whitespace-pre-line break-words">{trimmedDesc}</p>
                    <button
                      type="button"
                      onClick={() => setIsTextExpanded(false)}
                      className="mt-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                    >
                      Show less
                    </button>
                  </div>
                ) : (
                  <p
                    onClick={() => setIsTextExpanded(true)}
                    className="cursor-pointer group/desc break-words"
                    title="Click to expand full description"
                  >
                    <span>{truncatedDesc}… </span>
                    <span className="text-xs font-semibold text-live group-hover/desc:underline transition-colors">
                      Show more
                    </span>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[13px] leading-relaxed whitespace-pre-line break-words text-zinc-200">
                {trimmedDesc}
              </p>
            )}
          </div>
        )}
      </div>
    </CardShell>
  );
}
