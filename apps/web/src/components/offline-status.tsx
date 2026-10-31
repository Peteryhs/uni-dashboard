import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { useOffline } from '@/lib/connectivity';

let updater: ((reloadPage?: boolean) => Promise<void>) | null = null;
export function OfflineStatus() {
  const offline = useOffline(), client = useQueryClient();
  const [ready, setReady] = useState(false), [update, setUpdate] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    updater = registerSW({ onOfflineReady: () => setReady(true), onNeedRefresh: () => setUpdate(true), onRegisterError: () => setError('Offline launch could not be prepared. Reconnect and reload to retry.') });
    const online = () => { void client.invalidateQueries(); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [client]);
  return <div className="offline-status" role="status">
    {offline && <p className="data-note">Offline · Showing saved information. Changes require a connection.</p>}
    {ready && !offline && <p className="data-note">Ready for offline use.</p>}
    {error && <p className="data-note">{error}</p>}
    {update && !offline && <button className="quiet-action" onClick={() => void updater?.(true)}>Update available · Reload</button>}
  </div>;
}

export function ClearOfflineData() {
  const [error, setError] = useState('');
  return <div><button className="quiet-action" onClick={async () => {
    if (!window.confirm('Clear saved dashboard information, local preferences and offline files from this browser? Your server data is kept.')) return;
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('uni-dashboard:') || key.startsWith('uni-dash')) localStorage.removeItem(key);
      if ('caches' in window) for (const name of await caches.keys()) if (name.includes('workbox') || name.startsWith('uni-dashboard')) await caches.delete(name);
      if ('serviceWorker' in navigator) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      window.location.reload();
    } catch { setError('Could not clear all saved information. Use your browser’s site-data settings.'); }
  }}>Clear saved data on this device</button>{error && <p role="alert">{error}</p>}</div>;
}
