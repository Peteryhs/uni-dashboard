import type { DiningRecommendationController } from '@/components/use-dining-recommendation';
import { getRankedDiningOutlets } from '@/components/use-dining-recommendation';
import { getOutletLocation } from '@/components/cards/food';
import './ai-menu-summary.css';

function displayDate(serviceDate: string): string {
  const date = new Date(`${serviceDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return serviceDate;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

export function AiMenuSummary({
  service_date,
  state,
  isReranking,
  rerankError,
  rerank,
}: { service_date: string } & DiningRecommendationController) {
  const rankAgainButton = (
    <button
      className={`ai-menu-summary__rank-again${state.status !== 'ready' ? ' ai-menu-summary__rank-again--quiet' : ''}`}
      type="button"
      onClick={() => void rerank()}
      disabled={isReranking || state.status === 'budget_limited'}
      title={state.status === 'budget_limited' ? 'The shared AI allowance is fully reserved today.' : undefined}
      aria-label={isReranking ? 'Ranking dining picks' : 'Rank dining picks again'}
    >
      <span>{isReranking ? 'Ranking…' : 'Rank again'}</span>
    </button>
  );

  if (state.status !== 'ready') {
    const statusText = state.status === 'loading'
      ? 'Loading dining picks'
      : state.status === 'empty'
        ? 'No saved dining picks for this menu.'
        : state.status === 'attempt_limited'
          ? state.reason === 'automatic_attempt_cap'
            ? 'Automatic dining ranking paused at its daily cap. Manual rankings have a separate allowance.'
            : state.reason === 'daily_attempt_cap'
              ? 'Dining picks paused at the daily ranking attempt cap. Shared AI usage may still have capacity.'
              : 'Dining picks paused after repeated ranking failures. Shared AI usage may still have capacity.'
          : state.status === 'budget_limited'
            ? 'Dining picks paused because the shared AI allowance is fully reserved for today.'
            : state.reason?.includes('not valid JSON')
              ? 'Dining summary failed: AI returned unreadable data.'
              : state.reason
                ? `Dining summary failed: ${state.reason}`
                : 'Dining summary is unavailable.';

    return (
      <div className="ai-menu-summary ai-menu-summary--quiet" aria-live="polite" role={state.status === 'loading' ? undefined : 'status'}>
        <span>{statusText}</span>
        {state.status !== 'loading' && rankAgainButton}
        {rerankError && <span className="ai-menu-summary__rerank-error" role="alert">{rerankError}</span>}
      </div>
    );
  }

  const { recommendation } = state;
  const bestOutlet = getRankedDiningOutlets(recommendation)[0];

  return (
    <section className="ai-menu-summary" aria-label={`AI dining recommendation for ${displayDate(service_date)}`} aria-busy={isReranking}>
      <div className="ai-menu-summary__heading">
        <strong className="ai-menu-summary__restaurant">{bestOutlet?.outlet ? getOutletLocation(bestOutlet.outlet).name : 'No outlet recommendation saved'}</strong>
        {rankAgainButton}
      </div>

      {rerankError && <p className="ai-menu-summary__rerank-error" role="alert">Ranking failed: {rerankError}</p>}

      {state.stale && (
        <p className="ai-menu-summary__limited" role="status">
          {state.sourceStatus === 'budget_limited'
            ? 'Showing saved picks. New rankings paused because the shared AI allowance is fully reserved today.'
            : state.sourceStatus === 'attempt_limited' && state.limitReason === 'automatic_attempt_cap'
              ? 'Showing saved picks. Automatic ranking reached its daily cap; manual rankings have a separate allowance.'
              : state.sourceStatus === 'attempt_limited' || state.sourceStatus === 'limited'
                ? 'Showing saved picks. New rankings paused at the daily attempt cap; shared AI usage may still have capacity.'
                : 'Showing saved picks while an updated ranking is unavailable.'}
        </p>
      )}

    </section>
  );
}
