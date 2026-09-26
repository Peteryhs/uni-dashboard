import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFoodRecommendation, requestFoodRanking } from '@/lib/api';
import type { FoodAiRankedOutlet, FoodAiRecommendation } from '@/lib/contract';

export type RecommendationState =
  | { status: 'loading' }
  | { status: 'processing' }
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
  const [starting, setStarting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const query = useQuery({
    queryKey: ['food-recommendation', serviceDate],
    queryFn: () => fetchFoodRecommendation(serviceDate!),
    enabled: Boolean(serviceDate),
    refetchInterval: (current) => current.state.data?.ranking_job?.status === 'processing' ? 3_000 : 60_000,
  });
  const data = query.data;
  const job = data?.ranking_job;
  const isReranking = starting || job?.status === 'processing';
  const jobError = job?.status === 'failed' && (!data?.recommendation || data.recommendation.generated_at <= (job.updated_at || 0))
    ? job.error || 'Manual dining ranking failed.' : '';
  const rerankError = requestError || jobError;

  let state: RecommendationState;
  if (!serviceDate) state = { status: 'empty' };
  else if (!data) state = query.isError ? { status: 'failed' } : { status: 'loading' };
  else if (data.recommendation?.service_date === serviceDate) {
    const sourceStatus = job?.status === 'processing' ? 'processing' : data.status;
    state = {
      status: 'ready', recommendation: data.recommendation,
      stale: Boolean(data.stale || sourceStatus !== 'ready'), sourceStatus, limitReason: data.limit_reason,
    };
  } else if (job?.status === 'processing' || data.status === 'processing') state = { status: 'processing' };
  else if (data.status === 'attempt_limited' || data.status === 'limited') state = { status: 'attempt_limited', reason: data.limit_reason };
  else if (data.status === 'budget_limited') state = { status: 'budget_limited' };
  else if (data.status === 'failed') state = { status: 'failed', reason: data.error };
  else state = { status: 'empty' };

  const rerank = async () => {
    if (!serviceDate || isReranking || state.status === 'budget_limited') return;
    setStarting(true);
    setRequestError('');
    try {
      await requestFoodRanking(serviceDate);
      await query.refetch();
    } catch (error: unknown) {
      setRequestError(error instanceof Error ? error.message : 'Could not start dining ranking.');
    } finally {
      setStarting(false);
    }
  };

  return { state, isReranking, rerankError, rerank };
}
