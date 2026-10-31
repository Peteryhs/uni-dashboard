import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, TriangleAlert } from 'lucide-react';
import { departureTimes, transitDate } from '#contract/transit.mjs';
import { BlurFade } from '@/components/ui/blur-fade';
import { BlurFadeDisclosure } from '@/components/ui/blur-fade-disclosure';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { activateCommute, cancelCommute, deleteCommute, fetchCommutes, fetchTransitStops, saveCommute, refreshTransit } from '@/lib/api';
import { useOffline } from '@/lib/connectivity';
import { formatTime, shortAge } from '@/lib/time';
import { usePreferences } from '@/lib/preferences-store';
import { commuteSummary, describeTransitError, emptyCommute, leaveLabel, MAX_COMMUTES, stopMeta, suggestedCommuteName, type Commute, type CommuteDraft, type TransitData, type TransitStop } from '@/lib/transit';
import './transit.css';

const GRT_OPEN_DATA = 'https://www.grt.ca/about-grt/open-data/';
type Departure = TransitData['journeys'][number]['departures'][number];

export function TransitSection({ data, now, onManage }: { data?: TransitData | null; now: number; onManage: () => void }) {
  const offline = useOffline(), client = useQueryClient();
  const { preferences } = usePreferences();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (id?: string) => {
    setBusy(true); setError('');
    try { if (id) await activateCommute(id, preferences.section, preferences.groupNumber); else await cancelCommute(); await client.invalidateQueries({ queryKey: ['recommendations'] }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update commute.'); } finally { setBusy(false); }
  };
  const guidance = !offline && data?.guidance && now < data.guidance.expires_at ? data.guidance : null;
  const target = data?.target && data.target.starts_at > now && transitDate(data.target.starts_at) === transitDate(now) ? data.target : null;
  const activation = target && data?.activation?.date === transitDate(now) ? data.activation : null;
  const commutes = data?.commutes ?? [];
  const failures = data?.error ? describeTransitError(data.error) : [];
  const age = data?.updated_at ? `${shortAge(data.updated_at, now)} ago` : '';
  const status = !data ? '' : offline ? ['Saved', age].filter(Boolean).join(' · ') : failures.length ? ['Partly updated', age].filter(Boolean).join(' · ') : age ? `Updated ${age}` : '';

  return <BlurFade as="section" className="content-section transit-section" id="transit" inView duration={0.45} offset={10} blur="6px" direction="up" aria-labelledby="transit-title">
    <div className="section-head">
      <h2 id="transit-title">Transit</h2>
      <div className="transit-head-meta">
        {status && commutes.length > 0 && <span className={'section-count transit-status' + (offline || failures.length ? ' is-saved' : '')}>{status}</span>}
        <button type="button" className="section-control" onClick={onManage}>Manage commutes</button>
      </div>
    </div>
    {!data && <div className="state-panel" role="status">Transit is unavailable. Refresh to try again.</div>}
    {data && !commutes.length && <div className="state-panel transit-empty">
      <p>{data.status === 'initializing' ? 'GRT timetables are still being prepared. You can add a commute once they are ready.' : 'Save the bus or ION trip you take to campus to see its next departures here.'}</p>
      <button type="button" className="quiet-action" onClick={onManage}>Add a commute</button>
    </div>}
    {commutes.length > 0 && <>
      {guidance ? <GuidanceLead data={data!} guidance={guidance} now={now} /> : target && !activation && <p className="transit-target">
        <span>Next on campus</span><strong>{target.title}</strong><small>{formatTime(target.starts_at)} · {target.location}</small>
      </p>}
      <div className={'transit-grid' + (commutes.length === 1 ? ' is-single' : '')}>
        {commutes.map(commute => <CommuteCard key={commute.id} commute={commute} journey={data!.journeys.find(j => j.commute_id === commute.id)} now={now} offline={offline}
          action={activation?.commute_id === commute.id
            ? <button type="button" className="quiet-action" disabled={offline || busy} onClick={() => void run()}>Cancel today’s trip</button>
            : target && <button type="button" className="quiet-action" disabled={offline || busy} onClick={() => void run(commute.id)} aria-label={`Going to campus for ${target.title} using ${commute.name}`}>Going to campus</button>}
          active={activation?.commute_id === commute.id} />)}
      </div>
    </>}
    {error && <p className="action-error transit-action-error" role="alert">{error}</p>}
    {data && commutes.length > 0 && <TransitAbout failures={failures} />}
  </BlurFade>;
}

function GuidanceLead({ data, guidance, now }: { data: TransitData; guidance: NonNullable<TransitData['guidance']>; now: number }) {
  const commute = data.commutes.find(c => c.id === guidance.commute_id);
  const times = guidance.departure ? departureTimes(guidance.departure, now) : null;
  // Recompute from the actual prediction age; a cached server-generated leave time is not a clock.
  const leaveAt = times && commute ? times.departure - commute.walk_to_minutes * 60_000 : null;
  return <div className="transit-lead transit-guidance" role="status">
    <span className="transit-lead-label">{commute ? `${commute.name} · ` : ''}for {guidance.event_title}</span>
    {leaveAt != null && times && guidance.departure ? <>
      <h3>{leaveLabel(leaveAt, now)}</h3>
      <p className="transit-lead-detail">
        <span>Leave at {formatTime(leaveAt)}</span>
        <span>Route {guidance.departure.route} departs {formatTime(times.departure)}</span>
        <span>Arrives {formatTime(times.arrival)}</span>
        <span className="transit-basis">{times.predicted ? (guidance.departure.predicted_arrival == null ? 'Predicted departure · scheduled arrival' : 'Predicted') : 'Scheduled'}</span>
      </p>
    </> : <h3>No direct trip fits before {guidance.event_title}</h3>}
    <small>{guidance.message}</small>
  </div>;
}

function CommuteCard({ commute, journey, now, offline, action, active }: { commute: Commute; journey?: TransitData['journeys'][number]; now: number; offline: boolean; action: React.ReactNode; active: boolean }) {
  const departures = journey?.departures.filter(d => !d.cancelled && departureTimes(d, now, offline).departure - commute.walk_to_minutes * 60_000 >= now).slice(0, 3) || [];
  const alerts = journey?.alerts ?? [];
  return <article className={'transit-commute' + (active ? ' is-active' : '')} aria-label={commute.name}>
    <div className="transit-commute-heading">
      <div className="transit-commute-title">
        <h3>{commute.name}</h3>
        <p>{commute.origin_name} → {commute.destination_name}</p>
      </div>
      {action}
    </div>
    {alerts.length > 0 && <TransitAlerts alerts={alerts} />}
    {departures.length > 0
      ? <ol className="transit-departures" aria-label={`Next departures for ${commute.name}`}>{departures.map(d => <DepartureRow key={d.id} departure={d} commute={commute} now={now} offline={offline} />)}</ol>
      : <p className="transit-none">{journey?.schedule_valid ? 'No direct departures you can still reach in the next 24 hours.' : 'The timetable is unavailable or does not cover today.'}</p>}
  </article>;
}

function DepartureRow({ departure, commute, now, offline }: { departure: Departure; commute: Commute; now: number; offline: boolean }) {
  const t = departureTimes(departure, now, offline);
  const basis = t.predicted ? 'Predicted' : offline ? 'Saved schedule' : 'Scheduled';
  return <li className={'transit-departure' + (t.predicted ? ' is-predicted' : '')}>
    <span className="transit-route" aria-label={`Route ${departure.route}`}>{departure.route}</span>
    <span className="transit-departure-copy">
      <strong>{departure.headsign || `Route ${departure.route}`}</strong>
      <small>{basis} · arrives {formatTime(t.arrival)}{t.predicted && departure.predicted_arrival == null ? ' (scheduled)' : ''}</small>
    </span>
    <span className="transit-departure-time">
      <time dateTime={new Date(t.departure).toISOString()}>{formatTime(t.departure)}</time>
      <small>{leaveLabel(t.departure - commute.walk_to_minutes * 60_000, now).toLowerCase()}</small>
    </span>
  </li>;
}

function TransitAlerts({ alerts }: { alerts: string[] }) {
  const [first, ...rest] = alerts;
  return <div className="transit-alerts" role="note" aria-label={alerts.length === 1 ? 'GRT service alert' : `${alerts.length} GRT service alerts`}>
    <TriangleAlert size={15} aria-hidden="true" />
    <div className="transit-alerts-copy">
      <p>{first}</p>
      {rest.length > 0 && <BlurFadeDisclosure className="transit-alerts-more" summary={<><span>{rest.length === 1 ? '1 more alert' : `${rest.length} more alerts`}</span><ChevronRight size={13} aria-hidden="true" /></>}>
        {rest.map(alert => <p key={alert}>{alert}</p>)}
      </BlurFadeDisclosure>}
    </div>
  </div>;
}

function TransitAbout({ failures }: { failures: string[] }) {
  return <BlurFadeDisclosure className="transit-about" summary={<><span>{failures.length ? 'Some GRT data could not be updated' : 'About transit times'}</span><ChevronRight size={14} aria-hidden="true" /></>}>
    {failures.length > 0 && <ul className="transit-failures">{failures.map(f => <li key={f}>{f}</li>)}</ul>}
    <p>Departures are direct GRT bus and ION trips. Predicted times come from GRT’s live feed and fall back to the schedule when a prediction is older than 90 seconds. Leave times subtract the walking minutes you set for each commute.</p>
    <a href={GRT_OPEN_DATA} target="_blank" rel="noreferrer">GRT open data <ExternalLink size={13} aria-hidden="true" /></a>
  </BlurFadeDisclosure>;
}

/* ---------------------------------------------------------------- Settings */

function useDebounced<T>(value: T, ms: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return current;
}

function StopPicker({ label, help, value, origin = '', disabled, disabledNote, onChange }: {
  label: string; help: string; value: TransitStop | null; origin?: string; disabled?: boolean; disabledNote?: string; onChange: (stop: TransitStop | null) => void;
}) {
  const id = useId(), listId = `${id}-results`, inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const search = useDebounced(query.trim(), 200);
  // A destination list is useful before typing: it only contains stops with a direct trip.
  const browse = Boolean(origin) && open && !query.trim();
  const enabled = !disabled && open && (search.length >= 2 || browse);
  const result = useQuery({ queryKey: ['transit-stops', browse ? '' : search, origin], queryFn: ({ signal }) => fetchTransitStops(browse ? '' : search, origin, signal), enabled, staleTime: 60_000 });
  const stops = enabled ? result.data ?? [] : [];
  useEffect(() => { setActive(0); }, [search, browse]);
  const choose = (stop: TransitStop) => { onChange(stop); setQuery(''); setOpen(false); };
  const typing = query.trim() !== search && !browse;

  if (value) return <div className="transit-field">
    <span className="transit-field-label" id={`${id}-label`}>{label}</span>
    <div className="transit-selected-stop" aria-labelledby={`${id}-label`}>
      <span><strong>{value.name}</strong><small>{stopMeta(value)}</small></span>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { onChange(null); setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }} aria-label={`Change ${label.toLowerCase()}`}>Change</Button>
    </div>
  </div>;

  const showList = open && !disabled && (search.length >= 2 || browse || query.trim().length >= 2);
  let groupLabel: string | null | undefined;
  return <div className="transit-field">
    <Label htmlFor={`${id}-input`} className="transit-field-label">{label}</Label>
    <Input ref={inputRef} id={`${id}-input`} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" aria-describedby={`${id}-help`}
      aria-activedescendant={showList && stops[active] ? `${id}-option-${active}` : undefined}
      value={query} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={80} placeholder={disabled ? '' : 'Search stops'}
      onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
      onKeyDown={e => {
        if (e.key === 'ArrowDown' && stops.length) { e.preventDefault(); setOpen(true); setActive(i => (i + 1) % stops.length); }
        else if (e.key === 'ArrowUp' && stops.length) { e.preventDefault(); setActive(i => (i - 1 + stops.length) % stops.length); }
        else if (e.key === 'Enter' && showList && stops[active]) { e.preventDefault(); choose(stops[active]); }
        else if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); }
      }} />
    <p className="transit-field-help" id={`${id}-help`}>{disabled && disabledNote ? disabledNote : help}</p>
    {showList && <div className="transit-stop-results" aria-live="polite">
      {(result.isFetching && !stops.length) || typing ? <p className="transit-stop-state">Searching…</p>
        : result.isError ? <p className="transit-stop-state is-error" role="alert">Could not search stops. Check the connection and try again.</p>
          : !stops.length ? <p className="transit-stop-state">{origin ? `No stop with a direct trip from the boarding stop matches “${query.trim()}”.` : `No stops match “${query.trim()}”. Try a street, the stop number on the sign, or a building code such as E7.`}</p>
            : <>
              {browse && <p className="transit-stop-group">Direct from the boarding stop</p>}
              <ul role="listbox" id={listId} aria-label={`${label} results`}>
                {stops.map((stop, i) => {
                  const heading = !browse && stop.hint !== groupLabel && (stop.hint || groupLabel) ? (stop.hint ?? 'Matching stop names') : null;
                  groupLabel = stop.hint;
                  return <li key={stop.id} role="presentation">
                    {heading && <span className="transit-stop-group" role="presentation">{heading}</span>}
                    <div role="option" id={`${id}-option-${i}`} aria-selected={i === active} className="transit-stop-option"
                      onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(stop)}>
                      <strong>{stop.name}</strong><small>{stopMeta(stop)}</small>
                    </div>
                  </li>;
                })}
              </ul>
            </>}
    </div>}
  </div>;
}

