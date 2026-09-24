import { useEffect, useRef, useState } from 'react';
import { fetchFoodRecommendation, getFoodTasteProfile, rankFoodWithAi } from '@/lib/api';
import type { FoodAiRankedOutlet, FoodAiRecommendation } from '@/lib/contract';

export type RecommendationState =
  | { status: 'loading' }
  | { status: 'ready'; recommendation: FoodAiRecommendation; stale: boolean; sourceStatus: string; limitReason?: string }
  | { status: 'attempt_limited'; reason?: string }
  | { status: 'budget_limited' }
  | { status: 'empty' }
  | { status: 'failed'; reason?: string };

export interface DiningRecommendationController {
  state: RecommendationState;
  isReranking: boolean;
  rerankError: string;
  rerank: () => Promise<void>;
}

function hasContent(outlet: FoodAiRankedOutlet): boolean {
  return Boolean(outlet.outlet?.trim() || outlet.verdict?.trim() || outlet.highlights?.length);
}

export function getRankedDiningOutlets(recommendation: FoodAiRecommendation): FoodAiRankedOutlet[] {
  return [...recommendation.ranked_outlets]
    .filter(hasContent)
    .sort((a, b) => a.rank - b.rank);
}

function normalizeName(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.length > 4 && token.endsWith('ies')
      ? `${token.slice(0, -3)}y`
      : token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
        ? token.slice(0, -1)
        : token);
}

/** Match only normalized exact names or unambiguous multiword subsets. */
export function diningNameMatches(aiName: string, menuName: string): boolean {
  const aiTokens = normalizeName(aiName);
  const menuTokens = normalizeName(menuName);
  if (!aiTokens.length || !menuTokens.length) return false;
  const ai = new Set(aiTokens);
  const menu = new Set(menuTokens);
  if (ai.size === menu.size && [...ai].every((token) => menu.has(token))) return true;
  const shorter = ai.size < menu.size ? ai : menu;
  const longer = ai.size < menu.size ? menu : ai;
  return shorter.size >= 2 && [...shorter].every((token) => longer.has(token));
}

export function matchDiningOutlet(
  recommendation: FoodAiRecommendation | undefined,
  menuOutlet: string,
): FoodAiRankedOutlet | undefined {
  if (!recommendation) return undefined;
  return getRankedDiningOutlets(recommendation).find((outlet) => diningNameMatches(outlet.outlet, menuOutlet));
}

export function matchDiningDish(
  recommendation: FoodAiRankedOutlet | undefined,
  menuDish: string,
) {
  if (!recommendation) return undefined;
  return recommendation.highlights.find((highlight) => highlight.dish?.trim() && diningNameMatches(highlight.dish, menuDish));
}

export function useDiningRecommendation(serviceDate: string | undefined): DiningRecommendationController {
  const [state, setState] = useState<RecommendationState>({ status: 'loading' });
  const [isReranking, setIsReranking] = useState(false);
  const [rerankError, setRerankError] = useState('');
  const manualResultRef = useRef<FoodAiRecommendation | null>(null);
  const manualAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    manualResultRef.current = null;
    setIsReranking(false);
    setRerankError('');
    if (!serviceDate) {
      setState({ status: 'empty' });
      return () => { active = false; };
    }
    setState({ status: 'loading' });

    const load = () => fetchFoodRecommendation(serviceDate)
      .then(({ recommendation, status, stale, limit_reason, error }) => {
        if (!active || manualResultRef.current?.service_date === serviceDate) return;
        // The endpoint may return a saved result for another day; never attach it to this menu.
        if (recommendation && recommendation.service_date === serviceDate) {
          setState({ status: 'ready', recommendation, stale: Boolean(stale || status !== 'ready'), sourceStatus: status, limitReason: limit_reason });
          return;
        }

        if (status === 'attempt_limited' || status === 'limited') {
          setState({ status: 'attempt_limited', reason: limit_reason || (status === 'limited' ? 'daily_attempt_cap' : undefined) });
          return;
        }
        if (status === 'budget_limited') {
          setState({ status: 'budget_limited' });
          return;
        }
        if (status === 'failed') {
          setState({ status: 'failed', reason: error });
          return;
        }
        if (!recommendation || recommendation.service_date !== serviceDate) setState({ status: 'empty' });
      })
      .catch(() => {
        if (active && manualResultRef.current?.service_date !== serviceDate) setState({ status: 'failed' });
      });

    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      manualAbortRef.current?.abort();
      manualAbortRef.current = null;
      window.clearInterval(interval);
    };
  }, [serviceDate]);

  const rerank = async () => {
    if (!serviceDate || manualAbortRef.current || state.status === 'budget_limited') return;
    const controller = new AbortController();
    manualAbortRef.current = controller;
    setIsReranking(true);
    setRerankError('');

    try {
      const { profile } = await getFoodTasteProfile();
      if (controller.signal.aborted) return;
      const model = typeof profile?.selectedAiModel === 'string' ? profile.selectedAiModel : undefined;
      const recommendation = await rankFoodWithAi({ tasteProfile: profile ?? {}, model, date: serviceDate, force: true }, controller.signal);
      if (controller.signal.aborted) return;
      if (recommendation.service_date !== serviceDate) throw new Error('Ranking returned a different menu date.');
      manualResultRef.current = recommendation;
      setState({ status: 'ready', recommendation, stale: false, sourceStatus: 'ready' });
    } catch (error: unknown) {
      if (!controller.signal.aborted) setRerankError(error instanceof Error ? error.message : 'Manual dining ranking failed.');
    } finally {
      if (manualAbortRef.current === controller) manualAbortRef.current = null;
      if (!controller.signal.aborted) setIsReranking(false);
    }
  };

  return { state, isReranking, rerankError, rerank };
}
