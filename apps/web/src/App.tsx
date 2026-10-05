import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, ExternalLink, Settings2, Star, WifiOff, X } from 'lucide-react';
import { SearchField } from '@/components/ui/search-field';
import { RefreshButton } from '@/components/ui/refresh-button';
import { CustomizationSheet } from '@/components/customization-sheet';
import { readGuideProgress } from '@/lib/setup-guide';
import { SetupChecklist } from '@/components/setup-checklist';
import { AiMenuSummary } from '@/components/ai-menu-summary';
import { CourseDetailContent } from '@/components/course-detail-content';
import { BlurFade } from '@/components/ui/blur-fade';
import { BlurFadeDisclosure } from '@/components/ui/blur-fade-disclosure';
import { CAMPUS_DINING_LOCATIONS, getOutletLocation } from '@/components/cards/food';
import { matchDiningDish, matchDiningOutlet, useDiningRecommendation } from '@/components/use-dining-recommendation';
import { dismissAlert, fetchCalendar, fetchCurrentWeather, fetchPostedMenu, fetchRecommendations, fetchSetupStatus, getToken, readCachedCalendar, readCachedRecommendations, RelayError, saveRecommendationAction, triggerPoll } from '@/lib/api';
import { useDashboard, useNow } from '@/hooks/use-dashboard';
import { usePreferences } from '@/lib/preferences-store';
import { campusDate, countdown, formatDay, formatShortDay, formatTime, shortAge } from '@/lib/time';
import type { AlertData, CalendarData, CalendarEvent, CardState, DueSoonData, DueSoonItem, NextCommitmentData, RecommendationItem } from '@/lib/contract';
import './dashboard.css';

function cleanTitle(value: string): string {
  return value.replace(/\s+(?:[-–—]\s*)?Available\s*$/i, '').replace(/\s+(?:[-–—]\s*)?Due\s*$/i, '').replace(/\s+[-–—]\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\s*$/i, '').replace(/\s*[-–]\s*Residence Dining Hall\s*$/i, '').trim();
}
function heroTitleSize(value: string): number {
  return Math.round(Math.max(28, Math.min(47, 51 - Math.max(0, [...cleanTitle(value)].length - 18) * 0.42)));
}
function recommendationBody(item: RecommendationItem): string {
  return item.kind === 'food' ? item.body.replace(/^AI picks?:\s*/i, '') : item.body;
}
function kindLabel(item: RecommendationItem): string {
  return ({ office_hours: 'Office hours', focus: 'Study window', learning: 'Learning', food: 'Lunch', change: 'Schedule update' } as Record<string, string>)[item.kind] ?? item.kind;
}
function isAiFood(item: RecommendationItem): boolean {
  return item.kind === 'food' && item.source_label === 'Cached dining recommendation';
}
function timing(item: RecommendationItem, now: number): string {
  if (item.kind === 'change') return `${item.state === 'stale' || item.state === 'dead' ? 'Cached · ' : ''}${item.starts_at ? formatShortDay(item.starts_at) : 'Schedule update'}`;
  if (item.starts_at && item.ends_at && item.starts_at <= now && item.ends_at > now) return 'In progress, ends ' + formatTime(item.ends_at);
  if (item.due_at) {
    const dueDay = campusDate(item.due_at);
    const today = campusDate(now);
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const label = dueDay === today ? 'today' : dueDay === tomorrow ? 'tomorrow' : formatShortDay(item.due_at);
    return 'Due ' + label + ' at ' + formatTime(item.due_at);
  }
  if (item.starts_at) return 'Starts ' + countdown(item.starts_at, now) + ' at ' + formatTime(item.starts_at);
  if (item.scheduled_date) return (item.kind === 'task' ? 'Due ' : 'Scheduled ') + formatShortDay(Date.parse(item.scheduled_date + 'T12:00:00Z')) + (item.kind === 'task' ? ' · time not supplied' : '');
  return 'For today';
}
function shortTiming(item: RecommendationItem, now: number): string {
  const at = item.due_at ?? item.starts_at;
  if (!at) return '';
  const day = campusDate(at), today = campusDate(now);
  if (day === today) return 'Today';
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  return day === tomorrow ? 'Tomorrow' : formatShortDay(at);
}
function progress(item: RecommendationItem, now: number): number | null {
  if (item.kind === 'change') return null;
  if (!item.starts_at || !item.ends_at || now < item.starts_at || now > item.ends_at) return null;
  return Math.round(((now - item.starts_at) / (item.ends_at - item.starts_at)) * 100);
}
function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
function shortDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
function weekendDateParts(satDate: string, sunDate: string): { month: string; days: string } {
  const sat = new Date(satDate + 'T12:00:00Z');
  const sun = new Date(sunDate + 'T12:00:00Z');
  const satMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'long' }).format(sat);
  const sunMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'long' }).format(sun);
  const satDay = sat.getUTCDate();
  const sunDay = sun.getUTCDate();

  if (satMonth === sunMonth) {
    return {
      month: satMonth,
      days: `${satDay} – ${sunDay}`,
    };
  }
  return {
    month: `${satMonth} ${satDay} –`,
    days: `${sunMonth} ${sunDay}`,
  };
}
function countLabel(count: number, singular: string, plural = singular + 's'): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function refreshIssue(sourceId: string, error: string | undefined, outcome: string): string {
  const source = ({
    'uw-learn-ics': 'LEARN',
    'uw-portal-ics': 'Schedule',
    'uw-food-daily-menu': 'Dining',
    'user-office-hours': 'Office hours',
  } as Record<string, string>)[sourceId] ?? sourceId.replace(/-/g, ' ');
  const reason = /not authenticated|unauthorized/i.test(error ?? '') ? 'sign-in needed'
    : /timed? out/i.test(error ?? '') ? 'timed out'
      : /rate limit|\b429\b/i.test(error ?? '') ? 'rate limited'
        : error || outcome;
  return `${source}: ${reason}`;
}
function refreshRequestIssue(message: string): string {
  if (/token rejected/i.test(message)) return 'Token rejected';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'Relay unreachable';
  return message.length <= 34 ? message : 'Refresh failed';
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function isWeekendDay(dateStr?: string): boolean {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return false;
  const day = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return day === 0 || day === 6;
}
function calendarTime(event: CalendarEvent): string {
  if (event.all_day) return event.category === 'deadline' || event.category === 'exam' ? 'Date only' : 'All day';
  return formatTime(event.starts_at);
}
function calendarKind(event: CalendarEvent): string {
  if (event.category === 'deadline') return /quiz/i.test(event.title) ? 'Quiz due' : 'Due';
  return event.category.replace('_', ' ');
}
function distinctCalendarSubtitle(event: CalendarEvent): string {
  const subtitle = event.subtitle.trim();
  const description = event.description.trim();
  // Portal class feeds copy their description into the short subtitle field.
  // Keep one readable description and preserve the room as its own line.
  if (!subtitle || subtitle === description || description.startsWith(subtitle)) return '';
  return event.subtitle;
}
function useExitingPresence<T>(value: T | null | undefined, durationMs = 220): { item: T | null; isClosing: boolean } {
  const [item, setItem] = useState<T | null>(value ?? null);
  const [isClosing, setIsClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (value) {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setItem(value);
      setIsClosing(false);
    } else if (item && !isClosing) {
      setIsClosing(true);
      timerRef.current = window.setTimeout(() => {
        setItem(null);
        setIsClosing(false);
        timerRef.current = null;
      }, durationMs);
    }
  }, [value, item, isClosing, durationMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return { item, isClosing };
}

function AnimatedUndoToast({
  lastHidden,
  onUndo,
  onDismiss,
}: {
  lastHidden: { id: string; title: string } | null;
  onUndo: (id: string) => void;
  onDismiss: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [activeItem, setActiveItem] = useState(lastHidden);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastHidden) {
      setActiveItem(lastHidden);
      setClosing(false);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setClosing(true);
        timerRef.current = window.setTimeout(() => {
          setActiveItem(null);
          setClosing(false);
          onDismiss();
        }, 180);
      }, 7800);
      return () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
      };
    } else if (activeItem && !closing) {
      setClosing(true);
      timerRef.current = window.setTimeout(() => {
        setActiveItem(null);
        setClosing(false);
      }, 180);
      return () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
      };
    }
  }, [lastHidden, activeItem, closing, onDismiss]);

  if (!activeItem) return null;

  const handleUndo = () => {
    setClosing(true);
    window.setTimeout(() => {
      onUndo(activeItem.id);
      setActiveItem(null);
      setClosing(false);
    }, 180);
  };

  return (
    <BlurFade as="div" className={'undo-toast' + (closing ? ' is-closing' : '')} role="status" duration={0.3} offset={8} blur="5px">
      <span>Hidden: {activeItem.title}</span>
      <button onClick={handleUndo}>Undo</button>
    </BlurFade>
  );
}

