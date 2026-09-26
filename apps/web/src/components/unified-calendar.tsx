import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MapPin } from 'lucide-react';
import { fetchCalendar, previewCourseImport, readCachedCalendar, saveCourseResources } from '@/lib/api';
import { usePreferences } from '@/lib/preferences-store';
import { campusDate, formatTime } from '@/lib/time';
import type { CalendarData, CalendarEvent, CourseResource } from '@/lib/contract';
import { cn } from '@/lib/utils';

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
const shortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
function dateAtNoon(date: string) { return new Date(`${date}T12:00:00Z`); }
function distinctSubtitle(event: CalendarEvent) {
  const subtitle = event.subtitle.trim();
  const description = event.description.trim();
  return subtitle && subtitle !== description && !description.startsWith(subtitle) ? event.subtitle : '';
}

const categoryLabel: Record<CalendarEvent['category'], string> = {
  class: 'Class', deadline: 'Due', opens: 'Opens', exam: 'Exam', office_hours: 'Office hours', event: 'Event',
};
const categoryTone: Record<CalendarEvent['category'], string> = {
  class: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  deadline: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  opens: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  exam: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  office_hours: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  event: 'border-white/15 bg-secondary/40 text-zinc-300',
};

function CalendarItem({ event, onSelectCourse }: { event: CalendarEvent; onSelectCourse: (course: string) => void }) {
  const time = event.all_day ? 'All day' : event.continues_from_previous ? 'Ongoing' : formatTime(event.starts_at);
  return (
    <li className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border-t border-border/50 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-3',
      (event.state === 'stale' || event.state === 'dead') && 'opacity-60')}>
      <span className="pt-0.5 text-xs tabular-nums text-zinc-400">{time}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', categoryTone[event.category])}>
            {categoryLabel[event.category]}
          </span>
          {event.course && <button type="button" onClick={() => onSelectCourse(event.course!)} className="text-[11px] font-semibold text-live hover:underline">{event.course}</button>}
          <span className="text-[10px] text-zinc-500">{event.source_label}</span>
          {event.category === 'opens' && event.due_at && (
            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              Due {formatTime(event.due_at)}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm font-medium leading-snug text-foreground">{event.title}</p>
        {(event.subtitle || event.location || event.description) && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-400">
            {distinctSubtitle(event) && <>{distinctSubtitle(event)}{event.location || event.description ? ' · ' : ''}</>}
            {event.location && <><MapPin className="mr-1 inline size-3" />{event.location}{event.description ? ' · ' : ''}</>}
            {event.description}
          </p>
        )}
        {event.url && (
          <a href={event.url} target="_blank" rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-live hover:underline">
            Open event <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </li>
  );
}

function CoursePanel({ group, events, onSaved }: { group: CalendarData['courses'][number]; events: CalendarEvent[]; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CourseResource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<CourseResource['kind']>('resource');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (resources: CourseResource[]) => {
    setBusy(true); setError('');
    try { await saveCourseResources(group.course, resources); onSaved(); setPreview([]); setText(''); setTitle(''); setUrl(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save resources'); }
    finally { setBusy(false); }
  };
  const importText = async () => {
    setBusy(true); setError('');
    try { const resources = await previewCourseImport(text); setPreview(resources); setSelected(resources.map((item) => item.url)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not parse this page'); }
    finally { setBusy(false); }
  };
  return <div className="border-b border-border/60 bg-secondary/20 px-4 py-4 sm:px-5">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-foreground">{group.course}</h3><p className="text-xs text-zinc-400">This week: {group.class_count} classes · {group.deadline_count} due · {group.office_hours_count} office hours</p></div>
      {group.learn_url && <a href={group.learn_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-live/40 px-2 py-1 text-xs text-live hover:bg-live/10">Open LEARN course <ExternalLink className="size-3" /></a>}
    </div>
    <div className="mt-3 grid gap-4 lg:grid-cols-2">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Course links</h4>
        {group.resources.length === 0 && <p className="mt-1 text-xs text-zinc-500">Add a textbook, syllabus, lecture page, or other link.</p>}
        <ul className="mt-1 space-y-1">{group.resources.map((resource) => <li key={resource.url} className="flex items-center gap-2 text-xs"><a href={resource.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-live hover:underline">{resource.title}</a><span className="text-zinc-500">{resource.kind}</span><button type="button" onClick={() => save(group.resources.filter((item) => item.url !== resource.url))} disabled={busy} className="ml-auto text-zinc-400 hover:text-foreground" aria-label={`Remove ${resource.title}`}>Remove</button></li>)}</ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Link title" aria-label="Link title" className="min-w-32 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" aria-label="Link URL" className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
          <select value={kind} onChange={(event) => setKind(event.target.value as CourseResource['kind'])} aria-label="Link type" className="rounded border border-border bg-background px-2 py-1 text-xs"><option value="resource">Resource</option><option value="textbook">Textbook</option><option value="learn">LEARN</option></select>
          <button type="button" disabled={busy || !title.trim() || !url.trim()} onClick={() => save([...group.resources, { title: title.trim(), url: url.trim(), kind }])} className="rounded border border-live/40 px-2 py-1 text-xs text-live disabled:opacity-40">Add</button>
        </div>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Import from LEARN or a resource list</h4>
        <p className="mt-1 text-xs text-zinc-500">While signed in, copy page content or save the page as HTML. Preview links before saving.</p>
        <textarea value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => { const html = event.clipboardData.getData('text/html'); if (html && /href\s*=/.test(html)) { event.preventDefault(); setText(html.slice(0, 100_000)); } }} placeholder="Paste page content or links here" aria-label="LEARN page content" rows={3} className="mt-2 w-full rounded border border-border bg-background p-2 text-xs" />
        <div className="flex flex-wrap items-center gap-2"><input type="file" accept=".html,.htm,.txt,text/html,text/plain" aria-label="Import an HTML or text file" className="max-w-48 text-xs text-zinc-400" onChange={async (event) => { const file = event.target.files?.[0]; if (file) setText((await file.text()).slice(0, 100_000)); }} /><button type="button" onClick={importText} disabled={busy || !text.trim()} className="rounded border border-live/40 px-2 py-1 text-xs text-live disabled:opacity-40">Preview links</button></div>
        {preview.length > 0 && <div className="mt-2 max-h-40 overflow-auto rounded border border-border p-2"><ul className="space-y-1">{preview.map((resource) => <li key={resource.url} className="text-xs"><label className="flex items-start gap-1.5"><input type="checkbox" checked={selected.includes(resource.url)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, resource.url] : current.filter((value) => value !== resource.url))} /><span className="min-w-0"><span className="block truncate text-foreground">{resource.title}</span><span className="block truncate text-zinc-500">{resource.url}</span></span></label></li>)}</ul><button type="button" disabled={busy || selected.length === 0} onClick={() => save([...group.resources, ...preview.filter((item) => selected.includes(item.url))])} className="mt-2 rounded border border-live/40 px-2 py-1 text-xs text-live disabled:opacity-40">Save {selected.length} links</button></div>}
      </div>
    </div>
    {events.length > 0 && <div className="mt-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">This week</h4><ul className="mt-1 space-y-1">{events.map((event) => <li key={event.id} className="text-xs text-zinc-300"><span className="text-zinc-500">{categoryLabel[event.category]} · {event.all_day ? 'All day' : formatTime(event.starts_at)}</span> · {event.title}{event.url && <a href={event.url} target="_blank" rel="noopener noreferrer" className="ml-2 text-live hover:underline">Open</a>}</li>)}</ul></div>}
    {error && <p role="alert" className="mt-2 text-xs text-amber-300">{error}</p>}
  </div>;
}

/** The server owns classification, enrichment, ordering, group scope, and Waterloo day grouping. */
export function UnifiedCalendar({ now }: { now: number }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedCourse, setSelectedCourse] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { preferences } = usePreferences();
  const today = campusDate(now);
  const start = shiftDate(today, weekOffset * 7);
  const query = useQuery({
    queryKey: ['calendar', start, preferences.section, preferences.groupNumber],
    queryFn: ({ signal }) => fetchCalendar(start, 7, preferences.section, preferences.groupNumber, signal),
    initialData: () => readCachedCalendar(start, preferences.section, preferences.groupNumber) ?? undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    retry: 1,
  });
  const hidden = new Set(preferences.dismissedTasks);
  const rangeLabel = `${shortDate.format(dateAtNoon(start))} – ${shortDate.format(dateAtNoon(shiftDate(start, 6)))}`;

  return (
    <section aria-label="Unified calendar" className="overflow-hidden rounded-lg border border-border/80 bg-card shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><CalendarDays className="size-4 text-live" />Calendar</h2>
          <p className="mt-0.5 text-xs text-zinc-400">Classes, deadlines and office hours · {rangeLabel}</p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setWeekOffset((value) => value - 1)} aria-label="Previous seven days"
            className="rounded-md border border-border/80 p-1.5 text-zinc-300 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live"><ChevronLeft className="size-4" /></button>
          <button type="button" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}
            className="rounded-md border border-border/80 px-2 py-1.5 text-xs text-zinc-300 hover:bg-secondary/50 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live">Today</button>
          <button type="button" onClick={() => setWeekOffset((value) => value + 1)} aria-label="Next seven days"
            className="rounded-md border border-border/80 p-1.5 text-zinc-300 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live"><ChevronRight className="size-4" /></button>
        </div>
      </div>
      {query.data && query.data.courses.length > 0 && <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-4 py-2 sm:px-5" aria-label="Courses this week">{query.data.courses.map((group) => <button key={group.course} type="button" onClick={() => setSelectedCourse((current) => current === group.course ? null : group.course)} className={cn('rounded border px-2 py-1 text-xs font-medium', selectedCourse === group.course ? 'border-live/60 bg-live/10 text-live' : 'border-border text-zinc-300 hover:bg-secondary/50')}>{group.course}</button>)}</div>}
      {query.data?.courses.find((group) => group.course === selectedCourse) && <CoursePanel key={selectedCourse} group={query.data.courses.find((group) => group.course === selectedCourse)!} events={query.data.days.flatMap((day) => day.events).filter((event, index, all) => event.course === selectedCourse && all.findIndex((other) => other.id === event.id) === index)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['calendar'] })} />}
      <div className="px-4 pb-2 sm:px-5">
        {query.data?.sources.some((source) => source.status !== 'ok') && (
          <p className="pt-3 text-xs text-amber-300">Some calendar sources need attention. Check Sources below; this schedule may be incomplete.</p>
        )}
        {query.isPending && <p className="py-5 text-sm text-zinc-400">Loading calendar…</p>}
        {query.isError && !query.data && <p className="py-5 text-sm text-amber-300">Calendar unavailable. The dashboard cards are still available.</p>}
        {query.isError && query.data && <p className="pt-3 text-xs text-amber-300">Showing the last saved calendar. Refresh failed.</p>}
        {query.data?.days.map((day) => {
          const events = day.events.filter((event) => !hidden.has(event.occurrence_id) && !(event.uid && hidden.has(event.uid)));
          return (
            <div key={day.date} className="py-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {day.date === today ? 'Today · ' : ''}{dateLabel.format(dateAtNoon(day.date))}
                <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">{events.length || 'No events'}</span>
              </h3>
               {events.length > 0 && <ul className="mt-1">{events.map((event) => <CalendarItem key={event.id} event={event} onSelectCourse={setSelectedCourse} />)}</ul>}
            </div>
          );
        })}
        {query.data?.truncated && <p className="pb-3 text-xs text-amber-300">This date range has more events than the calendar can show. Select a shorter range.</p>}
      </div>
    </section>
  );
}
