import { CookingPot, Croissant, Flame, Pizza, Salad, Sandwich, Soup, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { stationKind, type StationKind } from '@/lib/menu';

const ICONS: Record<StationKind, LucideIcon> = {
  grill: Flame,
  stove: CookingPot,
  build: Salad,
  pizza: Pizza,
  deli: Sandwich,
  soup: Soup,
  bakery: Croissant,
  other: UtensilsCrossed,
};

/** Decorative: the station name is always printed next to it. */
export function StationIcon({ station, size = 14 }: { station: string; size?: number }) {
  const Icon = ICONS[stationKind(station)];
  return <Icon size={size} aria-hidden />;
}
