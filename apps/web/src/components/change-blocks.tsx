/**
 * A schedule change drawn as blocks: [E7 2409] → [RCH 101], [10:30am] → [11:30am].
 *
 * The server still sends a sentence (`body`) for notifications and older clients; this reads the
 * structured fields instead, so the change is legible at a glance and needs no reading.
 */
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChangeDetail } from '@/lib/contract';
import { campusDate, formatShortDay, formatTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import './change-blocks.css';

function stamp(at: number, allDay: boolean, other: number | null): string {
  if (allDay) return formatShortDay(at);
  // Only add the day when the change moves across days; otherwise the time alone is enough.
  return other != null && campusDate(other) !== campusDate(at) ? `${formatShortDay(at)} ${formatTime(at)}` : formatTime(at);
}

function Arrow({ before, after, label }: { before: string; after: string; label: string }) {
  return <span className="change-row" role="img" aria-label={`${label}: ${before} to ${after}`}>
    <span className="change-block change-block--before">{before}</span>
    <ArrowRight className="change-arrow" size={13} aria-hidden />
    <span className="change-block change-block--after">{after}</span>
  </span>;
}

export function ChangeBlocks({ change, className, showConfidence = false }: { change: ChangeDetail; className?: string; showConfidence?: boolean }) {
  const rows: ReactNode[] = [];
  const roomMoved = change.previous_location && change.previous_location !== change.location;
  if (roomMoved) {
    rows.push(<Arrow key="room" label={change.kind === 'unusual_room' ? 'Different room' : 'Room changed'}
      before={change.previous_location} after={change.location || '—'} />);
  }
  if (change.previous_at != null) {
    rows.push(<Arrow key="time" label="Time changed"
      before={stamp(change.previous_at, change.all_day, change.current_at)}
      after={change.current_at != null ? stamp(change.current_at, change.all_day, change.previous_at) : '—'} />);
  }
  if (change.kind === 'cancelled' || change.kind === 'removed') {
    rows.push(<span key="gone" className="change-row">
      <span className="change-block change-block--gone">{change.kind === 'cancelled' ? 'Cancelled' : 'Not in calendar'}</span>
    </span>);
  }
  if (change.kind === 'tutorial_work') {
    rows.push(<span key="online" className="change-row">
      <span className="change-block change-block--after">Online work</span>
    </span>);
  }
  if (!rows.length) return null;
  return <span className={cn('change-blocks', className)}>
    {rows}
    {change.confidence === 'check' && <span className={showConfidence ? 'change-confidence' : 'sr-only'}>Unconfirmed · check the source</span>}
  </span>;
}

/** The ChangeDetail view of a calendar alert, which carries the same fields flat. */
export function alertChange(alert: {
  kind: ChangeDetail['kind']; previous_location: string; location: string; confidence: ChangeDetail['confidence'];
  previous_at?: number | null; current_at?: number | null; all_day?: boolean;
}): ChangeDetail {
  return {
    kind: alert.kind, previous_location: alert.previous_location, location: alert.location, confidence: alert.confidence,
    previous_at: alert.previous_at ?? null, current_at: alert.current_at ?? null, all_day: alert.all_day ?? false,
  };
}