function RouteChoice({ origin, destination, value, onChange }: { origin: TransitStop | null; destination: TransitStop | null; value: string; onChange: (route: string) => void }) {
  // A destination picked from search already carries its direct routes. A saved commute only
  // carries names, so look the destination up again from its origin to list its direct routes.
  const known = destination?.routes.length ? destination.routes : null;
  const lookup = useQuery({ queryKey: ['transit-stops', destination?.name, origin?.id], enabled: Boolean(origin && destination && !known), staleTime: 60_000,
    queryFn: ({ signal }) => fetchTransitStops(destination!.name, origin!.id, signal) });
  const routes = useMemo(() => {
    const list = known ?? lookup.data?.find(s => s.id === destination?.id)?.routes ?? [];
    return value && !list.includes(value) ? [...list, value] : list;
  }, [known, lookup.data, destination?.id, value]);
  if (!origin || !destination) return null;
  return <fieldset className="transit-field transit-routes">
    <legend className="transit-field-label">Route</legend>
    <div className="transit-route-options">
      {['', ...routes].map(route => <button type="button" key={route || 'any'} className="transit-route-option" aria-pressed={value === route} onClick={() => onChange(route)}>
        {route ? `Route ${route}` : 'Any direct route'}
      </button>)}
    </div>
    <p className="transit-field-help">{lookup.isFetching && !known ? 'Checking direct routes…' : routes.length > 1 ? 'Limit departures to one route, or keep every direct route.' : 'Departures use the direct routes between these stops.'}</p>
  </fieldset>;
}

