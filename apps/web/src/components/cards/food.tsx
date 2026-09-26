/**
 * Card 3: food. The owner's number one want, so it gets the most vertical space and features.
 *
 * Priorities:
 * 1. Pinned outlets always render, including when nothing is posted.
 * 2. Taste history: User can star favorite dishes and outlets, which float to the top.
 * 3. Instant search & dietary filtering across all dining halls.
 * 4. Density awareness: Full detailed view vs compact summary view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  UtensilsCrossed,
  Search,
  Star,
  X,
  ChevronRight,
  MapPin,
  Compass,
  Building2,
  Bot,
  RefreshCw,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { CardShell, EmptyState } from '@/components/card-shell';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { mutedIfStale } from '@/components/freshness';
import { migrateTasteProfile, usePreferences, type DietaryPreference, type TasteProfile } from '@/lib/preferences-store';
import type { Card as CardT, FoodData, FoodDish, FoodOutletPinned, FoodAiRecommendation } from '@/lib/contract';
import { fetchFoodRecommendation, getFoodTasteProfile, requestFoodRanking } from '@/lib/api';
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
    walkHint: 'West Campus residence',
  },
  {
    name: "Mudie's",
    building: 'Village 1',
    code: 'V1',
    campusZone: 'North Campus',
    description: 'Main V1 Residence Dining Hall · Daily hot counters, grill & fresh bakery',
    walkHint: 'North Campus residence',
  },
  {
    name: 'The Market',
    building: 'Claudette Millar Hall',
    code: 'CMH',
    campusZone: 'East Campus',
    description: 'CMH Residence Dining Hall · Made-to-order bowls, market & grocery',
    walkHint: 'East Campus residence',
  },
  {
    name: 'Brubakers Food Court',
    building: 'Student Life Centre',
    code: 'SLC',
    campusZone: 'Central Campus',
    description: 'SLC Lower Level · Subway, Pita Pit, Quesada, Shawarma Hub, Teriyaki',
    walkHint: 'Central Campus SLC',
  },
  {
    name: 'Tim Hortons (5 Hubs)',
    building: 'SLC, DC, SCH, ML, EC5',
    code: 'TIMS',
    campusZone: 'Campus Wide',
    description: 'Coffee, donuts, breakfast wraps & bagels across 5 campus spots',
    walkHint: 'Campus Wide',
  },
  {
    name: 'Browsers Café',
    building: 'Dana Porter Library',
    code: 'DPL',
    campusZone: 'South Campus',
    description: 'Dana Porter Arts Library Ground Floor · Coffee, espresso & snacks',
    walkHint: 'South Campus library',
  },
  {
    name: 'South Side Marketplace',
    building: 'South Campus Hall',
    code: 'SCH',
    campusZone: 'South Campus Entrance',
    description: 'Beside main University Ave entrance · Hot lunches, deli & soup bar',
    walkHint: 'South Campus entrance',
  },
  {
    name: 'Liquid Assets Café',
    building: 'Hagey Hall',
    code: 'HH',
    campusZone: 'Arts Quad',
    description: 'Hagey Hall Atrium · Gourmet coffee, sandwiches & pastry case',
    walkHint: 'Arts Quad',
  },
  {
    name: 'CEIT Café',
    building: 'EIT Building',
    code: 'EIT',
    campusZone: 'North-Central Campus',
    description: 'EIT Dinosaur Museum Atrium · Coffee, light lunches & treats',
    walkHint: 'Science & Engineering',
  },
  {
    name: 'Ev3rgreen Café',
    building: 'Environment 3',
    code: 'EV3',
    campusZone: 'Central Campus',
    description: 'Environment 3 Living Wall Atrium · Fair trade & plant-forward items',
    walkHint: 'Environment Quad',
  },
  {
    name: "ML's Diner",
    building: 'Modern Languages',
    code: 'ML',
    campusZone: 'Arts Quad',
    description: 'Modern Languages Ground Floor · All-day breakfast, burgers & poutine',
    walkHint: 'Arts Quad',
  },
  {
    name: 'Starbucks',
    building: 'Science Teaching Complex & AHS',
    code: 'STC',
    campusZone: 'Science Quad',
    description: 'Science Teaching Complex Ground Floor · Espresso & cold brews',
    walkHint: 'Science Quad',
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

function shortDietLabel(tag: string, compact?: boolean): string {
  if (!compact) return dietLabel(tag);
  const lower = tag.toLowerCase();
  if (lower === 'vegan') return 'VG';
  if (lower === 'vegetarian') return 'V';
  if (lower === 'halal') return 'H';
  if (lower === 'kosher') return 'K';
  if (lower === 'dairy') return 'DF';
  if (lower === 'gluten') return 'GF';
  return tag.slice(0, 2).toUpperCase();
}

const DIETARY_TAGS: { id: DietaryPreference; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'halal', label: 'Halal' },
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Veg' },
  { id: 'dairy', label: 'Dairy' },
];

const AI_REC_CACHE_KEY_PREFIX = 'uni-dashboard:ai-rec:v1:';
const AI_REC_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function computeAiRecCacheKey(serviceDate: string, tasteProfile: unknown, model: string): string {
  const p = (tasteProfile || {}) as Record<string, unknown>;
  const bio = String(p.bio || '').trim().toLowerCase();
  const spice = String(p.spiceLevel || 'medium');
  const goals = Array.isArray(p.dietaryGoals) ? [...p.dietaryGoals].sort().join(',') : '';
  return `${AI_REC_CACHE_KEY_PREFIX}${serviceDate}:${model}:${bio}:${spice}:${goals}`;
}

function loadCachedAiRec(serviceDate: string, tasteProfile: unknown, model: string): FoodAiRecommendation | null {
  try {
    const key = computeAiRecCacheKey(serviceDate, tasteProfile, model);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const item = JSON.parse(raw);
    if (item && item.expiresAt && Date.now() < item.expiresAt && item.data) {
      return item.data as FoodAiRecommendation;
    }
  } catch {}
  return null;
}

function saveCachedAiRec(serviceDate: string, tasteProfile: unknown, model: string, data: FoodAiRecommendation) {
  try {
    const key = computeAiRecCacheKey(serviceDate, tasteProfile, model);
    localStorage.setItem(
      key,
      JSON.stringify({
        data,
        expiresAt: Date.now() + AI_REC_CACHE_TTL_MS,
      }),
    );
  } catch {}
}

export function FoodCard({ card, now }: { card: CardT<FoodData>; now: number }) {
  const d = card.data;
  const muted = mutedIfStale(card.state);
  const {
    preferences,
    setDietaryFilter,
    updateTasteProfile,
    toggleFavoriteDish,
    isFavoriteDish,
    setOnlyFavorites,
  } = usePreferences();

  const isCompact = preferences.density === 'compact';

  const [localSearch, setLocalSearch] = useState('');
  const [selectedOutlet, setSelectedOutlet] = useState<string>('all');
  const [showCampusDirectory, setShowCampusDirectory] = useState(false);

  // Workers AI Dining Advisor state with persistent local cache
  const currentModel = preferences.tasteProfile.selectedAiModel;
  const [aiRec, setAiRec] = useState<FoodAiRecommendation | null>(() =>
    loadCachedAiRec(d.service_date, preferences.tasteProfile, currentModel),
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);

  const offset = dayOffset(Date.parse(`${d.service_date}T12:00:00Z`), now);
  const dayLabel = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : d.service_date;
  const nothingAtAll = d.total_dishes === 0;

  const fetchAiRanking = useCallback(
    async (force = false) => {
      if (nothingAtAll) return;
      const key = computeAiRecCacheKey(d.service_date, preferences.tasteProfile, currentModel);

      // If not forcing a refresh, check if we have a valid cache first
      if (!force) {
        const cached = loadCachedAiRec(d.service_date, preferences.tasteProfile, currentModel);
        if (cached) {
          setAiRec(cached);
          lastKeyRef.current = key;
          return;
        }
      }

      try {
        setAiLoading(true);
        setAiError(null);
        const job = await requestFoodRanking(d.service_date);
        if (job.status === 'ready' && job.result) {
          setAiRec(job.result);
          saveCachedAiRec(d.service_date, preferences.tasteProfile, currentModel, job.result);
          lastKeyRef.current = key;
        }
        setAiLoading(job.status === 'processing');
      } catch (err: unknown) {
        setAiError(err instanceof Error ? err.message : 'AI ranking unavailable');
        setAiLoading(false);
      }
    },
    [preferences.tasteProfile, currentModel, d.service_date, nothingAtAll],
  );

  useEffect(() => {
    const key = computeAiRecCacheKey(d.service_date, preferences.tasteProfile, currentModel);
    if (nothingAtAll) return;
    const cached = loadCachedAiRec(d.service_date, preferences.tasteProfile, currentModel);
    setAiRec(cached);
    setAiError(null);
    let active = true;
    const profile = {
      bio: preferences.tasteProfile.bio,
      spiceLevel: preferences.tasteProfile.spiceLevel,
      dietaryGoals: preferences.tasteProfile.dietaryGoals,
      selectedAiModel: currentModel,
      dietaryFilter: preferences.dietaryFilter,
    };
    const refresh = async () => {
      try {
        const result = await fetchFoodRecommendation(d.service_date);
        if (!active) return;
        if (result.recommendation) {
          setAiRec(result.recommendation);
          saveCachedAiRec(d.service_date, preferences.tasteProfile, currentModel, result.recommendation);
          lastKeyRef.current = key;
          setAiError(null);
          setAiLoading(result.ranking_job?.status === 'processing');
        } else if (result.ranking_job?.status === 'failed') {
          setAiError(result.ranking_job.error || 'Background ranking failed');
          setAiLoading(false);
        } else if (result.status === 'failed') {
          setAiError(result.error || 'Background ranking failed');
          setAiLoading(false);
        } else setAiLoading(true);
      } catch (error: unknown) {
        if (active) { setAiError(error instanceof Error ? error.message : 'AI ranking unavailable'); setAiLoading(false); }
      }
    };
    const prepare = async () => {
      const syncKey = 'uni-dashboard:food-profile-synced:v1';
      const local = JSON.stringify(profile);
      let lastSynced: string | null = null;
      try { lastSynced = localStorage.getItem(syncKey); } catch {}
      const saved = (await getFoodTasteProfile()).profile;
      if (!active) return;
      // Local edits since the last successful sync win; otherwise another device's saved profile wins.
      if (!lastSynced || lastSynced === local) {
        if (saved) {
          const serverTaste = migrateTasteProfile({
            bio: typeof saved.bio === 'string' ? saved.bio : '',
            spiceLevel: typeof saved.spiceLevel === 'string' ? saved.spiceLevel as TasteProfile['spiceLevel'] : 'none',
            dietaryGoals: Array.isArray(saved.dietaryGoals) ? saved.dietaryGoals.filter((goal): goal is string => typeof goal === 'string') : [],
            selectedAiModel: typeof saved.selectedAiModel === 'string' ? saved.selectedAiModel : undefined,
          });
          const serverProfile = {
            bio: serverTaste.bio, spiceLevel: serverTaste.spiceLevel, dietaryGoals: serverTaste.dietaryGoals,
            selectedAiModel: serverTaste.selectedAiModel, dietaryFilter: saved.dietaryFilter,
          };
          const serverKey = JSON.stringify(serverProfile);
          if (serverKey !== local) {
            try { localStorage.setItem(syncKey, serverKey); } catch {}
            const { dietaryFilter, ...taste } = serverProfile;
            updateTasteProfile(taste as Partial<TasteProfile>);
            if (typeof dietaryFilter === 'string') setDietaryFilter(dietaryFilter as DietaryPreference);
            return;
          }
          try { localStorage.setItem(syncKey, local); } catch {}
          await refresh();
          return;
        }
      }
      // Profile writes are owned by the settings drawer. The dining card still
      // hydrates a saved profile and refreshes recommendations, but it must not
      // issue one write per keystroke while someone is editing the drawer.
      await refresh();
    };
    prepare().catch((error: unknown) => {
      if (active) { setAiError(error instanceof Error ? error.message : 'Could not save taste profile'); setAiLoading(false); }
    });
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [d.service_date, preferences.tasteProfile, preferences.dietaryFilter, currentModel, nothingAtAll, updateTasteProfile, setDietaryFilter]);

  // Map of outlet -> AI rank details
  const aiRankMap = useMemo(() => {
    const map = new Map<
      string,
      {
        rank: number;
        match_score: number;
        verdict: string;
        highlights: { dish: string; why: string }[];
      }
    >();
    if (aiRec?.ranked_outlets) {
      for (const r of aiRec.ranked_outlets) {
        map.set(r.outlet, r);
      }
    }
    return map;
  }, [aiRec]);

  // Filtered pinned outlets
  const processedOutlets = useMemo(() => {
    const list = d.pinned.map((outlet) => {
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

      const aiInfo = aiRankMap.get(outlet.outlet);

      return {
        ...outlet,
        dishes,
        serving: outlet.serving,
        matchCount: dishes.length,
        aiInfo,
      };
    });

    // Reorder outlets by AI rank when enabled
    if (preferences.tasteProfile.sortByAiRank && aiRankMap.size > 0) {
      list.sort((a, b) => {
        const aRank = a.aiInfo?.rank ?? 99;
        const bRank = b.aiInfo?.rank ?? 99;
        return aRank - bRank;
      });
    }

    return list;
  }, [
    d.pinned,
    preferences.dietaryFilter,
    preferences.onlyFavorites,
    preferences.tasteProfile.sortByAiRank,
    localSearch,
    isFavoriteDish,
    aiRankMap,
  ]);

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
          <a
            href={`https://uwaterloo.ca/food-services/daily-menu?date=${d.service_date}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-zinc-400 hover:text-foreground transition-colors p-1 rounded hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live"
            title={`View official Waterloo daily menu for ${d.service_date}`}
            aria-label={`View official Waterloo daily menu for ${d.service_date}`}
          >
            <ExternalLink className="size-3" />
          </a>
        </div>
      }
    >
      {card.state === 'failed' ? (
        <div className="py-2">
          <p className="text-[15px] font-semibold text-rose-400">
            Unable to fetch daily menu
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {d.error || 'Failed to sync with Waterloo Food Services feed. Menu items could not be loaded.'}
          </p>
        </div>
      ) : nothingAtAll ? (
        <EmptyState hint="The daily menu feed has nothing posted for this service date.">
          No menu posted
        </EmptyState>
      ) : (
        <div className={preferences.density === 'compact' ? 'space-y-2.5' : 'space-y-3.5'}>
          {/* AI Dining Advisor */}
          {preferences.density === 'compact' ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border/80 bg-secondary/25 px-3 py-1.5 text-xs shadow-xs">
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex size-5 items-center justify-center rounded bg-[#3478eb] text-white shrink-0">
                  <Bot className="size-3" />
                </div>
                <div className="flex items-center gap-1.5 truncate">
                  <span className="font-semibold text-foreground text-xs shrink-0">
                    {aiRec?.top_outlet ? (
                      <>Today Pick: <span className="text-[#78adff]">{getOutletLocation(aiRec.top_outlet).name}</span></>
                    ) : (
                      'AI Dining Advisor'
                    )}
                  </span>
                  {aiRec?.ranked_outlets?.[0]?.match_score !== undefined && (
                    <span className="rounded bg-[#3478eb]/15 border border-[#3478eb]/40 px-1 py-0 text-[9px] font-bold text-[#78adff] shrink-0">
                      {aiRec.ranked_outlets[0].match_score}% Match
                    </span>
                  )}
                  <span className="text-zinc-400 truncate text-[11px]">
                    {aiLoading ? (
                      'Evaluating dishes with AI...'
                    ) : aiRec?.headline ? (
                      `· ${aiRec.headline}`
                    ) : aiError ? (
                      '· AI ranking offline'
                    ) : (
                      '· Customize profile in Settings'
                    )}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => fetchAiRanking(true)}
                  disabled={aiLoading}
                  aria-label="Re-rank daily menu with AI"
                  className="flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 px-2 py-0.5 text-[11px] text-zinc-300 hover:text-foreground transition-colors"
                  title="Re-evaluate today menu against your taste profile"
                >
                  <RefreshCw className={cn('size-2.5', aiLoading && 'animate-spin text-[#78adff]')} />
                  <span className="hidden sm:inline">{aiLoading ? '...' : 'Re-rank'}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/80 bg-secondary/25 p-3 sm:p-3.5 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex size-6 items-center justify-center rounded-md bg-[#3478eb] text-white shrink-0">
                    <Bot className="size-3.5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-foreground">
                        {aiRec?.top_outlet ? (
                          <>Today Top Pick: <span className="text-[#78adff]">{getOutletLocation(aiRec.top_outlet).name}</span></>
                        ) : (
                          'AI Dining Advisor'
                        )}
                      </span>
                      {aiRec?.ranked_outlets?.[0]?.match_score !== undefined && (
                        <span className="rounded bg-[#3478eb]/15 border border-[#3478eb]/40 px-1.5 py-0.2 text-[10px] font-bold text-[#78adff]">
                          {aiRec.ranked_outlets[0].match_score}% Match
                        </span>
                      )}
                      <span className="text-[10px] font-mono text-zinc-400">
                        {preferences.tasteProfile.selectedAiModel.includes('gemma')
                          ? 'Gemma 4'
                          : preferences.tasteProfile.selectedAiModel.includes('glm')
                            ? 'GLM-4.7'
                            : preferences.tasteProfile.selectedAiModel.includes('llama')
                              ? 'Llama 4'
                              : preferences.tasteProfile.selectedAiModel.includes('deepseek')
                                ? 'DeepSeek-R1'
                                : 'Workers AI'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => fetchAiRanking(true)}
                    disabled={aiLoading}
                    aria-label="Re-rank daily menu with AI"
                    className="flex items-center gap-1 rounded-md border border-border/60 bg-secondary/30 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/20 hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
                    title="Re-evaluate today menu against your taste profile"
                  >
                    <RefreshCw className={cn('size-3', aiLoading && 'animate-spin text-[#78adff]')} />
                    <span className="hidden sm:inline">{aiLoading ? 'Evaluating...' : 'Re-rank'}</span>
                  </button>
                </div>
              </div>

              {/* Content / Verdict */}
              <div className="mt-2 text-xs text-zinc-300 leading-relaxed">
                {aiLoading ? (
                  <p className="text-zinc-400 italic">
                    Evaluating today dining hall dishes against your taste profile...
                  </p>
                ) : aiRec ? (
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {aiRec.headline}
                    </p>
                    {aiRec.tip && (
                      <p className="text-[11px] text-zinc-400">
                        Tip: {aiRec.tip}
                      </p>
                    )}
                  </div>
                ) : aiError ? (
                  <div className="rounded-md border border-amber/30 bg-amber/10 p-2.5">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="size-4 text-amber shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold text-foreground text-xs">AI Menu Ranking Unavailable</p>
                        <p className="text-[11px] text-zinc-300 mt-0.5 leading-relaxed">{aiError}</p>
                        <p className="text-[10px] text-zinc-500 mt-1">
                          Showing official dining hall menus below in standard campus order without AI scoring.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-zinc-400">
                    Enter your taste profile and cravings in Settings to get ranked recommendations.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Controls Bar: Search (Detailed mode only) & Quick Diet Chips */}
          <div className="flex flex-col gap-2 pt-1">
            {!isCompact && (
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
            )}

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

                {/* Campus Locations Directory toggle (Detailed mode only) */}
                {!isCompact && (
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
                )}
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

          {/* Secondary Outlets Section (Detailed mode only to reduce info density in compact) */}
          {!isCompact && d.others.length > 0 && selectedOutlet === 'all' && !localSearch && (
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
                            <span className="font-semibold text-foreground">{loc.name}</span>
                            <span className="text-zinc-400 ml-1.5 text-[11px]">· {loc.building}</span>
                          </div>
                        </div>
                        <span className="text-[11px] text-zinc-400 font-mono">
                          {loc.campusZone}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Summary footer line (Detailed mode only) */}
          {!isCompact && (
            <div className="flex items-center justify-between pt-1 text-xs text-zinc-400">
              <span>
                Showing {totalFilteredDishes} of {d.total_dishes} dishes
              </span>
              <span className="flex items-center gap-1.5 text-zinc-300">
                <Star className="size-3 text-amber fill-amber" /> Click ★ to rank dishes to your taste
              </span>
            </div>
          )}
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
  outlet: FoodOutletPinned & {
    matchCount?: number;
    aiInfo?: {
      rank: number;
      match_score: number;
      verdict: string;
      highlights: { dish: string; why: string }[];
    };
  };
  muted: string;
  density: 'detailed' | 'compact';
  isFavoriteDish: (name: string) => boolean;
  toggleFavoriteDish: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const loc = getOutletLocation(outlet.outlet);

  return (
    <div className={cn(
      'flex flex-col rounded-lg border border-border/80 bg-card/70 transition-colors hover:border-border',
      density === 'compact' ? 'p-2.5 gap-1.5' : 'p-3.5 gap-2',
    )}>
      {/* Outlet Header */}
      <div className={cn('flex flex-col border-b border-border/60', density === 'compact' ? 'gap-1 pb-1.5' : 'gap-2 pb-2.5')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
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

            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="rounded bg-live/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-live border border-live/30">
                  {loc.code}
                </span>
                <h3 className={cn('text-sm font-semibold tracking-tight text-foreground', muted)}>
                  {loc.name}
                </h3>
                {!loc.name.toLowerCase().includes(loc.building.toLowerCase()) && (
                  <span className="text-xs text-zinc-400 font-normal">· {loc.building}</span>
                )}
                {outlet.aiInfo && (
                  <span
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                      outlet.aiInfo.rank === 1
                        ? 'border-[#3478eb]/40 bg-[#3478eb]/15 text-[#78adff]'
                        : 'border-border/80 bg-secondary/40 text-zinc-300',
                    )}
                  >
                    #{outlet.aiInfo.rank} Match ({outlet.aiInfo.match_score}%)
                  </span>
                )}
              </div>

              {/* AI Verdict summary for this outlet (Detailed mode only) */}
              {density !== 'compact' && outlet.aiInfo?.verdict && (
                <div className="mt-1 flex items-start gap-1.5 rounded-md bg-secondary/30 px-2 py-1 text-[11px] text-zinc-300 border border-border/50">
                  <Bot className="size-3 text-[#78adff] shrink-0 mt-0.5" />
                  <span className="leading-snug">{outlet.aiInfo.verdict}</span>
                </div>
              )}
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
        <div className={density === 'compact' ? 'mt-1.5 pt-0.5' : 'mt-2.5 pt-1'}>
          {outlet.serving ? (
            outlet.dishes.length > 0 ? (
              <div className={density === 'compact' ? 'space-y-1' : 'space-y-1.5'}>
                {(density === 'compact' ? outlet.dishes.slice(0, 3) : outlet.dishes).map((dish) => {
                  const isFav = isFavoriteDish(dish.dish);
                  const highlight = outlet.aiInfo?.highlights?.find(
                    (h) =>
                      h.dish.toLowerCase() === dish.dish.toLowerCase() ||
                      dish.dish.toLowerCase().includes(h.dish.toLowerCase()) ||
                      h.dish.toLowerCase().includes(dish.dish.toLowerCase()),
                  );
                  return (
                    <DishItem
                      key={dish.dish}
                      dish={dish}
                      aiHighlight={density === 'compact' ? undefined : highlight?.why}
                      muted={muted}
                      isFavorite={isFav}
                      onToggleFavorite={() => toggleFavoriteDish(dish.dish)}
                      compact={density === 'compact'}
                    />
                  );
                })}
                {density === 'compact' && outlet.dishes.length > 3 && (
                  <p className="pt-0.5 text-[11px] text-zinc-400 pl-6">
                    +{outlet.dishes.length - 3} more dishes · <span className="text-zinc-300">Detailed view has full menu</span>
                  </p>
                )}
                {density !== 'compact' && outlet.hidden_dishes > 0 && (
                  <p className="pt-1 text-xs text-zinc-400 pl-6">
                    +{outlet.hidden_dishes} additional items
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-zinc-400 pl-6">
                No dishes found matching current filters.
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
  aiHighlight,
  muted,
  isFavorite,
  onToggleFavorite,
  compact,
}: {
  dish: FoodDish;
  aiHighlight?: string;
  muted: string;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-1.5 transition-colors hover:bg-secondary/40',
        compact ? 'py-0.5 px-1.5 rounded' : 'py-1 px-2 rounded-lg',
        isFavorite && 'bg-amber/5 border border-amber/20',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          className="shrink-0 p-0.5 text-zinc-400 transition-colors hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded"
        >
          <Star
            className={cn(
              'transition-all',
              compact ? 'size-3' : 'size-3.5',
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

        {aiHighlight && (
          <span
            title={aiHighlight}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border border-[#3478eb]/40 bg-[#3478eb]/15 font-medium text-[#78adff] shrink-0',
              compact ? 'px-1 py-0 text-[9px] max-w-[100px] sm:max-w-[130px]' : 'px-1.5 py-0.5 text-[10px] max-w-[140px] sm:max-w-[200px]',
            )}
          >
            <Bot className={cn(compact ? 'size-2' : 'size-2.5', 'text-[#78adff] shrink-0')} />
            <span className="truncate">{aiHighlight}</span>
          </span>
        )}
      </div>

      {/* Diet chips */}
      {dish.diet.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5">
          {dish.diet.map((tag) => (
            <span
              key={tag}
              className={cn(
                'rounded border font-semibold tracking-wider uppercase',
                compact ? 'px-1 py-0 text-[8.5px]' : 'px-1.5 py-0.5 text-[9px]',
                DIET_TONE[tag.toLowerCase()] ?? 'border-white/10 bg-secondary/30 text-zinc-300',
              )}
            >
              {shortDietLabel(tag, compact)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
