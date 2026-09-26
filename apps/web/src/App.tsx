import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Settings2, Star, WifiOff, X } from 'lucide-react';
import { CustomizationSheet } from '@/components/customization-sheet';
import { AiMenuSummary } from '@/components/ai-menu-summary';
import { CAMPUS_DINING_LOCATIONS, getOutletLocation } from '@/components/cards/food';
import { matchDiningDish, matchDiningOutlet, useDiningRecommendation } from '@/components/use-dining-recommendation';
import { dismissAlert, fetchCalendar, fetchCurrentWeather, fetchPostedMenu, fetchRecommendations, readCachedCalendar, readCachedRecommendations, saveRecommendationAction, triggerPoll } from '@/lib/api';
import { useDashboard, useNow } from '@/hooks/use-dashboard';
import { usePreferences } from '@/lib/preferences-store';
import { campusDate, countdown, formatDay, formatShortDay, formatTime, shortAge } from '@/lib/time';
import type { AlertData, CalendarData, CalendarEvent, CardState, DueSoonData, DueSoonItem, NextCommitmentData, RecommendationItem } from '@/lib/contract';
import './dashboard.css';

function cleanTitle(value: string): string {
  return value.replace(/\s+(?:[-–—]\s*)?Due\s*$/i, '').replace(/\s+[-–—]\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\s*$/i, '').replace(/\s*[-–]\s*Residence Dining Hall\s*$/i, '').trim();
}
function heroTitleSize(value: string): number {
  return Math.round(Math.max(28, Math.min(47, 51 - Math.max(0, [...cleanTitle(value)].length - 18) * 0.42)));
}
function recommendationBody(item: RecommendationItem): string {
  return item.kind === 'food' ? item.body.replace(/^AI picks?:\s*/i, '') : item.body;
}
function kindLabel(item: RecommendationItem): string {
  return ({ office_hours: 'Office hours', focus: 'Study window', learning: 'Learning', food: 'Lunch' } as Record<string, string>)[item.kind] ?? item.kind;
}
function isAiFood(item: RecommendationItem): boolean {
  return item.kind === 'food' && item.source_label === 'Cached dining recommendation';
}
function timing(item: RecommendationItem, now: number): string {
  if (item.starts_at && item.ends_at && item.starts_at <= now && item.ends_at > now) return 'In progress, ends ' + formatTime(item.ends_at);
  if (item.due_at) {
    const dueDay = campusDate(item.due_at);
    const today = campusDate(now);
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const label = dueDay === today ? 'today' : dueDay === tomorrow ? 'tomorrow' : formatShortDay(item.due_at);
    return 'Due ' + label + ' at ' + formatTime(item.due_at);
  }
  if (item.starts_at) return 'Starts in ' + countdown(item.starts_at, now) + ' at ' + formatTime(item.starts_at);
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
  if (!item.starts_at || !item.ends_at || now < item.starts_at || now > item.ends_at) return null;
  return Math.round(((now - item.starts_at) / (item.ends_at - item.starts_at)) * 100);
}
function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
function shortDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
function countLabel(count: number, singular: string, plural = singular + 's'): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
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
function useReveal() {
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('[data-reveal]');
    if (!('IntersectionObserver' in window)) { sections.forEach(section => section.classList.add('is-visible')); return; }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: 0.06, rootMargin: '0px 0px -35px 0px' });
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);
}

function RecommendationDetail({ item, onClose, onAction }: { item: RecommendationItem; onClose: () => void; onAction: (action: 'done' | 'snooze') => void }) {
  return <section className={'rec-detail' + (isAiFood(item) ? ' rec-detail--ai' : '')} aria-label={'Details for ' + cleanTitle(item.title)}>
    <div className="rec-detail-head"><div>{!isAiFood(item) && <span className="neutral-label">{kindLabel(item)}</span>}<h3>{cleanTitle(item.title)}</h3></div><button className="close-detail" onClick={onClose} aria-label="Close recommendation details"><X size={17} /></button></div>
    <p>{recommendationBody(item)}</p>
    {(item.topics.length > 0 || item.readings.length > 0) && <div className="rec-detail-list">
      {item.topics.length > 0 && <p><strong>Topics</strong> {item.topics.join(', ')}</p>}
      {item.readings.length > 0 && <p><strong>Readings</strong> {item.readings.join(', ')}</p>}
    </div>}
    <div className="rec-detail-actions">
      {item.kind === 'food'
        ? <a className="solid-action" href="#menu">View menu</a>
        : item.action && <a className="solid-action" href={item.action.url} target="_blank" rel="noopener noreferrer">{item.action.label}<ExternalLink size={15} /></a>}
      {item.can_complete && <button className="quiet-action" onClick={() => onAction('done')}><Check size={15} /> Mark done</button>}
      <button className="quiet-action" onClick={() => onAction('snooze')}>Remind me in an hour</button>
    </div>
    <details className="rec-evidence"><summary>Source details</summary><p>{item.source_label}. {item.evidence || 'No additional source details.'}</p></details>
  </section>;
}

