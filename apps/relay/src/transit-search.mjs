/**
 * Ranked GRT stop search: forgiving name matching, stop numbers, and campus places.
 *
 * GTFS names are written as "Ring Rd. / U.W. - Davis Centre" or "University Of Waterloo Station -
 * Northbound". People type "ring road davis", "uw station", "E7" or a room such as "MC 4020".
 * Names are reduced to comparable tokens, every query token must match a name token (prefix while
 * typing, one typo allowed on longer words), and campus building codes resolve to the stops closest
 * to that building.
 */

/**
 * UW building centres. These only order nearby stops for search; they are never used for walk
 * times. Coordinates are approximate building centres from the campus map.
 */
export const CAMPUS_PLACES = [
  { code: 'E7', name: 'Engineering 7', lat: 43.4730, lon: -80.5396, aliases: ['engineering 7', 'eng 7'] },
  { code: 'E6', name: 'Engineering 6', lat: 43.4735, lon: -80.5402, aliases: ['engineering 6', 'eng 6'] },
  { code: 'E5', name: 'Engineering 5', lat: 43.4727, lon: -80.5401, aliases: ['engineering 5', 'eng 5'] },
  { code: 'E3', name: 'Engineering 3', lat: 43.4716, lon: -80.5413, aliases: ['engineering 3', 'eng 3'] },
  { code: 'E2', name: 'Engineering 2', lat: 43.4715, lon: -80.5416, aliases: ['engineering 2', 'eng 2'] },
  { code: 'DWE', name: 'Douglas Wright Engineering', lat: 43.4705, lon: -80.5410, aliases: ['douglas wright'] },
  { code: 'CPH', name: 'Carl A. Pollock Hall', lat: 43.4712, lon: -80.5418, aliases: ['carl pollock', 'pollock hall'] },
  { code: 'RCH', name: 'J.R. Coutts Hall', lat: 43.4703, lon: -80.5415, aliases: ['coutts hall', 'jr coutts'] },
  { code: 'DC', name: 'Davis Centre', lat: 43.4728, lon: -80.5420, aliases: ['davis', 'davis centre', 'davis center'] },
  { code: 'MC', name: 'Mathematics & Computer', lat: 43.4721, lon: -80.5440, aliases: ['math and computer', 'mathematics and computer'] },
  { code: 'M3', name: 'Mathematics 3', lat: 43.4734, lon: -80.5440, aliases: ['math 3', 'mathematics 3'] },
  { code: 'QNC', name: 'Quantum-Nano Centre', lat: 43.4715, lon: -80.5445, aliases: ['quantum nano', 'quantum nano centre'] },
  { code: 'PHY', name: 'Physics', lat: 43.4717, lon: -80.5430, aliases: ['physics building'] },
  { code: 'ESC', name: 'Earth Sciences & Chemistry', lat: 43.4711, lon: -80.5425, aliases: ['earth sciences', 'chemistry building'] },
  { code: 'B1', name: 'Biology 1', lat: 43.4707, lon: -80.5440, aliases: ['biology 1'] },
  { code: 'B2', name: 'Biology 2', lat: 43.4702, lon: -80.5436, aliases: ['biology 2'] },
  { code: 'STC', name: 'Science Teaching Complex', lat: 43.4708, lon: -80.5432, aliases: ['science teaching'] },
  { code: 'DP', name: 'Dana Porter Library', lat: 43.4697, lon: -80.5422, aliases: ['dana porter', 'dpl'] },
  { code: 'SLC', name: 'Student Life Centre', lat: 43.4717, lon: -80.5457, aliases: ['student life', 'student life centre', 'student life center'] },
  { code: 'PAC', name: 'Physical Activities Complex', lat: 43.4717, lon: -80.5470, aliases: ['physical activities'] },
  { code: 'CIF', name: 'Columbia Icefield', lat: 43.4750, lon: -80.5485, aliases: ['columbia icefield', 'icefield'] },
  { code: 'BMH', name: 'B.C. Matthews Hall', lat: 43.4738, lon: -80.5460, aliases: ['matthews hall', 'bc matthews'] },
  { code: 'EXP', name: 'Expansion Building', lat: 43.4745, lon: -80.5450, aliases: ['expansion building'] },
  { code: 'OPT', name: 'Optometry', lat: 43.4752, lon: -80.5446, aliases: ['optometry'] },
  { code: 'HH', name: 'Hagey Hall', lat: 43.4682, lon: -80.5425, aliases: ['hagey hall'] },
  { code: 'AL', name: 'Arts Lecture Hall', lat: 43.4691, lon: -80.5425, aliases: ['arts lecture'] },
  { code: 'ML', name: 'Modern Languages', lat: 43.4692, lon: -80.5440, aliases: ['modern languages'] },
  { code: 'PAS', name: 'Psychology, Anthropology, Sociology', lat: 43.4688, lon: -80.5442, aliases: ['psychology building'] },
  { code: 'SCH', name: 'South Campus Hall', lat: 43.4690, lon: -80.5412, aliases: ['south campus hall', 'south campus'] },
  { code: 'TC', name: 'Tatham Centre', lat: 43.4697, lon: -80.5445, aliases: ['tatham'] },
  { code: 'EV1', name: 'Environment 1', lat: 43.4689, lon: -80.5430, aliases: ['environment 1'] },
  { code: 'EV2', name: 'Environment 2', lat: 43.4687, lon: -80.5426, aliases: ['environment 2'] },
  { code: 'EV3', name: 'Environment 3', lat: 43.4684, lon: -80.5435, aliases: ['environment 3'] },
  { code: 'REV', name: 'Ron Eydt Village', lat: 43.4704, lon: -80.5544, aliases: ['ron eydt'] },
  { code: 'V1', name: 'Village 1', lat: 43.4715, lon: -80.5505, aliases: ['village 1', 'village one'] },
  { code: 'MKV', name: 'Mackenzie King Village', lat: 43.4702, lon: -80.5528, aliases: ['mackenzie king'] },
  { code: 'UWP', name: 'UW Place', lat: 43.4721, lon: -80.5372, aliases: ['uw place', 'university of waterloo place'] },
  { code: 'CMH', name: 'Claudette Millar Hall', lat: 43.4735, lon: -80.5358, aliases: ['claudette millar', 'millar hall'] },
];

