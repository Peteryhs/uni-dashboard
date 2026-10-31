import { useSyncExternalStore } from 'react';

let reachable = typeof navigator === 'undefined' || navigator.onLine;
const listeners = new Set<() => void>();
export function setReachable(value: boolean) { reachable = value; for (const listener of listeners) listener(); }
export function isOffline() { return !reachable || !navigator.onLine; }
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setReachable(false));
  window.addEventListener('online', () => setReachable(true));
}
export function useOffline() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, isOffline, () => false); }
