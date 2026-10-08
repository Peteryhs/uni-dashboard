import { RefreshCw } from 'lucide-react';
import { BlurFade } from './blur-fade';

type RefreshButtonProps = {
  label: string;
  refreshing: boolean;
  onRefresh: () => void;
  status?: string;
  visibleStatus?: string;
  error?: string;
  showLabel?: boolean;
};

/** Shared by the main panel and dining: one control, including its status treatment. */
export function RefreshButton({ label, refreshing, onRefresh, status = '', visibleStatus = status, error = '', showLabel = false }: RefreshButtonProps) {
  return <button type="button" className={'top-refresh' + (visibleStatus ? ' has-status' : '') + (showLabel ? ' has-label' : '') + (error ? ' has-error' : '')} onClick={onRefresh} disabled={refreshing} aria-label={label} aria-busy={refreshing} title={error || label}>
    <RefreshCw size={16} className={refreshing ? 'spinning' : ''} aria-hidden="true" />
    {showLabel && <span className="top-refresh-label">{label}</span>}
    <span className="top-refresh-status" aria-hidden="true">{visibleStatus && <BlurFade as="span" className="top-refresh-message" key={visibleStatus} duration={0.24} offset={3} blur="3px" direction="up">{visibleStatus}</BlurFade>}</span>
    <span className="sr-only" role="status">{status || (refreshing ? `${label} in progress` : '')}</span>
  </button>;
}
