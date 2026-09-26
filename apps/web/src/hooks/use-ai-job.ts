import { useQuery } from '@tanstack/react-query';
import { fetchAiJob, type AiJob } from '@/lib/api';

export function useAiJob<Result>(kind: 'office_hours' | 'syllabus', scope: string) {
  return useQuery<AiJob<Result>>({
    queryKey: ['ai-job', kind, scope],
    queryFn: () => fetchAiJob<Result>(kind, scope),
    enabled: Boolean(scope),
    refetchInterval: (query) => query.state.data?.status === 'processing' ? 3_000 : 60_000,
  });
}
