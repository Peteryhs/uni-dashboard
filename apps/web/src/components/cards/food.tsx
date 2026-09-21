/**
 * Card 3: food. The owner's number one want, so it gets the most vertical space and features.
 *
 * Priorities:
 * 1. Pinned outlets always render, including when nothing is posted.
 * 2. Taste history: User can star favorite dishes and outlets, which float to the top.
 * 3. Instant search & dietary filtering across all dining halls.
 * 4. Density awareness: Full detailed view vs compact summary view.
 */
import { useMemo, useState } from 'react';
import { UtensilsCrossed, Search, Star, X, ChevronRight, MapPin, Compass, Building2 } from 'lucide-react';
import { CardShell, EmptyState } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { mutedIfStale } from '@/components/freshness';
import { usePreferences, type DietaryPreference } from '@/lib/preferences-store';
import type { Card as CardT, FoodData, FoodDish, FoodOutletPinned } from '@/lib/contract';
import { dayOffset, dietLabel } from '@/lib/time';
import { cn } from '@/lib/utils';

export interface OutletLocationInfo {
  name: string;
  building: string;
  code: string;
  campusZone: string;
  description: string;
  walkHint: string;
}

export const CAMPUS_DINING_LOCATIONS: OutletLocationInfo[] = [
  {
    name: 'REVelation',
    building: 'Ron Eydt Village',
    code: 'REV',
    campusZone: 'West Campus',
    description: 'Main REV Residence Dining Hall · Hot entrees, wok, grill & pizza',
    walkHint: 'Home base (0 min)',
  },
  {
    name: "Mudie's",
    building: 'Village 1',
    code: 'V1',
    campusZone: 'North Campus',
    description: 'Main V1 Residence Dining Hall · Daily hot counters, grill & fresh bakery',
    walkHint: '~12 min walk from REV',
  },
  {
    name: 'The Market',
    building: 'Claudette Millar Hall',
    code: 'CMH',
    campusZone: 'East Campus',
    description: 'CMH Residence Dining Hall · Made-to-order bowls, market & grocery',
    walkHint: '~16 min walk from REV',
  },
  {
    name: 'Brubakers Food Court',
    building: 'Student Life Centre',
    code: 'SLC',
    campusZone: 'Central Campus',
    description: 'SLC Lower Level · Subway, Pita Pit, Quesada, Shawarma Hub, Teriyaki',
    walkHint: '~10 min walk from REV',
  },
  {
    name: 'Tim Hortons (5 Hubs)',
    building: 'SLC, DC, SCH, ML, EC5',
    code: 'TIMS',
    campusZone: 'Campus Wide',
    description: 'Coffee, donuts, breakfast wraps & bagels across 5 campus spots',
    walkHint: 'Davis Centre & SLC hubs',
  },
  {
    name: 'Browsers Café',
    building: 'Dana Porter Library',
    code: 'DPL',
    campusZone: 'South Campus',
    description: 'Dana Porter Arts Library Ground Floor · Coffee, espresso & snacks',
    walkHint: '~15 min walk from REV',
  },
  {
    name: 'South Side Marketplace',
    building: 'South Campus Hall',
    code: 'SCH',
    campusZone: 'South Campus Entrance',
    description: 'Beside main University Ave entrance · Hot lunches, deli & soup bar',
    walkHint: '~16 min walk from REV',
  },
  {
    name: 'Liquid Assets Café',
    building: 'Hagey Hall',
    code: 'HH',
    campusZone: 'Arts Quad',
    description: 'Hagey Hall Atrium · Gourmet coffee, sandwiches & pastry case',
    walkHint: '~15 min walk from REV',
  },
  {
    name: 'CEIT Café',
    building: 'EIT Building',
    code: 'EIT',
    campusZone: 'North-Central Campus',
    description: 'EIT Dinosaur Museum Atrium · Coffee, light lunches & treats',
    walkHint: '~18 min walk from REV',
  },
  {
    name: 'Ev3rgreen Café',
    building: 'Environment 3',
    code: 'EV3',
    campusZone: 'Central Campus',
    description: 'Environment 3 Living Wall Atrium · Fair trade & plant-forward items',
    walkHint: '~12 min walk from REV',
  },
  {
    name: "ML's Diner",
    building: 'Modern Languages',
    code: 'ML',
    campusZone: 'Arts Quad',
    description: 'Modern Languages Ground Floor · All-day breakfast, burgers & poutine',
    walkHint: '~14 min walk from REV',
  },
  {
    name: 'Starbucks',
    building: 'Science Teaching Complex & AHS',
    code: 'STC',
    campusZone: 'Science Quad',
    description: 'Science Teaching Complex Ground Floor · Espresso & cold brews',
    walkHint: '~16 min walk from REV',
  },
];

