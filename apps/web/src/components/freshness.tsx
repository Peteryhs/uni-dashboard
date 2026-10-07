/**
 * Freshness marks. Amber means stale and nothing else (README "Two visible design rules").
 */
import { cn } from '@/lib/utils';

/** The amber dot for a dead source or a tripped circuit breaker. */
export function StaleDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full bg-amber', className)}
      aria-hidden
    />
  );
}
