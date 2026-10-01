/** A legacy relay token is only for a local relay. Access owns deployed browser sessions. */
export function localRelayToken(token, origin) {
  try {
    const url = new URL(origin);
    // HTTP relays also support a phone/laptop on the owner's LAN. Deployed Access uses HTTPS.
    return url.protocol === 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? token : '';
  } catch { return ''; }
}

export class RelayError extends Error {
  /** @param {string} message @param {number | undefined} [status] */
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'RelayError';
  }
}

/** Catch Access and SPA responses before any screen treats them as empty configuration. */
export async function checkRelayResponse(response, usesLocalToken = false) {
  if (response.status === 401 || (response.redirected && response.headers.get('content-type')?.includes('text/html'))) {
    throw new RelayError(usesLocalToken
      ? 'Connection token rejected. Check Connections in Settings.'
      : 'Your Cloudflare sign-in has expired or could not be verified. Reload the dashboard to sign in again.', 401);
  }
  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new RelayError('The dashboard loaded, but the backend returned a web page instead of data. The deployment needs its API routing fixed; your saved connections could not be checked.', response.status);
  }
  if (response.status === 503) {
    const body = await response.clone().json().catch(() => null);
    if (body?.error === 'access not configured') {
      throw new RelayError('Cloudflare sign-in is configured at the edge, but the backend is missing its Access settings. Check ACCESS_TEAM_DOMAIN and ACCESS_AUD on the Worker.', 503);
    }
    if (body?.error === 'access verification unavailable') {
      throw new RelayError('The backend could not verify Cloudflare sign-in. Try again shortly.', 503);
    }
  }
}

export async function readRelayJson(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RelayError(body?.error || `The backend returned ${response.status}. Try again.`, response.status);
  }
  try { return await response.json(); }
  catch { throw new RelayError('The backend returned unreadable data. Try again.', response.status); }
}
