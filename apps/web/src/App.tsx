import { useState, useMemo } from 'react';
import { RefreshCw, WifiOff, LayoutGrid, LayoutList, Utensils, CalendarClock, ClipboardList, ShieldAlert } from 'lucide-react';
import { CardRenderer } from '@/components/cards';
import { DueSoonDetail } from '@/components/cards/due-soon-detail';
import { taskKey } from '@/components/cards/due-soon';
import { SourcesPanel } from '@/components/sources-panel';
import { CustomizationSheet } from '@/components/customization-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useDashboard, useNow } from '@/hooks/use-dashboard';
import { usePreferences } from '@/lib/preferences-store';
import { formatDay, formatTime, shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { FoodData, NextCommitmentData, DueSoonData, AlertData, Card, DueSoonItem } from '@/lib/contract';

/**
 * Uni Dashboard: The Live Student Life Command Center
 *
 * Cards arrive pre-sorted by server-computed priority so that web and Android agree.
 * Honesty and staleness rules are maintained without exception.
 */
export default function App() {
  const now = useNow(10_000); // Ticks every 10s for accurate leave-by countdowns
  const { cards, skipped, offline, error, isInitialLoading, isFetching, refetch, bundle } =
    useDashboard();

  const {
    preferences,
    setDensity,
    setDietaryFilter,
    setOnlyFavorites,
    toggleFavoriteDish,
    updateTasteProfile,
    resetPreferences,
  } = usePreferences();

  const isCompact = preferences.density === 'compact';

  /**
   * The task whose detail panel is open in compact view, looked up from the current bundle.
   * Only the key is stored, so a refetch that drops the task closes the panel automatically.
   */
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const dueCard = cards.find((c) => c.type === 'due_soon') as Card<DueSoonData> | undefined;

  const selectedTask = useMemo(() => {
    if (!selectedTaskKey || !dueCard) return null;
    const d = dueCard.data;
    const allItems: DueSoonItem[] = [
      ...(d.due ?? []),
      ...(d.opens ?? []),
      ...(d.ahead?.flatMap((g) => g.items) ?? []),
      ...(d.items ?? []),
      ...(d.courses?.flatMap((c) => c.items) ?? []),
    ];
    const item = allItems.find((i) => taskKey(i) === selectedTaskKey);
    if (!item) return null;
    return { item, course: item.course ?? '' };
  }, [selectedTaskKey, dueCard]);

  return (
    <div className="relative min-h-dvh bg-background text-foreground antialiased selection:bg-live/30 selection:text-live">
      <div className={cn('relative z-10 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8', isCompact ? 'pt-4 pb-12' : 'pt-6 pb-20')}>
        {/* Top Header & Navigation HUD */}
        <Header
          now={now}
          offline={offline}
          isFetching={isFetching}
          onRefresh={refetch}
          preferences={preferences}
          setDensity={setDensity}
          setDietaryFilter={setDietaryFilter}
          setOnlyFavorites={setOnlyFavorites}
          toggleFavoriteDish={toggleFavoriteDish}
          updateTasteProfile={updateTasteProfile}
          resetPreferences={resetPreferences}
        />

        {/* Quick Glance Summary Pills */}
        {!isInitialLoading && bundle && (
          <QuickGlanceHUD cards={cards} now={now} isCompact={isCompact} />
        )}

        {/* Outage Notice (Compact Box) */}
        {!isInitialLoading && (() => {
          const alertCard = cards.find((c) => c.type === 'alert');
          return alertCard ? (
            <div className={isCompact ? 'mt-2.5' : 'mt-4'}>
              <CardRenderer card={alertCard} now={now} />
            </div>
          ) : null;
        })()}

        {/* Main Cards Stack - Responsive Desktop Grid */}
        {isInitialLoading ? (
          <LoadingCards />
        ) : error && !bundle ? (
          <ConnectionError message={error.message} onRetry={refetch} />
        ) : (
          <main className={cn(isCompact ? 'mt-3 space-y-3' : 'mt-4 space-y-4 lg:space-y-5')} id="dashboard-cards">
            {/* Primary Cards: Next Commitment & Upcoming Deadlines */}
            {(() => {
              const nextCard = cards.find((c) => c.type === 'next_commitment');
              if (!nextCard && !dueCard) return null;

              if (isCompact) {
                return (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
                      {nextCard && (
                        <CardRenderer key={nextCard.id} card={nextCard} now={now} className="h-full" />
                      )}
                      {dueCard && (
                        <CardRenderer
                          key={dueCard.id}
                          card={dueCard}
                          now={now}
                          className="h-full"
                          selectedTaskKey={selectedTaskKey}
                          onSelectTask={(item) =>
                            setSelectedTaskKey((prev) => (prev === taskKey(item) ? null : taskKey(item)))
                          }
                        />
                      )}
                    </div>

                    {/* Compact View: separate card structure for task detail */}
                    {selectedTask && dueCard && (
                      <DueSoonDetail
                        card={dueCard}
                        item={selectedTask.item}
                        course={selectedTask.course}
                        now={now}
                        onClose={() => setSelectedTaskKey(null)}
                      />
                    )}
                  </>
                );
              }

              // In detailed view, each card is its own full-width horizontal card
              return (
                <>
                  {nextCard && (
                    <CardRenderer key={nextCard.id} card={nextCard} now={now} className="w-full" />
                  )}
                  {dueCard && (
                    <CardRenderer
                      key={dueCard.id}
                      card={dueCard}
                      now={now}
                      className="w-full"
                    />
                  )}
                </>
              );
            })()}

            {/* Remaining Cards (Dining / Food full width) */}
            {cards
              .filter((c) => c.type !== 'alert' && c.type !== 'next_commitment' && c.type !== 'due_soon')
              .map((card) => (
                <CardRenderer
                  key={card.id}
                  card={card}
                  now={now}
                  className="w-full"
                />
              ))}
          </main>
        )}

        {/* Admin Telemetry & Relay Sources Drawer */}
        <div className={isCompact ? 'mt-4' : 'mt-6'}>
          <SourcesPanel onRefresh={refetch} isFetching={isFetching} />
        </div>

        {/* Honest System Footer */}
        <Footer bundleGeneratedAt={bundle?.generated_at ?? null} skipped={skipped} now={now} />
      </div>
    </div>
  );
}

function Header({
  now,
  offline,
  isFetching,
  onRefresh,
  preferences,
  setDensity,
  setDietaryFilter,
  setOnlyFavorites,
  toggleFavoriteDish,
  updateTasteProfile,
  resetPreferences,
}: {
  now: number;
  offline: boolean;
  isFetching: boolean;
  onRefresh: () => void;
  preferences: ReturnType<typeof usePreferences>['preferences'];
  setDensity: ReturnType<typeof usePreferences>['setDensity'];
  setDietaryFilter: ReturnType<typeof usePreferences>['setDietaryFilter'];
  setOnlyFavorites: ReturnType<typeof usePreferences>['setOnlyFavorites'];
  toggleFavoriteDish: ReturnType<typeof usePreferences>['toggleFavoriteDish'];
  updateTasteProfile: ReturnType<typeof usePreferences>['updateTasteProfile'];
  resetPreferences: ReturnType<typeof usePreferences>['resetPreferences'];
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        {/* Waterloo Time & Date */}
        <div>
          <div className="flex items-center gap-2 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">
            <span className="inline-block size-2 rounded-full bg-live animate-pulse" />
            <span>Waterloo, ON</span>
            <span className="text-zinc-500">·</span>
            <span className="font-semibold text-foreground">{formatTime(now)}</span>
          </div>
          <h1 className="mt-0.5 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            {formatDay(now)}
          </h1>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Offline indicator badge */}
          {offline && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber/40 bg-amber/15 px-2.5 py-1 text-[11px] font-medium text-amber-foreground shadow-xs">
              <WifiOff className="size-3" />
              <span>Offline Cache</span>
            </span>
          )}

          {/* Quick layout density segmented control */}
          <div className="flex items-center rounded-lg border border-white/10 bg-secondary/30 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setDensity('detailed')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none',
                preferences.density === 'detailed'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-zinc-400 hover:text-foreground',
              )}
              title="Detailed view: Full summaries, weather details, and spacious layout"
            >
              <LayoutList className="size-3.5" />
              <span className="hidden sm:inline">Detailed</span>
            </button>
            <button
              type="button"
              onClick={() => setDensity('compact')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none',
                preferences.density === 'compact'
                  ? 'bg-card text-live font-semibold shadow-xs'
                  : 'text-zinc-400 hover:text-foreground',
              )}
              title="Compact view: Reduced information density with glanceable essentials"
            >
              <LayoutGrid className="size-3.5" />
              <span className="hidden sm:inline">Compact</span>
            </button>
          </div>

          {/* Customization preferences sheet */}
          <CustomizationSheet
            preferences={preferences}
            setDensity={setDensity}
            setDietaryFilter={setDietaryFilter}
            setOnlyFavorites={setOnlyFavorites}
            toggleFavoriteDish={toggleFavoriteDish}
            updateTasteProfile={updateTasteProfile}
            resetPreferences={resetPreferences}
          />

          {/* Refresh button */}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
            className="h-8 size-8 p-0 rounded-lg border-white/10 bg-card text-zinc-300 hover:border-white/25 hover:bg-secondary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
            title="Refresh dashboard bundle"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin text-live')} />
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * Quick Glance HUD: Instant glanceable pills summarizing the state of the world in 1 line
 */
