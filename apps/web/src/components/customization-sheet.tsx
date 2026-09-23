import { useState, useEffect } from 'react';
import {
  Sliders,
  Star,
  Utensils,
  LayoutGrid,
  RotateCcw,
  KeyRound,
  Check,
  AlertCircle,
  RefreshCw,
  Lock,
  Calendar,
  Clock,
  ShieldCheck,
  Sparkles,
  Cpu,
  Bot,
  GraduationCap,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchCredentialsStatus,
  updateCredentials,
  triggerPoll,
  type CredentialsStatus,
} from '@/lib/api';
import {
  usePreferences,
  type DietaryPreference,
  type LayoutDensity,
  type SpiceLevel,
  type TasteProfile,
  type UserPreferences,
} from '@/lib/preferences-store';
import { cn } from '@/lib/utils';
import { ScheduleTab } from './schedule-tab';

const DIETARY_OPTIONS: { id: DietaryPreference; label: string }[] = [
  { id: 'all', label: 'All Items' },
  { id: 'halal', label: 'Halal' },
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Vegetarian' },
  { id: 'dairy', label: 'Dairy-Free' },
  { id: 'gluten', label: 'Gluten-Free' },
];

interface TasteChip {
  id: string;
  label: string;
  type: 'goal' | 'spice';
  value: string;
}

const DEFAULT_TASTE_CHIPS: TasteChip[] = [
  { id: 'high-protein', label: 'High Protein', type: 'goal', value: 'high-protein' },
  { id: 'mild-spice', label: 'Mild Spice', type: 'spice', value: 'mild' },
  { id: 'medium-spice', label: 'Medium Spice', type: 'spice', value: 'medium' },
  { id: 'hot-spice', label: 'Hot Spice', type: 'spice', value: 'hot' },
  { id: 'extra-hot-spice', label: 'Extra Hot Spice', type: 'spice', value: 'extra-hot' },
  { id: 'comfort', label: 'Comfort Food', type: 'goal', value: 'comfort' },
  { id: 'low-carb', label: 'Low Carb', type: 'goal', value: 'low-carb' },
  { id: 'plant-forward', label: 'Plant-Forward', type: 'goal', value: 'plant-forward' },
  { id: 'budget', label: 'Budget Friendly', type: 'goal', value: 'budget' },
  { id: 'halal', label: 'Halal', type: 'goal', value: 'halal' },
  { id: 'vegetarian', label: 'Vegetarian', type: 'goal', value: 'vegetarian' },
  { id: 'vegan', label: 'Vegan', type: 'goal', value: 'vegan' },
];

const AI_MODEL_OPTIONS = [
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Google Gemma 4 (26B-A4B)',
    badge: 'Recommended · 4B Active MoE',
  },
  {
    id: '@cf/zhipu/glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    badge: 'Ultra-Fast Flash',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    name: 'Meta Llama 4 Scout (17B)',
    badge: '16-Expert MoE',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek-R1 Distill (32B)',
    badge: 'Reasoning Specialist',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 (30B-A3B)',
    badge: 'Dense & MoE',
  },
];