/** Common names for places whose stops carry a different official name. */
const LANDMARKS = [
  { phrase: 'conestoga mall', query: 'conestoga station', hint: 'Serves Conestoga Mall' },
  { phrase: 'fairview park mall', query: 'fairway station', hint: 'Serves Fairview Park Mall' },
  { phrase: 'fairview', query: 'fairway station', hint: 'Serves Fairview Park Mall' },
  { phrase: 'uptown waterloo', query: 'waterloo public square', hint: 'Serves Uptown Waterloo' },
  { phrase: 'uptown', query: 'waterloo public square', hint: 'Serves Uptown Waterloo' },
  { phrase: 'wilfrid laurier', query: 'laurier', hint: 'Serves Wilfrid Laurier University' },
  { phrase: 'wlu', query: 'laurier', hint: 'Serves Wilfrid Laurier University' },
  { phrase: 'research park', query: 'research and technology', hint: 'Serves the David Johnston Research + Technology Park' },
  { phrase: 'david johnston', query: 'research and technology', hint: 'Serves the David Johnston Research + Technology Park' },
  { phrase: 'r and t', query: 'research and technology', hint: 'Serves the David Johnston Research + Technology Park' },
  { phrase: 'downtown kitchener', query: 'kitchener city hall', hint: 'Serves downtown Kitchener' },
];

const SYNONYMS = { road: 'rd', avenue: 'ave', av: 'ave', street: 'st', drive: 'dr', boulevard: 'blvd', crescent: 'cres', court: 'crt', place: 'pl',
  northbound: 'nb', southbound: 'sb', eastbound: 'eb', westbound: 'wb', centre: 'center', ctr: 'center', stn: 'station', univ: 'university' };
const IGNORED = new Set(['and', 'at', 'of', 'the', 'stop', 'near']);
const NEAR_METRES = 600;

