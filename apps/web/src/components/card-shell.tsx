/**
 * One frame for every card, so the age ladder, the title and the source label cannot be
 * implemented four slightly different ways.
 */
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { FreshnessLine } from '@/components/freshness';
import { usePreferences } from '@/lib/preferences-store';
import type { CardState } from '@/lib/contract';
import { cn } from '@/lib/utils';

export function CardShell({
  title,
  icon,
  state,
  observedAt,
  sourceId,
  now,
  action,
  children,
  className,
  showFreshness = true,
}: {
  title: string;
  icon?: ReactNode;
  state: CardState;
  observedAt: number | null;
  sourceId?: string;
  now: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  showFreshness?: boolean;
}) {
  const { preferences } = usePreferences();
  const isCompact = preferences.density === 'compact';

  return (
    <Card
      className={cn(
        'group relative p-0 py-0 gap-0 overflow-hidden rounded-lg border border-border/80 bg-card shadow-xs transition-colors hover:border-border h-full flex flex-col justify-between',
        className,
      )}
    >
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className={cn(
            'flex items-center justify-between gap-3',
            isCompact ? 'px-3.5 pt-2.5 pb-1.5 sm:px-4' : 'px-4 pt-3 pb-2 sm:px-5',
          )}
        >
          <h2
            className={cn(
              'flex items-center gap-2 font-semibold text-zinc-400 uppercase',
              isCompact ? 'text-[10px] tracking-wider' : 'text-[11px] tracking-[0.14em]',
            )}
          >
            <span className="text-zinc-400 transition-colors group-hover:text-foreground">
              {icon}
            </span>
            <span>{title}</span>
          </h2>
          {action}
        </div>
        <CardContent
          className={cn(
            'p-0 pt-0 flex-1 flex flex-col min-h-0',
            isCompact ? 'px-3.5 pb-2.5 sm:px-4' : 'px-4 pb-3.5 sm:px-5',
          )}
        >
          {children}
        </CardContent>
      </div>
      {showFreshness && (
        <div
          className={cn(
            'border-t border-border/60 bg-secondary/20 mt-auto shrink-0',
            isCompact ? 'px-3.5 py-1 sm:px-4' : 'px-4 py-1.5 sm:px-5',
          )}
        >
          <FreshnessLine state={state} observedAt={observedAt} now={now} sourceId={sourceId} />
        </div>
      )}
    </Card>
  );
}

/**
 * A declarative empty state. Not an error, not a spinner.
 *
 * BUILD_SPEC calls this out twice: a day with no menu and a timetable with nothing ahead are both
 * facts about the world, and rendering either as a failure trains the reader to distrust the card.
 */
export function EmptyState({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="py-2">
      <p className="text-[15px] font-medium text-foreground">{children}</p>
      {hint && <p className="mt-1 text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}
