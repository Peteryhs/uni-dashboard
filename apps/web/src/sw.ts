/// <reference lib="webworker" />
import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string | null }> };
const excluded = /^\/(?:v1(?:\/|$)|mcp(?:\/|$)|healthz(?:\/|$)|oauth(?:\/|$)|cdn-cgi(?:\/|$)|\.well-known(?:\/|$))/;

// Fail installation rather than precache Cloudflare Access login HTML or a redirected asset.
const trustedAssets = {
  async cacheWillUpdate({ response, request }: { response: Response; request: Request }) {
    if (response.status !== 200 || response.redirected || new URL(response.url || request.url).origin !== self.location.origin) return null;
    if (new URL(request.url).pathname === '/index.html') {
      if (!response.headers.get('content-type')?.includes('text/html') || !(await response.clone().text()).includes('name="uni-dashboard-shell"')) return null;
    } else if (response.headers.get('content-type')?.includes('text/html')) return null;
    return response;
  },
};
cleanupOutdatedCaches();
const precache = new PrecacheController({ plugins: [trustedAssets] });
precache.addToCacheList(self.__WB_MANIFEST);
self.addEventListener('install', event => event.waitUntil(precache.install(event)));
self.addEventListener('activate', event => event.waitUntil((async () => { await precache.activate(event); await self.clients.claim(); })()));

registerRoute(({ request, url }) => request.mode === 'navigate' && url.origin === self.location.origin && !excluded.test(url.pathname), async options => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try { return await fetch(options.request, { signal: controller.signal }); }
  catch { return (await precache.matchPrecache('/index.html')) || Response.error(); }
  finally { clearTimeout(timer); }
});
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting(); });
// Navigation must precede precache's / → /index.html alias, or online reloads bypass Access.
registerRoute(new PrecacheRoute(precache));
