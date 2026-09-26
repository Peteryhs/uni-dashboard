import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Sliders,
  Star,
  Utensils,
  RotateCcw,
  KeyRound,
  Check,
  AlertCircle,
  RefreshCw,
  Lock,
  Calendar,
  Clock,
  Cpu,
  Bot,
  GraduationCap,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchCredentialsStatus,
  updateCredentials,
  triggerPoll,
  fetchAiUsage,
  getFoodTasteProfile,
  saveFoodTasteProfile,
  type AiUsageStatus,
  type CredentialsStatus,
} from '@/lib/api';
import {
  usePreferences,
  DEFAULT_TASTE_PROFILE,
  migrateTasteProfile,
  type DietaryPreference,
  type TasteProfile,
  type UserPreferences,
} from '@/lib/preferences-store';
import { cn } from '@/lib/utils';
import { ScheduleTab } from './schedule-tab';
import { CourseSettingsTab } from './course-settings-tab';
import { SourcesPanel } from './sources-panel';
import type { CalendarData } from '@/lib/contract';
import './customization-sheet.css';

const DIETARY_OPTIONS: { id: DietaryPreference; label: string }[] = [
  { id: 'all', label: 'All items' },
  { id: 'halal', label: 'Halal' },
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Vegetarian' },
  { id: 'dairy', label: 'Dairy-free' },
  { id: 'gluten', label: 'Gluten-free' },
];

const AI_MODEL_OPTIONS = [
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Google Gemma 4 (26B-A4B)',
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM-4.7 Flash',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    name: 'Meta Llama 4 Scout (17B)',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek-R1 Distill (32B)',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 (30B-A3B)',
  },
];