function NextCommitment({ data, state, now }: { data?: NextCommitmentData; state?: CardState; now: number }) {
  if (!data) return null;
  const label = state === 'failed' || state === 'degraded' ? 'Schedule unavailable' : ({ deadline: 'Next due', exam: 'Next exam', class: 'Next class', office_hours: 'Next office hours' } as Record<string, string>)[data.kind || ''] || 'Next on your schedule';
  const sourceAge = state === 'stale' || state === 'dead' ? ' · Saved schedule' : '';
  if (!data.starts_at) return <div className="next-commitment next-commitment-empty"><span>{label}</span><strong>{data.title || 'Nothing scheduled'}</strong>{data.subtitle && <small>{data.subtitle}</small>}</div>;
  const when = campusDate(data.starts_at) === campusDate(now) ? 'Today' : campusDate(data.starts_at) === shiftDate(campusDate(now), 1) ? 'Tomorrow' : formatShortDay(data.starts_at);
  return <details className="next-commitment"><summary><span>{label}</span><strong>{cleanTitle(data.title)}</strong><small>{when}{data.all_day ? ' · Date only' : ' · ' + formatTime(data.starts_at)}{data.location ? ' · ' + data.location : ''}{sourceAge}</small><ChevronRight size={15} /></summary><div className="next-commitment-detail">{data.subtitle && <p>{data.subtitle}</p>}{data.following && <p>Then: {cleanTitle(data.following.title)}{data.following.starts_at ? ' · ' + formatShortDay(data.following.starts_at) + (data.following.all_day ? '' : ' ' + formatTime(data.following.starts_at)) : ''}{data.following.location ? ' · ' + data.following.location : ''}</p>}{data.weather && !data.weather.error && data.weather.temp_c != null && <p>At that time: {Math.round(data.weather.temp_c)}°C{data.weather.feels_c != null ? ' · feels ' + Math.round(data.weather.feels_c) + '°C' : ''}{data.weather.precip_prob != null && data.weather.precip_prob > 0 ? ' · ' + Math.round(data.weather.precip_prob) + '% rain' : ''}{data.weather.wind_kmh != null && data.weather.wind_kmh >= 20 ? ' · wind ' + Math.round(data.weather.wind_kmh) + ' km/h' : ''}{data.weather.show && data.weather.reason ? ' · ' + data.weather.reason : ''}</p>}</div></details>;
}