function RecommendationDetail({ item, isClosing, onClose, onAction }: { item: RecommendationItem; isClosing?: boolean; onClose: () => void; onAction: (action: 'done' | 'snooze') => void }) {
  const course = item.course;
  return <BlurFade as="section" className={'rec-detail' + (isAiFood(item) ? ' rec-detail--ai' : '') + (isClosing ? ' is-closing' : '')} duration={0.3} offset={8} blur="5px" aria-label={'Details for ' + cleanTitle(item.title)}>
    <div className="rec-detail-head">
      <div>
        {!isAiFood(item) && <span className="neutral-label">{kindLabel(item)}</span>}
        <h3>{cleanTitle(item.title)}</h3>
        {course && <p className="rec-detail-course">{course}</p>}
      </div>
      <button className="close-detail" onClick={onClose} aria-label="Close recommendation details"><X size={17} /></button>
    </div>
    {isAiFood(item) ? <p>{recommendationBody(item)}</p> : <CourseDetailContent
      description={recommendationBody(item)} topics={item.topics} readings={item.readings}
    />}
    <div className="rec-detail-actions">
      {item.kind === 'food'
        ? <a className="solid-action" href="#menu">View menu</a>
        : item.action && <a className="solid-action" href={item.action.url} target="_blank" rel="noopener noreferrer">{item.action.label}<ExternalLink size={15} /></a>}
      {item.can_complete && <button className="quiet-action" onClick={() => onAction('done')}><Check size={15} /> Mark done</button>}
      <button className="quiet-action" onClick={() => onAction('snooze')}>Remind me in an hour</button>
    </div>
    <BlurFadeDisclosure className="rec-evidence" summary="Source details"><p>{item.source_label}. {item.evidence || 'No additional source details.'}</p></BlurFadeDisclosure>
  </BlurFade>;
}

function NextCommitment({ data, state, now }: { data?: NextCommitmentData; state?: CardState; now: number }) {
  if (!data) return null;
  const label = state === 'failed' || state === 'degraded' ? 'Schedule unavailable' : ({ deadline: 'Next due', exam: 'Next exam', class: 'Next class', office_hours: 'Next office hours' } as Record<string, string>)[data.kind || ''] || 'Next on your schedule';
  const sourceAge = state === 'stale' || state === 'dead' ? ' · Saved schedule' : '';
  if (!data.starts_at) return <div className="next-commitment next-commitment-empty"><span>{label}</span><strong>{data.title || 'Nothing scheduled'}</strong>{data.subtitle && <small>{data.subtitle}</small>}</div>;
  const when = campusDate(data.starts_at) === campusDate(now) ? 'Today' : campusDate(data.starts_at) === shiftDate(campusDate(now), 1) ? 'Tomorrow' : formatShortDay(data.starts_at);
  return <BlurFadeDisclosure className="next-commitment" contentClassName="next-commitment-detail" summary={<><span>{label}</span><strong>{cleanTitle(data.title)}</strong><small>{when}{data.all_day ? ' · Date only' : ' · ' + formatTime(data.starts_at)}{data.location ? ' · ' + data.location : ''}{sourceAge}</small><ChevronRight size={15} /></>}>{data.subtitle && <p>{data.subtitle}</p>}{data.following && <p>Then: {cleanTitle(data.following.title)}{data.following.starts_at ? ' · ' + formatShortDay(data.following.starts_at) + (data.following.all_day ? '' : ' ' + formatTime(data.following.starts_at)) : ''}{data.following.location ? ' · ' + data.following.location : ''}</p>}{data.weather && !data.weather.error && data.weather.temp_c != null && <p>At that time: {Math.round(data.weather.temp_c)}°C{data.weather.feels_c != null ? ' · feels ' + Math.round(data.weather.feels_c) + '°C' : ''}{data.weather.precip_prob != null && data.weather.precip_prob > 0 ? ' · ' + Math.round(data.weather.precip_prob) + '% rain' : ''}{data.weather.wind_kmh != null && data.weather.wind_kmh >= 20 ? ' · wind ' + Math.round(data.weather.wind_kmh) + ' km/h' : ''}{data.weather.show && data.weather.reason ? ' · ' + data.weather.reason : ''}</p>}</BlurFadeDisclosure>;
}