export function getOutletLocation(rawName: string): OutletLocationInfo {
  const lower = rawName.toLowerCase();
  for (const loc of CAMPUS_DINING_LOCATIONS) {
    if (
      lower.includes(loc.name.toLowerCase()) ||
      lower.includes(loc.code.toLowerCase()) ||
      lower.includes(loc.building.toLowerCase())
    ) {
      return loc;
    }
  }
  const cleaned = rawName.replace(/\s*[-–]\s*Residence Dining Hall\s*$/i, '').trim();
  return {
    name: cleaned || rawName,
    building: 'Campus Food Services',
    code: 'UW',
    campusZone: 'Main Campus',
    description: 'UW Campus Dining Location',
    walkHint: 'Campus eatery',
  };
}

/** Diet tags the UW feed actually emits. Anything unknown falls through to a neutral chip. */
const DIET_TONE: Record<string, string> = {
  vegan: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  vegetarian: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  halal: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  kosher: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  dairy: 'border-white/10 bg-secondary/30 text-muted-foreground',
  gluten: 'border-white/10 bg-secondary/30 text-muted-foreground',
};

const DIETARY_TAGS: { id: DietaryPreference; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'halal', label: 'Halal' },
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Veg' },
  { id: 'dairy', label: 'Dairy' },
];