function CalendarSection({ data, pending, error, now, page, setPage, nextCommitment, nextCommitmentState }: { data?: CalendarData; pending: boolean; error: boolean; now: number; page: number; setPage: (page: number) => void; nextCommitment?: NextCommitmentData; nextCommitmentState?: CardState }) {
  const [view, setView] = useState<'compact' | 'week' | 'full'>('compact');
  const [lastHidden, setLastHidden] = useState<{ id: string; title: string } | null>(null);
  const { preferences, dismissTask, undismissTask } = usePreferences();
  useEffect(() => { if (!lastHidden) return; const timer = window.setTimeout(() => setLastHidden(null), 8000); return () => window.clearTimeout(timer); }, [lastHidden]);
  const today = campusDate(now);
  const hidden = new Set(preferences.dismissedTasks);
  const visibleDays = data?.days.map(day => ({ ...day, events: day.events.filter(event => !hidden.has(event.occurrence_id) && !(event.uid && hidden.has(event.uid))) })) ?? [];
  const rangeLength = view === 'compact' ? 2 : view === 'week' ? 7 : 31;
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
  return <section className="content-section" id="calendar" data-reveal>
    <div className="section-head"><h2>Calendar</h2>{view === 'full' && <nav className="calendar-navigation" aria-label="31-day calendar dates"><button onClick={() => setPage(page - 1)} aria-label="Previous 31 days"><ChevronLeft size={15} /></button><span>{shortDateLabel(data?.start ?? today)} – {shortDateLabel(data?.end ? shiftDate(data.end, -1) : shiftDate(today, 30))}</span><button onClick={() => setPage(page + 1)} aria-label="Next 31 days"><ChevronRight size={15} /></button>{page !== 0 && <button onClick={() => setPage(0)}>Today</button>}</nav>}</div>
    <div className={'section-panel calendar-panel' + (view === 'full' ? ' is-full' : '')}>
      {page === 0 && <NextCommitment data={nextCommitment} state={nextCommitmentState} now={now} />}
      {pending && <p className="empty-state">Loading calendar…</p>}
      {error && !data && <p className="empty-state" role="alert">Calendar is unavailable right now.</p>}
      {data && days.length === 0 && <p className="empty-state">No events in the next {view === 'full' ? '31' : rangeLength} days.</p>}
      <div className="calendar-day-list" id="calendar-day-list">
      {days.map(day => <div className="calendar-day" key={day.date}>
        <div className="calendar-date"><span>{day.date === today ? 'Today' : dateLabel(day.date)}</span><small>{day.events.length ? day.events.length + (day.events.length === 1 ? ' event' : ' events') : 'Clear'}</small></div>
        <div className="calendar-events">{day.events.length ? day.events.map(event => <details className="calendar-event" key={event.id}>
          <summary><span className="calendar-time">{calendarTime(event)}</span><span className="calendar-event-title"><strong>{cleanTitle(event.title)}</strong><span className="course-tag">{event.course || 'Course not identified'}</span><span className={'event-tag event-' + event.category}>{calendarKind(event)}</span></span><ChevronRight className="calendar-item-chevron" size={14} /></summary>
          <div className="calendar-event-detail">
            {event.all_day && (event.category === 'deadline' || event.category === 'exam') && <p>No exact time was supplied.</p>}
            {distinctCalendarSubtitle(event) && <p>{distinctCalendarSubtitle(event)}</p>}
            {event.location && <p>{event.location}</p>}
            {(event.group_scope.section != null || event.group_scope.groups != null) && <p>{[event.group_scope.section != null ? `Section ${event.group_scope.section}` : null, event.group_scope.groups != null ? `Groups ${event.group_scope.groups[0]}–${event.group_scope.groups[1]}` : null].filter(Boolean).join(' · ')}</p>}
            {event.description && <p>{event.description}</p>}
            {event.topics && event.topics.length > 0 && <p><strong>{event.syllabus_scope === 'period' ? 'Topics for this period' : 'Topics'}</strong> · {event.topics.join(', ')}</p>}
            {event.readings && event.readings.length > 0 && <p><strong>Readings</strong> · {event.readings.join(', ')}</p>}
            {event.syllabus_evidence && event.syllabus_evidence.length > 0 && <details className="calendar-evidence"><summary>Syllabus source text</summary>{event.syllabus_evidence.map((line, index) => <p key={index}>{line}</p>)}</details>}
            <small>{event.source_label}{event.state !== 'live' ? ' · ' + event.state : ''}</small>
            <div className="calendar-event-actions">{event.links.map((link, index) => <a key={link.url + index} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} /></a>)}{event.url && !event.links.some(link => link.url === event.url) && <a href={event.url} target="_blank" rel="noopener noreferrer">Open event<ExternalLink size={12} /></a>}{!event.url && event.links.length === 0 && data?.courses.find(course => course.course === event.course)?.learn_url && <a href={data.courses.find(course => course.course === event.course)!.learn_url!} target="_blank" rel="noopener noreferrer">Open course<ExternalLink size={12} /></a>}<button onClick={() => { const id = event.occurrence_id || event.uid || event.id; dismissTask(id); setLastHidden({ id, title: cleanTitle(event.title) }); }}>Hide event</button></div>
          </div>
        </details>) : <p className="calendar-clear">Nothing scheduled.</p>}
        </div>
      </div>)}
      </div>
      {view !== 'full' && weeks.size > 0 && <div className="calendar-weeks"><span>Deadlines and exams ahead</span>{[...weeks.entries()].slice(0, 4).map(([date, events]) => <div className="calendar-week" key={date}><strong>Week of {shortDateLabel(date)}</strong><p>{events.slice(0, 2).map(event => cleanTitle(event.title)).join(' · ')}{events.length > 2 ? ' · +' + (events.length - 2) + ' more' : ''}</p></div>)}</div>}
      {data && <div className="calendar-view-controls">
        {view === 'compact' && <button className="calendar-mode-step" onClick={() => setView('week')} aria-controls="calendar-day-list" aria-expanded={false}>Show 7 days</button>}
        {view === 'week' && <button className="calendar-mode-step" onClick={() => { setView('compact'); setPage(0); }} aria-controls="calendar-day-list" aria-expanded={true} aria-label="Collapse calendar to today and tomorrow">Show 2 days</button>}
        {view !== 'full' && <button className="calendar-expand" onClick={() => setView('full')} aria-controls="calendar-day-list" aria-expanded={false}>Show full calendar<ChevronRight size={16} /></button>}
        {view === 'full' && <button className="calendar-expand" onClick={() => { setView('compact'); setPage(0); }} aria-controls="calendar-day-list" aria-expanded={true} aria-label="Collapse calendar to today and tomorrow">Show 2 days<ChevronLeft size={16} /></button>}
      </div>}
      {data?.truncated && <p className="calendar-notice">The calendar feed has more events than can be shown in this range.</p>}
      {data?.sources.some(source => source.status !== 'ok') && <p className="calendar-notice">Some calendar sources need attention. The schedule may be incomplete.</p>}
      {lastHidden && <div className="undo-toast" role="status"><span>Hidden: {lastHidden.title}</span><button onClick={() => { undismissTask(lastHidden.id); setLastHidden(null); }}>Undo</button></div>}
    </div>
  </section>;
}