export function normalizeText(text) {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[&+]/g, ' and ').replace(/[.']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
export function searchTokens(text) {
  return normalizeText(text).split(' ').map(t => SYNONYMS[t] ?? t).filter(t => t && !IGNORED.has(t));
}
function nameTokens(name) {
  const tokens = searchTokens(name);
  // "University Of Waterloo" is spelled out in some names and "U.W." in others.
  if (/university of waterloo/i.test(name) && !tokens.includes('uw')) tokens.push('uw');
  return tokens;
}

/** Bounded Damerau-Levenshtein distance; returns max + 1 once the bound is exceeded. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v); best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = row;
  }
  return prev[b.length];
}

function tokenScore(query, tokens) {
  let best = 0;
  for (const token of tokens) {
    if (token === query) return 3;
    if (token.startsWith(query)) { best = Math.max(best, 2); continue; }
    if (query.length >= 4 && !/\d/.test(query)) {
      const max = query.length >= 8 ? 2 : 1;
      if (editDistance(query, token, max) <= max || editDistance(query, token.slice(0, query.length), max) <= max) best = Math.max(best, 1);
    }
  }
  return best;
}

/** Score one stop name against already tokenized query words; 0 means no match. */
export function nameScore(queryTokens, compactQuery, entry) {
  if (!queryTokens.length) return 0;
  let total = 0;
  for (const q of queryTokens) {
    const s = tokenScore(q, entry.tokens);
    if (!s) return compactQuery.length >= 3 && entry.compact.includes(compactQuery) ? 1 : 0;
    total += s;
  }
  if (entry.tokens[0] === queryTokens[0] || entry.tokens[0]?.startsWith(queryTokens[0])) total += 2;
  return total + queryTokens.length / entry.tokens.length;
}

export function distanceMetres(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Campus places the query names, either by building code (E7, "MC 4020") or a spelled-out alias. */
export function matchPlaces(queryTokens) {
  if (!queryTokens.length) return [];
  const [first] = queryTokens, room = /^([a-z]{1,3})(\d{3,4}[a-z]?)$/.exec(first);
  const byCode = CAMPUS_PLACES.filter(p => { const code = p.code.toLowerCase(); return code === first || room?.[1] === code; });
  if (byCode.length) return byCode.map(place => ({ place, strength: 'code' }));
  return CAMPUS_PLACES.filter(p => p.aliases.some(alias => {
    const tokens = searchTokens(alias);
    if (queryTokens.length < Math.min(tokens.length, 2) || queryTokens.length > tokens.length) return false;
    // The last word may still be half typed, but a two-letter fragment is too vague to name a building.
    return queryTokens.every((q, i) => i === queryTokens.length - 1 ? tokens[i].startsWith(q) && q.length >= Math.min(3, tokens[i].length) : tokens[i] === q);
  })).map(place => ({ place, strength: 'alias' }));
}

function landmarkQueries(text) {
  const normal = normalizeText(text);
  return LANDMARKS.filter(l => normal === l.phrase || normal.startsWith(`${l.phrase} `) || (normal.length >= 4 && l.phrase.startsWith(normal) && l.phrase.split(' ').length > 1))
    .map(l => ({ tokens: searchTokens(l.query), hint: l.hint }));
}

/**
 * Rank a stop catalog for a query. `entries` carry { stop, tokens, compact }; the result is a list of
 * { entry, score, hint } sorted best first. Stops without coordinates simply never match a place.
 */
export function rankStops(entries, q) {
  const text = String(q || '').slice(0, 80);
  const tokens = searchTokens(text), compact = tokens.join('');
  const digits = normalizeText(text).replace(/\s+/g, '');
  const results = new Map();
  const offer = (entry, score, hint = null) => { const prev = results.get(entry.stop.id); if (!prev || score > prev.score) results.set(entry.stop.id, { entry, score, hint: hint ?? prev?.hint ?? null }); };
  if (!tokens.length) return entries.map(entry => ({ entry, score: 0, hint: null })).sort((a, b) => compareStops(a.entry.stop, b.entry.stop));
  const places = matchPlaces(tokens), landmarks = landmarkQueries(text);
  for (const entry of entries) {
    const { stop } = entry;
    if (/^\d+$/.test(digits) && digits.length >= 2) {
      if (stop.code === digits) offer(entry, 200);
      else if (digits.length >= 3 && stop.code.startsWith(digits)) offer(entry, 20);
    }
    const score = nameScore(tokens, compact, entry);
    if (score) offer(entry, score);
    for (const landmark of landmarks) { const s = nameScore(landmark.tokens, landmark.tokens.join(''), entry); if (s) offer(entry, 10 + s, landmark.hint); }
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) for (const { place, strength } of places) {
      const metres = distanceMetres(place, stop);
      if (metres <= NEAR_METRES) offer(entry, (strength === 'code' ? 100 : 60) - metres / 100, `Near ${place.code} · ${place.name}`);
    }
  }
  return [...results.values()].sort((a, b) => b.score - a.score || compareStops(a.entry.stop, b.entry.stop));
}

function compareStops(a, b) { return a.name.localeCompare(b.name) || a.code.localeCompare(b.code, undefined, { numeric: true }); }

export function searchEntry(stop) { const tokens = nameTokens(stop.name); return { stop, tokens, compact: tokens.join('') }; }

export function sortRoutes(routes) { return [...new Set(routes)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
