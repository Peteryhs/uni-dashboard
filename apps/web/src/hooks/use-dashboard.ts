import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBundle, fetchHealth, fetchHealthz, readCachedBundle } from '@/lib/api';
import { renderableCards, type Bundle, type Card } from '@/lib/contract';

/** Card types this build knows how to draw. Anything else is skipped and counted, never fatal. */
export const KNOWN_CARD_TYPES = ['next_commitment', 'due_soon', 'food', 'alert'] as const;

/**
 * A clock that ticks independently of the data.
 *
 * Countdowns have to stay truthful between polls, but re-fetching once a second to move a "in 2h
 * 14m" label would be absurd. So time advances locally and data advances on its own schedule.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    // A phone that was asleep has a stale clock reading until the next tick; correct it the
    // instant the tab is visible again, otherwise the countdown lies right when it is being read.
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}

export interface DashboardResult {
  bundle: Bundle | null;
  cards: Card[];
  /** Cards the server sent that this build does not understand. Surfaced, not hidden. */
  skipped: number;
  /** True when the newest bundle came from localStorage rather than the network. */
  offline: boolean;
  error: Error | null;
  isInitialLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export function useDashboard(): DashboardResult {
  // Read the cache once, synchronously, before the first paint. This is what removes the spinner
  // on a cold start with a dead relay.
  const cached = useRef(readCachedBundle()).current;

  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => fetchBundle(signal),
    // The fastest source cadence is 60s (campus status), so polling faster than that only burns
    // requests against the Workers free tier without producing new information.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    initialData: cached?.bundle,
    // Treat the hydrated cache as already stale so a real fetch starts immediately on mount.
    initialDataUpdatedAt: 0,
    retry: 1,
    staleTime: 15_000,
  });

  const bundle = query.data ?? null;

  const { cards, skipped } = useMemo(() => {
    if (!bundle) return { cards: [] as Card[], skipped: 0 };
    const { rendered, skipped: n } = renderableCards(bundle, [...KNOWN_CARD_TYPES]);
    return { cards: rendered, skipped: n };
  }, [bundle]);

  return {
    bundle,
    cards,
    skipped,
    // Showing data while the network is failing is the designed behaviour, but it must be labelled.
    offline: Boolean(query.isError && bundle),
    error: (query.error as Error | null) ?? null,
    isInitialLoading: query.isLoading && !bundle,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export function useHealth(enabled: boolean) {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: enabled ? 60_000 : false,
    enabled,
    retry: 1,
  });
}

export function useHealthz(enabled: boolean) {
  return useQuery({
    queryKey: ['healthz'],
    queryFn: ({ signal }) => fetchHealthz(signal),
    refetchInterval: enabled ? 10_000 : false,
    enabled,
    retry: 1,
  });
}

/**
 * Fires once when a value actually changes, so the UI can flash it.
 *
 * The spec is explicit that motion means information: a poll returning identical bytes must produce
 * no movement. Comparing the value rather than the fetch is what enforces that.
 */
export function useChanged(value: unknown): boolean {
  const serialized = JSON.stringify(value ?? null);
  const previous = useRef<string | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (previous.current !== null && previous.current !== serialized) {
      setChanged(true);
      const id = setTimeout(() => setChanged(false), 1700);
      previous.current = serialized;
      return () => clearTimeout(id);
    }
    previous.current = serialized;
  }, [serialized]);

  return changed;
}
