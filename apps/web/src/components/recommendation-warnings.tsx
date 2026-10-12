import { CircleHelp, ClockAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Tooltip } from 'radix-ui';
import { RECOMMENDATION_WARNINGS, recommendationPresentation } from '#contract/recommendation-presentation.mjs';
import type { RecommendationItem, RecommendationWarning } from '@/lib/contract';
import { cn } from '@/lib/utils';
import './recommendation-warnings.css';

function WarningIcon({ code }: { code: RecommendationWarning }) {
  const [open, setOpen] = useState(false);
  const { label, detail } = RECOMMENDATION_WARNINGS[code];
  const Icon = code === 'time_unknown' ? ClockAlert : code === 'coverage_unknown' ? CircleHelp : TriangleAlert;
  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger className="recommendation-warning" aria-label={label} onClick={event => {
      // Radix normally closes on click; keep the explanation available to touch users.
      event.preventDefault();
      setOpen(value => !value);
    }}><Icon size={14} aria-hidden /></Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content className="recommendation-warning-tooltip" sideOffset={6} collisionPadding={12}>
        {detail}
        <Tooltip.Arrow className="recommendation-warning-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}

export function RecommendationWarnings({ item, className }: { item: RecommendationItem; className?: string }) {
  const warnings = recommendationPresentation(item).warnings as RecommendationWarning[];
  if (!warnings.length) return null;
  return <span className={cn('recommendation-warnings', className)}>
    {warnings.map(code => <WarningIcon key={code} code={code} />)}
  </span>;
}
