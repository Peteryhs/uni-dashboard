import { isIP } from 'node:net';

export function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

/** Check before opening the database or starting any background work. */
export function assertSafeLocalBind({ host, token, allowOpen = false }) {
  if (!isLoopbackHost(host) && !String(token || '').trim() && !allowOpen) {
    throw new Error('Non-loopback relay binding requires RELAY_TOKEN. Set DEV_ALLOW_OPEN=1 only for deliberate open development access.');
  }
}
