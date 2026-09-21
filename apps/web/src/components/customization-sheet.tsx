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
  ExternalLink,
  RefreshCw,
  Lock,
  Calendar,
  Clock,
  ShieldCheck,
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
import {
  fetchCredentialsStatus,
  updateCredentials,
  triggerPoll,
  type CredentialsStatus,
} from '@/lib/api';
import type { DietaryPreference, LayoutDensity, UserPreferences } from '@/lib/preferences-store';
import { cn } from '@/lib/utils';

const DIETARY_OPTIONS: { id: DietaryPreference; label: string }[] = [
  { id: 'all', label: 'All Items' },
  { id: 'halal', label: 'Halal' },
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Vegetarian' },
  { id: 'dairy', label: 'Dairy-Free' },
  { id: 'gluten', label: 'Gluten-Free' },
];

export function CustomizationSheet({
  preferences,
  setDensity,
  setDietaryFilter,
  setOnlyFavorites,
  toggleFavoriteDish,
  resetPreferences,
}: {
  preferences: UserPreferences;
  setDensity: (d: LayoutDensity) => void;
  setDietaryFilter: (f: DietaryPreference) => void;
  setOnlyFavorites: (fav: boolean) => void;
  toggleFavoriteDish: (dish: string) => void;
  resetPreferences: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'preferences' | 'credentials'>('preferences');

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
                Customize preferences, taste history, and student feed credentials.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'preferences' | 'credentials')}
          className="mt-5"
        >
          <TabsList className="grid w-full grid-cols-2 bg-secondary/40 p-1 border border-border/60 rounded-lg">
            <TabsTrigger
              value="preferences"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <Sliders className="size-3.5 mr-1.5" /> Preferences
            </TabsTrigger>
            <TabsTrigger
              value="credentials"
              className="text-xs data-[state=active]:bg-card data-[state=active]:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            >
              <KeyRound className="size-3.5 mr-1.5" /> Credentials & Feeds
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: General Preferences */}
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

          {/* Tab 2: Feeds & Credentials */}
          <TabsContent value="credentials" className="mt-5 space-y-5">
            <CredentialsManager />
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

    // Clean up webcal:// -> https:// automatically
    let cleanPortal = portalUrl.trim();
    if (cleanPortal.startsWith('webcal://')) {
      cleanPortal = 'https://' + cleanPortal.slice('webcal://'.length);
    }

    let cleanLearn = learnUrl.trim();
    if (cleanLearn.startsWith('webcal://')) {
      cleanLearn = 'https://' + cleanLearn.slice('webcal://'.length);
    }

    try {
      const payload: { PORTAL_ICS_URL?: string; LEARN_ICS_URL?: string } = {};
      if (cleanPortal) payload.PORTAL_ICS_URL = cleanPortal;
      if (cleanLearn) payload.LEARN_ICS_URL = cleanLearn;

      if (Object.keys(payload).length === 0) {
        setFeedback({ type: 'error', message: 'Enter at least one calendar URL to save.' });
        setSaving(false);
        return;
      }

      await updateCredentials(payload);
      await triggerPoll();

      setFeedback({
        type: 'success',
        message: 'Credentials saved! Feeds are synchronizing in the background.',
      });
      setPortalUrl('');
      setLearnUrl('');
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
          <span>Locked Personal Feeds</span>
        </div>
        <p className="mt-1.5 text-xs text-zinc-300 leading-relaxed">
          The dashboard uses your two official private calendar subscription URLs. They never touch external cloud servers; they are stored locally on your machine and polled by your relay.
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
                1. Schedule Feed: Google Calendar (or UW Portal)
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

          <div className="text-xs text-zinc-400 space-y-1.5">
            <p>
              <strong className="text-foreground">Powers:</strong> Next Commitment card (next class/event, room destination, walk time from REV & leave-by alert).
            </p>

            <div className="rounded-lg bg-secondary/35 p-2.5 border border-border/60 space-y-1">
              <span className="font-semibold text-foreground flex items-center gap-1 text-xs">
                📅 How to get your Google Calendar secret iCal URL:
              </span>
              <ol className="list-decimal list-inside pl-0.5 space-y-0.5 text-xs text-zinc-300">
                <li>
                  Open{' '}
                  <a
                    href="https://calendar.google.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-live hover:underline inline-flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded"
                  >
                    calendar.google.com <ExternalLink className="size-2.5" />
                  </a>
                </li>
                <li>Under <em>My calendars</em> on the left, hover over your calendar, click <strong>⋮</strong> (Options) → <strong>Settings and sharing</strong>.</li>
                <li>Scroll down to the <strong>Integrate calendar</strong> section.</li>
                <li>Copy the <strong>"Secret address in iCal format"</strong> (ends with <code className="font-mono text-[10px]">.../basic.ics</code>).</li>
              </ol>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed bg-secondary/50 p-2.5 rounded-md border border-border/60">
              💡 <strong>Pro tip:</strong> Import your Waterloo schedule into Google Calendar alongside your personal events (gym, work, meetings). Any event with a campus room (e.g. <code className="font-mono text-zinc-200">E7 2317</code>, <code className="font-mono text-zinc-200">MC 4021</code>, <code className="font-mono text-zinc-200">PAC</code>) will automatically calculate your walk from REV!
            </p>
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
                  ? 'Configured (paste new Google Calendar or Portal URL to update)...'
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

          <div className="text-xs text-zinc-400 space-y-1.5">
            <p>
              <strong className="text-foreground">Powers:</strong> Due Soon card (assignments, quizzes, and project deadlines grouped by course).
            </p>
            <p>
              <strong className="text-foreground">How to get it:</strong>
            </p>
            <ol className="list-decimal list-inside pl-1 space-y-0.5 text-xs text-zinc-300">
              <li>
                Log into{' '}
                <a
                  href="https://learn.uwaterloo.ca"
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:underline inline-flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live rounded"
                >
                  learn.uwaterloo.ca <ExternalLink className="size-2.5" />
                </a>
              </li>
              <li>Open <strong>Calendar</strong>, click <strong>Settings</strong>, check <strong>Enable Calendar Feeds</strong>, and click <strong>Save</strong>.</li>
              <li>Click <strong>Subscribe</strong>, choose <strong>All Calendars and Tasks</strong>, and copy the URL.</li>
            </ol>
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

        {/* Submit button */}
        <Button
          type="submit"
          disabled={saving || (!portalUrl.trim() && !learnUrl.trim())}
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

