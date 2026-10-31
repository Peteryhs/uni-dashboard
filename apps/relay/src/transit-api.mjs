import { buildCalendar, calendarOptions } from './calendar.mjs';
import { transitTarget } from './transit.mjs';
import { transitDate } from '#contract/transit.mjs';

export const isTransitRoute = path => path === '/v1/transit' || path.startsWith('/v1/transit/');
export async function handleTransitRoute({ url, method, readBody, transit, store, now = Date.now() }) {
  if (!transit) return { status: 503, body: { error: 'Transit storage is not configured.' } };
  try {
    const path = url.pathname;
    if (path === '/v1/transit/refresh' && method === 'POST') { await transit.refresh(); return { status: 202, body: { ok: true } }; }
    if (path === '/v1/transit/stops' && method === 'GET') return { status: 200, body: { stops: await transit.stops(url.searchParams.get('q') || '', url.searchParams.get('origin') || '') } };
    if (path === '/v1/transit/commutes' && method === 'GET') return { status: 200, body: { commutes: await transit.commutes() } };
    if (path === '/v1/transit/commutes' && method === 'POST') return { status: 201, body: { commute: await transit.save(await readBody(), null) } };
    const match = /^\/v1\/transit\/commutes\/([a-zA-Z0-9-]{1,80})$/.exec(path);
    if (match && method === 'PUT') return { status: 200, body: { commute: await transit.save(await readBody(), match[1]) } };
    if (match && method === 'DELETE') { await transit.remove(match[1]); return { status: 200, body: { ok: true } }; }
    if ((path === '/v1/transit/activation' && method === 'POST') || (path === '/v1/transit' && method === 'GET')) {
      const options = calendarOptions(url.searchParams, now);
      const calendar = await buildCalendar(store, { ...options, start: transitDate(now), days: 1, now });
      const target = transitTarget(calendar, now);
      if (method === 'POST') {
        const input = await readBody();
        if (typeof input.commute_id !== 'string') throw new RangeError('Choose a saved commute.');
        return { status: 200, body: { activation: await transit.activate(input.commute_id, target, now) } };
      }
      return { status: 200, body: await transit.view({ now, target, events: calendar.days.flatMap(d => d.events).map(e => transitTarget({ ...calendar, days: [{ events: [e] }] }, now)).filter(Boolean) }) };
    }
    if (path === '/v1/transit/activation' && method === 'DELETE') { await transit.cancel(); return { status: 200, body: { ok: true } }; }
    return { status: 405, body: { error: 'Method not allowed' } };
  } catch (error) {
    // DO RPC errors preserve their message but not their prototype/custom properties.
    return { status: error.status || (error.name === 'ZodError' || error instanceof RangeError || /Choose |commute|direct trip|stops/i.test(error.message) ? 400 : 503), body: { error: error.message } };
  }
}
