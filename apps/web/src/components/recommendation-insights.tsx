import { useMemo, useState } from 'react';
import { ChangeBlocks } from '@/components/change-blocks';
import { useSlidingIndicator } from '@/hooks/use-sliding-indicator';
import type { RecommendationCandidateDiagnostic, RecommendationResponse } from '@/lib/contract';
import { formatShortDay, formatTime, shortAge } from '@/lib/time';
import './recommendation-insights.css';

type OutcomeFilter = 'all' | 'shown' | 'deferred' | 'suppressed';

const KIND_LABELS: Record<RecommendationCandidateDiagnostic['kind'], string> = {
  class: 'Class',
  task: 'Task',
  learning: 'Learning',
  office_hours: 'Office hours',
  focus: 'Study window',
  conflict: 'Schedule conflict',
  food: 'Dining',
  weather: 'Weather',
  change: 'Schedule change',
};

function candidateWhen(candidate: RecommendationCandidateDiagnostic): string | null {
  const at = candidate.due_at ?? candidate.starts_at;
  if (at == null) return candidate.scheduled_date ? `${candidate.kind === 'task' ? 'Due' : 'Scheduled'} ${formatShortDay(Date.parse(candidate.scheduled_date + 'T12:00:00Z'))} · time not supplied` : null;
  const label = candidate.due_at != null ? 'Due' : 'Starts';
  return `${label} ${formatShortDay(at)}${candidate.due_at != null || candidate.starts_at != null ? ` at ${formatTime(at)}` : ''}`;
}

function statusLabel(status: RecommendationCandidateDiagnostic['status']): string {
  return status[0].toUpperCase() + status.slice(1);
}