function CalendarSection({ data, pending, error, now, page, setPage, nextCommitment, nextCommitmentState }: { data?: CalendarData; pending: boolean; error: boolean; now: number; page: number; setPage: (page: number) => void; nextCommitment?: NextCommitmentData; nextCommitmentState?: CardState }) {
  const [view, setView] = useState<'compact' | 'week' | 'full'>('compact');
  const [lastHidden, setLastHidden] = useState<{ id: string; title: string } | null>(null);
  const calendarContentRef = useRef<HTMLDivElement>(null);
  const previousRangeRef = useRef<string | null>(null);
  const { preferences, dismissTask, undismissTask } = usePreferences();
  const today = campusDate(now);
  const rangeStart = data?.start;

  useEffect(() => {
    if (!rangeStart) return;
    const range = `${view}:${rangeStart}`;
    const previousRange = previousRangeRef.current;
    previousRangeRef.current = range;
    if (!previousRange || previousRange === range || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const content = calendarContentRef.current;
    if (!content?.animate) return;
    const animation = content.animate([
      { opacity: 0.35, filter: 'blur(4px)', transform: 'translateY(5px)' },
      { opacity: 1, filter: 'none', transform: 'none' },
    ], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    return () => animation.cancel();
  }, [view, rangeStart]);

  const hidden = new Set(preferences.dismissedTasks);
  const visibleDays = data?.days.map(day => ({ ...day, events: day.events.filter(event => !hidden.has(event.occurrence_id) && !(event.uid && hidden.has(event.uid))) })) ?? [];
  const rangeLength = view === 'compact' ? 3 : view === 'week' ? 7 : 31;
  const days = view === 'full' ? visibleDays : visibleDays.slice(0, rangeLength);
  const later = visibleDays.slice(rangeLength);
  const weeks = new Map<string, CalendarEvent[]>();
  for (const day of later) for (const event of day.events) {
    if (event.category !== 'deadline' && event.category !== 'exam') continue;
    const monday = new Date(day.date + 'T12:00:00Z');
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key)!.push(event);
  }

  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const day of visibleDays) eventsByDate.set(day.date, day.events);

  type CalendarRow =
    | { kind: 'single'; date: string; events: CalendarEvent[]; isCompressedWeekend?: boolean }
    | { kind: 'weekend'; satDate: string; sunDate: string; events: Array<CalendarEvent & { dayLabel: 'Sat' | 'Sun' }> };

  const calendarRows: CalendarRow[] = [];
  for (let i = 0; i < days.length; i++) {
    const currentDay = days[i];
    const dayOfWeek = new Date(currentDay.date + 'T12:00:00Z').getUTCDay();

    if (dayOfWeek === 6) {
      const nextDay = days[i + 1];
      const isAdjacentSunday = Boolean(nextDay && nextDay.date === shiftDate(currentDay.date, 1));
      const sunEvents = eventsByDate.get(shiftDate(currentDay.date, 1)) ?? [];
      const totalWeekendCount = currentDay.events.length + sunEvents.length;

      if (totalWeekendCount < 5) {
        if (isAdjacentSunday && nextDay) {
          const satEvents = currentDay.events.map(ev => ({ ...ev, dayLabel: 'Sat' as const }));
          const sunEventsTagged = nextDay.events.map(ev => ({ ...ev, dayLabel: 'Sun' as const }));
          calendarRows.push({
            kind: 'weekend',
            satDate: currentDay.date,
            sunDate: nextDay.date,
            events: [...satEvents, ...sunEventsTagged],
          });
          i++;
          continue;
        } else {
          calendarRows.push({
            kind: 'single',
            date: currentDay.date,
            events: currentDay.events,
            isCompressedWeekend: true,
          });
          continue;
        }
      }
    } else if (dayOfWeek === 0) {
      const prevSatDate = shiftDate(currentDay.date, -1);
      const satEvents = eventsByDate.get(prevSatDate) ?? [];
      const totalWeekendCount = satEvents.length + currentDay.events.length;

      if (totalWeekendCount < 5) {
        calendarRows.push({
          kind: 'single',
          date: currentDay.date,
          events: currentDay.events,
          isCompressedWeekend: true,
        });
        continue;
      }
    }

    calendarRows.push({
      kind: 'single',
      date: currentDay.date,
      events: currentDay.events,
      isCompressedWeekend: false,
    });
  }

  const renderCalendarEvent = (event: CalendarEvent, dayBadge?: string) => (
    <BlurFadeDisclosure className="calendar-event" key={`${event.id}:${dayBadge ?? ''}`} contentClassName="calendar-event-detail" summary={<>
        <span className="calendar-time">
          {dayBadge && <span className="calendar-day-badge">{dayBadge}</span>}
          {calendarTime(event)}
        </span>
        <span className="calendar-event-title">
          <strong>{cleanTitle(event.title)}</strong>
          <span className="course-tag">{event.course || 'Course not identified'}</span>
          <span className={'event-tag event-' + event.category}>{event.attendance === 'replaced' ? 'Replaced' : calendarKind(event)}</span>
          {event.attendance !== 'replaced' && data?.alerts?.some(alert => alert.event_id === event.id) && <span className="calendar-change-tag">{data.alerts.find(alert => alert.event_id === event.id)?.kind === 'unusual_room' ? `Different room · ${event.location}` : data.alerts.find(alert => alert.event_id === event.id)?.kind === 'room' ? `Room changed · ${event.location || 'check source'}` : event.attendance === 'check_instructions' ? 'Check instructions' : 'Updated'}</span>}
        </span>
        <ChevronRight className="calendar-item-chevron" size={14} />
      </>}>
        {event.all_day && (event.category === 'deadline' || event.category === 'exam') && <p>No exact time was supplied.</p>}
        {event.category === 'opens' && event.due_at && <p><strong>Due:</strong> {formatShortDay(event.due_at)} · {formatTime(event.due_at)}</p>}
        {distinctCalendarSubtitle(event) && <p>{distinctCalendarSubtitle(event)}</p>}
        {event.location && !data?.alerts?.some(alert => alert.event_id === event.id && ['room', 'unusual_room'].includes(alert.kind)) && <p>{event.attendance === 'replaced' ? 'Original room · ' : ''}{event.location}</p>}
        {data?.alerts?.filter(alert => alert.event_id === event.id).map(alert => <p className="calendar-change-text" key={alert.id}>{alert.body}{['stale', 'dead'].includes(alert.state) ? ' · Cached; check source.' : ''}</p>)}
        {(event.group_scope.section != null || event.group_scope.groups != null) && <p>{[event.group_scope.section != null ? `Section ${event.group_scope.section}` : null, event.group_scope.groups != null ? `Groups ${event.group_scope.groups[0]}–${event.group_scope.groups[1]}` : null].filter(Boolean).join(' · ')}</p>}
        <CourseDetailContent description={event.description} topics={event.topics} readings={event.readings}
          syllabusScope={event.syllabus_scope} syllabusEvidence={event.syllabus_evidence} />
        <div className="calendar-event-footer">
        <small>{event.source_label}{event.state !== 'live' ? ' · ' + event.state : ''}</small>
        <div className="calendar-event-actions">
          {event.links.map((link, index) => <a key={link.url + index} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} /></a>)}
          {event.url && !event.links.some(link => link.url === event.url) && <a href={event.url} target="_blank" rel="noopener noreferrer">Open event<ExternalLink size={12} /></a>}
          {!event.url && event.links.length === 0 && data?.courses.find(course => course.course === event.course)?.learn_url && <a href={data.courses.find(course => course.course === event.course)!.learn_url!} target="_blank" rel="noopener noreferrer">Open course<ExternalLink size={12} /></a>}
          <button onClick={() => { const id = event.occurrence_id || event.uid || event.id; dismissTask(id); setLastHidden({ id, title: cleanTitle(event.title) }); }}>Hide event</button>
        </div>
        </div>
    </BlurFadeDisclosure>
  );

  return <BlurFade as="section" className="content-section" id="calendar" inView duration={0.45} offset={10} blur="6px" direction="up">
    <div className={'section-head calendar-section-head' + (view === 'full' ? ' is-full' : '')}>
      <h2>Calendar</h2>
      {view === 'full' && <nav className="calendar-navigation" aria-label="31-day calendar dates"><button onClick={() => setPage(page - 1)} aria-label="Previous 31 days"><ChevronLeft size={15} /></button><span>{shortDateLabel(data?.start ?? today)} – {shortDateLabel(data?.end ? shiftDate(data.end, -1) : shiftDate(today, 30))}</span><button onClick={() => setPage(page + 1)} aria-label="Next 31 days"><ChevronRight size={15} /></button>{page !== 0 && <button onClick={() => setPage(0)}>Today</button>}</nav>}
      {data && <div className="calendar-range" role="group" aria-label="Calendar range" style={{ '--calendar-range-offset': `${({ compact: 0, week: 1, full: 2 }[view]) * 100}%` } as CSSProperties}>
        <button type="button" aria-controls="calendar-day-list" aria-pressed={view === 'compact'} onClick={() => { setView('compact'); setPage(0); }}>3 days</button>
        <button type="button" aria-controls="calendar-day-list" aria-pressed={view === 'week'} onClick={() => { setView('week'); setPage(0); }}>7 days</button>
        <button type="button" aria-controls="calendar-day-list" aria-pressed={view === 'full'} onClick={() => setView('full')}>31 days</button>
      </div>}
    </div>
    <div className={'section-panel calendar-panel' + (view === 'full' ? ' is-full' : '')}>
      {page === 0 && nextCommitment && <BlurFade as="div" className="next-commitment-fade" duration={0.42} offset={7} blur="4px"><NextCommitment data={nextCommitment} state={nextCommitmentState} now={now} /></BlurFade>}
      <div className="calendar-view-content" ref={calendarContentRef}>
      {pending && <p className="empty-state">Loading calendar…</p>}
      {error && !data && <p className="empty-state" role="alert">Calendar is unavailable right now.</p>}
      {data && calendarRows.length === 0 && <p className="empty-state">No events in the next {view === 'full' ? '31' : rangeLength} days.</p>}
      {data?.alerts?.filter(alert => ['cancelled', 'removed'].includes(alert.kind) && campusDate(alert.starts_at) < shiftDate(rangeStart ?? today, rangeLength)).map(alert => <p className="calendar-change-summary" key={alert.id}><strong>{alert.title}</strong><span>{alert.body}</span>{alert.url && <a href={alert.url} target="_blank" rel="noopener noreferrer">Check source <ExternalLink size={12} /></a>}</p>)}
      <div className="calendar-day-list" id="calendar-day-list">
      {calendarRows.map(row => {
        if (row.kind === 'weekend') {
          const weekendDates = weekendDateParts(row.satDate, row.sunDate);
          return (
            <div className="calendar-day calendar-day--weekend-compressed" key={row.satDate}>
              <div className="calendar-date calendar-date--weekend">
                <span className="calendar-date-split">
                  <span>{weekendDates.month}</span>
                  <span className="calendar-date-days">{weekendDates.days}</span>
                </span>
                <small>Weekend · {row.events.length ? countLabel(row.events.length, 'event') : 'Clear'}</small>
              </div>
              <div className="calendar-events calendar-events--weekend">
                {row.events.length ? (
                  row.events.map(event => renderCalendarEvent(event, event.dayLabel))
                ) : (
                  <p className="calendar-clear calendar-clear--weekend">Nothing scheduled this weekend.</p>
                )}
              </div>
            </div>
          );
        }
        return (
          <div className={'calendar-day' + (row.isCompressedWeekend ? ' calendar-day--weekend-compressed' : '')} key={row.date}>
            <div className={'calendar-date' + (row.isCompressedWeekend ? ' calendar-date--weekend' : '')}>
              <span>{row.date === today ? 'Today' : dateLabel(row.date)}</span>
              <small>{row.isCompressedWeekend ? 'Weekend · ' : ''}{row.events.length ? countLabel(row.events.length, 'event') : 'Clear'}</small>
            </div>
            <div className="calendar-events">
              {row.events.length ? (
                row.events.map(event => renderCalendarEvent(event))
              ) : (
                <p className={'calendar-clear' + (row.isCompressedWeekend ? ' calendar-clear--weekend' : '')}>Nothing scheduled.</p>
              )}
            </div>
          </div>
        );
      })}
      </div>
      {view !== 'full' && weeks.size > 0 && <div className="calendar-weeks"><span>Deadlines and exams ahead</span>{[...weeks.entries()].slice(0, 4).map(([date, events]) => <div className="calendar-week" key={date}><strong>Week of {shortDateLabel(date)}</strong><p>{events.slice(0, 2).map(event => cleanTitle(event.title)).join(' · ')}{events.length > 2 ? ' · +' + (events.length - 2) + ' more' : ''}</p></div>)}</div>}
      {data?.truncated && <p className="calendar-notice">The calendar feed has more events than can be shown in this range.</p>}
      {data?.sources.some(source => source.status !== 'ok') && <p className="calendar-notice">Some calendar sources need attention. The schedule may be incomplete.</p>}
      </div>
      <AnimatedUndoToast lastHidden={lastHidden} onUndo={(id) => { undismissTask(id); setLastHidden(null); }} onDismiss={() => setLastHidden(null)} />
    </div>
  </BlurFade>;
}