function DueWorkSection({ data }: { data?: DueSoonData }) {
  const [lastHidden, setLastHidden] = useState<{ id: string; title: string } | null>(null);
  const { preferences, dismissTask, undismissTask } = usePreferences();
  useEffect(() => { if (!lastHidden) return; const timer = window.setTimeout(() => setLastHidden(null), 8000); return () => window.clearTimeout(timer); }, [lastHidden]);
  if (!data) return null;
  const hidden = new Set(preferences.dismissedTasks);
  const isVisible = (item: DueSoonItem) => !hidden.has(item.occurrence_id || '') && !hidden.has(item.uid || '');
  const near = [...(data.due ?? data.items ?? []), ...(data.opens ?? [])].filter(isVisible).sort((a, b) => a.starts_at - b.starts_at);
  const ahead = (data.ahead ?? []).map(group => ({ ...group, items: group.items.filter(isVisible) })).filter(group => group.items.length > 0);
  const renderTask = (item: DueSoonItem) => <details className="work-item" key={(item.occurrence_id || item.uid || item.title) + item.starts_at}><summary><span>{item.all_day ? formatShortDay(item.starts_at) : formatShortDay(item.starts_at) + ' · ' + formatTime(item.starts_at)}</span><strong>{cleanTitle(item.title)}</strong>{item.course && <small>{item.course}</small>}<em>{item.phase === 'opens' ? 'Opens' : 'Due'}</em><ChevronRight size={14} /></summary><div className="work-item-detail">{item.all_day && <p>No exact time was supplied.</p>}{item.description && <p>{item.description}</p>}{item.location && <p>{item.location}</p>}<div>{item.links?.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12} /></a>)}{item.url && !item.links?.some(link => link.url === item.url) && <a href={item.url} target="_blank" rel="noopener noreferrer">Open task<ExternalLink size={12} /></a>}{(item.occurrence_id || item.uid) && <button onClick={() => { const id = item.occurrence_id || item.uid!; dismissTask(id); setLastHidden({ id, title: cleanTitle(item.title) }); }}>Hide</button>}</div></div></details>;
  return <section className="content-section" id="work" data-reveal><div className="section-head"><h2>Due & opening</h2><span className="section-count">{near.filter(item => item.phase !== 'opens').length} due · {near.filter(item => item.phase === 'opens').length} opens in 7 days</span></div><div className="section-panel work-panel">{data.error && <p className="calendar-notice">{data.error}</p>}{near.length ? near.map(renderTask) : <p className="empty-state">Nothing due or opening in the next seven days.</p>}{ahead.length > 0 && <details className="term-work"><summary>Later this term · {ahead.reduce((sum, group) => sum + group.items.length, 0)} major items<ChevronRight size={15} /></summary>{ahead.map(group => <div className="term-week" key={group.week_start}><h3>{group.label}</h3>{group.items.map(renderTask)}</div>)}</details>}{lastHidden && <div className="undo-toast" role="status"><span>Hidden: {lastHidden.title}</span><button onClick={() => { undismissTask(lastHidden.id); setLastHidden(null); }}>Undo</button></div>}</div></section>;
}

