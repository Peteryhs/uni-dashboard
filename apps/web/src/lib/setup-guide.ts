/** Only non-secret navigation state belongs in browser storage. */
export const SETUP_GUIDE_KEY = 'unidash.setup-guide.v1';
export const SETUP_STEPS = ['Schedule feed', 'LEARN deadlines', 'Personalize', 'Connect Android', 'Review'] as const;
export type GuideProgress = { seen: boolean; step: number; finished: boolean };

export function parseGuideProgress(raw: string | null): GuideProgress {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.seen === true && Number.isInteger(value.step) && value.step >= 0 && value.step < SETUP_STEPS.length) {
      return { seen: true, step: value.step, finished: value.finished === true };
    }
  } catch { /* A damaged or old record starts a fresh guide. */ }
  return { seen: false, step: 0, finished: false };
}

export function readGuideProgress(): GuideProgress {
  try { return parseGuideProgress(localStorage.getItem(SETUP_GUIDE_KEY)); }
  catch { return parseGuideProgress(null); }
}

export function saveGuideProgress(step: number, finished = readGuideProgress().finished) {
  try { localStorage.setItem(SETUP_GUIDE_KEY, JSON.stringify({ seen: true, step, finished })); }
  catch { /* Private browsing can disable storage; the guide still works. */ }
}

export function normalizeFeedAddress(value: string): string {
  const input = value.trim().replace(/^webcal:\/\//i, 'https://');
  if (/\s/.test(input)) throw new Error('Paste the complete feed URL without spaces.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Paste an iCal subscription URL, starting with https:// or webcal://.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS feed URL without a username, password, or fragment.');
  }
  return url.href;
}

export function dashboardOrigin(value: string): string | null {
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    // Generated terminal commands only contain DNS / IPv6 hostname characters and a numeric
    // port. WHATWG URLs alone also accept characters that have meaning in a shell.
    const safeHost = /^[a-z0-9.-]+$/i.test(url.hostname) || /^\[[0-9a-f:]+\]$/i.test(url.hostname);
    return url.protocol === 'https:' && safeHost && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** The selectable grant is an owner configuration request, never a client-side expiry override. */
export function oauthSetupCommand(origin: string, weeks: number): string {
  if (dashboardOrigin(origin) !== origin || ![1, 2, 3].includes(weeks)) throw new Error('Choose an HTTPS dashboard and a session of 1, 2, or 3 weeks.');
  return `npm run access:oauth -- --dashboard ${origin} --grant-weeks ${weeks}`;
}
