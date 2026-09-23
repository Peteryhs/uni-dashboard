/**
 * The alert slot. Usually invisible.
 *
 * "An empty slot renders zero height, not a green card."
 * When there is an outage or incident, this renders a high-visibility, glassmorphic notice banner.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { FreshnessLine } from '@/components/freshness';
import { Badge } from '@/components/ui/badge';
import { dismissAlert } from '@/lib/api';
import type { AlertData, Card as CardT } from '@/lib/contract';
import { shortAge } from '@/lib/time';
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
  const queryClient = useQueryClient();
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (d.dismissed || (d.key && hiddenKey === d.key)) return null;

  // No notices. That is an all clear only if the relay actually looked recently: the server marks
  // an old status check stale or dead on the age ladder, and swallowing that would quietly turn
  // "we do not know" into "nothing is wrong".
  if (!d.count) {
    if (card.state !== 'stale' && card.state !== 'dead' && card.state !== 'failed') return null;
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-amber/40 bg-amber/10 px-3.5 py-2.5 text-xs text-zinc-300">
        <AlertTriangle className="size-3.5 shrink-0 text-amber" aria-hidden />
        <span>
          {card.state === 'failed'
            ? 'Campus status check failed: unable to reach status.uwaterloo.ca'
            : `Campus status unknown${d.checked_at ? `, last checked ${shortAge(d.checked_at, now)} ago` : ''}`}
        </span>
      </div>
    );
  }

  const worst = d.notices[0];
  const tone = SEVERITY_TONE[worst?.severity ?? 'info'] ?? SEVERITY_TONE.info;

  const dismiss = async () => {
    setHiddenKey(d.key);
    try {
      await dismissAlert(d.key);
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (cause) {
      setHiddenKey(null);
      setError(cause instanceof Error ? cause.message : 'Could not dismiss the alert');
    }
  };

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-2.5 rounded-md border px-3.5 py-2.5 bg-card text-xs transition-colors shadow-xs',
        tone.ring,
      )}
    >
      <AlertTriangle className={cn('size-4 shrink-0', tone.text)} aria-hidden />
      <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider rounded', tone.badge)}>{tone.label}</Badge>
      <span className="min-w-0 flex-1 text-foreground">{d.summary || worst?.title}</span>
      {worst?.url && <a href={worst.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-zinc-300 hover:underline">Details <ExternalLink className="size-3" /></a>}
      <button type="button" onClick={dismiss} aria-label="Dismiss campus alert" className="rounded p-1 text-zinc-300 hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live"><X className="size-3.5" /></button>
      <div className="hidden sm:block shrink-0">
        <FreshnessLine state={card.state} observedAt={card.observed_at} now={now} sourceId={card.source_id || undefined} />
      </div>
      {error && <span className="w-full text-amber-300">{error}</span>}
    </div>
  );
}
