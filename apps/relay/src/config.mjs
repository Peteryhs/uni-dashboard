/**
 * Personal configuration. Deliberately a committed file in v1, not a settings UI: editing pins
 * is a text edit, and the UI version is a write path plus a settings screen on two clients.
 */
export const config = {
  timezone: 'America/Toronto',

  /** Pinned outlets always render, even closed. REV is home; CMH is the other hall worth the walk. */
  pinnedOutlets: [
    'REVelation - Residence Dining Hall',
    "Mudie's - Residence Dining Hall",
    'The Market - Residence Dining Hall',
  ],

  /** Building-to-building walk minutes, written once by hand. Replaces live transit data. */
  homeBuilding: 'REV',
  walkMinutes: {
    'REV->E7': 14,
    'REV->E5': 15,
    'REV->E3': 12,
    'REV->MC': 17,
    'REV->DC': 20,
    'REV->RCH': 13,
    'REV->CPH': 14,
    'REV->PHY': 16,
    'REV->QNC': 12,
    'E7->E5': 2,
    'E7->E3': 4,
    'E5->E3': 3,
  },

  /** Only used to guess the walk when a room string has no building prefix. */
  defaultWalkMinutes: 15,

  /** Alert slot shows only when status is not normal. */
  alertSeverities: ['minor', 'major', 'critical', 'credential'],
};

export const BUILDING_COORDS = {
  REV: { lat: 43.4704, lng: -80.5544, name: 'Ron Eydt Village' },
  CMH: { lat: 43.4735, lng: -80.5358, name: 'Claudette Millar Hall' },
  V1: { lat: 43.4715, lng: -80.5505, name: 'Village 1' },
  MKV: { lat: 43.4702, lng: -80.5528, name: 'Mackenzie King Village' },
  UWP: { lat: 43.4721, lng: -80.5372, name: 'University Waterloo Place' },
  CLV: { lat: 43.4831, lng: -80.5505, name: 'Columbia Lake Village' },
  E7: { lat: 43.4730, lng: -80.5396, name: 'Engineering 7' },
  E5: { lat: 43.4727, lng: -80.5401, name: 'Engineering 5' },
  E3: { lat: 43.4716, lng: -80.5413, name: 'Engineering 3' },
  E2: { lat: 43.4715, lng: -80.5416, name: 'Engineering 2' },
  E6: { lat: 43.4735, lng: -80.5402, name: 'Engineering 6' },
  DWE: { lat: 43.4705, lng: -80.5410, name: 'Douglas Wright Engineering' },
  CPH: { lat: 43.4712, lng: -80.5418, name: 'Carl A. Pollock Hall' },
  RCH: { lat: 43.4703, lng: -80.5415, name: 'J.R. Coutts Hall' },
  MC: { lat: 43.4721, lng: -80.5440, name: 'Mathematics & Computer' },
  M3: { lat: 43.4734, lng: -80.5440, name: 'Mathematics 3' },
  DC: { lat: 43.4728, lng: -80.5420, name: 'William G. Davis Centre' },
  QNC: { lat: 43.4715, lng: -80.5445, name: 'Quantum-Nano Centre' },
  PHY: { lat: 43.4717, lng: -80.5430, name: 'Physics' },
  ESC: { lat: 43.4711, lng: -80.5425, name: 'Earth Sciences & Chemistry' },
  B1: { lat: 43.4707, lng: -80.5440, name: 'Biology 1' },
  B2: { lat: 43.4702, lng: -80.5436, name: 'Biology 2' },
  STC: { lat: 43.4708, lng: -80.5432, name: 'Science Teaching Complex' },
  PAC: { lat: 43.4717, lng: -80.5470, name: 'Physical Activities Complex' },
  SLC: { lat: 43.4717, lng: -80.5457, name: 'Student Life Centre' },
  CIF: { lat: 43.4728, lng: -80.5495, name: 'Columbia Icefield' },
  HH: { lat: 43.4682, lng: -80.5425, name: 'Hagey Hall' },
  AL: { lat: 43.4691, lng: -80.5425, name: 'Arts Lecture Hall' },
  ML: { lat: 43.4692, lng: -80.5440, name: 'Modern Languages' },
  PAS: { lat: 43.4688, lng: -80.5442, name: 'Psychology, Anthropology, Sociology' },
  SCH: { lat: 43.4689, lng: -80.5450, name: 'South Campus Hall' },
  TC: { lat: 43.4697, lng: -80.5445, name: 'William M. Tatham Centre' },
  BMH: { lat: 43.4738, lng: -80.5460, name: 'B.C. Matthews Hall' },
  EXP: { lat: 43.4745, lng: -80.5450, name: 'Expansion Building' },
  PSE: { lat: 43.4725, lng: -80.5410, name: 'Physics / Science' },
  EV1: { lat: 43.4689, lng: -80.5430, name: 'Environment 1' },
  EV2: { lat: 43.4687, lng: -80.5426, name: 'Environment 2' },
  EV3: { lat: 43.4684, lng: -80.5435, name: 'Environment 3' },
};