export function CustomizationSheet({
  open,
  onOpenChange,
  hideTrigger = false,
  preferences,
  courseData,
  courseDataPending,
  courseDataError,
  focusCourse,
  onRetryCourseData,
  onCourseDataSaved,
  setDietaryFilter,
  setOnlyFavorites,
  toggleFavoriteDish,
  updateTasteProfile,
  resetPreferences,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  preferences: UserPreferences;
  courseData?: CalendarData;
  courseDataPending: boolean;
  courseDataError: boolean;
  focusCourse?: string | null;
  onRetryCourseData: () => void;
  onCourseDataSaved: () => void;
  setDietaryFilter: (f: DietaryPreference) => void;
  setOnlyFavorites: (fav: boolean) => void;
  toggleFavoriteDish: (dish: string) => void;
  updateTasteProfile: (patch: Partial<TasteProfile>) => void;
  resetPreferences: () => void;
}) {
  const { undismissTask } = usePreferences();
  const [activeTab, setActiveTab] = useState<'taste' | 'courses' | 'credentials' | 'schedule'>('taste');
  const [savedTasteProfileKey, setSavedTasteProfileKey] = useState('');
  const [tasteProfileError, setTasteProfileError] = useState('');
  const [aiUsage, setAiUsage] = useState<AiUsageStatus | null>(null);
  const [savingTasteProfile, setSavingTasteProfile] = useState(false);
  const [tasteProfileSyncReady, setTasteProfileSyncReady] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const relayTasteProfile = {
    bio: preferences.tasteProfile.bio,
    spiceLevel: preferences.tasteProfile.spiceLevel,
    dietaryGoals: preferences.tasteProfile.dietaryGoals,
    selectedAiModel: preferences.tasteProfile.selectedAiModel,
    dietaryFilter: preferences.dietaryFilter,
  };
  const latestTasteProfileKey = useRef('');
  const latestTasteProfile = useRef(relayTasteProfile);
  const tasteProfileSyncReadyRef = useRef(false);
  const savedTasteProfileKeyRef = useRef('');
  const pendingTasteSave = useRef<{ key: string; profile: typeof relayTasteProfile } | null>(null);
  const activeTasteSaveKey = useRef<string | null>(null);
  const tasteSaveQueueRunning = useRef(false);
  const tasteSaveTimer = useRef<number | null>(null);
  const tasteSaveRetryTimer = useRef<number | null>(null);
  const tasteSaveRetry = useRef({ key: '', count: 0 });
  const relayTasteProfileKey = JSON.stringify(relayTasteProfile);
  const tasteProfileIsSaved = Boolean(relayTasteProfileKey && savedTasteProfileKey === relayTasteProfileKey);
  latestTasteProfileKey.current = relayTasteProfileKey;
  latestTasteProfile.current = relayTasteProfile;
  tasteProfileSyncReadyRef.current = tasteProfileSyncReady;
  savedTasteProfileKeyRef.current = savedTasteProfileKey;

  const drainTasteSaveQueue = async () => {
    if (tasteSaveQueueRunning.current) return;
    tasteSaveQueueRunning.current = true;
    try {
      while (pendingTasteSave.current) {
        const next = pendingTasteSave.current;
        pendingTasteSave.current = null;
        activeTasteSaveKey.current = next.key;
        setSavingTasteProfile(true);
        try {
          await saveFoodTasteProfile(next.profile);
          if (latestTasteProfileKey.current === next.key) {
            try {
              localStorage.setItem('uni-dashboard:food-profile-synced:v1', next.key);
            } catch {
              // The relay remains authoritative if local storage is unavailable.
            }
            tasteSaveRetry.current = { key: '', count: 0 };
            setSavedTasteProfileKey(next.key);
            setTasteProfileError('');
          }
        } catch (error) {
          if (latestTasteProfileKey.current === next.key) {
            setTasteProfileError(error instanceof Error ? error.message : 'Could not save the dining profile.');
            if (tasteSaveRetry.current.key !== next.key) tasteSaveRetry.current = { key: next.key, count: 0 };
            if (tasteSaveRetry.current.count < 2) {
              tasteSaveRetry.current.count += 1;
              if (tasteSaveRetryTimer.current !== null) window.clearTimeout(tasteSaveRetryTimer.current);
              tasteSaveRetryTimer.current = window.setTimeout(() => {
                tasteSaveRetryTimer.current = null;
                pendingTasteSave.current = { key: latestTasteProfileKey.current, profile: latestTasteProfile.current };
                void drainTasteSaveQueue();
              }, 2_000);
            }
          }
        }
        activeTasteSaveKey.current = null;
      }
    } finally {
      tasteSaveQueueRunning.current = false;
      setSavingTasteProfile(false);
    }
  };

  const enqueueTasteSave = (profile: typeof relayTasteProfile, key: string) => {
    if (activeTasteSaveKey.current === key || pendingTasteSave.current?.key === key) return;
    pendingTasteSave.current = { profile, key };
    void drainTasteSaveQueue();
  };

  const flushTasteProfileSave = () => {
    if (!tasteProfileSyncReadyRef.current || latestTasteProfileKey.current === savedTasteProfileKeyRef.current) return;
    if (activeTasteSaveKey.current === latestTasteProfileKey.current || pendingTasteSave.current?.key === latestTasteProfileKey.current) return;
    if (tasteSaveTimer.current !== null) {
      window.clearTimeout(tasteSaveTimer.current);
      tasteSaveTimer.current = null;
    }
    if (tasteSaveRetryTimer.current !== null) {
      window.clearTimeout(tasteSaveRetryTimer.current);
      tasteSaveRetryTimer.current = null;
    }
    enqueueTasteSave({ ...latestTasteProfile.current, dietaryGoals: [...latestTasteProfile.current.dietaryGoals] }, latestTasteProfileKey.current);
  };

  useEffect(() => {
    if (open && focusCourse) setActiveTab('courses');
  }, [open, focusCourse]);

  useEffect(() => {
    if (!open) {
      setTasteProfileSyncReady(false);
      return;
    }
    let active = true;
    const initialTasteProfileKey = latestTasteProfileKey.current;
    setTasteProfileSyncReady(false);
    setTasteProfileError('');
    getFoodTasteProfile().then(({ profile }) => {
      if (!active) return;
      const serverProfile = profile ? (() => {
        const taste = migrateTasteProfile({
          bio: typeof profile.bio === 'string' ? profile.bio : '',
          spiceLevel: typeof profile.spiceLevel === 'string' ? profile.spiceLevel as TasteProfile['spiceLevel'] : 'none',
          dietaryGoals: Array.isArray(profile.dietaryGoals) ? profile.dietaryGoals.filter((goal): goal is string => typeof goal === 'string') : [],
          selectedAiModel: typeof profile.selectedAiModel === 'string' ? profile.selectedAiModel : DEFAULT_TASTE_PROFILE.selectedAiModel,
        });
        return {
          bio: taste.bio,
          spiceLevel: taste.spiceLevel,
          dietaryGoals: taste.dietaryGoals,
          selectedAiModel: taste.selectedAiModel,
          dietaryFilter: typeof profile.dietaryFilter === 'string' ? profile.dietaryFilter : 'all',
        };
      })() : null;
      const serverKey = serverProfile ? JSON.stringify(serverProfile) : '';
      let lastSyncedKey: string | null = null;
      try {
        lastSyncedKey = localStorage.getItem('uni-dashboard:food-profile-synced:v1');
      } catch {
        // The relay remains authoritative if local storage is unavailable.
      }

      // A changed local profile is an intentional edit. Keep it and let the
      // autosave send it; otherwise hydrate an existing relay profile here.
      const localProfileChangedWhileLoading = latestTasteProfileKey.current !== initialTasteProfileKey;
      if (serverProfile && !localProfileChangedWhileLoading && (!lastSyncedKey || lastSyncedKey === initialTasteProfileKey) && serverKey !== initialTasteProfileKey) {
        const { dietaryFilter, ...taste } = serverProfile;
        updateTasteProfile(taste as Partial<TasteProfile>);
        if (typeof dietaryFilter === 'string') setDietaryFilter(dietaryFilter as DietaryPreference);
      }
      setSavedTasteProfileKey(serverKey);
      setTasteProfileSyncReady(true);
    }).catch(() => {
      if (!active) return;
      // A failed read should not block local edits from being saved. The next
      // profile change will retry the write, and the write itself reports errors.
      setSavedTasteProfileKey('');
      setTasteProfileSyncReady(true);
    });
    return () => { active = false; };
  }, [open, setDietaryFilter, updateTasteProfile]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchAiUsage(controller.signal).then(setAiUsage).catch(() => setAiUsage(null));
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open || !tasteProfileSyncReady) return;
    if (tasteProfileIsSaved) {
      setTasteProfileError('');
      return;
    }

    const profileToSave = { ...relayTasteProfile, dietaryGoals: [...relayTasteProfile.dietaryGoals] };
    const saveKey = relayTasteProfileKey;
    if (tasteSaveRetryTimer.current !== null) {
      window.clearTimeout(tasteSaveRetryTimer.current);
      tasteSaveRetryTimer.current = null;
    }
    if (tasteSaveTimer.current !== null) window.clearTimeout(tasteSaveTimer.current);
    tasteSaveTimer.current = window.setTimeout(() => {
      tasteSaveTimer.current = null;
      enqueueTasteSave(profileToSave, saveKey);
    }, 450);
    return () => {
      if (tasteSaveTimer.current !== null) {
        window.clearTimeout(tasteSaveTimer.current);
        tasteSaveTimer.current = null;
      }
    };
  }, [open, relayTasteProfileKey, tasteProfileIsSaved, tasteProfileSyncReady]);

  useEffect(() => () => {
    if (tasteSaveRetryTimer.current !== null) window.clearTimeout(tasteSaveRetryTimer.current);
    flushTasteProfileSave();
  }, []);

  const handleResetPreferences = async () => {
    resetPreferences();
    setResetStatus(null);
    setTasteProfileError('');
    const defaultRelayProfile = {
      bio: DEFAULT_TASTE_PROFILE.bio,
      spiceLevel: DEFAULT_TASTE_PROFILE.spiceLevel,
      dietaryGoals: DEFAULT_TASTE_PROFILE.dietaryGoals,
      selectedAiModel: DEFAULT_TASTE_PROFILE.selectedAiModel,
      dietaryFilter: 'all' as DietaryPreference,
    };
    const defaultKey = JSON.stringify(defaultRelayProfile);
    latestTasteProfileKey.current = defaultKey;
    latestTasteProfile.current = defaultRelayProfile;
    pendingTasteSave.current = { key: defaultKey, profile: defaultRelayProfile };
    setResetStatus({ type: 'success', message: 'Preferences reset. Saving automatically.' });
    void drainTasteSaveQueue();
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) flushTasteProfileSave();
      onOpenChange?.(nextOpen);
    }}>
      {!hideTrigger && <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg border-white/10 bg-card px-2.5 text-xs text-zinc-300 transition-colors hover:border-white/25 hover:bg-secondary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
        >
          <Sliders className="size-3.5" />
          <span className="hidden sm:inline">Settings</span>
        </Button>
      </SheetTrigger>}
      <SheetContent showCloseButton={false} className="settings-sheet w-full sm:max-w-[44rem] border-border/80 bg-card p-5 text-foreground overflow-y-auto max-h-screen shadow-2xl">
        <SheetHeader className="settings-heading p-0 text-left">
          <SheetTitle className="text-base font-semibold">Settings</SheetTitle>
        </SheetHeader>
        <SheetClose className="settings-close" aria-label="Close settings">Close</SheetClose>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'taste' | 'courses' | 'credentials' | 'schedule')}
          className="settings-tabs-wrap mt-5"
        >
          <TabsList className="settings-tabs grid h-10 w-full grid-cols-4 bg-secondary/50 p-1 border border-border/60 rounded-lg">
            <TabsTrigger
              value="taste"
              className="settings-tab text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-950 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Bot className="size-3.5 mr-1 text-[#3478eb]" /> Dining
            </TabsTrigger>
            <TabsTrigger
              value="courses"
              className="settings-tab text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-950 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <GraduationCap className="size-3.5 mr-1" /> Courses
            </TabsTrigger>
            <TabsTrigger
              value="schedule"
              className="settings-tab text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-950 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Calendar className="size-3.5 mr-1" /> Schedule
            </TabsTrigger>
            <TabsTrigger
              value="credentials"
              className="settings-tab text-xs data-[state=active]:bg-zinc-100 data-[state=active]:text-zinc-950 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <KeyRound className="size-3.5 mr-1" /> Connections
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: AI Taste Profile */}
          <TabsContent value="taste" className="settings-panel mt-5 space-y-4">

            {/* One freeform prompt keeps the dining profile in the user’s own words. */}
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="taste-bio" className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  <Bot className="size-3.5 text-[#3478eb]" /> What you like
                </Label>
              </div>
              <Textarea
                id="taste-bio"
                value={preferences.tasteProfile.bio}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateTasteProfile({ bio: e.target.value })}
                placeholder="Spicy food, chicken, noodle bowls; no celery or pork"
                className="settings-input mt-2 min-h-20 text-xs bg-secondary/30 border-border/80 text-foreground placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-[#3478eb] focus-visible:outline-none resize-none"
              />
            </div>

            {/* Workers AI Engine Selection */}
            <details className="settings-disclosure settings-model-picker">
              <summary className="settings-model-summary">
                <span className="flex items-center gap-1.5 font-medium"><Cpu className="size-3.5 text-[#3478eb]" /> AI model</span>
                <span className="settings-model-current">{AI_MODEL_OPTIONS.find((model) => model.id === preferences.tasteProfile.selectedAiModel)?.name ?? 'Selected model'}</span>
              </summary>
              <div className="settings-model-options">
                {AI_MODEL_OPTIONS.map((m) => {
                  const isSelected = preferences.tasteProfile.selectedAiModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => updateTasteProfile({ selectedAiModel: m.id })}
                      className={cn(
                        'settings-model-option w-full flex items-center justify-between rounded-md p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3478eb] focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        isSelected
                        ? 'is-selected text-[#8dbaff]'
                          : 'text-zinc-400 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('size-2 rounded-full', isSelected ? 'bg-white' : 'bg-zinc-600')} />
                        <span className="text-xs font-medium text-foreground">{m.name}</span>
                      </div>
                      {isSelected && <Check className="size-3.5 text-[#78adff]" aria-label="Selected" />}
                    </button>
                  );
                })}
              </div>
            </details>

            <div className="settings-profile-save" aria-live="polite">
              <span className="settings-profile-status">
                {savingTasteProfile ? 'Saving profile…' : tasteProfileIsSaved ? 'Saved automatically' : 'Changes save automatically'}
              </span>
              {tasteProfileError && <p className="settings-profile-message settings-profile-message--error" role="alert">{tasteProfileError} Edit the profile to retry.</p>}
            </div>

            {aiUsage && <p className="settings-ai-usage">Shared AI allowance: {aiUsage.remaining_neurons.toLocaleString()} of {aiUsage.budget_neurons.toLocaleString()} neurons remaining <span>(relay reservation)</span></p>}

            <div>
              <Label className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                <Utensils className="size-3.5" /> Menu filter
              </Label>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {DIETARY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={preferences.dietaryFilter === opt.id}
                    onClick={() => setDietaryFilter(opt.id)}
                    className={`settings-chip rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                      preferences.dietaryFilter === opt.id
                        ? 'border border-white/30 bg-white/10 text-foreground hover:bg-white/15'
                        : 'border border-border/60 bg-secondary/30 text-zinc-300 hover:border-white/20 hover:text-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Taste History & Starred Dishes */}
            <div>
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                  <Star className="size-3.5 text-zinc-400" /> Favorites
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
                        Remove
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-zinc-400">No favorites yet.</p>
              )}
            </div>

          </TabsContent>

          <TabsContent value="courses" className="settings-panel settings-courses mt-5">
            <CourseSettingsTab
              data={courseData}
              pending={courseDataPending}
              error={courseDataError}
              focusCourse={focusCourse}
              onRetry={onRetryCourseData}
              onSaved={onCourseDataSaved}
            />
          </TabsContent>

          <TabsContent value="credentials" className="settings-panel mt-5 space-y-4">
            <CredentialsManager />
            <div className="settings-subsection">
              <SourceStatus />
            </div>
            <details className="settings-disclosure settings-advanced">
              <summary className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                <span className="flex items-center gap-2 font-medium"><Sliders className="size-3.5" /> Advanced</span>
                <span className="text-zinc-500">Reset preferences</span>
              </summary>
              <div className="mt-3 space-y-2">
                <p className="text-xs leading-relaxed text-zinc-400">Reset local settings and the saved dining profile.</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleResetPreferences()}
                  className="h-8 w-full justify-start gap-2 text-xs text-zinc-300 hover:bg-destructive/10 hover:text-destructive"
                >
                  <RotateCcw className="size-3.5" /> Reset all preferences
                </Button>
                {resetStatus && (
                  <p className={cn('text-xs', resetStatus.type === 'error' ? 'text-rose-300' : 'text-emerald-300')} role={resetStatus.type === 'error' ? 'alert' : 'status'}>
                    {resetStatus.message}
                  </p>
                )}
              </div>
            </details>
          </TabsContent>

          <TabsContent value="schedule" className="settings-panel settings-schedule mt-5 space-y-4">
            <ScheduleTab />

            <section className="settings-subsection">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-zinc-200">Hidden schedule items</h3>
                <span className="text-[11px] text-zinc-400">{preferences.dismissedTasks.length}</span>
              </div>
              {preferences.dismissedTasks.length > 0 ? (
                <div className="mt-2.5 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                  {preferences.dismissedTasks.map((id) => (
                    <div key={id} className="settings-hidden-item flex min-w-0 items-center justify-between gap-2 text-xs text-zinc-300">
                      <span className="min-w-0 truncate" title={id}>
                        {id.includes('@') ? id.split('@')[0] : id}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => undismissTask(id)}
                        className="h-7 shrink-0 gap-1 px-2 text-[10px] text-zinc-300 hover:bg-white/5 hover:text-foreground"
                      >
                        <RotateCcw className="size-2.5" /> Restore
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-zinc-400">No hidden items.</p>
              )}
            </section>
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
        <span>Loading connections…</span>
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
        message: 'Saved. Sync started.',
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

      <form onSubmit={handleSave} className="space-y-3">
        <div className="settings-connection">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="size-4 text-live" />
              <span className="text-xs font-medium text-foreground">Calendar feed</span>
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
                Missing
              </Badge>
            )}
          </div>

          <div>
            <Label htmlFor="portal-url" className="text-xs text-zinc-400">
              Google Calendar or Portal URL
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

        <div className="settings-connection">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-cyan-400" />
              <span className="text-xs font-medium text-foreground">LEARN feed</span>
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
                Missing
              </Badge>
            )}
          </div>

          <div>
            <Label htmlFor="learn-url" className="text-xs text-zinc-400">
              LEARN URL
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

        <details className="settings-connection settings-disclosure">
          <summary className="flex items-center justify-between gap-2 text-xs text-zinc-300">
            <span className="flex items-center gap-2 font-medium"><Bot className="size-4 text-[#3478eb]" /> AI service</span>
            <span className={status?.cloudflare?.configured ? 'text-emerald-300' : 'text-zinc-400'}>
              {status?.cloudflare?.configured ? 'Connected' : 'Optional'}
            </span>
          </summary>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label htmlFor="cf-account" className="text-[11px] text-zinc-400">
                Account ID
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
              <Label htmlFor="cf-token" className="text-[11px] text-zinc-400">
                API token
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
        </details>

        {/* Submit button */}
        <Button
          type="submit"
          disabled={saving || (!portalUrl.trim() && !learnUrl.trim() && !cfAccountId.trim() && !cfApiToken.trim())}
          className="w-full h-9 gap-2 text-xs font-medium bg-zinc-100 text-zinc-950 hover:bg-white focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
        >
          {saving ? (
            <>
              <RefreshCw className="size-3.5 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Lock className="size-3.5" /> Save and sync
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

function SourceStatus() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await triggerPoll();
      await queryClient.invalidateQueries({ queryKey: ['health'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh sources.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 settings-source-panel">
      <SourcesPanel onRefresh={() => void refresh()} isFetching={refreshing} />
      {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
    </div>
  );
}
