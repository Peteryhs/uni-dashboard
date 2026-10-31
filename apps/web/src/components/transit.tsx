import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BusFront } from 'lucide-react';
import { departureTimes, transitDate } from '#contract/transit.mjs';
import { activateCommute, cancelCommute, deleteCommute, fetchCommutes, fetchTransitStops, saveCommute, refreshTransit } from '@/lib/api';
import { useOffline } from '@/lib/connectivity';
import { countdown, formatTime, shortAge } from '@/lib/time';
import { usePreferences } from '@/lib/preferences-store';
import { emptyCommute, type Commute, type CommuteDraft, type TransitData, type TransitStop } from '@/lib/transit';
import './transit.css';

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
  const selected = data?.commutes.find(c => c.id === guidance?.commute_id);
  const guidanceTimes = guidance?.departure ? departureTimes(guidance.departure, now) : null;
  // Recompute from the actual prediction age; a cached server-generated leave time is not a clock.
  const leaveAt = guidanceTimes && selected ? guidanceTimes.departure - selected.walk_to_minutes * 60_000 : null;
  return <section className="content-section" id="transit" aria-labelledby="transit-title">
    <div className="section-head"><h2 id="transit-title">Transit</h2><button className="quiet-action" onClick={onManage}>Manage commutes</button></div>
    <div className="section-panel transit-panel">
      {!data && <p className="empty-state">Transit is unavailable. Refresh to try again.</p>}
      {data && !data.commutes.length && <p className="empty-state">{data.status === 'initializing' ? 'GRT timetables are being prepared. Add a commute in Settings when they are ready.' : 'Save a bus or ION commute to see departures here.'}</p>}
      {guidance && <div className="transit-guidance"><BusFront size={20} aria-hidden="true" /><div><strong>{leaveAt != null ? `Leave ${countdown(leaveAt, now)} for ${guidance.event_title}` : guidance.message}</strong>{leaveAt != null && <p>At {formatTime(leaveAt)} · {guidanceTimes?.predicted ? 'Predicted' : 'Scheduled'} departure{guidanceTimes?.predicted && guidance.departure?.predicted_arrival == null ? ' · Scheduled arrival' : ''}</p>}<small>{guidance.message}</small></div></div>}
      {data?.commutes.map(commute => {
        const journey = data.journeys.find(j => j.commute_id === commute.id);
        const departures = journey?.departures.filter(d => !d.cancelled && departureTimes(d, now, offline).departure - commute.walk_to_minutes * 60_000 >= now).slice(0, 3) || [];
        return <div className="transit-commute" key={commute.id}>
          <div className="transit-commute-heading"><div><h3>{commute.name}</h3><p>{commute.origin_name} → {commute.destination_name}</p></div>
            {activation?.commute_id === commute.id ? <button className="quiet-action" disabled={offline || busy} onClick={() => void run()}>Cancel today’s trip</button> : target && <button className="quiet-action" disabled={offline || busy} onClick={() => void run(commute.id)} aria-label={`Going to campus for ${target.title} using ${commute.name}`}>Going to campus</button>}
          </div>
          {!activation && target && <p className="transit-target">For {target.title} · {formatTime(target.starts_at)} · {target.location}</p>}
          {departures.map(d => { const t = departureTimes(d, now, offline); return <div className="transit-departure" key={d.id}><strong>{d.route}</strong><span>{d.headsign}<small>{t.predicted ? 'Predicted' : offline ? 'Saved schedule' : 'Scheduled'} · arrives {formatTime(t.arrival)}{t.predicted && d.predicted_arrival == null ? ' (scheduled)' : ''}</small></span><time>{formatTime(t.departure)}</time></div>; })}
          {!departures.length && <p className="data-note">{journey?.schedule_valid ? 'No saved boardable direct departures in the next 24 hours.' : 'Timetable is unavailable or does not cover today.'}</p>}
          {journey?.alerts.map(alert => <p className="transit-alert" key={alert}>{alert}</p>)}
        </div>;
      })}
      {data?.updated_at && <p className="data-note">{offline ? 'Saved' : 'Updated'} {shortAge(data.updated_at, now)} ago · <a href="https://www.grt.ca/about-grt/open-data/" target="_blank" rel="noreferrer">GRT open data</a></p>}
      {data?.error && <p className="transit-alert">{data.error}</p>}{error && <p role="alert">{error}</p>}
    </div>
  </section>;
}