export function RecommendationInsights({
  response,
  pending = false,
  error = false,
  onRetry,
}: {
  response?: RecommendationResponse;
  pending?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const [filter, setFilter] = useState<OutcomeFilter>('all');
  const { ref: filterRef, style: filterStyle } = useSlidingIndicator(filter, '[aria-pressed="true"]');
  const diagnostics = response?.diagnostics;
  const candidates = useMemo<RecommendationCandidateDiagnostic[]>(() => {
    if (diagnostics) return diagnostics.candidates;
    return (response?.items ?? []).map((item, index) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      course: item.course,
      starts_at: item.starts_at,
      due_at: item.due_at,
      scheduled_date: item.scheduled_date,
      priority: item.priority,
      status: 'shown',
      reason: item.reason,
      eligible_at: null,
      position: index + 1,
      course_penalty: 0,
      ranking_score: null,
      change: item.change,
    }));
  }, [diagnostics, response?.items]);
  const orderedCandidates = useMemo(() => [...candidates].sort((a, b) => {
    const position = (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
    if (position !== 0) return position;
    const statusOrder = { shown: 0, deferred: 1, suppressed: 2 };
    return statusOrder[a.status] - statusOrder[b.status];
  }), [candidates]);
  const visibleCandidates = filter === 'all'
    ? orderedCandidates
    : orderedCandidates.filter(candidate => candidate.status === filter);
  const counts = diagnostics?.summary ?? {
    shown: candidates.filter(candidate => candidate.status === 'shown').length,
    deferred: candidates.filter(candidate => candidate.status === 'deferred').length,
    suppressed: candidates.filter(candidate => candidate.status === 'suppressed').length,
  };
  const summary = diagnostics
    ? `${counts.shown} shown · ${counts.deferred} deferred · ${counts.suppressed} suppressed`
    : `${candidates.length} shown · detailed decision history is not available`;

  if (!response && pending) return <section className="recommendation-insights" aria-busy="true"><p className="recommendation-insights-state">Loading the current ranking…</p></section>;
  if (!response && error) return <section className="recommendation-insights" role="alert"><p className="recommendation-insights-state">The current ranking could not be loaded.</p>{onRetry && <button className="section-control" onClick={onRetry}>Try again</button>}</section>;
  if (!response) return <section className="recommendation-insights"><p className="recommendation-insights-state">The current ranking is unavailable.</p></section>;

  return <section className="recommendation-insights" aria-label="Recommendation ranking">
    <header className="recommendation-insights-heading">
      <h2>Recommendation ranking</h2>
      <p className="recommendation-insights-summary"><span>{summary}</span><span>Updated {shortAge(response.generated_at)} ago</span></p>
    </header>

    {(response.warnings.length > 0 || diagnostics) && <div className="recommendation-insights-details">
      {response.warnings.length > 0 && <details className="recommendation-disclosure recommendation-data-warnings">
        <summary>{response.warnings.length} data {response.warnings.length === 1 ? 'warning' : 'warnings'}</summary>
        <ul>{response.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
      </details>}

      {diagnostics && <details className="recommendation-disclosure recommendation-policy">
        <summary>Timing rules</summary>
        <dl>
          <div><dt>Schedule notices</dt><dd>Enter guidance {diagnostics.policy.schedule_notice_hours} hours before the event</dd></div>
          <div><dt>Deadline changes</dt><dd>Enter guidance {diagnostics.policy.deadline_change_hours} hours before the due time</dd></div>
          <div><dt>Tutorial work notices</dt><dd>Enter guidance {diagnostics.policy.tutorial_work_notice_hours ?? 72} hours before the event</dd></div>
          <div><dt>Large tasks</dt><dd>Shown within {diagnostics.policy.task_horizon_days} days of the due date</dd></div>
          <div><dt>Smaller tasks</dt><dd>Shown within {diagnostics.policy.small_task_feed_days} days of the due date</dd></div>
          <div><dt>Daily limit</dt><dd>{diagnostics.policy.max_feed_items} recommendations</dd></div>
        </dl>
      </details>}
    </div>}

    <div ref={filterRef} style={filterStyle} className="settings-selector recommendation-outcome-filters" role="group" aria-label="Recommendation outcomes">
      {(['all', 'shown', 'deferred', 'suppressed'] as const).map(outcome => {
        const count = outcome === 'all' ? candidates.length : counts[outcome];
        return <button key={outcome} type="button" aria-pressed={filter === outcome} onClick={() => setFilter(outcome)}>
          {outcome === 'all' ? 'All' : statusLabel(outcome)} <span>{count}</span>
        </button>;
      })}
    </div>

    {visibleCandidates.length
      ? <ol className="recommendation-candidate-list" aria-label="Ranked recommendations">
        {visibleCandidates.map(candidate => {
          const when = candidateWhen(candidate);
          return <li key={candidate.id} className="recommendation-candidate">
            <span className="recommendation-candidate-rank" aria-label={candidate.position == null ? 'Not ranked' : `Rank ${candidate.position}`}>
              {candidate.position == null ? '—' : candidate.position}
            </span>
            <div className="recommendation-candidate-body">
              <div className="recommendation-candidate-title-row">
                <h3>{candidate.title}</h3>
                <span className={`recommendation-candidate-status recommendation-candidate-status--${candidate.status}`}>{statusLabel(candidate.status)}</span>
              </div>
              <p className="recommendation-candidate-meta">{KIND_LABELS[candidate.kind]}{candidate.course ? ` · ${candidate.course}` : ''}{when ? ` · ${when}` : ''}</p>
              {candidate.change && <ChangeBlocks className="recommendation-candidate-change" change={candidate.change} showConfidence />}
              <p className="recommendation-candidate-reason">{candidate.reason || 'No decision reason was supplied.'}</p>
              {candidate.eligible_at != null && <p className="recommendation-candidate-eligible">Eligible from {formatShortDay(candidate.eligible_at)} at {formatTime(candidate.eligible_at)}</p>}
              {diagnostics && candidate.ranking_score != null && <details className="recommendation-score-detail">
                <summary>Ranking details</summary>
                <span>Score {candidate.ranking_score}</span>
                {candidate.course_penalty > 0 && <span>Course variety adjustment −{candidate.course_penalty}</span>}
              </details>}
            </div>
          </li>;
        })}
      </ol>
      : <p className="recommendation-insights-state">No {filter === 'all' ? '' : filter + ' '}recommendations in this view.</p>}
  </section>;
}