function DueWorkSection({ data }: { data?: DueSoonData }) {
  const [lastHidden, setLastHidden] = useState<{ id: string; title: string } | null>(null);
  const { preferences, dismissTask, undismissTask } = usePreferences();
  if (!data) return null;
  const hidden = new Set(preferences.dismissedTasks);
  const isVisible = (item: DueSoonItem) => !hidden.has(item.occurrence_id || '') && !hidden.has(item.uid || '');
  const near = [...(data.due ?? data.items ?? []), ...(data.opens ?? [])].filter(isVisible).sort((a, b) => a.starts_at - b.starts_at);
  const ahead = (data.ahead ?? []).map(group => ({ ...group, items: group.items.filter(isVisible) })).filter(group => group.items.length > 0);
  const renderTask = (item: DueSoonItem) => <BlurFadeDisclosure className="work-item" key={(item.occurrence_id || item.uid || item.title) + item.starts_at} contentClassName="work-item-detail" summary={<><span>{item.all_day ? formatShortDay(item.starts_at) : formatShortDay(item.starts_at) + ' · ' + formatTime(item.starts_at)}</span><strong>{cleanTitle(item.title)}</strong>{item.course && <small>{item.course}</small>}<em>{item.phase === 'opens' ? (item.due_at ? `Opens · Due ${formatShortDay(item.due_at)}` : 'Opens') : 'Due'}</em><ChevronRight size={14} /></>}>{item.all_day && <p>No exact time was supplied.</p>}{item.phase === 'opens' && item.due_at && <p><strong>Due:</strong> {formatShortDay(item.due_at)} · {formatTime(item.due_at)}</p>}{item.description && <p>{item.description}</p>}{item.location && <p>{item.location}</p>}<div>{item.links?.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} /></a>)}{item.url && !item.links?.some(link => link.url === item.url) && <a href={item.url} target="_blank" rel="noopener noreferrer">Open task<ExternalLink size={12} /></a>}{(item.occurrence_id || item.uid) && <button onClick={() => { const id = item.occurrence_id || item.uid!; dismissTask(id); setLastHidden({ id, title: cleanTitle(item.title) }); }}>Hide</button>}</div></BlurFadeDisclosure>;
  return <BlurFade as="section" className="content-section" id="work" inView duration={0.45} offset={10} blur="6px" direction="up"><div className="section-head"><h2>Due & opening</h2><span className="section-count">{near.filter(item => item.phase !== 'opens').length} due · {near.filter(item => item.phase === 'opens').length} opens in 7 days</span></div><div className="section-panel work-panel">{data.error && <p className="calendar-notice">{data.error}</p>}{near.length ? near.map(renderTask) : <p className="empty-state">Nothing due or opening in the next seven days.</p>}{ahead.length > 0 && <BlurFadeDisclosure className="term-work" summary={<>Later this term · {ahead.reduce((sum, group) => sum + group.items.length, 0)} major items<ChevronRight size={15} /></>}>{ahead.map(group => <div className="term-week" key={group.week_start}><h3>{group.label}</h3>{group.items.map(renderTask)}</div>)}</BlurFadeDisclosure>}<AnimatedUndoToast lastHidden={lastHidden} onUndo={(id) => { undismissTask(id); setLastHidden(null); }} onDismiss={() => setLastHidden(null)} /></div></BlurFade>;
}