function QuickGlanceHUD({ cards, now, isCompact }: { cards: Card[]; now: number; isCompact?: boolean }) {
  const nextCard = cards.find((c) => c.type === 'next_commitment') as Card<NextCommitmentData> | undefined;
  const alertCard = cards.find((c) => c.type === 'alert') as Card<AlertData> | undefined;
  const dueCard = cards.find((c) => c.type === 'due_soon') as Card<DueSoonData> | undefined;
  const foodCard = cards.find((c) => c.type === 'food') as Card<FoodData> | undefined;

  const nextTitle = nextCard?.data?.title;
  const nextStartsAt = nextCard?.data?.starts_at;
  const nextSoon = nextStartsAt != null && nextStartsAt - now <= 15 * 60_000;

  const alertCount = alertCard?.data?.count ?? 0;
  const dueCourses = dueCard?.data?.courses ?? [];
  const futureDueItems = dueCourses.flatMap((c) => c.items).filter((i) => i.starts_at >= now);
  const dueCount = dueCourses.length > 0 ? futureDueItems.length : (dueCard?.data?.count ?? 0);
  const dishCount = foodCard?.data?.total_dishes ?? 0;

  return (
    <div className={cn(
      'flex items-center overflow-x-auto no-scrollbar',
      isCompact ? 'mt-2 gap-1.5 pb-0.5 text-[11px]' : 'mt-3.5 gap-2 pb-1 text-xs'
    )}>
      {/* Alert pill if active */}
      {alertCount > 0 && (
        <div className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/15 text-rose-300 font-medium shadow-xs',
          isCompact ? 'px-2 py-0.5' : 'px-2.5 py-1'
        )}>
          <ShieldAlert className={isCompact ? 'size-2.5' : 'size-3'} />
          <span>{alertCount} Incident{alertCount === 1 ? '' : 's'}</span>
        </div>
      )}

      {/* Next Up pill */}
      {nextTitle && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md border font-medium transition-colors',
            isCompact ? 'px-2 py-0.5' : 'px-2.5 py-1',
            nextSoon
              ? 'border-amber/50 bg-amber/15 text-amber-foreground'
              : 'border-white/10 bg-card text-foreground',
          )}
        >
          <CalendarClock className={cn(isCompact ? 'size-3' : 'size-3.5', 'text-cyan-400')} />
          <span className="truncate max-w-[160px]">{nextTitle}</span>
          {nextStartsAt != null && (
            <span className="text-zinc-400 font-normal">· {formatTime(nextStartsAt)}</span>
          )}
        </div>
      )}

      {/* Due soon pill */}
      <div className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-card font-medium text-zinc-300',
        isCompact ? 'px-2 py-0.5' : 'px-2.5 py-1'
      )}>
        <ClipboardList className={cn(isCompact ? 'size-3' : 'size-3.5', 'text-amber-400')} />
        <span>{dueCount} Due Soon</span>
      </div>

      {/* Food pill */}
      <div className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-card font-medium text-zinc-300',
        isCompact ? 'px-2 py-0.5' : 'px-2.5 py-1'
      )}>
        <Utensils className={cn(isCompact ? 'size-3' : 'size-3.5', 'text-emerald-400')} />
        <span>{dishCount} Dishes Today</span>
      </div>
    </div>
  );
}