const BUFFERS = [
  { key: 'walk_to_minutes', label: 'Walk to stop', help: 'From where you leave' },
  { key: 'walk_from_minutes', label: 'Walk after', help: 'From the stop to class' },
  { key: 'arrival_buffer_minutes', label: 'Arrive early', help: 'Before class starts' },
] as const;

function stopFromCommute(id: string, name: string): TransitStop | null {
  if (!id) return null;
  const [mode, code] = id.split(':');
  return { id, name, code, mode: mode === 'ion' ? 'ion' : 'bus', routes: [], hint: null };
}

function CommuteEditor({ initial, editing, busy, offline, onSave, onCancel }: { initial: CommuteDraft; editing: Commute | null; busy: boolean; offline: boolean; onSave: (draft: CommuteDraft) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [origin, setOrigin] = useState(() => stopFromCommute(initial.origin, editing?.origin_name ?? ''));
  const [destination, setDestination] = useState(() => stopFromCommute(initial.destination, editing?.destination_name ?? ''));
  const suggested = suggestedCommuteName(destination?.name);
  const ready = Boolean(origin && destination);
  return <form className="transit-editor" onSubmit={e => { e.preventDefault(); if (ready) onSave({ ...draft, name: draft.name.trim() || suggested }); }}>
    <div className="transit-settings-heading"><h3>{editing ? `Edit ${editing.name}` : 'New commute'}</h3></div>
    <fieldset disabled={offline || busy} className="transit-editor-fields">
      <StopPicker label="Boarding stop" help="Stop name, number from the sign, or a campus building such as E7." value={origin}
        onChange={stop => { setOrigin(stop); if (stop?.id !== origin?.id) { setDestination(null); setDraft(d => ({ ...d, origin: stop?.id ?? '', destination: '', route: '' })); } }} />
      <StopPicker label="Destination stop" help="Only stops with a direct trip from your boarding stop are listed. Building codes such as E7 work here too." value={destination} origin={origin?.id}
        disabled={!origin} disabledNote="Choose a boarding stop first."
        onChange={stop => { setDestination(stop); setDraft(d => ({ ...d, destination: stop?.id ?? '', route: stop && d.route && !stop.routes.includes(d.route) ? '' : d.route })); }} />
      <RouteChoice origin={origin} destination={destination} value={draft.route} onChange={route => setDraft(d => ({ ...d, route }))} />
      <fieldset className="transit-field">
        <legend className="transit-field-label">Timing</legend>
        <div className="transit-buffers">
          {BUFFERS.map(b => <label key={b.key} className="transit-buffer">
            <span>{b.label}</span>
            <span className="transit-minutes"><Input type="number" inputMode="numeric" min={0} max={120} required value={draft[b.key]} aria-label={`${b.label} (minutes)`}
              onChange={e => setDraft(d => ({ ...d, [b.key]: e.target.value === '' ? 0 : Math.min(120, Math.max(0, Math.round(Number(e.target.value)))) }))} /><span aria-hidden="true">min</span></span>
            <small>{b.help}</small>
          </label>)}
        </div>
      </fieldset>
      <div className="transit-field">
        <Label htmlFor="transit-commute-name" className="transit-field-label">Name</Label>
        <Input id="transit-commute-name" maxLength={80} value={draft.name} placeholder={suggested} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <p className="transit-field-help">Shown on Today. Leave blank to use “{suggested}”.</p>
      </div>
      <div className="transit-editor-actions">
        <Button type="submit" size="sm" disabled={!ready}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save commute'}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </fieldset>
  </form>;
}

export function TransitSettings({ active, cached }: { active: boolean; cached?: TransitData | null }) {
  const client = useQueryClient(), offline = useOffline();
  const list = useQuery({ queryKey: ['transit-commutes'], queryFn: ({ signal }) => fetchCommutes(signal), enabled: active, initialData: cached?.commutes, initialDataUpdatedAt: 0 });
  const [editor, setEditor] = useState<{ draft: CommuteDraft; editing: Commute | null; key: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const commutes = list.data ?? [];
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['transit-commutes'] }), client.invalidateQueries({ queryKey: ['recommendations'] })]); };
  const write = async (operation: () => Promise<unknown>, done = '', close = true) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); if (close) { setEditor(null); setConfirmId(null); } setNotice(done); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save commute.'); } finally { setBusy(false); }
  };
  const open = (draft: CommuteDraft, editing: Commute | null) => { setEditor({ draft, editing, key: Date.now() }); setConfirmId(null); setError(''); setNotice(''); };
  const full = commutes.length >= MAX_COMMUTES;
  const updated = cached?.updated_at ? `Timetable checked ${shortAge(cached.updated_at, Date.now())} ago` : cached?.status === 'initializing' ? 'Timetables are still being prepared' : 'Timetable not checked yet';

  return <div className="transit-settings">
    {offline && <p className="transit-settings-notice">Showing saved commutes. Connect to add or change them.</p>}
    {error && <p className="transit-settings-error" role="alert">{error}</p>}
    {notice && <p className="transit-settings-done" role="status">{notice}</p>}
    {editor
      ? <CommuteEditor key={editor.key} initial={editor.draft} editing={editor.editing} busy={busy} offline={offline}
        onCancel={() => { setEditor(null); setError(''); }}
        onSave={draft => void write(() => saveCommute(draft, editor.editing?.id), editor.editing ? 'Commute updated.' : 'Commute saved. Its departures appear on Today.')} />
      : <section className="transit-settings-section" aria-labelledby="transit-commutes-title">
        <div className="transit-settings-heading">
          <h3 id="transit-commutes-title">Commutes</h3>
          <span>{commutes.length} of {MAX_COMMUTES}</span>
        </div>
        <p className="transit-settings-copy">Direct GRT bus and ION trips. On Today, choose Going to campus as you leave to get a leave-by time for your next class.</p>
        {list.isError && <p className="transit-settings-error" role="alert">Could not refresh the commute list. Saved commutes are shown.</p>}
        {commutes.length > 0 ? <ul className="transit-commute-list">
          {commutes.map(c => <li key={c.id} className="transit-commute-row">
            <div className="transit-commute-row-copy">
              <h4>{c.name}</h4>
              <p>{c.origin_name} → {c.destination_name}</p>
              <small>{commuteSummary(c)}</small>
            </div>
            {confirmId === c.id
              ? <div className="transit-confirm" role="group" aria-label={`Remove ${c.name}`}>
                <span>Remove this commute?</span>
                <div>
                  <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => void write(() => deleteCommute(c.id), `${c.name} removed.`)}>{busy ? 'Removing…' : 'Remove'}</Button>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmId(null)}>Keep</Button>
                </div>
              </div>
              : <div className="transit-row-actions">
                <Button type="button" variant="ghost" size="xs" disabled={offline || busy} onClick={() => open({ ...c }, c)} aria-label={`Edit ${c.name}`}>Edit</Button>
                <Button type="button" variant="ghost" size="xs" disabled={offline || busy} onClick={() => setConfirmId(c.id)} aria-label={`Remove ${c.name}`}>Remove</Button>
              </div>}
          </li>)}
        </ul> : <p className="transit-settings-empty">No commutes yet. Add the trip you usually take to campus.</p>}
        <div className="transit-settings-actions">
          <Button type="button" size="sm" disabled={offline || busy || full} onClick={() => open({ ...emptyCommute }, null)}>Add commute</Button>
          {full && <span className="transit-settings-meta">You can save up to {MAX_COMMUTES} commutes.</span>}
        </div>
      </section>}
    <section className="transit-settings-section" aria-labelledby="transit-data-title">
      <div className="transit-settings-heading"><h3 id="transit-data-title">Timetable</h3></div>
      <div className="transit-timetable-row">
        <span>{updated}</span>
        <Button type="button" variant="ghost" size="sm" disabled={offline || busy} onClick={() => void write(() => refreshTransit(), 'Checking GRT for new times. Today updates shortly.', false)}>Check now</Button>
      </div>
      <p className="transit-settings-note">Contains information provided by the Regional Municipality of Waterloo under its <a href={GRT_OPEN_DATA} target="_blank" rel="noreferrer">open data licence</a>. Predictions are estimates; check GRT for disruptions.</p>
    </section>
  </div>;
}
