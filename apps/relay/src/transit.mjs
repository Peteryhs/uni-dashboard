import { CommuteInput, TransitView, departureTimes, leaveGuidance, transitDate } from '#contract/transit.mjs';
import { FEEDS, GRT_BASE, importSchedule, scheduledJourneys, decodeRealtime, applyRealtime, relevantAlerts, stopData } from './transit-gtfs.mjs';

const DAY = 86_400_000;
export function cloudTransit(env) { return env.TRANSIT ? env.TRANSIT.get(env.TRANSIT.idFromName('grt')) : null; }
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');

async function download(url, headers = {}, max = 8_000_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 304) return { res, bytes: null };
  if (!res.ok) { const error = new Error(`GRT returned ${res.status}`); const retry = Number(res.headers.get('retry-after')); error.retryMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, DAY) : 0; throw error; }
  const chunks = []; let size = 0;
  for await (const chunk of res.body) { size += chunk.length; if (size > max) throw new Error('GRT feed exceeds the download limit'); chunks.push(chunk); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { res, bytes };
}

export function transitTarget(calendar, now, id = null) {
  const cancelled = new Set((calendar.alerts || []).filter(a => ['cancelled', 'removed'].includes(a.kind)).map(a => a.event_id));
  return calendar.days.flatMap(d => d.events).filter(e => (!id || e.id === id) && ['class', 'exam'].includes(e.category) && !e.all_day && e.location.trim()
    && !/\b(online|zoom|teams|virtual|tba|tbd)\b/i.test(e.location) && !['stale', 'dead'].includes(e.state) && e.attendance !== 'replaced'
    && !cancelled.has(e.id) && e.starts_at > now && transitDate(e.starts_at) === transitDate(now))
    .sort((a, b) => a.starts_at - b.starts_at).map(e => ({ id: e.id, title: e.title, starts_at: e.starts_at, location: e.location }))[0] || null;
}