/**
 * Shimmer skeleton for cold start
 */
function LoadingCards() {
  return (
    <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5" aria-busy="true" aria-label="Loading dashboard">
      <div className="col-span-1 md:col-span-1 lg:col-span-6 rounded-lg border border-border/80 bg-card p-5">
        <Skeleton className="h-4 w-24 rounded-md bg-secondary/50" />
        <Skeleton className="mt-4 h-7 w-3/4 rounded-md bg-secondary/60" />
        <Skeleton className="mt-2.5 h-3.5 w-1/2 rounded-md bg-secondary/40" />
      </div>
      <div className="col-span-1 md:col-span-1 lg:col-span-6 rounded-lg border border-border/80 bg-card p-5">
        <Skeleton className="h-4 w-24 rounded-md bg-secondary/50" />
        <Skeleton className="mt-4 h-7 w-3/4 rounded-md bg-secondary/60" />
        <Skeleton className="mt-2.5 h-3.5 w-1/2 rounded-md bg-secondary/40" />
      </div>
      <div className="col-span-1 md:col-span-2 lg:col-span-12 rounded-lg border border-border/80 bg-card p-5">
        <Skeleton className="h-4 w-32 rounded-md bg-secondary/50" />
        <Skeleton className="mt-4 h-24 w-full rounded-md bg-secondary/60" />
      </div>
    </div>
  );
}

function ConnectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-amber/40 bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-lg bg-amber/20 text-amber">
          <WifiOff className="size-4" />
        </div>
        <p className="text-sm font-semibold text-amber-foreground">Relay Server Unreachable</p>
      </div>

      <p className="mt-2 font-mono text-[11px] break-words text-zinc-300 bg-secondary/30 p-2.5 rounded-lg border border-white/5">
        {message}
      </p>

      <p className="mt-3 text-xs text-zinc-400">
        Ensure the relay is active via <code className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-foreground">node apps/relay/src/cli.mjs serve</code>.
      </p>

      <Button
        type="button"
        onClick={onRetry}
        variant="outline"
        size="sm"
        className="mt-4 border-amber/40 bg-amber/10 text-xs font-semibold text-amber-foreground hover:bg-amber/20 focus-visible:ring-2 focus-visible:ring-live focus-visible:outline-none"
      >
        Retry Connection
      </Button>
    </div>
  );
}

function Footer({
  bundleGeneratedAt,
  skipped,
  now,
}: {
  bundleGeneratedAt: number | null;
  skipped: number;
  now: number;
}) {
  if (bundleGeneratedAt == null && !skipped) return null;
  return (
    <footer className="mt-8 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/60 pt-4 text-xs text-zinc-400">
      <div className="flex items-center gap-2">
        {bundleGeneratedAt != null && (
          <span>Bundle generated {shortAge(bundleGeneratedAt, now)} ago</span>
        )}
        {skipped > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="text-amber-foreground font-medium">
              {skipped} unknown card{skipped === 1 ? '' : 's'} skipped
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs text-zinc-400">
        <span className="size-2 rounded-full bg-live" />
        <span>Uni Dashboard v0.1</span>
      </div>
    </footer>
  );
}