const routeCache = new Map();

function haversineMeters(c1, c2) {
  const R = 6371000;
  const dLat = ((c2.lat - c1.lat) * Math.PI) / 180;
  const dLng = ((c2.lng - c1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((c1.lat * Math.PI) / 180) *
      Math.cos((c2.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function walkMinutes(from, to) {
  if (!from || !to) return config.defaultWalkMinutes;
  if (from === to) return 0;
  return config.walkMinutes[`${from}->${to}`] ?? config.walkMinutes[`${to}->${from}`] ?? config.defaultWalkMinutes;
}

/**
 * Calculates walking duration in minutes using OpenStreetMap pedestrian routing,
 * falling back to curated table or campus footpaths distance formula.
 */
export async function calculateWalkMinutes(from, to, { useApi = true } = {}) {
  if (!from || !to) return config.defaultWalkMinutes;
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 0;

  const cacheKey = `${f}->${t}`;
  if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);

  // If useApi is false (e.g. fast deterministic tests), prefer static table
  if (!useApi) {
    const tableVal = config.walkMinutes[`${f}->${t}`] ?? config.walkMinutes[`${t}->${f}`];
    if (tableVal != null) return tableVal;
  }

  const c1 = BUILDING_COORDS[f];
  const c2 = BUILDING_COORDS[t];

  if (useApi && c1 && c2) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1800);
      const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${c1.lng},${c1.lat};${c2.lng},${c2.lat}?overview=false`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data.code === 'Ok' && data.routes?.[0]?.duration != null) {
          const mins = Math.max(1, Math.round(data.routes[0].duration / 60));
          routeCache.set(cacheKey, mins);
          routeCache.set(`${t}->${f}`, mins);
          return mins;
        }
      }
    } catch {
      // Graceful fallback to table or geometry if API is unreachable/offline
    }
  }

  // Fallback 1: Hand-curated table
  const tableVal = config.walkMinutes[`${f}->${t}`] ?? config.walkMinutes[`${t}->${f}`];
  if (tableVal != null) {
    routeCache.set(cacheKey, tableVal);
    return tableVal;
  }

  // Fallback 2: Geometric distance on campus footpaths
  if (c1 && c2) {
    const distMeters = haversineMeters(c1, c2);
    const estimated = Math.max(1, Math.round((distMeters * 1.3) / 80));
    routeCache.set(cacheKey, estimated);
    return estimated;
  }

  return config.defaultWalkMinutes;
}

/**
 * Builds a direct Google Maps walking navigation link.
 */
export function googleMapsNavUrl(from, to) {
  if (!to) return null;
  const originQuery = from ? `University of Waterloo ${from}` : 'University of Waterloo';
  const destQuery = `University of Waterloo ${to}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originQuery)}&destination=${encodeURIComponent(destQuery)}&travelmode=walking`;
}

/**
 * "E7 2317" -> "E7", "MC 4021" -> "MC", "RCH 305" -> "RCH", "PAC 1" -> "PAC", "SLC" -> "SLC".
 * UW room strings put a short building code first (one to four characters, optionally one digit),
 * then the room number. Getting this wrong silently falls back to a default walk time, which is
 * how a leave-by time becomes a lie.
 */
export function buildingOf(room) {
  if (!room) return '';
  const trimmed = room.trim();
  const withNumber = /^([A-Za-z]{1,4}\d?)[\s\-]+(\d{1,5}[A-Za-z]?)$/.exec(trimmed);
  if (withNumber) return withNumber[1].toUpperCase();
  const bare = /^([A-Za-z]{1,4}\d?)$/.exec(trimmed);
  if (bare) return bare[1].toUpperCase();
  const loose = /^([A-Za-z]{1,4}\d?)\b/.exec(trimmed);
  return loose ? loose[1].toUpperCase() : '';
}
