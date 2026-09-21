/**
 * One frame for every card, so the age ladder, the title and the source label cannot be
 * implemented four slightly different ways.
 */
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { FreshnessLine } from '@/components/freshness';
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
  return (
    <Card
      className={cn(
        'group relative gap-0 overflow-hidden rounded-lg border border-border/80 bg-card shadow-xs transition-colors hover:border-border h-full flex flex-col justify-between',
        className,
      )}
    >
      <div>
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2 sm:px-5">
          <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-zinc-400 uppercase">
            <span className="text-zinc-400 transition-colors group-hover:text-foreground">
              {icon}
            </span>
            <span>{title}</span>
          </h2>
          {action}
        </div>
        <CardContent className="px-4 pb-4 sm:px-5">{children}</CardContent>
      </div>
      {showFreshness && (
        <div className="border-t border-border/60 bg-secondary/20 px-4 py-2 sm:px-5 mt-auto">
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
