/**
 * MCP key presentation rules.
 *
 * Pure and side-effect free so the settings tab renders the same decision the test asserts: a key
 * is active, expired or revoked; an expiry is a date, not a countdown that silently lies when the
 * tab stays open. Everything here is display logic only — the server is authoritative.
 */
export type McpAuthMode = 'access' | 'token' | 'both' | 'local';

export interface McpToken {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface McpTokenList {
  tokens: McpToken[];
  auth?: { mode: McpAuthMode };
}

export type McpTokenStatus = 'active' | 'expired' | 'revoked';
export type McpExpiryChoice = 'never' | 30 | 90 | 365;

export const MCP_EXPIRY_OPTIONS: { value: McpExpiryChoice; label: string }[] = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
  { value: 'never', label: 'No expiry' },
];

export function parseExpiryChoice(value: string): McpExpiryChoice {
  if (value === 'never') return 'never';
  const days = Number(value);
  return days === 30 || days === 90 || days === 365 ? days : 90;
}

/** `null` means no expiry, matching the API's `expires_in_days: null`. */
export function expiryInDays(choice: McpExpiryChoice): number | null {
  return choice === 'never' ? null : choice;
}

export function mcpTokenStatus(token: McpToken, now = Date.now()): McpTokenStatus {
  if (token.revoked_at != null) return 'revoked';
  if (token.expires_at != null && token.expires_at <= now) return 'expired';
  return 'active';
}

export function mcpTokenStatusLabel(status: McpTokenStatus): string {
  return status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Revoked';
}

/** A short, non-secret id is enough to tell two keys for the same device apart. */
export function mcpTokenIdHint(id: string): string {
  return id.replaceAll('-', '').slice(0, 8);
}

/** Mirrors the server's rule: 1-60 printable characters. Returns an error, or null when valid. */
export function validateMcpTokenName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the key a name, such as the device or agent that will use it.';
  if (trimmed.length > 60) return 'Keep the name to 60 characters or fewer.';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'The name contains characters that cannot be saved.';
  return null;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function formatMcpDate(ms: number): string {
  return dateFmt.format(new Date(ms));
}

export function describeMcpExpiry(token: McpToken, now = Date.now()): string {
  if (token.expires_at == null) return 'No expiry';
  if (token.expires_at <= now) return `Expired ${formatMcpDate(token.expires_at)}`;
  return `Expires ${formatMcpDate(token.expires_at)}`;
}

export function describeMcpLastUsed(token: McpToken): string {
  return token.last_used_at == null ? 'Never used' : `Last used ${formatMcpDate(token.last_used_at)}`;
}