function MenuSection() {
  const queryClient = useQueryClient();
  const { preferences, isFavoriteDish, toggleFavoriteDish, isFavoriteOutlet, toggleFavoriteOutlet, setDishSearchQuery } = usePreferences();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [selectedOutlet, setSelectedOutlet] = useState('all');
  const menu = useQuery({ queryKey: ['posted-menu'], queryFn: ({ signal }) => fetchPostedMenu(signal), refetchInterval: 5 * 60_000, staleTime: 60_000 });
  const diningRecommendation = useDiningRecommendation(menu.data?.service_date ?? undefined);
  const groups = new Map<string, NonNullable<typeof menu.data>['items']>();
  const search = preferences.dishSearchQuery.trim().toLowerCase();
  for (const dish of menu.data?.items ?? []) {
    if (preferences.dietaryFilter !== 'all' && !dish.diet.some(tag => tag.toLowerCase() === preferences.dietaryFilter)) continue;
    if (preferences.onlyFavorites && !isFavoriteDish(dish.dish)) continue;
    if (search && ![dish.dish, dish.outlet, dish.station, ...dish.allergens].some(value => value.toLowerCase().includes(search))) continue;
    if (selectedOutlet !== 'all' && selectedOutlet !== dish.outlet) continue;
    if (!groups.has(dish.outlet)) groups.set(dish.outlet, []);
    groups.get(dish.outlet)!.push(dish);
  }
  const outlets = [...new Set([...(menu.data?.items.map(item => item.outlet) ?? []), ...preferences.favoriteOutlets])].sort((a, b) => Number(isFavoriteOutlet(b)) - Number(isFavoriteOutlet(a)) || a.localeCompare(b));
  if (menu.data) for (const outlet of preferences.favoriteOutlets) if ((!search || outlet.toLowerCase().includes(search)) && (selectedOutlet === 'all' || selectedOutlet === outlet) && !groups.has(outlet) && preferences.dietaryFilter === 'all' && !preferences.onlyFavorites) groups.set(outlet, []);
  const rankedRecommendation = diningRecommendation.state.status === 'ready'
    ? diningRecommendation.state.recommendation
    : undefined;
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    const rankA = matchDiningOutlet(rankedRecommendation, a)?.rank ?? Number.POSITIVE_INFINITY;
    const rankB = matchDiningOutlet(rankedRecommendation, b)?.rank ?? Number.POSITIVE_INFINITY;
    return rankA - rankB || Number(isFavoriteOutlet(b)) - Number(isFavoriteOutlet(a)) || a.localeCompare(b);
  });
  const refresh = async () => {
    setRefreshing(true); setRefreshError('');
    try { await triggerPoll('uw-food-daily-menu'); await queryClient.invalidateQueries({ queryKey: ['posted-menu'] }); }
    catch (error) { setRefreshError(error instanceof Error ? error.message : 'Could not refresh the menu.'); }
    finally { setRefreshing(false); }
  };
  return <section className="content-section" id="menu" data-reveal>
    <div className="section-head"><h2>Dining menu</h2><button className="section-control" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} /> Refresh menu</button></div>
    {menu.data?.status === 'previous' && <p className="menu-status">Today’s menu has not been posted. Showing the last posted menu from {dateLabel(menu.data.service_date!)}.</p>}
    {menu.data?.status === 'today' && <p className="menu-status">Posted for today, {dateLabel(menu.data.service_date!)}.</p>}
    {menu.data?.service_date && <AiMenuSummary service_date={menu.data.service_date} {...diningRecommendation} />}
    {menu.data && <div className="menu-controls"><input type="search" aria-label="Search dishes or outlets" placeholder="Search dishes or outlets" value={preferences.dishSearchQuery} onChange={event => setDishSearchQuery(event.target.value)} /><div className="menu-outlet-select" aria-label="Dining outlets"><button aria-pressed={selectedOutlet === 'all'} onClick={() => setSelectedOutlet('all')}>All outlets</button>{outlets.map(outlet => <button key={outlet} aria-pressed={selectedOutlet === outlet} onClick={() => setSelectedOutlet(outlet)}>{getOutletLocation(outlet).name}</button>)}</div></div>}
    {menu.isPending && <p className="state-panel">Loading dining menu…</p>}
    {menu.isError && <p className="state-panel" role="alert">Could not load the dining menu.</p>}
    {refreshError && <p className="action-error" role="alert">{refreshError}</p>}
    {menu.data?.status === 'unavailable' && <p className="state-panel">No menu has been published in the feed yet.</p>}
    {menu.data && menu.data.items.length > 0 && groups.size === 0 && <p className="state-panel">No dishes match your dining filters.</p>}
    {groups.size > 0 && <div className="menu-grid">{sortedGroups.map(([outlet, dishes]) => {
      const aiOutlet = diningRecommendation.state.status === 'ready'
        ? matchDiningOutlet(diningRecommendation.state.recommendation, outlet)
        : undefined;
      return <article className={'menu-outlet' + (aiOutlet?.rank === 1 ? ' menu-outlet--best' : '')} key={outlet}>
        <div className="menu-outlet-head"><div><h3>{getOutletLocation(outlet).name}</h3><small>{getOutletLocation(outlet).building} · {getOutletLocation(outlet).campusZone}</small>{aiOutlet?.verdict.trim() && <p className="menu-outlet-ai-verdict">{aiOutlet.verdict.trim()}</p>}</div><div><span>{dishes.length} {dishes.length === 1 ? 'dish' : 'dishes'}</span><button onClick={() => toggleFavoriteOutlet(outlet)} aria-label={(isFavoriteOutlet(outlet) ? 'Unpin ' : 'Pin ') + getOutletLocation(outlet).name} aria-pressed={isFavoriteOutlet(outlet)}><Star size={15} fill={isFavoriteOutlet(outlet) ? 'currentColor' : 'none'} /></button></div></div>
        {dishes.length ? <ul>{dishes.map((dish, index) => {
          const aiHighlight = matchDiningDish(aiOutlet, dish.dish);
          const meta = [dish.station, ...dish.diet, ...dish.allergens.map(allergen => 'Contains ' + allergen)].filter(Boolean).join(' · ');
          return <li className={aiHighlight ? 'menu-dish--ai-picked' : undefined} key={dish.dish + index}>
            <div className="menu-dish-copy"><strong>{dish.dish}</strong>{aiHighlight?.why.trim() && <small className="menu-dish-ai-why">{aiHighlight.why.trim()}</small>}{meta && <small className="menu-dish-meta">{meta}</small>}</div>
            <div className="menu-dish-actions"><button onClick={() => toggleFavoriteDish(dish.dish)} aria-label={(isFavoriteDish(dish.dish) ? 'Remove ' : 'Favorite ') + dish.dish} aria-pressed={isFavoriteDish(dish.dish)}><Star size={14} fill={isFavoriteDish(dish.dish) ? 'currentColor' : 'none'} /></button>{dish.url && <a href={dish.url} target="_blank" rel="noopener noreferrer" aria-label={'View ' + dish.dish}><ExternalLink size={14} /></a>}</div>
          </li>;
        })}</ul> : <p className="menu-outlet-empty">No dishes posted here today.</p>}
      </article>;
    })}</div>}
    <details className="dining-directory"><summary>Campus dining locations</summary><div>{CAMPUS_DINING_LOCATIONS.map(location => <p key={location.name}><strong>{location.name}</strong><span>{location.building} · {location.campusZone}</span></p>)}</div></details>
  </section>;
}

