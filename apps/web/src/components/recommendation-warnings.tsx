import { CircleHelp, ClockAlert, TriangleAlert } from 'lucide-react';
import { RECOMMENDATION_WARNINGS, recommendationPresentation } from '#contract/recommendation-presentation.mjs';
import type { RecommendationItem, RecommendationWarning } from '@/lib/contract';
import { cn } from '@/lib/utils';
import './recommendation-warnings.css';

export function RecommendationWarnings({ item, className }: { item: RecommendationItem; className?: string }) {
  const warnings = recommendationPresentation(item).warnings as RecommendationWarning[];
  if (!warnings.length) return null;
  return <span className={cn('recommendation-warnings', className)}>
    {warnings.map(code => {
      const { label, detail } = RECOMMENDATION_WARNINGS[code];
      const Icon = code === 'time_unknown' ? ClockAlert : code === 'coverage_unknown' ? CircleHelp : TriangleAlert;
      return <span key={code} className="recommendation-warning" role="img" aria-label={detail} title={detail}>
        <Icon size={14} aria-hidden /><span>{label}</span>
      </span>;
    })}
  </span>;
}