function StopPicker({ label, value, name, origin = '', onChange }: { label: string; value: string; name?: string; origin?: string; onChange: (stop: TransitStop) => void }) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 250); return () => clearTimeout(timer); }, [query]);
  const result = useQuery({ queryKey: ['transit-stops', search, origin], queryFn: ({ signal }) => fetchTransitStops(search, origin, signal), enabled: search.trim().length >= 2, staleTime: 60_000 });
  return <div className="transit-stop-picker"><label>{label}<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stop name or number" autoComplete="off" /></label>
    {value && <p className="data-note">Selected: {name || value}</p>}
    {search.length >= 2 && <div className="transit-stop-results" aria-label={`${label} results`}>{result.isPending ? <p>Searching…</p> : result.isError ? <p role="alert">Could not search stops.</p> : result.data?.length ? result.data.map(stop => <button type="button" key={stop.id} aria-pressed={stop.id === value} onClick={() => { onChange(stop); setQuery(''); setSearch(''); }}>{stop.name}<small>{stop.mode === 'ion' ? 'ION' : 'Bus'} · {stop.code}</small></button>) : <p>No matching stops. The timetable may still be importing.</p>}</div>}
  </div>;
}

export function TransitSettings({ active, cached }: { active: boolean; cached?: TransitData | null }) {
  const client = useQueryClient(), offline = useOffline();
  const list = useQuery({ queryKey: ['transit-commutes'], queryFn: ({ signal }) => fetchCommutes(signal), enabled: active, initialData: cached?.commutes, initialDataUpdatedAt: 0 });
  const [draft, setDraft] = useState<CommuteDraft | null>(null), [editing, setEditing] = useState<Commute | null>(null), [names, setNames] = useState({ origin: '', destination: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['transit-commutes'] }), client.invalidateQueries({ queryKey: ['recommendations'] })]); };
  const write = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); setDraft(null); setEditing(null); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save commute.'); } finally { setBusy(false); } };
  return <div className="transit-settings">
    <p className="data-note">Direct GRT bus and ION trips. Activate a commute on Today when leaving your saved origin.</p>
    <button className="quiet-action" disabled={offline || busy || Boolean(draft)} onClick={() => void write(async () => { await refreshTransit(); })}>Update transit</button>
    {offline && <p className="transit-alert">Saved information. Connect to add or change commutes.</p>}
    {!draft && <><button className="quiet-action" disabled={offline || busy || (list.data?.length || 0) >= 6} onClick={() => { setDraft({ ...emptyCommute }); setEditing(null); setNames({ origin: '', destination: '' }); setError(''); }}>Add commute</button>
      {list.isError && <p role="alert">Could not update the commute list. Saved commutes remain below.</p>}
      {list.data?.map(c => <div className="transit-commute" key={c.id}><h3>{c.name}</h3><p>{c.origin_name} → {c.destination_name}</p><div className="transit-actions"><button className="quiet-action" disabled={offline || busy} onClick={() => { setDraft(c); setEditing(c); setNames({ origin: c.origin_name, destination: c.destination_name }); }}>Edit</button><button className="quiet-action" disabled={offline || busy} onClick={() => { if (window.confirm(`Remove ${c.name}?`)) void write(() => deleteCommute(c.id)); }}>Remove</button></div></div>)}
      {!list.data?.length && <p className="data-note">No saved commutes.</p>}</>}
    {draft && <form className="transit-form" onSubmit={e => { e.preventDefault(); void write(() => saveCommute(draft, editing?.id)); }}><h3>{editing ? 'Edit commute' : 'Add commute'}</h3><fieldset disabled={offline || busy}>
      <label>Name<input required maxLength={80} value={draft.name} placeholder="To campus" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <StopPicker label="Boarding stop" value={draft.origin} name={names.origin} onChange={s => { setDraft({ ...draft, origin: s.id, destination: '' }); setNames({ origin: s.name, destination: '' }); }} />
      <StopPicker label="Destination stop" value={draft.destination} name={names.destination} origin={draft.origin} onChange={s => { setDraft({ ...draft, destination: s.id }); setNames({ ...names, destination: s.name }); }} />
      <label>Route filter (optional)<input value={draft.route} maxLength={40} placeholder="Any direct route" onChange={e => setDraft({ ...draft, route: e.target.value })} /></label>
      <div className="transit-buffers">{(['walk_to_minutes', 'walk_from_minutes', 'arrival_buffer_minutes'] as const).map((key, i) => <label key={key}>{['Walk to stop', 'Walk after arrival', 'Arrive early'][i]} (min)<input type="number" min={0} max={120} required value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' ? 0 : Number(e.target.value) })} /></label>)}</div>
      <div className="transit-actions"><button type="submit" className="quiet-action" disabled={!draft.origin || !draft.destination}>{busy ? 'Saving…' : 'Save commute'}</button><button type="button" className="quiet-action" onClick={() => setDraft(null)}>Cancel</button></div>
    </fieldset></form>}
    {error && <p role="alert">{error}</p>}
    <p className="data-note">Contains information provided by the Regional Municipality of Waterloo under its <a href="https://www.grt.ca/about-grt/open-data/" target="_blank" rel="noreferrer">open data licence</a>. Predictions are estimates; check GRT for disruptions.</p>
  </div>;
}