export class TransitEngine {
  constructor(store) { this.store = store; this.running = null; }
  async upstream(key, now, work) {
    const previous = this.store.get(`backoff:${key}`);
    if (previous?.until > now) throw new Error(previous.error);
    try { const result = await work(); this.store.delete(`backoff:${key}`); return result; }
    catch (error) {
      const failures = Math.min((previous?.failures || 0) + 1, 10);
      this.store.put(`backoff:${key}`, { failures, error: error.message, until: now + Math.max(error.retryMs || 0, Math.min(60_000 * 2 ** (failures - 1), 3_600_000)) });
      throw error;
    }
  }
  commutes() { return this.store.get('commutes') || []; }
  stops(q = '', origin = '') {
    const text = q.trim().toLowerCase().slice(0, 80);
    const all = Object.keys(FEEDS).flatMap(mode => { const meta = this.store.get(`feed:${mode}`); return meta?.generation ? Object.values(this.store.get(`gtfs:${mode}:${meta.generation}:stops`) || {}) : []; });
    let reachable = null, from = null, meta = null, mode = null;
    if (origin) {
      let id; [mode, id] = origin.split(':'); meta = this.store.get(`feed:${mode}`);
      if (!meta?.generation) return [];
      from = stopData(this.store, mode, meta.generation, id);
      // The small stop search catalog is cached per generation; full stop rows are not read here.
      const targets = this.store.get(`reachable:${origin}:${meta.generation}`);
      if (targets) reachable = new Set(targets);
      else {
        // Reachability is computed at import time for saved origins; for new origins use route
        // membership as a search prefilter and validate exact trip order on save.
        const routes = new Set(Object.values(from.trips).map(t => t[0]));
        const stopRoutes = this.store.get(`gtfs:${mode}:${meta.generation}:stop-routes`) || {};
        reachable = new Set(all.filter(s => s.mode === mode && (stopRoutes[s.id.split(':')[1]] || []).some(r => routes.has(r))).map(s => s.id));
      }
    }
    const candidates = all.filter(s => s.id !== origin && (!reachable || reachable.has(s.id)) && (!text || s.name.toLowerCase().includes(text) || s.code.includes(text)));
    if (!from) return candidates.slice(0, 30);
    const boardable = new Map();
    for (const row of from.entries) if (row[4] === 0) boardable.set(row[0], Math.min(boardable.get(row[0]) ?? Infinity, row[1]));
    return candidates.slice(0, 120).filter(s => stopData(this.store, mode, meta.generation, s.id.split(':')[1], false).entries.some(r => r[5] === 0 && r[1] > (boardable.get(r[0]) ?? Infinity))).slice(0, 30);
  }
  save(input, id = null) {
    const parsed = CommuteInput.parse(input), list = this.commutes();
    if (id && !list.some(c => c.id === id)) throw Object.assign(new Error('Commute not found'), { status: 404 });
    if (!id && list.length >= 6) throw new RangeError('You can save up to six commutes.');
    const [mode, fromId] = parsed.origin.split(':'), toId = parsed.destination.split(':')[1];
    const meta = this.store.get(`feed:${mode}`), prefix = `gtfs:${mode}:${meta?.generation}:`;
    const stops = this.store.get(`${prefix}stops`);
    if (!stops?.[fromId] || !stops?.[toId]) throw new RangeError('Choose stops from the current timetable.');
    const from = stopData(this.store, mode, meta.generation, fromId), to = stopData(this.store, mode, meta.generation, toId);
    const dest = new Map();
    for (const row of to.entries) if (row[5] === 0) dest.set(row[0], Math.max(dest.get(row[0]) || 0, row[1]));
    const routes = this.store.get(`${prefix}routes`);
    if (!from.entries.some(r => r[4] === 0 && dest.get(r[0]) > r[1] && (!parsed.route || routes[from.trips[r[0]][0]] === parsed.route))) throw new RangeError('These stops have no direct trip in this direction. Choose another destination or route.');
    const value = { ...parsed, id: id || crypto.randomUUID(), origin_name: stops[fromId].name, destination_name: stops[toId].name };
    this.store.put('commutes', [...list.filter(c => c.id !== value.id), value]);
    const now = Date.now(), planned = scheduledJourneys(this.store, value, now);
    this.store.put(`journey:${value.id}`, { ...planned, generation: meta.generation, date: transitDate(now), alerts: [], alerts_at: 0 });
    this.store.delete('activation');
    return value;
  }
  remove(id) {
    this.store.put('commutes', this.commutes().filter(c => c.id !== id)); this.store.delete(`journey:${id}`);
    if (this.store.get('activation')?.commute_id === id) this.store.delete('activation');
  }
  activate(id, event, now) {
    if (!this.commutes().some(c => c.id === id)) throw new RangeError('Choose a saved commute.');
    if (!event) throw new RangeError('There is no upcoming physical class or exam today with a confirmed time and location.');
    const activation = { commute_id: id, event_id: event.id, date: transitDate(now) };
    this.store.put('activation', activation); return activation;
  }
  cancel() { this.store.delete('activation'); }
  refresh() { void (async () => { for (let i = 0; i < 3; i++) await this.tick(); })().catch(() => {}); }
  view({ now = Date.now(), target = null, events = null } = {}) {
    const commutes = this.commutes(), raw = this.store.get('activation');
    const activation = raw?.date === transitDate(now) ? raw : null;
    const activeTarget = activation && events ? events.find(e => e.id === activation.event_id) || null : activation && target?.id === activation.event_id ? target : null;
    const currentTarget = activeTarget || target;
    const journeys = commutes.map(c => {
      const value = this.store.get(`journey:${c.id}`);
      // A snapshot from a superseded schedule cannot supply valid service times.
      const meta = this.store.get(`feed:${c.origin.split(':')[0]}`);
      const valid = value?.generation === meta?.generation && value?.date === transitDate(now) && value?.schedule_valid;
      return { commute_id: c.id, departures: valid ? value.departures.filter(d => !d.cancelled && departureTimes(d, now).departure - c.walk_to_minutes * 60_000 >= now) : [],
        alerts: value && now - value.alerts_at <= 600_000 ? value.alerts : [], schedule_valid: Boolean(valid) };
    });
    const active = commutes.find(c => c.id === activation?.commute_id);
    const guidance = active && activeTarget && activeTarget.starts_at > now ? leaveGuidance(active, journeys.find(j => j.commute_id === active.id)?.departures || [], activeTarget, now) : null;
    const status = this.store.get('status');
    const upstreamErrors = ['static:bus', 'static:ion', 'rt:bus', 'rt:ion', 'alerts'].map(key => { const backoff = this.store.get(`backoff:${key}`); return backoff ? `${key}: ${backoff.error}` : null; }).filter(Boolean);
    return TransitView.parse({ generated_at: now, status: !this.store.get('feed:bus')?.generation && !this.store.get('feed:ion')?.generation ? status?.error ? 'failed' : 'initializing' : commutes.length ? 'ready' : 'unconfigured',
      error: upstreamErrors.length ? upstreamErrors.join(' · ') : status?.error || null, updated_at: status?.updated_at || null, commutes, journeys, activation: activeTarget ? activation : null, target: currentTarget, guidance });
  }
  tick(now = Date.now(), force = false) {
    if (this.running) return this.running;
    this.running = this.update(now, force).finally(() => { this.running = null; }); return this.running;
  }
  async update(now, force) {
    const retry = this.store.get('retry');
    if (!force && retry?.until > now) return;
    try {
      // One static import per invocation keeps peak memory bounded and leaves time for alarms.
      for (const [mode, id] of Object.entries(FEEDS)) {
        const meta = this.store.get(`feed:${mode}`);
        if (!meta || now - meta.checked_at >= DAY) {
          try {
          const { res, bytes } = await this.upstream(`static:${mode}`, now, () => download(`${GRT_BASE}/staticfeeds/${id}`, meta?.etag ? { 'if-none-match': meta.etag } : {}));
          if (bytes) {
            const generation = await digest(bytes);
            if (generation !== meta?.generation) {
              this.store.prune(`gtfs:${mode}:${generation}:`);
              let imported;
              try { imported = this.store.batch(() => importSchedule(this.store, bytes, mode, generation)); }
              catch (error) { this.store.prune(`gtfs:${mode}:${generation}:`); throw error; }
              this.store.put(`feed:${mode}`, { ...imported, etag: res.headers.get('etag'), checked_at: now });
              if (meta?.generation) this.store.prune(`gtfs:${mode}:${meta.generation}:`);
            } else this.store.put(`feed:${mode}`, { ...meta, checked_at: now });
          } else this.store.put(`feed:${mode}`, { ...meta, checked_at: now });
          this.store.put('status', { updated_at: now, error: null });
          this.store.delete('retry');
          return; // Remaining mode and predictions are serviced on the next alarm.
          } catch (error) {
            // A failed bus catalog must not prevent ION's catalog or predictions from updating.
            this.store.put('status', { updated_at: this.store.get('status')?.updated_at || null, error: `Timetable update failed: ${error.message}` });
          }
        }
      }
      const commutes = this.commutes();
      if (!commutes.length) return;
      const planned = commutes.map(c => ({ commute: c, ...scheduledJourneys(this.store, c, now) }));
      const errors = [];
      let alertFeed = { entity: [] }, alertsAt = 0;
      const savedAlerts = this.store.get('alerts');
      if (!savedAlerts || now - (savedAlerts.checked_at ?? savedAlerts.at) >= 300_000) {
        try {
        const { bytes } = await this.upstream('alerts', now, () => download(`${GRT_BASE}/alerts`, {}, 2_000_000));
        // toObject converts protobuf Long values before persisting.
        const feed = decodeRealtime(bytes);
        const at = Number(feed.header?.timestamp) * 1000;
        alertsAt = Number.isFinite(at) && at <= now ? at : 0;
        this.store.put('alerts', { checked_at: now, at: alertsAt, feed: JSON.parse(JSON.stringify(feed)) });
        alertFeed = feed;
        } catch (error) { errors.push(`Service alerts: ${error.message}`); if (savedAlerts) { alertFeed = savedAlerts.feed; alertsAt = savedAlerts.at; } }
      } else { alertFeed = savedAlerts.feed; alertsAt = savedAlerts.at; }
      for (const mode of Object.keys(FEEDS)) {
        const relevant = planned.filter(p => p.commute.origin.startsWith(`${mode}:`));
        if (!relevant.length) continue;
        const near = relevant.some(p => p.departures.some(d => d.scheduled_departure >= now - 90 * 60_000 && d.scheduled_departure <= now + 90 * 60_000));
        let feed = null;
        if (near) {
          try { const { bytes } = await this.upstream(`rt:${mode}`, now, () => download(`${GRT_BASE}/tripupdates/${FEEDS[mode]}`, {}, 3_000_000)); feed = decodeRealtime(bytes); }
          catch (error) { errors.push(`${mode === 'ion' ? 'ION' : 'Bus'} predictions: ${error.message}`); }
        }
        for (const p of relevant) {
          const departures = feed ? applyRealtime(p.departures, feed, now) : p.departures;
          this.store.put(`journey:${p.commute.id}`, { date: transitDate(now), generation: this.store.get(`feed:${mode}`).generation, schedule_valid: p.schedule_valid,
            departures, alerts: relevantAlerts(alertFeed, p.commute, p.departures, now), alerts_at: alertsAt });
        }
      }
      this.store.put('status', { updated_at: errors.length ? this.store.get('status')?.updated_at || null : now, error: errors.length ? errors.join(' · ') : null });
      this.store.delete('retry');
    } catch (error) {
      const failures = Math.min((retry?.failures || 0) + 1, 10);
      this.store.put('retry', { failures, until: now + Math.max(error.retryMs || 0, Math.min(60_000 * 2 ** (failures - 1), 3_600_000)) });
      this.store.put('status', { updated_at: this.store.get('status')?.updated_at || null, error: `Transit update failed: ${error.message}` });
    }
  }
}
