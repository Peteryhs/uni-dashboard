import type { SourceHealth } from './contract';

export type SourceCondition = 'healthy' | 'stale' | 'dead' | 'failing' | 'blocked' | 'unknown' | 'partial';
export function sourceCondition(source: SourceHealth, now?: number): SourceCondition;
