/**
 * The alert slot. Usually invisible.
 *
 * "An empty slot renders zero height, not a green card."
 * When there is an outage or incident, this renders a high-visibility, glassmorphic notice banner.
 */
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { FreshnessLine } from '@/components/freshness';
import { Badge } from '@/components/ui/badge';
import type { AlertData, Card as CardT } from '@/lib/contract';
import { cn } from '@/lib/utils';

const SEVERITY_TONE: Record<string, { ring: string; badge: string; text: string; label: string }> = {
  credential: {
    ring: 'border-rose-500/50 bg-rose-500/10',
    badge: 'border-rose-500/40 bg-rose-500/20 text-rose-300',
    text: 'text-rose-400',
    label: 'Credential Required',
  },
  critical: {
    ring: 'border-rose-500/50 bg-rose-500/10',
    badge: 'border-rose-500/40 bg-rose-500/20 text-rose-300',
    text: 'text-rose-400',
    label: 'Critical Outage',
  },
  major: {
    ring: 'border-amber-500/40 bg-amber-500/10',
    badge: 'border-amber-500/40 bg-amber-500/20 text-amber-300',
    text: 'text-amber-400',
    label: 'Major Outage',
  },
  minor: {
    ring: 'border-amber-500/30 bg-amber-500/5',
    badge: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
    text: 'text-amber-400',
    label: 'Minor Incident',
  },
  info: {
    ring: 'border-border/80 bg-card',
    badge: 'border-border/80 bg-secondary/40 text-zinc-300',
    text: 'text-zinc-300',
    label: 'Campus Notice',
  },
};

export function AlertCard({ card, now }: { card: CardT<AlertData>; now: number }) {
  const d = card.data;
  if (!d.count) return null;

  const worst = d.notices[0];
  const tone = SEVERITY_TONE[worst?.severity ?? 'info'] ?? SEVERITY_TONE.info;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-md border px-3.5 py-2.5 bg-card text-xs transition-colors shadow-xs',
        tone.ring,
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn('flex size-6 shrink-0 items-center justify-center rounded bg-background/80 border border-white/5', tone.text)}>
          <AlertTriangle className="size-3.5" />
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider rounded', tone.badge)}>
            {tone.label}
          </Badge>
          <span className="text-zinc-400 text-xs hidden md:inline">· UW Campus Status</span>
          <div className="flex items-center gap-2 min-w-0">
            {d.notices.map((n) => (
              <span key={`${n.severity}-${n.title}`} className="font-medium truncate text-foreground">
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 hover:underline text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none rounded"
                  >
                    <span>{n.title}</span>
                    <ExternalLink className="size-3 shrink-0 text-zinc-400" />
                  </a>
                ) : (
                  n.title
                )}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 self-end sm:self-center border-t sm:border-t-0 border-white/5 pt-1 sm:pt-0">
        <FreshnessLine
          state={card.state}
          observedAt={card.observed_at}
          now={now}
          sourceId={card.source_id || undefined}
        />
      </div>
    </div>
  );
}
