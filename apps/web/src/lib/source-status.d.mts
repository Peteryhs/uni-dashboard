import type { SourceHealth, HealthSummary } from './contract';

export type SourceCondition = 'healthy' | 'stale' | 'dead' | 'failing' | 'blocked' | 'unknown' | 'partial';
export function sourceCondition(source: SourceHealth, now?: number): SourceCondition;
export function healthSummary(sources: SourceHealth[], now?: number): HealthSummary;
