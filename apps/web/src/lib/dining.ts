/**
 * Campus dining locations: display names, buildings and zones for the raw outlet names the UW
 * daily-menu feed uses ("REVelation - Residence Dining Hall").
 */
export interface OutletLocationInfo {
  name: string;
  building: string;
  code: string;
  campusZone: string;
}

export const CAMPUS_DINING_LOCATIONS: OutletLocationInfo[] = [
  { name: 'REVelation', building: 'Ron Eydt Village', code: 'REV', campusZone: 'West Campus' },
  { name: "Mudie's", building: 'Village 1', code: 'V1', campusZone: 'North Campus' },
  { name: 'The Market', building: 'Claudette Millar Hall', code: 'CMH', campusZone: 'East Campus' },
  { name: 'Brubakers Food Court', building: 'Student Life Centre', code: 'SLC', campusZone: 'Central Campus' },
  { name: 'Tim Hortons (5 Hubs)', building: 'SLC, DC, SCH, ML, EC5', code: 'TIMS', campusZone: 'Campus Wide' },
  { name: 'Browsers Café', building: 'Dana Porter Library', code: 'DPL', campusZone: 'South Campus' },
  { name: 'South Side Marketplace', building: 'South Campus Hall', code: 'SCH', campusZone: 'South Campus Entrance' },
  { name: 'Liquid Assets Café', building: 'Hagey Hall', code: 'HH', campusZone: 'Arts Quad' },
  { name: 'CEIT Café', building: 'EIT Building', code: 'EIT', campusZone: 'North-Central Campus' },
  { name: 'Ev3rgreen Café', building: 'Environment 3', code: 'EV3', campusZone: 'Central Campus' },
  { name: "ML's Diner", building: 'Modern Languages', code: 'ML', campusZone: 'Arts Quad' },
  { name: 'Starbucks', building: 'Science Teaching Complex & AHS', code: 'STC', campusZone: 'Science Quad' },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match on the name or building, or the short code as a whole word ("SCH" must not match "school"). */
export function getOutletLocation(rawName: string): OutletLocationInfo {
  const lower = rawName.toLowerCase();
  const found = CAMPUS_DINING_LOCATIONS.find((loc) =>
    lower.includes(loc.name.toLowerCase())
    || lower.includes(loc.building.toLowerCase())
    || new RegExp(`\\b${escape(loc.code.toLowerCase())}\\b`).test(lower));
  if (found) return found;
  const cleaned = rawName.replace(/\s*[-–]\s*Residence Dining Hall\s*$/i, '').trim();
  return { name: cleaned || rawName, building: 'Campus Food Services', code: 'UW', campusZone: 'Main Campus' };
}
