/**
 * The card dispatcher and the degrade chain.
 *
 * Contract rule 7: a client skips an unknown card type and counts it, never crashes on it. The
 * renderer map below is the whole mechanism. When the server starts sending a `library_occupancy`
 * card next term, this build ignores it and says so in the footer, rather than throwing.
 *
 * The error boundary is the second half of the same promise: one card with a surprising payload
 * must not take the other three off the screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCard } from '@/components/cards/alert';
import { DueSoonCard } from '@/components/cards/due-soon';
import { FoodCard } from '@/components/cards/food';
import { NextCommitmentCard } from '@/components/cards/next-commitment';
import { CardShell } from '@/components/card-shell';
import type { Card as CardT, DueSoonItem } from '@/lib/contract';
import { cn } from '@/lib/utils';

export function CardRenderer({
  card,
  now,
  className,
  selectedTaskKey = null,
  onSelectTask,
}: {
  card: CardT<any>;
  now: number;
  className?: string;
  selectedTaskKey?: string | null;
  onSelectTask?: (item: DueSoonItem, course: string) => void;
}) {
  return (
    <div className={cn('h-full flex flex-col', className)}>
      <CardErrorBoundary card={card} now={now}>
        {renderCard(card, now, selectedTaskKey, onSelectTask)}
      </CardErrorBoundary>
    </div>
  );
}

function renderCard(
  card: CardT<any>,
  now: number,
  selectedTaskKey: string | null,
  onSelectTask?: (item: DueSoonItem, course: string) => void,
): ReactNode {
  switch (card.type) {
    case 'next_commitment':
      return <NextCommitmentCard card={card as CardT<never>} now={now} />;
    case 'due_soon':
      return (
        <DueSoonCard
          card={card as CardT<never>}
          now={now}
          selectedKey={selectedTaskKey}
          onSelectTask={onSelectTask}
        />
      );
    case 'food':
      return <FoodCard card={card as CardT<never>} now={now} />;
    case 'alert':
      return <AlertCard card={card as CardT<never>} now={now} />;
    default:
      // Unreachable in practice: useDashboard filters to KNOWN_CARD_TYPES first. Kept so that a
      // direct caller still degrades instead of rendering nothing.
      return null;
  }
}

interface BoundaryProps {
  card: CardT<any>;
  now: number;
  children: ReactNode;
}

class CardErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged rather than swallowed: a card that cannot render is a bug worth finding, and the
    // console is the only reporting channel this build has.
    console.error(`card ${this.props.card.type} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { card, now } = this.props;
    return (
      <CardShell
        title={card.type.replace(/_/g, ' ')}
        state="failed"
        observedAt={card.observed_at}
        sourceId={card.source_id || undefined}
        now={now}
        className="opacity-80"
      >
        <p className="text-sm text-amber-foreground">This card could not be rendered.</p>
        <p className="mt-1 font-mono text-[11px] break-words text-muted-foreground">
          {this.state.error.message}
        </p>
      </CardShell>
    );
  }
}
