/**
 * Cloudflare allows an HTTPS authorization redirect. Android accepts arbitrary dashboard
 * origins at runtime, so this page hands the one-use code to the app's fixed custom scheme.
 * It never exchanges a code, creates a session, or accepts a caller-supplied redirect target.
 * The native client verifies state and exchanges the code with its PKCE verifier.
 */
export const ANDROID_OAUTH_CALLBACK_PATH = '/oauth/android/callback';
export const ANDROID_OAUTH_APP_CALLBACK = 'dev.peteryhs.unidash:/oauth/callback';

export function androidOAuthCallback(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const params = new URL(request.url).searchParams;
  const allowed = ['code', 'state', 'error', 'iss'];
  const validValue = (key, max) => params.getAll(key).length <= 1 &&
    (!params.has(key) || (params.get(key).length > 0 && params.get(key).length <= max && !/[\u0000-\u001f\u007f]/.test(params.get(key))));
  const valid = validValue('state', 1024) && params.has('state') &&
    validValue('code', 8192) && validValue('error', 512) && validValue('iss', 2048) &&
    (params.has('code') !== params.has('error'));
  const nativeParams = new URLSearchParams();
  if (valid) for (const key of allowed) if (params.has(key)) nativeParams.set(key, params.get(key));
  const target = valid ? `${ANDROID_OAUTH_APP_CALLBACK}?${nativeParams}` : null;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  // Escaping '<' also prevents a malicious parameter from closing the script element.
  const serializedTarget = JSON.stringify(target).replaceAll('<', '\\u003c');
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Return to Uni Dashboard</title>
<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;padding:24px;min-height:100dvh;box-sizing:border-box;display:grid;place-items:center;background:light-dark(#f5fafc,#0e1415);color:light-dark(#171d1e,#dee3e5)}main{max-width:28rem}h1{font-size:1.8rem;line-height:1.2}p{line-height:1.6}a{display:inline-block;padding:14px 24px;border-radius:24px;background:light-dark(#006876,#83d2e3);color:light-dark(#fff,#00363e);font-weight:600;text-decoration:none}a:focus-visible{outline:3px solid currentColor;outline-offset:4px}[hidden]{display:none}</style></head>
<body><main><h1>${valid ? 'Return to your dashboard' : 'Sign-in could not finish'}</h1>
<p>${valid ? 'Continue in the Uni Dashboard Android app to finish signing in.' : 'Open Uni Dashboard and start sign-in again. This return link is incomplete or invalid.'}</p>
<a id="continue" hidden>Open Uni Dashboard</a>
<p id="help" hidden>If the app does not open, install it on this device and start sign-in from the app.</p>
<script nonce="${nonce}">const target=${serializedTarget};if(target){const link=document.getElementById('continue');link.href=target;link.hidden=false;document.getElementById('help').hidden=false;window.location.replace(target);}</script>
</main></body></html>`, {
    status: valid ? 200 : 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}