export function FoodCard({ card, now }: { card: CardT<FoodData>; now: number }) {
  const d = card.data;
  const muted = mutedIfStale(card.state);
  const {
    preferences,
    setDietaryFilter,
    toggleFavoriteDish,
    isFavoriteDish,
    setOnlyFavorites,
  } = usePreferences();

  const [localSearch, setLocalSearch] = useState('');
  const [selectedOutlet, setSelectedOutlet] = useState<string>('all');
  const [showCampusDirectory, setShowCampusDirectory] = useState(false);

  const offset = dayOffset(Date.parse(`${d.service_date}T12:00:00Z`), now);
  const dayLabel = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : d.service_date;
  const nothingAtAll = d.total_dishes === 0;

  // Filtered pinned outlets
  const processedOutlets = useMemo(() => {
    return d.pinned.map((outlet) => {
      let dishes = [...outlet.dishes];

      // 1. Dietary filter
      if (preferences.dietaryFilter !== 'all') {
        const filter = preferences.dietaryFilter.toLowerCase();
        dishes = dishes.filter((dish) =>
          dish.diet.some((t) => t.toLowerCase() === filter),
        );
      }

      // 2. Search query
      if (localSearch.trim()) {
        const q = localSearch.trim().toLowerCase();
        dishes = dishes.filter((dish) => dish.dish.toLowerCase().includes(q));
      }

      // 3. Only favorites toggle
      if (preferences.onlyFavorites) {
        dishes = dishes.filter((dish) => isFavoriteDish(dish.dish));
      }

      // 4. Taste ranking sort: Starred dishes float to top
      dishes.sort((a, b) => {
        const aFav = isFavoriteDish(a.dish) ? 1 : 0;
        const bFav = isFavoriteDish(b.dish) ? 1 : 0;
        return bFav - aFav;
      });

      return {
        ...outlet,
        dishes,
        serving: outlet.serving,
        matchCount: dishes.length,
      };
    });
  }, [d.pinned, preferences.dietaryFilter, preferences.onlyFavorites, localSearch, isFavoriteDish]);

  const visibleOutlets = useMemo(() => {
    if (selectedOutlet === 'all') return processedOutlets;
    return processedOutlets.filter((o) => o.outlet === selectedOutlet);
  }, [processedOutlets, selectedOutlet]);

  const totalFilteredDishes = useMemo(() => {
    return processedOutlets.reduce((acc, o) => acc + o.dishes.length, 0);
  }, [processedOutlets]);

  return (
    <CardShell
      title="Daily Food & Menus"
      icon={<UtensilsCrossed className="size-3.5" />}
      state={card.state}
      observedAt={card.observed_at}
      sourceId={card.source_id || undefined}
      now={now}
      action={
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className="border-white/10 bg-secondary/30 px-2 py-0.5 text-[10px] font-medium tracking-wide text-foreground/90 backdrop-blur-sm"
          >
            {nothingAtAll ? d.service_date : `${d.total_dishes} dishes · ${dayLabel}`}
          </Badge>
        </div>
      }
    >
      {nothingAtAll ? (
        <EmptyState hint="The daily menu feed has nothing posted for this service date.">
          No menu posted
        </EmptyState>
      ) : (
        <div className="space-y-3.5">
          {/* Controls Bar: Search & Quick Diet Chips */}
          <div className="flex flex-col gap-2 pt-1">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-zinc-400" />
              <Input
                type="text"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder="Search dishes across dining halls (e.g. lasagna, chicken, tofu)..."
                className="h-8 pl-8 pr-8 text-xs bg-card border-border/80 text-foreground placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
              />
              {localSearch && (
                <button
                  type="button"
                  onClick={() => setLocalSearch('')}
                  aria-label="Clear search input"
                  className="absolute right-2.5 rounded-md p-0.5 text-zinc-400 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* Outlet selector tabs, dietary filter pills, and guide button */}
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              {/* Outlet switcher with building codes */}
              <div className="inline-flex flex-wrap rounded-lg bg-secondary/40 p-0.5 text-xs border border-border/60">
                <button
                  type="button"
                  onClick={() => setSelectedOutlet('all')}
                  className={cn(
                    'rounded-md px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    selectedOutlet === 'all'
                      ? 'bg-card text-foreground font-medium shadow-xs'
                      : 'text-zinc-400 hover:text-foreground',
                  )}
                >
                  All Outlets
                </button>
                {d.pinned.map((o) => {
                  const loc = getOutletLocation(o.outlet);
                  const isSelected = selectedOutlet === o.outlet;
                  return (
                    <button
                      key={o.outlet}
                      type="button"
                      onClick={() => setSelectedOutlet(o.outlet)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        isSelected
                          ? 'bg-card text-foreground font-medium shadow-xs'
                          : 'text-zinc-400 hover:text-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'rounded px-1 text-[9px] font-bold tracking-wider',
                          isSelected ? 'bg-live/25 text-live' : 'bg-white/10 text-zinc-300',
                        )}
                      >
                        {loc.code}
                      </span>
                      <span>{loc.name}</span>
                    </button>
                  );
                })}
              </div>

              {/* Dietary filters & Guide button */}
              <div className="flex flex-wrap items-center gap-1">
                {DIETARY_TAGS.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setDietaryFilter(tag.id)}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                      preferences.dietaryFilter === tag.id
                        ? 'border border-live/60 bg-live/15 text-live'
                        : 'border border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground',
                    )}
                  >
                    {tag.label}
                  </button>
                ))}

                {/* Favorites filter toggle */}
                <button
                  type="button"
                  onClick={() => setOnlyFavorites(!preferences.onlyFavorites)}
                  title="Show only favorited dishes"
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    preferences.onlyFavorites
                      ? 'border border-amber/50 bg-amber/15 text-amber-foreground'
                      : 'border border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground',
                  )}
                >
                  <Star
                    className={cn(
                      'size-3',
                      preferences.onlyFavorites && 'fill-amber text-amber',
                    )}
                  />
                  <span>Favorites</span>
                </button>

                {/* Campus Locations Directory toggle */}
                <button
                  type="button"
                  onClick={() => setShowCampusDirectory(!showCampusDirectory)}
                  title="View Waterloo campus dining locations & building codes"
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    showCampusDirectory
                      ? 'border border-live/60 bg-live/15 text-live'
                      : 'border border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground',
                  )}
                >
                  <Compass className="size-3.5 text-live" />
                  <span className="hidden sm:inline">Location Guide</span>
                  <span className="sm:hidden">Guide</span>
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Campus Dining Guide (Collapsible) */}
          {showCampusDirectory && (
            <div className="rounded-lg border border-border/80 bg-card p-3.5 shadow-sm">
              <div className="flex items-center justify-between pb-2 border-b border-border/60">
                <div className="flex items-center gap-2">
                  <Building2 className="size-4 text-live" />
                  <div>
                    <h4 className="text-xs font-semibold text-foreground">
                      Waterloo Campus Dining Locations
                    </h4>
                    <p className="text-[11px] text-zinc-400">
                      Building codes & eateries across campus
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCampusDirectory(false)}
                  aria-label="Close location guide"
                  className="rounded-md p-1 text-zinc-400 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {CAMPUS_DINING_LOCATIONS.map((loc) => (
                  <div
                    key={loc.code + loc.name}
                    className="flex flex-col justify-between rounded-lg border border-border/70 bg-secondary/30 p-2.5 hover:border-border transition-colors"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-xs text-foreground">{loc.name}</span>
                        <span className="rounded bg-live/15 px-1 py-0.5 text-[9px] font-bold text-live border border-live/20">
                          {loc.code}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-400">
                        <MapPin className="size-2.5 text-live shrink-0" />
                        <span className="font-medium text-zinc-300">{loc.building}</span>
                        <span>·</span>
                        <span>{loc.campusZone}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400 leading-tight line-clamp-2">
                        {loc.description}
                      </p>
                    </div>
                    <div className="mt-2 pt-1 border-t border-border/50 text-[10px] font-mono text-zinc-400">
                      {loc.walkHint}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outlets Listing */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visibleOutlets.map((outlet) => (
              <PinnedOutletSection
                key={outlet.outlet}
                outlet={outlet}
                muted={muted}
                density={preferences.density}
                isFavoriteDish={isFavoriteDish}
                toggleFavoriteDish={toggleFavoriteDish}
              />
            ))}

            {visibleOutlets.every((o) => o.dishes.length === 0) && (
              <div className="col-span-full rounded-lg border border-dashed border-border/70 p-4 text-center">
                <p className="text-xs text-zinc-400">
                  No dishes match the selected filter or search query.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setLocalSearch('');
                    setDietaryFilter('all');
                    setOnlyFavorites(false);
                  }}
                  className="mt-2 text-xs font-medium text-live hover:underline focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none rounded px-1"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>

          {/* Secondary Outlets Section (e.g. Other Campus Locations) */}
          {d.others.length > 0 && selectedOutlet === 'all' && !localSearch && (
            <>
              <Separator className="bg-border/60" />
              <div className="rounded-lg bg-secondary/20 p-3 border border-border/60">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                    Other Campus Locations
                  </span>
                  <span className="text-xs text-zinc-400">
                    {d.others_count} location{d.others_count === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {d.others.map((o) => {
                    const loc = getOutletLocation(o.outlet);
                    return (
                      <div
                        key={o.outlet}
                        className="flex items-center justify-between rounded-md bg-card/60 px-3 py-2 text-xs text-zinc-300 hover:bg-card transition-colors border border-border/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-zinc-300 border border-white/10">
                            {loc.code}
                          </span>
                          <div>
                            <span className="font-medium text-foreground">{loc.name}</span>
                            <span className="ml-1.5 text-xs text-zinc-400">· {loc.building} ({loc.campusZone})</span>
                          </div>
                        </div>
                        <span className="tabular-nums text-xs text-zinc-400">
                          {o.dish_count} dishes serving
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Summary footer line */}
          <div className="flex items-center justify-between pt-1 text-xs text-zinc-400">
            <span>
              Showing {totalFilteredDishes} of {d.total_dishes} dishes
            </span>
            <span className="flex items-center gap-1.5 text-zinc-300">
              <Star className="size-3 text-amber fill-amber" /> Click ★ to rank dishes to your taste
            </span>
          </div>
        </div>
      )}
    </CardShell>
  );
}

function PinnedOutletSection({
  outlet,
  muted,
  density,
  isFavoriteDish,
  toggleFavoriteDish,
}: {
  outlet: FoodOutletPinned & { matchCount?: number };
  muted: string;
  density: 'detailed' | 'compact';
  isFavoriteDish: (name: string) => boolean;
  toggleFavoriteDish: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const loc = getOutletLocation(outlet.outlet);

  return (
    <div className="flex flex-col rounded-lg border border-border/80 bg-card/70 p-3.5 transition-colors hover:border-border">
      {/* Outlet Header */}
      <div className="flex flex-col gap-2 border-b border-border/60 pb-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5">
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? 'Collapse outlet menu' : 'Expand outlet menu'}
              className="mt-0.5 rounded-md p-0.5 text-zinc-400 transition-colors hover:bg-secondary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <ChevronRight
                className={cn(
                  'size-4 transition-transform duration-200',
                  expanded && 'rotate-90',
                )}
              />
            </button>

            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-live/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-live border border-live/30">
                  {loc.code}
                </span>
                <h3 className={cn('text-sm font-semibold tracking-tight text-foreground', muted)}>
                  {loc.name}
                </h3>
              </div>

              {/* Direct location badge with building, campus zone, and walking hint */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <MapPin className="size-3 text-live shrink-0" />
                  {loc.building} ({loc.code})
                </span>
                <span>·</span>
                <span className="text-zinc-300">{loc.campusZone}</span>
                {loc.walkHint && (
                  <>
                    <span>·</span>
                    <span className="text-[11px] text-zinc-400 font-mono">{loc.walkHint}</span>
                  </>
                )}
              </div>

              <p className="text-xs text-zinc-400">
                {loc.description}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0 pt-0.5">
            {outlet.serving ? (
              <Badge
                variant="outline"
                className="border-border/80 bg-secondary/40 px-2 py-0 text-[10px] font-medium text-zinc-300 tabular-nums"
              >
                {outlet.dishes.length} dishes
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber/30 bg-amber/10 px-2 py-0 text-[10px] text-amber-foreground"
              >
                nothing posted
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Dishes List */}
      {expanded && (
        <div className="mt-2.5 pt-1">
          {outlet.serving ? (
            outlet.dishes.length > 0 ? (
              <div className={density === 'compact' ? 'space-y-1' : 'space-y-1.5'}>
                {outlet.dishes.map((dish) => {
                  const isFav = isFavoriteDish(dish.dish);
                  return (
                    <DishItem
                      key={dish.dish}
                      dish={dish}
                      muted={muted}
                      isFavorite={isFav}
                      onToggleFavorite={() => toggleFavoriteDish(dish.dish)}
                      compact={density === 'compact'}
                    />
                  );
                })}
                {outlet.hidden_dishes > 0 && (
                  <p className="pt-1 text-xs text-zinc-400 pl-6">
                    +{outlet.hidden_dishes} additional items
                  </p>
                )}
              </div>
            ) : (
              <p className="py-1 text-xs text-zinc-400 pl-6">
                No dishes matching the active filters.
              </p>
            )
          ) : (
            <p className="text-xs text-zinc-400 pl-6">
              Pinned outlet. No menu items currently posted for today.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DishItem({
  dish,
  muted,
  isFavorite,
  onToggleFavorite,
  compact,
}: {
  dish: FoodDish;
  muted: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-2 rounded-lg px-2 transition-colors hover:bg-secondary/40',
        compact ? 'py-0.5' : 'py-1',
        isFavorite && 'bg-amber/5 border border-amber/20',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          className="shrink-0 p-0.5 text-zinc-400 transition-colors hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded"
        >
          <Star
            className={cn(
              'size-3.5 transition-all',
              isFavorite
                ? 'fill-amber text-amber scale-110'
                : 'text-zinc-500 hover:text-amber group-hover:text-zinc-400',
            )}
          />
        </button>

        {dish.url ? (
          <a
            href={dish.url}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              'truncate text-xs transition-colors hover:text-live-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded',
              isFavorite ? 'font-medium text-foreground' : 'text-zinc-200',
              muted,
            )}
          >
            {dish.dish}
          </a>
        ) : (
          <span
            className={cn(
              'truncate text-xs',
              isFavorite ? 'font-medium text-foreground' : 'text-zinc-200',
              muted,
            )}
          >
            {dish.dish}
          </span>
        )}
      </div>

      {/* Diet chips */}
      {dish.diet.length > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          {dish.diet.map((tag) => (
            <span
              key={tag}
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase',
                DIET_TONE[tag.toLowerCase()] ?? 'border-white/10 bg-secondary/30 text-zinc-300',
              )}
            >
              {dietLabel(tag)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