function CoursesSection({ data, pending, error, onManageCourse }: { data?: CalendarData; pending: boolean; error: boolean; onManageCourse: (course: string) => void }) {
  const events = data?.days.flatMap(day => day.events) ?? [];
  return <section className="content-section" id="courses" data-reveal>
    <div className="section-head"><h2>Courses</h2></div>
    {pending && <p className="state-panel">Loading courses…</p>}
    {error && !data && <p className="state-panel" role="alert">Courses are unavailable right now.</p>}
    {data && data.courses.length === 0 && <p className="state-panel">No courses are in the calendar feed. Add your schedule in Settings.</p>}
    {data && data.courses.length > 0 && <div className="courses-grid">{data.courses.map(course => {
      const upcoming = events.filter(event => event.course === course.course).slice(0, 3);
      return <article className="course-card" key={course.course}>
        <div className="course-card-head"><h3>{course.course}</h3>{course.learn_url && <a href={course.learn_url} target="_blank" rel="noopener noreferrer">Open course <ExternalLink size={14} /></a>}</div>
        <p className="course-counts">In this range · {countLabel(course.class_count, 'class', 'classes')} · {countLabel(course.deadline_count, 'deadline')} · {countLabel(course.office_hours_count, 'office hour')}</p>
        {course.resources.length > 0 && <div className="course-links">{course.resources.map(resource => <a href={resource.url} key={resource.url} target="_blank" rel="noopener noreferrer">{resource.title} <ExternalLink size={12} /></a>)}</div>}
        <div className="course-upcoming"><span>Coming up</span>{upcoming.length ? upcoming.map(event => <div key={event.id}><small>{formatShortDay(event.starts_at)} · {event.all_day ? 'Date only' : formatTime(event.starts_at)}</small><strong>{cleanTitle(event.title)}</strong></div>) : <p>Nothing scheduled in this range.</p>}</div>
        <button type="button" className="course-manage" onClick={() => onManageCourse(course.course)}>Manage in Settings <ChevronRight size={14} /></button>
      </article>;
    })}</div>}
  </section>;
}