function MenuSection() {
  const queryClient = useQueryClient();
  const { preferences, isFavoriteDish, toggleFavoriteDish, isFavoriteOutlet, toggleFavoriteOutlet, setDishSearchQuery } = usePreferences();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [refreshStatus, setRefreshStatus] = useState('');
  useEffect(() => {
    if (refreshStatus !== 'Updated') return;
    const timer = window.setTimeout(() => setRefreshStatus(''), 2200);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);
  const [selectedDay, setSelectedDay] = useState<'today' | 'tomorrow'>('today');
  const todayDate = useMemo(() => {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }, []);
  const tomorrowDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }, []);
  const activeDate = selectedDay === 'tomorrow' ? tomorrowDate : undefined;

  const menu = useQuery({ queryKey: ['posted-menu', selectedDay], queryFn: ({ signal }) => fetchPostedMenu(activeDate, signal), refetchInterval: 5 * 60_000, staleTime: 60_000 });
  const diningRecommendation = useDiningRecommendation(menu.data?.service_date ?? undefined);
  const groups = new Map<string, NonNullable<typeof menu.data>['items']>();
  const search = preferences.dishSearchQuery.trim().toLowerCase();
  for (const dish of menu.data?.items ?? []) {
    if (preferences.dietaryFilter !== 'all' && !dish.diet.some(tag => tag.toLowerCase() === preferences.dietaryFilter)) continue;
    if (preferences.onlyFavorites && !isFavoriteDish(dish.dish)) continue;
    if (search && ![dish.dish, dish.outlet, dish.station, ...dish.allergens].some(value => value.toLowerCase().includes(search))) continue;
    if (!groups.has(dish.outlet)) groups.set(dish.outlet, []);
    groups.get(dish.outlet)!.push(dish);
  }
  if (menu.data) for (const outlet of preferences.favoriteOutlets) if ((!search || outlet.toLowerCase().includes(search)) && !groups.has(outlet) && preferences.dietaryFilter === 'all' && !preferences.onlyFavorites) groups.set(outlet, []);
  const rankedRecommendation = diningRecommendation.state.status === 'ready'
    ? diningRecommendation.state.recommendation
    : undefined;
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    const rankA = matchDiningOutlet(rankedRecommendation, a)?.rank ?? Number.POSITIVE_INFINITY;
    const rankB = matchDiningOutlet(rankedRecommendation, b)?.rank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB || Number(isFavoriteOutlet(b)) - Number(isFavoriteOutlet(a)) || a.localeCompare(b);
  });
  const refresh = async () => {
    setRefreshing(true); setRefreshError(''); setRefreshStatus('Checking menu…');
    try {
      const result = await triggerPoll('uw-food-daily-menu');
      await queryClient.invalidateQueries({ queryKey: ['posted-menu'] });
      const issue = result.receipts.find(receipt => receipt.outcome !== 'ok' && receipt.outcome !== 'empty' && receipt.outcome !== 'skipped');
      if (issue) throw new Error(refreshIssue(issue.source_id, issue.error, issue.outcome));
      const viewError = queryClient.getQueryState(['posted-menu', selectedDay])?.error;
      if (viewError) throw viewError;
      const foodReceipt = result.receipts.find(receipt => receipt.source_id === 'uw-food-daily-menu');
      if (foodReceipt?.outcome === 'empty' || foodReceipt?.outcome === 'skipped') {
        const targetDay = selectedDay === 'tomorrow' ? tomorrowDate : todayDate;
        setRefreshStatus(isWeekendDay(targetDay) ? 'No weekend menu posted' : 'No menu posted yet');
      } else {
        setRefreshStatus('Updated');
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Could not refresh the menu.';
      setRefreshError(message); setRefreshStatus(refreshRequestIssue(message));
    }
    finally { setRefreshing(false); }
  };
  return <BlurFade as="section" className="content-section" id="menu" inView duration={0.45} offset={10} blur="6px" direction="up">
    <div className="section-head">
      <h2>Dining menu</h2>
      <RefreshButton label="Refresh menu" refreshing={refreshing} onRefresh={() => void refresh()} status={refreshStatus} error={refreshError} />
    </div>
    <div className="menu-controls">
      <SearchField className="menu-search" label="Search dishes or outlets" placeholder="Search dishes or outlets" clearLabel="Clear dining search" value={preferences.dishSearchQuery} onValueChange={setDishSearchQuery} />
      <div className="menu-day-select" role="group" aria-label="Menu date" style={{ '--menu-day-offset': selectedDay === 'tomorrow' ? '100%' : '0%' } as CSSProperties}>
        <button type="button" aria-pressed={selectedDay === 'today'} onClick={() => setSelectedDay('today')}>Today</button>
        <button type="button" aria-pressed={selectedDay === 'tomorrow'} onClick={() => setSelectedDay('tomorrow')}>Tomorrow</button>
      </div>
    </div>
    <BlurFade key={selectedDay} duration={0.35} offset={8} blur="6px" direction="up">
      {menu.data?.status === 'previous' && (
        <p className="menu-status">
          {isWeekendDay(menu.data.requested_date)
            ? `Food Services usually does not publish daily menus on weekends. Showing the last posted menu from ${dateLabel(menu.data.service_date!)}.`
            : `Today’s menu has not been posted yet. Showing the last posted menu from ${dateLabel(menu.data.service_date!)}.`}
        </p>
      )}
      {menu.data?.status === 'today' && (
        <p className="menu-status">
          {isWeekendDay(menu.data.service_date!)
            ? `Weekend menu for today, ${dateLabel(menu.data.service_date!)} (some locations may not publish on weekends).`
            : `Posted for today, ${dateLabel(menu.data.service_date!)}.`}
        </p>
      )}
      {menu.data?.status === 'upcoming' && (
        <p className="menu-status">
          {isWeekendDay(menu.data.service_date!)
            ? `Weekend menu for ${dateLabel(menu.data.service_date!)} (some locations may not publish on weekends).`
            : `Posted in advance for ${dateLabel(menu.data.service_date!)}.`}
        </p>
      )}
      {menu.data?.service_date && <AiMenuSummary service_date={menu.data.service_date} {...diningRecommendation} />}
      {menu.isPending && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">Loading dining menu…</BlurFade>}
      {menu.isError && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px" role="alert">Could not load the dining menu.</BlurFade>}
      {refreshError && <p className="action-error" role="alert">{refreshError}</p>}
      {menu.data?.status === 'unavailable' && (
        <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">
          {isWeekendDay(menu.data?.requested_date)
            ? 'Food Services usually does not publish daily menus on weekends. No menu is currently published for this date.'
            : 'No menu has been published in the feed yet.'}
        </BlurFade>
      )}
      {menu.data && menu.data.items.length > 0 && groups.size === 0 && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">No dishes match your dining filters.</BlurFade>}
      {groups.size > 0 && <div className="menu-grid">{sortedGroups.map(([outlet, dishes], outletIndex) => {
        const aiOutlet = diningRecommendation.state.status === 'ready'
          ? matchDiningOutlet(diningRecommendation.state.recommendation, outlet)
          : undefined;
        return <BlurFade as="article" className={'menu-outlet' + (aiOutlet?.rank === 1 ? ' menu-outlet--best' : '')} key={outlet} inView delay={Math.min(outletIndex, 5) * 0.06} duration={0.5} offset={12} blur="6px">
          <div className="menu-outlet-head"><div><h3>{getOutletLocation(outlet).name}</h3><small>{getOutletLocation(outlet).building} · {getOutletLocation(outlet).campusZone}</small>{aiOutlet?.verdict.trim() && <p className="menu-outlet-ai-verdict">{aiOutlet.verdict.trim()}</p>}</div><div><span>{dishes.length} {dishes.length === 1 ? 'dish' : 'dishes'}</span><button onClick={() => toggleFavoriteOutlet(outlet)} aria-label={(isFavoriteOutlet(outlet) ? 'Unpin ' : 'Pin ') + getOutletLocation(outlet).name} aria-pressed={isFavoriteOutlet(outlet)}><Star size={15} fill={isFavoriteOutlet(outlet) ? 'currentColor' : 'none'} /></button></div></div>
          {dishes.length ? <ul>{dishes.map((dish, index) => {
            const aiHighlight = matchDiningDish(aiOutlet, dish.dish);
            const meta = [dish.station, ...dish.diet, ...dish.allergens.map(allergen => 'Contains ' + allergen)].filter(Boolean).join(' · ');
            return <li className={aiHighlight ? 'menu-dish--ai-picked' : undefined} key={dish.dish + index}>
              <div className="menu-dish-copy"><strong>{dish.dish}</strong>{aiHighlight?.why.trim() && <small className="menu-dish-ai-why">{aiHighlight.why.trim()}</small>}{meta && <small className="menu-dish-meta">{meta}</small>}</div>
              <div className="menu-dish-actions"><button onClick={() => toggleFavoriteDish(dish.dish)} aria-label={(isFavoriteDish(dish.dish) ? 'Remove ' : 'Favorite ') + dish.dish} aria-pressed={isFavoriteDish(dish.dish)}><Star size={14} fill={isFavoriteDish(dish.dish) ? 'currentColor' : 'none'} /></button>{dish.url && <a href={dish.url} target="_blank" rel="noopener noreferrer" aria-label={'View ' + dish.dish}><ExternalLink size={14} /></a>}</div>
            </li>;
          })}</ul> : <p className="menu-outlet-empty">{selectedDay === 'tomorrow' ? 'No dishes posted here for tomorrow.' : 'No dishes posted here today.'}</p>}
        </BlurFade>;
      })}</div>}
    </BlurFade>
    <BlurFadeDisclosure className="dining-directory" contentClassName="dining-directory-list" summary="Campus dining locations">{CAMPUS_DINING_LOCATIONS.map(location => <p key={location.name}><strong>{location.name}</strong><span>{location.building} · {location.campusZone}</span></p>)}</BlurFadeDisclosure>
  </BlurFade>;
}

function CoursesSection({ data, pending, error, onManageCourse }: { data?: CalendarData; pending: boolean; error: boolean; onManageCourse: (course: string) => void }) {
  const events = data?.days.flatMap(day => day.events) ?? [];
  return <BlurFade as="section" className="content-section" id="courses" inView duration={0.45} offset={10} blur="6px" direction="up">
    <div className="section-head"><h2>Courses</h2></div>
    {pending && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">Loading courses…</BlurFade>}
    {error && !data && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px" role="alert">Courses are unavailable right now.</BlurFade>}
    {data && data.courses.length === 0 && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">No courses are in the calendar feed. Add your schedule in Settings.</BlurFade>}
    {data && data.courses.length > 0 && <div className="courses-grid">{data.courses.map(course => {
      const upcoming = [...new Map(events.filter(event => event.course === course.course).map(event => [event.id, event])).values()].slice(0, 3);
      return <BlurFade as="article" className="course-card" key={course.course} inView duration={0.45} offset={10} blur="6px">
        <div className="course-card-head"><h3>{course.course}</h3>{course.learn_url && <a href={course.learn_url} target="_blank" rel="noopener noreferrer">Open course <ExternalLink size={14} /></a>}</div>
        <p className="course-counts">In this range · {countLabel(course.class_count, 'class', 'classes')} · {countLabel(course.deadline_count, 'deadline')} · {countLabel(course.office_hours_count, 'office hour')}</p>
        {course.resources.length > 0 && <div className="course-links">{course.resources.map(resource => <a href={resource.url} key={resource.url} target="_blank" rel="noopener noreferrer">{resource.title} <ExternalLink size={12} /></a>)}</div>}
        <div className="course-upcoming"><span>Coming up</span>{upcoming.length ? upcoming.map(event => <div key={event.id}><small>{formatShortDay(event.starts_at)} · {event.all_day ? 'Date only' : formatTime(event.starts_at)}</small><strong>{event.attendance === 'replaced' ? 'Replaced · ' : ''}{cleanTitle(event.title)}</strong></div>) : <p>Nothing scheduled in this range.</p>}</div>
        <button type="button" className="course-manage" onClick={() => onManageCourse(course.course)}>Manage in Settings <ChevronRight size={14} /></button>
      </BlurFade>;
    })}</div>}
  </BlurFade>;
}

export default function App() {
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const { cards, offline, error: dashboardError, refetch } = useDashboard();
  const { preferences, setDietaryFilter, setOnlyFavorites, toggleFavoriteDish, updateTasteProfile, resetPreferences } = usePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideRequest, setGuideRequest] = useState<{ step: number; key: number }>();
  const [setupLater, setSetupLater] = useState(false);
  const [guideFinished, setGuideFinished] = useState(() => readGuideProgress().finished);
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: ({ signal }) => fetchSetupStatus(signal), retry: false, staleTime: 30_000, refetchInterval: 60_000 });
  const openGuide = (step: number) => {
    setGuideRequest(previous => ({ step, key: (previous?.key ?? 0) + 1 }));
    setSettingsOpen(true);
  };
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('setup') === 'mobile') {
      setGuideRequest({ step: 3, key: 1 });
      setSettingsOpen(true);
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get('setup') === 'mobile') {
      url.searchParams.delete('setup');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);
  const [settingsCourse, setSettingsCourse] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertError, setAlertError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const { item: visibleSyncStatus } = useExitingPresence(syncStatus || null, 300);
  const syncStatusTimer = useRef<number | null>(null);
  const [calendarPage, setCalendarPage] = useState(0);
  const todayStart = campusDate(now);
  const start = shiftDate(todayStart, calendarPage * 31);
  const recs = useQuery({
    queryKey: ['recommendations', preferences.section, preferences.groupNumber],
    queryFn: ({ signal }) => fetchRecommendations(preferences.section, preferences.groupNumber, signal),
    initialData: () => readCachedRecommendations(preferences.section, preferences.groupNumber),
    initialDataUpdatedAt: 0, staleTime: 15_000, refetchInterval: 60_000,
  });
  const calendar = useQuery({
    queryKey: ['full-calendar', start, preferences.section, preferences.groupNumber],
    queryFn: ({ signal }) => fetchCalendar(start, 31, preferences.section, preferences.groupNumber, signal),
    initialData: () => readCachedCalendar(start, preferences.section, preferences.groupNumber) ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 60_000, refetchInterval: 5 * 60_000,
  });
  const courseCalendar = useQuery({
    queryKey: ['full-calendar', todayStart, preferences.section, preferences.groupNumber],
    queryFn: ({ signal }) => fetchCalendar(todayStart, 31, preferences.section, preferences.groupNumber, signal),
    initialData: () => readCachedCalendar(todayStart, preferences.section, preferences.groupNumber) ?? undefined,
    initialDataUpdatedAt: 0,
    enabled: calendarPage !== 0,
    staleTime: 60_000,
  });
  const settingsCalendar = calendarPage === 0 ? calendar : courseCalendar;
  const signInRequired = [dashboardError, recs.error, calendar.error].some(error => error instanceof RelayError && error.status === 401);
  const connectionError = [dashboardError, recs.error, calendar.error, setup.error].find(error => error instanceof RelayError);
  const usesConnectionToken = Boolean(getToken());
  const weather = useQuery({ queryKey: ['current-weather'], queryFn: ({ signal }) => fetchCurrentWeather(signal), staleTime: 15 * 60_000, refetchInterval: 15 * 60_000 });
  const items = recs.data?.items ?? [];
  const featured = items[0];
  const nextTwo = items.slice(1, 3);
  const selected = [...items, ...(recs.data?.tasks.large ?? []), ...(recs.data?.tasks.small ?? [])].find(item => item.id === selectedId) ?? null;
  const { item: activeSelected, isClosing: isDetailClosing } = useExitingPresence(selected, 220);
  const alertCard = cards.find(card => card.type === 'alert');
  const alert = alertCard?.data as AlertData | undefined;
  const { item: activeAlert, isClosing: isAlertClosing } = useExitingPresence(alertOpen && alert && !alert.dismissed ? alert : null, 200);
  const nextCommitmentCard = cards.find(card => card.type === 'next_commitment');
  const nextCommitment = nextCommitmentCard?.data as NextCommitmentData | undefined;
  const dueWork = cards.find(card => card.type === 'due_soon')?.data as DueSoonData | undefined;
  const isOld = Boolean(recs.data && now - recs.data.generated_at > Math.max(180_000, recs.data.refresh_after_ms * 2));
  const nextTask = [...(recs.data?.tasks.large ?? []), ...(recs.data?.tasks.small ?? [])]
    .filter(item => !items.slice(0, 3).some(visible => visible.id === item.id) && (item.due_at ?? item.starts_at ?? Infinity) >= now)
    .sort((a, b) => (a.due_at ?? a.starts_at ?? Infinity) - (b.due_at ?? b.starts_at ?? Infinity))[0];
  const largestTask = (recs.data?.tasks.large ?? []).find(item => item.id !== nextTask?.id && !items.slice(0, 3).some(visible => visible.id === item.id));
  const act = async (item: RecommendationItem, action: 'done' | 'snooze') => {
    setActionError(null);
    setSelectedId(null);
    try { await saveRecommendationAction(item.id, action); await recs.refetch(); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not update recommendation.'); }
  };
  useEffect(() => () => {
    if (syncStatusTimer.current !== null) window.clearTimeout(syncStatusTimer.current);
  }, []);
  const refreshAll = async () => {
    if (syncStatusTimer.current !== null) {
      window.clearTimeout(syncStatusTimer.current);
      syncStatusTimer.current = null;
    }
    setSyncing(true); setSyncError(''); setSyncStatus('Checking sources…');
    try {
      const result = await triggerPoll();
      setSyncStatus('Updating view…');
      await queryClient.invalidateQueries();

      const sourceIssues = result.receipts.filter(receipt => receipt.outcome !== 'ok' && receipt.outcome !== 'empty');
      if (sourceIssues.length) {
        const issues = sourceIssues.map(receipt => refreshIssue(receipt.source_id, receipt.error, receipt.outcome));
        setSyncStatus(issues[0] + (issues.length > 1 ? ` +${issues.length - 1} more` : ''));
        setSyncError(issues.join(' · '));
        return;
      }

      const viewIssue = queryClient.getQueryCache().getAll().find(query =>
        query.isActive() && ['dashboard', 'recommendations', 'full-calendar'].includes(String(query.queryKey[0])) && query.state.status === 'error',
      );
      if (viewIssue) {
        const reason = viewIssue.state.error instanceof Error ? viewIssue.state.error.message : 'Could not load updated information.';
        setSyncStatus(`View: ${refreshRequestIssue(reason)}`);
        setSyncError(reason);
        return;
      }

      const queued = result.deferred?.length ?? 0;
      setSyncStatus(queued ? `${queued} queued` : result.receipts.length ? 'Updated' : 'Up to date');
      syncStatusTimer.current = window.setTimeout(() => { setSyncStatus(''); syncStatusTimer.current = null; }, 2200);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not refresh sources.';
      setSyncStatus(refreshRequestIssue(reason));
      setSyncError(reason);
    }
    finally { setSyncing(false); }
  };
  return <div className="dashboard-app"><main className="dashboard-frame">
    <section className="today-content" aria-label="Today">
      <BlurFade as="div" className="day-context" duration={0.5} offset={8} blur="4px">
        <span>{formatDay(now)} · {formatTime(now)}</span>
        {weather.data?.temp_c !== null && weather.data?.temp_c !== undefined && <span>{weather.data.temp_c}°C</span>}
        {alert && alert.count > 0 && !alert.dismissed && <button className="context-alert" onClick={() => setAlertOpen(value => !value)} aria-expanded={alertOpen}>{alert.notices?.[0]?.title || alert.summary || 'Campus service issue'}{alert.count > 1 ? ' · ' + alert.count + ' notices' : ''}</button>}
        {alert && alert.count === 0 && (alertCard?.state === 'stale' || alertCard?.state === 'dead' || alertCard?.state === 'failed') && <span className="status-unknown" role="status">{alertCard.state === 'failed' ? 'Campus status check failed' : `Campus status unknown${alert.checked_at ? ` · checked ${shortAge(alert.checked_at, now)} ago` : ''}`}</span>}
        {(offline || recs.isError || isOld) && <span className="saved-context"><WifiOff size={13} /> Saved information</span>}
        <div className="day-context-actions">
          <RefreshButton label="Refresh all sources" refreshing={syncing} onRefresh={() => void refreshAll()} status={syncStatus} visibleStatus={visibleSyncStatus ?? ''} error={syncError} />
          <span className="sr-only" role="status">{syncError || syncStatus}</span>
          <button className="top-settings" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings2 size={17} /><span>Settings</span></button>
        </div>
      </BlurFade>
      {setup.data && (setup.data.first_run || setup.data.setup_needed) && !setupLater && !guideFinished && <SetupChecklist status={setup.data} onOpen={openGuide} onDismiss={() => setSetupLater(true)} />}
      {activeAlert && <BlurFade as="section" className={'alert-detail' + (isAlertClosing ? ' is-closing' : '')} duration={0.34} offset={8} blur="5px" aria-label="Campus alert details"><div className="alert-list">{activeAlert.notices?.map((notice, index) => <article key={index}><div><span className="alert-severity">{notice.severity}</span><strong>{notice.title}</strong></div>{notice.incident_status && <small>{notice.incident_status}</small>}{notice.body && <p>{notice.body}</p>}{notice.components.length > 0 && <p>Affected: {notice.components.join(', ')}</p>}{notice.url && <a href={notice.url} target="_blank" rel="noopener noreferrer">View status <ExternalLink size={13} /></a>}</article>)}{activeAlert.checked_at && <small>Checked {shortAge(activeAlert.checked_at, now)} ago</small>}</div><div className="alert-actions">{activeAlert.key && <button onClick={async () => { try { await dismissAlert(activeAlert.key); setAlertOpen(false); refetch(); } catch { setAlertError('Could not dismiss alert.'); } }}>Dismiss</button>}</div>{alertError && <p role="alert">{alertError}</p>}</BlurFade>}
      {signInRequired && <div className="state-panel" role="alert">
        {usesConnectionToken ? 'Your connection token was refused. ' : 'Sign in again to update your dashboard. '}
        <button type="button" className="inline-link" onClick={() => usesConnectionToken ? setSettingsOpen(true) : window.location.reload()}>
          {usesConnectionToken ? 'Check connection' : 'Sign in again'}
        </button>
      </div>}
      {!signInRequired && connectionError instanceof RelayError && <div className="state-panel" role="alert">
        {connectionError.message}{' '}
        <button type="button" className="inline-link" onClick={() => { void Promise.all([refetch(), recs.refetch(), calendar.refetch(), setup.refetch()]); }}>Try again</button>
      </div>}
      {recs.isPending && <BlurFade as="div" className="state-panel hero-loading" duration={0.42} offset={10} blur="5px" aria-busy="true">Finding your next move…</BlurFade>}
      {recs.isError && !recs.data && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px" role="alert">Recommendations are unavailable. <button className="inline-link" onClick={() => void recs.refetch()}>Try again</button></BlurFade>}
      {recs.data && !featured && <BlurFade as="div" className="state-panel" duration={0.42} offset={10} blur="5px">{recs.data.headline}.</BlurFade>}
      {featured && <div className="recommendation-grid">
        <BlurFade as="article" className={'hero-rec' + (isAiFood(featured) ? ' hero-rec--ai' : '')} duration={0.58} delay={0.06} offset={14} blur="7px">
          <div className="hero-primary">
            {!isAiFood(featured) && <span className="neutral-label">{kindLabel(featured)}</span>}
            <button className="hero-main" onClick={() => setSelectedId(selectedId === featured.id ? null : featured.id)} aria-expanded={selectedId === featured.id} aria-label={'See details for ' + cleanTitle(featured.title)}><h1 style={{ '--hero-title-max': `${heroTitleSize(featured.title)}px` } as CSSProperties}>{cleanTitle(featured.title)}</h1><p>{featured.kind === 'change' ? recommendationBody(featured) : featured.course || recommendationBody(featured).split('.')[0]}</p><ChevronRight size={18} /></button>
            {progress(featured, now) !== null ? <div className="event-timeline"><span>{formatTime(featured.starts_at!)}</span><div className="progress-wrap" role="progressbar" aria-valuenow={progress(featured, now)!} aria-valuemin={0} aria-valuemax={100} aria-label="Current event progress"><span style={{ width: progress(featured, now) + '%' }} /></div><span>{formatTime(featured.ends_at!)}</span></div> : <p className="hero-due">{timing(featured, now)}</p>}
          </div>
          <button className="hero-next" onClick={() => nextTask && setSelectedId(nextTask.id)} disabled={!nextTask}><span>Next</span><strong>{nextTask ? cleanTitle(nextTask.title) : 'Nothing else due soon'}</strong>{nextTask && <small>{shortTiming(nextTask, now)}</small>}</button>
        </BlurFade>
        <BlurFade as="section" className="more-recs" aria-label="More recommendations" duration={0.58} delay={0.14} offset={14} blur="7px"><span className="more-label">More for today</span>
          {nextTwo.length ? nextTwo.map(item => <button key={item.id} className={'more-rec-row' + (isAiFood(item) ? ' more-rec-row--ai' : '')} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)} aria-expanded={selectedId === item.id}><strong>{cleanTitle(item.title)}</strong><small>{timing(item, now)}</small><ChevronRight className="more-chevron" size={17} /></button>) : <p className="muted-note">Nothing else needs your attention right now.</p>}
          {largestTask && <button className="largest-task-row" onClick={() => setSelectedId(largestTask.id)}><span>Largest upcoming task</span><strong>{cleanTitle(largestTask.title)}</strong><small>{timing(largestTask, now)}</small></button>}
        </BlurFade>
      </div>}
      {activeSelected && <RecommendationDetail item={activeSelected} isClosing={isDetailClosing} onClose={() => setSelectedId(null)} onAction={action => void act(activeSelected, action)} />}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {recs.data?.warnings && recs.data.warnings.length > 0 && <BlurFade as="div" className="warning-strip" duration={0.4} offset={8} blur="4px"><BlurFadeDisclosure summary={`${recs.data.warnings.length} ${recs.data.warnings.length === 1 ? 'source warning needs' : 'source warnings need'} attention`}><ul>{recs.data.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></BlurFadeDisclosure></BlurFade>}
      {recs.data && <p className="data-note">Updated {shortAge(recs.data.generated_at, now)} ago{recs.isError ? ' · Refresh failed' : ''}</p>}
    </section>
    <CalendarSection data={calendar.data} pending={calendar.isPending} error={calendar.isError} now={now} page={calendarPage} setPage={setCalendarPage} nextCommitment={nextCommitment} nextCommitmentState={nextCommitmentCard?.state} />
    <DueWorkSection data={dueWork} />
    <MenuSection />
    <CoursesSection data={settingsCalendar.data} pending={settingsCalendar.isPending} error={settingsCalendar.isError} onManageCourse={(course) => { setSettingsCourse(course); setSettingsOpen(true); }} />
  </main>
  <CustomizationSheet
    open={settingsOpen}
    onOpenChange={(open) => { setSettingsOpen(open); if (!open) { setSettingsCourse(null); setGuideFinished(readGuideProgress().finished); } }}
    guideRequest={guideRequest}
    hideTrigger
    preferences={preferences}
    courseData={settingsCalendar.data}
    courseDataPending={settingsCalendar.isPending}
    courseDataError={settingsCalendar.isError}
    focusCourse={settingsCourse}
    onRetryCourseData={() => { void settingsCalendar.refetch(); }}
    onCourseDataSaved={() => {
      void queryClient.invalidateQueries({ queryKey: ['full-calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['recommendations'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }}
    setDietaryFilter={setDietaryFilter}
    setOnlyFavorites={setOnlyFavorites}
    toggleFavoriteDish={toggleFavoriteDish}
    updateTasteProfile={updateTasteProfile}
    resetPreferences={resetPreferences}
  />
  </div>;
}