export function CustomizationSheet({
  preferences,
  setDensity,
  setDietaryFilter,
  setOnlyFavorites,
  toggleFavoriteDish,
  updateTasteProfile,
  resetPreferences,
}: {
  preferences: UserPreferences;
  setDensity: (d: LayoutDensity) => void;
  setDietaryFilter: (f: DietaryPreference) => void;
  setOnlyFavorites: (fav: boolean) => void;
  toggleFavoriteDish: (dish: string) => void;
  updateTasteProfile: (patch: Partial<TasteProfile>) => void;
  resetPreferences: () => void;
}) {
  const { setSection, setGroupNumber, undismissTask } = usePreferences();
  const [activeTab, setActiveTab] = useState<'preferences' | 'taste' | 'credentials' | 'schedule'>('taste');

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg border-white/10 bg-card px-2.5 text-xs text-zinc-300 transition-colors hover:border-white/25 hover:bg-secondary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
        >
          <Sliders className="size-3.5" />
          <span className="hidden sm:inline">Settings</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-lg border-border/80 bg-card p-6 text-foreground overflow-y-auto max-h-screen shadow-2xl">
        <SheetHeader className="p-0 text-left">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg border border-live/30 bg-live/10 text-live">
              <Sliders className="size-4" />
            </div>
            <div>
              <SheetTitle className="text-base font-semibold">Dashboard Settings</SheetTitle>
              <SheetDescription className="text-xs text-zinc-400">
                Taste profile, AI dining advisor, layout, and feeds.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'preferences' | 'taste' | 'credentials' | 'schedule')}
          className="mt-5"
        >
          <TabsList className="grid w-full grid-cols-4 bg-secondary/40 p-1 border border-border/60 rounded-lg">
            <TabsTrigger
              value="taste"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Sparkles className="size-3.5 mr-1 text-amber" /> Taste AI
            </TabsTrigger>
            <TabsTrigger
              value="schedule"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Calendar className="size-3.5 mr-1" /> Schedule
            </TabsTrigger>
            <TabsTrigger
              value="preferences"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Sliders className="size-3.5 mr-1" /> General
            </TabsTrigger>
            <TabsTrigger
              value="credentials"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <KeyRound className="size-3.5 mr-1" /> Feeds
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: AI Taste Profile */}
          <TabsContent value="taste" className="mt-5 space-y-5">
            {/* Intro banner */}
            <div className="rounded-lg border border-border/80 bg-secondary/30 p-3.5 text-xs">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                <Bot className="size-4 text-live" />
                <span>Cloudflare Workers AI Dining Advisor</span>
              </div>
              <p className="mt-1.5 text-xs text-zinc-300 leading-relaxed">
                Describe your cravings and dietary goals. Powered by Google Gemma 4 on Workers AI free compute (10,000 neurons per day). It evaluates daily menus and ranks today best hall for you.
              </p>
            </div>

            {/* Bio / Freeform prompt with default labels directly below */}
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="taste-bio" className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Sparkles className="size-3.5 text-amber" /> Taste Profile & Cravings
                </Label>
                <span className="text-[11px] text-zinc-400">Natural language</span>
              </div>
              <Textarea
                id="taste-bio"
                value={preferences.tasteProfile.bio}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateTasteProfile({ bio: e.target.value })}
                placeholder="e.g. I love spicy food, high protein chicken dishes, and noodle bowls. Dislike celery and pork."
                className="mt-2 min-h-20 text-xs bg-secondary/30 border-border/80 text-foreground placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none resize-none"
              />

              {/* Default labels right below the box - unified, no separate sections */}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {DEFAULT_TASTE_CHIPS.map((chip) => {
                  const active =
                    chip.type === 'spice'
                      ? preferences.tasteProfile.spiceLevel === chip.value
                      : preferences.tasteProfile.dietaryGoals.includes(chip.value);

                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => {
                        if (chip.type === 'spice') {
                          const nextSpice =
                            preferences.tasteProfile.spiceLevel === chip.value
                              ? 'none'
                              : (chip.value as SpiceLevel);
                          updateTasteProfile({ spiceLevel: nextSpice });
                        } else {
                          const current = preferences.tasteProfile.dietaryGoals;
                          const next = current.includes(chip.value)
                            ? current.filter((g) => g !== chip.value)
                            : [...current, chip.value];
                          updateTasteProfile({ dietaryGoals: next });
                        }
                      }}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        active
                          ? 'border-live/60 bg-live/15 text-live shadow-xs font-semibold'
                          : 'border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground',
                      )}
                    >
                      {active ? '✓ ' : '+ '}
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <Separator className="bg-border/60" />

            {/* Workers AI Engine Selection */}
            <div>
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Cpu className="size-3.5 text-cyan-400" /> Workers AI Model
                </Label>
                <span className="text-[10px] text-zinc-400 font-mono">10k neurons/day free</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {AI_MODEL_OPTIONS.map((m) => {
                  const isSelected = preferences.tasteProfile.selectedAiModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => updateTasteProfile({ selectedAiModel: m.id })}
                      className={cn(
                        'w-full flex items-center justify-between rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        isSelected
                          ? 'border-live/60 bg-live/10 text-foreground'
                          : 'border-border/60 bg-secondary/25 text-zinc-400 hover:border-white/20 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('size-2 rounded-full', isSelected ? 'bg-live' : 'bg-zinc-600')} />
                        <span className="text-xs font-medium text-foreground">{m.name}</span>
                      </div>
                      <span className="text-[10px] font-mono text-zinc-400">{m.badge}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Separator className="bg-border/60" />

            {/* Sort Outlets by AI Rank Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="sort-ai-toggle" className="text-xs font-semibold text-foreground cursor-pointer">
                  Sort Outlets by AI Rank
                </Label>
                <p className="text-[11px] text-zinc-400">
                  Floats today top-matching dining hall to the top of the food card.
                </p>
              </div>
              <Switch
                id="sort-ai-toggle"
                checked={preferences.tasteProfile.sortByAiRank}
                onCheckedChange={(val) => updateTasteProfile({ sortByAiRank: val })}
              />
            </div>
          </TabsContent>

          {/* Tab 2: General Preferences */}
          <TabsContent value="preferences" className="mt-5 space-y-6">
            {/* Layout density */}
            <div>
              <Label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <LayoutGrid className="size-3.5" /> Layout Density
              </Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDensity('detailed')}
                  className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                    preferences.density === 'detailed'
                      ? 'border-live/60 bg-live/10 text-foreground shadow-xs'
                      : 'border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground'
                  }`}
                >
                  <span className="text-xs font-medium text-foreground">Detailed View</span>
                  <span className="mt-1 text-xs text-zinc-400">
                    Full dish lists, weather details, and complete timelines.
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setDensity('compact')}
                  className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                    preferences.density === 'compact'
                      ? 'border-live/60 bg-live/10 text-foreground shadow-xs'
                      : 'border-border/60 bg-secondary/30 text-zinc-400 hover:border-white/20 hover:text-foreground'
                  }`}
                >
                  <span className="text-xs font-medium text-foreground">Compact View</span>
                  <span className="mt-1 text-xs text-zinc-400">
                    Ultra-minimal glanceable summary for quick scanning.
                  </span>
                </button>
              </div>
            </div>

            <Separator className="bg-border/60" />

            {/* Dietary preferences */}
            <div>
              <Label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Utensils className="size-3.5" /> Default Dietary Filter
              </Label>
              <p className="mt-1 text-xs text-zinc-400">
                Automatically filters daily menus across dining halls.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {DIETARY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDietaryFilter(opt.id)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                      preferences.dietaryFilter === opt.id
                        ? 'border border-live/60 bg-live/20 text-live hover:bg-live/30'
                        : 'border border-border/60 bg-secondary/30 text-zinc-300 hover:border-white/20 hover:text-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <Separator className="bg-border/60" />

            {/* Taste History & Starred Dishes */}
            <div>
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Star className="size-3.5 text-amber" /> Taste History & Favorites
                </Label>
                <div className="flex items-center gap-2">
                  <Label htmlFor="fav-toggle" className="text-xs text-zinc-300 cursor-pointer">
                    Only favorites
                  </Label>
                  <Switch
                    id="fav-toggle"
                    checked={preferences.onlyFavorites}
                    onCheckedChange={setOnlyFavorites}
                  />
                </div>
              </div>

              <p className="mt-1 text-xs text-zinc-400">
                Star items on the food card to prioritize what you love when it appears on the menu.
              </p>

              {preferences.favoriteDishes.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                  {preferences.favoriteDishes.map((dish) => (
                    <Badge
                      key={dish}
                      variant="outline"
                      className="flex items-center gap-1.5 border-amber/30 bg-amber/10 py-0.5 pl-2 pr-1 text-xs text-amber-foreground"
                    >
                      <Star className="size-2.5 fill-amber text-amber" />
                      <span>{dish}</span>
                      <button
                        type="button"
                        onClick={() => toggleFavoriteDish(dish)}
                        className="ml-1 rounded-md p-0.5 text-zinc-400 hover:bg-amber/20 hover:text-amber-foreground focus-visible:ring-2 focus-visible:ring-amber focus-visible:outline-none"
                        title="Remove from favorites"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-dashed border-border/70 p-3 text-center">
                  <p className="text-xs text-zinc-400">
                    No favorited dishes yet. Click the star icon next to dishes on the food card!
                  </p>
                </div>
              )}
            </div>

            <Separator className="bg-border/60" />

            {/* Courses & Group Scope Section */}
            <div>
              <Label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <GraduationCap className="size-3.5 text-cyan-400" /> Course Group & Section
              </Label>
              <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                LEARN publishes every group's deadline; tell us yours to hide the rest.
              </p>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="course-section" className="text-xs font-medium text-foreground">
                    Section
                  </Label>
                  <Input
                    id="course-section"
                    type="number"
                    min={1}
                    max={999}
                    placeholder="e.g. 2"
                    value={preferences.section ?? ''}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      setSection(val ? Number(val) : null);
                    }}
                    className="h-8 text-xs bg-secondary/30 border-border/70"
                  />
                  <p className="text-[10px] text-zinc-400">Section number (e.g. 2 for Sec 002)</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="course-group" className="text-xs font-medium text-foreground">
                    Group Number
                  </Label>
                  <Input
                    id="course-group"
                    type="number"
                    min={1}
                    max={999}
                    placeholder="e.g. 7"
                    value={preferences.groupNumber ?? ''}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      setGroupNumber(val ? Number(val) : null);
                    }}
                    className="h-8 text-xs bg-secondary/30 border-border/70"
                  />
                  <p className="text-[10px] text-zinc-400">Your assigned team or group number</p>
                </div>
              </div>

              {/* Dismissed Tasks Manager */}
              <div className="mt-4 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold text-foreground">
                    Hidden Deadlines & Tasks
                  </Label>
                  <span className="text-[11px] font-mono text-zinc-400">
                    {preferences.dismissedTasks.length} hidden
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  Tasks you have hidden from the deadlines card.
                </p>

                {preferences.dismissedTasks.length > 0 ? (
                  <div className="mt-2.5 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {preferences.dismissedTasks.map((id) => (
                      <div
                        key={id}
                        className="flex items-center justify-between gap-2 rounded-md bg-secondary/25 border border-border/50 px-2.5 py-1 text-xs text-zinc-300"
                      >
                        <span className="truncate max-w-[280px]" title={id}>
                          {id.includes('@') ? id.split('@')[0] : id}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => undismissTask(id)}
                          className="h-6 px-1.5 text-[10px] text-live hover:text-live hover:bg-live/10 gap-1"
                        >
                          <RotateCcw className="size-2.5" /> Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-zinc-400 italic">No tasks currently hidden.</p>
                )}
              </div>
            </div>

            <Separator className="bg-border/60" />

            {/* Reset button */}
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={resetPreferences}
                className="h-8 w-full gap-2 text-xs text-zinc-400 hover:text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
              >
                <RotateCcw className="size-3.5" />
                Reset All Preferences to Default
              </Button>
            </div>
          </TabsContent>

          {/* Tab 3: Feeds & Credentials */}
          <TabsContent value="credentials" className="mt-5 space-y-5">
            <CredentialsManager />
          </TabsContent>

          {/* Tab 4: Schedule (Office Hours) */}
          <TabsContent value="schedule" className="mt-5 space-y-5">
            <ScheduleTab />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function CredentialsManager() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [learnUrl, setLearnUrl] = useState('');
  const [cfAccountId, setCfAccountId] = useState('');
  const [cfApiToken, setCfApiToken] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadStatus = async () => {
    try {
      setLoading(true);
      const data = await fetchCredentialsStatus();
      setStatus(data);
    } catch {
      // Backend may not have loaded or offline
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground gap-2 text-xs">
        <RefreshCw className="size-4 animate-spin text-live" />
        <span>Checking credential status...</span>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    let cleanPortal = portalUrl.trim();
    if (cleanPortal.startsWith('webcal://')) {
      cleanPortal = 'https://' + cleanPortal.slice('webcal://'.length);
    }

    let cleanLearn = learnUrl.trim();
    if (cleanLearn.startsWith('webcal://')) {
      cleanLearn = 'https://' + cleanLearn.slice('webcal://'.length);
    }

    try {
      const payload: {
        PORTAL_ICS_URL?: string;
        LEARN_ICS_URL?: string;
        CLOUDFLARE_ACCOUNT_ID?: string;
        CLOUDFLARE_API_TOKEN?: string;
      } = {};
      if (cleanPortal) payload.PORTAL_ICS_URL = cleanPortal;
      if (cleanLearn) payload.LEARN_ICS_URL = cleanLearn;
      if (cfAccountId.trim()) payload.CLOUDFLARE_ACCOUNT_ID = cfAccountId.trim();
      if (cfApiToken.trim()) payload.CLOUDFLARE_API_TOKEN = cfApiToken.trim();

      if (Object.keys(payload).length === 0) {
        setFeedback({ type: 'error', message: 'Enter at least one setting or credential to save.' });
        setSaving(false);
        return;
      }

      await updateCredentials(payload);
      await triggerPoll();

      setFeedback({
        type: 'success',
        message: 'Credentials saved! Feeds and AI configuration synchronized.',
      });
      setPortalUrl('');
      setLearnUrl('');
      setCfAccountId('');
      setCfApiToken('');
      await loadStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save credentials';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Intro info box */}
      <div className="rounded-lg border border-border/80 bg-secondary/30 p-3.5 text-xs">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <ShieldCheck className="size-4 text-live" />
          <span>Local Credential Vault</span>
        </div>
        <p className="mt-1.5 text-xs text-zinc-300 leading-relaxed">
          Your credentials are saved strictly in your local .env file. They never touch third-party servers.
        </p>
      </div>

      {feedback && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg p-2.5 text-xs',
            feedback.type === 'success'
              ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border border-destructive/40 bg-destructive/10 text-destructive',
          )}
        >
          {feedback.type === 'success' ? (
            <Check className="size-4 shrink-0" />
          ) : (
            <AlertCircle className="size-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        {/* Feed 1: Google Calendar or UW Portal */}
        <div className="rounded-lg border border-border/80 bg-card p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="size-4 text-live" />
              <span className="text-xs font-semibold text-foreground">
                1. Schedule Feed (Google Calendar or Portal)
              </span>
            </div>
            {status?.portal.configured ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]"
              >
                Configured
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber/40 bg-amber/10 text-amber-foreground text-[10px]"
              >
                Locked / Missing
              </Badge>
            )}
          </div>

          <div>
            <Label htmlFor="portal-url" className="text-xs font-mono text-zinc-400">
              GOOGLE_CALENDAR_ICS_URL / PORTAL_ICS_URL
            </Label>
            <Input
              id="portal-url"
              type="text"
              value={portalUrl}
              onChange={(e) => setPortalUrl(e.target.value)}
              placeholder={
                status?.portal.configured
                  ? 'Configured (paste new URL to update)...'
                  : 'https://calendar.google.com/calendar/ical/.../basic.ics'
              }
              className="mt-1 h-8 text-xs bg-secondary/40 border-border/80 text-foreground font-mono focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            />
          </div>
        </div>

        {/* Feed 2: Waterloo LEARN Deadlines */}
        <div className="rounded-lg border border-border/80 bg-card p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-cyan-400" />
              <span className="text-xs font-semibold text-foreground">2. Waterloo LEARN Deadlines</span>
            </div>
            {status?.learn.configured ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]"
              >
                Configured
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber/40 bg-amber/10 text-amber-foreground text-[10px]"
              >
                Locked / Missing
              </Badge>
            )}
          </div>

          <div>
            <Label htmlFor="learn-url" className="text-xs font-mono text-zinc-400">
              LEARN_ICS_URL
            </Label>
            <Input
              id="learn-url"
              type="text"
              value={learnUrl}
              onChange={(e) => setLearnUrl(e.target.value)}
              placeholder={
                status?.learn.configured
                  ? 'Configured (paste new URL to update)...'
                  : 'https://learn.uwaterloo.ca/d2l/le/calendar/feed/user/feed.ics?token=...'
              }
              className="mt-1 h-8 text-xs bg-secondary/40 border-border/80 text-foreground font-mono focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            />
          </div>
        </div>

        {/* Cloudflare Workers AI credentials (optional for local dev) */}
        <div className="rounded-lg border border-border/80 bg-card p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-live" />
              <span className="text-xs font-semibold text-foreground">
                3. Cloudflare Workers AI (Optional Local Relay)
              </span>
            </div>
            {status?.cloudflare?.configured ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]"
              >
                Connected
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-white/10 bg-secondary/40 text-zinc-400 text-[10px]"
              >
                Offline Fallback Active
              </Badge>
            )}
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Optional for local development. When deployed as a Cloudflare Worker, credentials are provided automatically.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label htmlFor="cf-account" className="text-[11px] font-mono text-zinc-400">
                CLOUDFLARE_ACCOUNT_ID
              </Label>
              <Input
                id="cf-account"
                type="text"
                value={cfAccountId}
                onChange={(e) => setCfAccountId(e.target.value)}
                placeholder={status?.cloudflare?.account_id || 'Account ID...'}
                className="mt-1 h-8 text-xs bg-secondary/40 border-border/80 text-foreground font-mono focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
              />
            </div>
            <div>
              <Label htmlFor="cf-token" className="text-[11px] font-mono text-zinc-400">
                CLOUDFLARE_API_TOKEN
              </Label>
              <Input
                id="cf-token"
                type="password"
                value={cfApiToken}
                onChange={(e) => setCfApiToken(e.target.value)}
                placeholder={status?.cloudflare?.configured ? '••••••••••••••••' : 'API Token...'}
                className="mt-1 h-8 text-xs bg-secondary/40 border-border/80 text-foreground font-mono focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Submit button */}
        <Button
          type="submit"
          disabled={saving || (!portalUrl.trim() && !learnUrl.trim() && !cfAccountId.trim() && !cfApiToken.trim())}
          className="w-full h-9 gap-2 text-xs font-medium bg-live hover:bg-live/90 text-live-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
        >
          {saving ? (
            <>
              <RefreshCw className="size-3.5 animate-spin" /> Saving & Polling...
            </>
          ) : (
            <>
              <Lock className="size-3.5" /> Save Credentials & Sync Now
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