export default function App() {
  useReveal();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const { cards, offline, refetch } = useDashboard();
  const { preferences, setDietaryFilter, setOnlyFavorites, toggleFavoriteDish, updateTasteProfile, resetPreferences } = usePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCourse, setSettingsCourse] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertError, setAlertError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
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
  const weather = useQuery({ queryKey: ['current-weather'], queryFn: ({ signal }) => fetchCurrentWeather(signal), staleTime: 15 * 60_000, refetchInterval: 15 * 60_000 });
  const items = recs.data?.items ?? [];
  const featured = items[0];
  const nextTwo = items.slice(1, 3);
  const selected = [...items, ...(recs.data?.tasks.large ?? []), ...(recs.data?.tasks.small ?? [])].find(item => item.id === selectedId) ?? null;
  const alertCard = cards.find(card => card.type === 'alert');
  const alert = alertCard?.data as AlertData | undefined;
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
    try { await saveRecommendationAction(item.id, action); setSelectedId(null); await recs.refetch(); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not update recommendation.'); }
  };
  const refreshAll = async () => {
    setSyncing(true); setSyncError('');
    try { await triggerPoll(); await queryClient.invalidateQueries(); }
    catch (error) { setSyncError(error instanceof Error ? error.message : 'Could not refresh sources.'); }
    finally { setSyncing(false); }
  };
  return <div className="dashboard-app"><main className="dashboard-frame">
    <section className="today-content" aria-label="Today">
      <div className="day-context">
        <span>{formatDay(now)} · {formatTime(now)}</span>
        {weather.data?.temp_c !== null && weather.data?.temp_c !== undefined && <span>{weather.data.temp_c}°C</span>}
        {alert && alert.count > 0 && !alert.dismissed && <button className="context-alert" onClick={() => setAlertOpen(value => !value)} aria-expanded={alertOpen}>{alert.notices?.[0]?.title || alert.summary || 'Campus service issue'}{alert.count > 1 ? ' · ' + alert.count + ' notices' : ''}</button>}
        {alert && alert.count === 0 && (alertCard?.state === 'stale' || alertCard?.state === 'dead' || alertCard?.state === 'failed') && <span className="status-unknown" role="status">{alertCard.state === 'failed' ? 'Campus status check failed' : `Campus status unknown${alert.checked_at ? ` · checked ${shortAge(alert.checked_at, now)} ago` : ''}`}</span>}
        {(offline || recs.isError || isOld) && <span className="saved-context"><WifiOff size={13} /> Saved information</span>}
        <div className="day-context-actions">
          <button className="top-refresh" onClick={() => void refreshAll()} disabled={syncing} aria-label="Refresh all sources" title="Refresh all sources"><RefreshCw size={16} className={syncing ? 'spinning' : ''} /></button>
          <button className="top-settings" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings2 size={17} /><span>Settings</span></button>
        </div>
      </div>
      {alertOpen && alert && !alert.dismissed && <section className="alert-detail" aria-label="Campus alert details"><div className="alert-list">{alert.notices?.map((notice, index) => <article key={index}><div><span className="alert-severity">{notice.severity}</span><strong>{notice.title}</strong></div>{notice.incident_status && <small>{notice.incident_status}</small>}{notice.body && <p>{notice.body}</p>}{notice.components.length > 0 && <p>Affected: {notice.components.join(', ')}</p>}{notice.url && <a href={notice.url} target="_blank" rel="noopener noreferrer">View status <ExternalLink size={13} /></a>}</article>)}{alert.checked_at && <small>Checked {shortAge(alert.checked_at, now)} ago</small>}</div><div className="alert-actions">{alert.key && <button onClick={async () => { try { await dismissAlert(alert.key); setAlertOpen(false); refetch(); } catch { setAlertError('Could not dismiss alert.'); } }}>Dismiss</button>}</div>{alertError && <p role="alert">{alertError}</p>}</section>}
      {syncError && <p className="action-error" role="alert">{syncError}</p>}
      {recs.isPending && <div className="state-panel hero-loading" aria-busy="true">Finding your next move…</div>}
      {recs.isError && !recs.data && <div className="state-panel" role="alert">Recommendations are unavailable. <button className="inline-link" onClick={() => void recs.refetch()}>Try again</button></div>}
      {recs.data && !featured && <div className="state-panel">{recs.data.headline}.</div>}
      {featured && <div className="recommendation-grid">
        <article className={'hero-rec' + (isAiFood(featured) ? ' hero-rec--ai' : '')}>
          <div className="hero-primary">
            {!isAiFood(featured) && <span className="neutral-label">{kindLabel(featured)}</span>}
            <button className="hero-main" onClick={() => setSelectedId(selectedId === featured.id ? null : featured.id)} aria-expanded={selectedId === featured.id} aria-label={'See details for ' + cleanTitle(featured.title)}><h1 style={{ '--hero-title-max': `${heroTitleSize(featured.title)}px` } as CSSProperties}>{cleanTitle(featured.title)}</h1><p>{featured.course || recommendationBody(featured).split('.')[0]}</p><ChevronRight size={18} /></button>
            {progress(featured, now) !== null ? <div className="event-timeline"><span>{formatTime(featured.starts_at!)}</span><div className="progress-wrap" role="progressbar" aria-valuenow={progress(featured, now)!} aria-valuemin={0} aria-valuemax={100} aria-label="Current event progress"><span style={{ width: progress(featured, now) + '%' }} /></div><span>{formatTime(featured.ends_at!)}</span></div> : <p className="hero-due">{timing(featured, now)}</p>}
          </div>
          <button className="hero-next" onClick={() => nextTask && setSelectedId(nextTask.id)} disabled={!nextTask}><span>Next</span><strong>{nextTask ? cleanTitle(nextTask.title) : 'Nothing else due soon'}</strong>{nextTask && <small>{shortTiming(nextTask, now)}</small>}</button>
        </article>
        <section className="more-recs" aria-label="More recommendations"><span className="more-label">More for today</span>
          {nextTwo.length ? nextTwo.map(item => <button key={item.id} className={'more-rec-row' + (isAiFood(item) ? ' more-rec-row--ai' : '')} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)} aria-expanded={selectedId === item.id}><strong>{cleanTitle(item.title)}</strong><small>{timing(item, now)}</small><ChevronRight className="more-chevron" size={17} /></button>) : <p className="muted-note">Nothing else needs your attention right now.</p>}
          {largestTask && <button className="largest-task-row" onClick={() => setSelectedId(largestTask.id)}><span>Largest upcoming task</span><strong>{cleanTitle(largestTask.title)}</strong><small>{timing(largestTask, now)}</small></button>}
        </section>
      </div>}
      {selected && <RecommendationDetail item={selected} onClose={() => setSelectedId(null)} onAction={action => void act(selected, action)} />}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {recs.data?.warnings && recs.data.warnings.length > 0 && <details className="warning-strip"><summary>{recs.data.warnings.length} source updates need attention</summary><ul>{recs.data.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      {recs.data && <p className="data-note">Updated {shortAge(recs.data.generated_at, now)} ago{recs.isError ? ' · Refresh failed' : ''}</p>}
    </section>
    <CalendarSection data={calendar.data} pending={calendar.isPending} error={calendar.isError} now={now} page={calendarPage} setPage={setCalendarPage} nextCommitment={nextCommitment} nextCommitmentState={nextCommitmentCard?.state} />
    <DueWorkSection data={dueWork} />
    <MenuSection />
    <CoursesSection data={settingsCalendar.data} pending={settingsCalendar.isPending} error={settingsCalendar.isError} onManageCourse={(course) => { setSettingsCourse(course); setSettingsOpen(true); }} />
  </main>
  <CustomizationSheet
    open={settingsOpen}
    onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsCourse(null); }}
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
