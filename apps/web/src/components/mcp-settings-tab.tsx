import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createMcpToken, fetchMcpTokens, revokeMcpToken } from '@/lib/api';
import {
  MCP_EXPIRY_OPTIONS,
  describeMcpExpiry,
  describeMcpLastUsed,
  expiryInDays,
  mcpTokenIdHint,
  mcpTokenStatus,
  mcpTokenStatusLabel,
  parseExpiryChoice,
  validateMcpTokenName,
  type McpAuthMode,
  type McpExpiryChoice,
  type McpToken,
} from '@/lib/mcp-tokens';
import './mcp-settings-tab.css';

const MODE_NOTES: Record<McpAuthMode, { tone: 'warning' | 'active' | 'neutral'; text: string }> = {
  access: {
    tone: 'warning',
    text: 'This deployment is in Access-only mode. Keys can be created here, but /mcp will ignore them until MCP_AUTH_MODE is token or both.',
  },
  token: {
    tone: 'active',
    text: 'Key authentication is active. /mcp accepts these keys and does not require Cloudflare Access.',
  },
  both: {
    tone: 'active',
    text: 'Either a Cloudflare Access credential or one of these keys can call /mcp.',
  },
  local: {
    tone: 'neutral',
    text: 'Local relay: these keys work on /mcp, alongside RELAY_TOKEN when one is configured.',
  },
};

async function copyText(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function McpSettingsTab({ active }: { active: boolean }) {
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [mode, setMode] = useState<McpAuthMode | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<McpExpiryChoice>(90);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; record: McpToken } | null>(null);
  const [actionError, setActionError] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'token' | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await fetchMcpTokens();
      setTokens(data.tokens);
      setMode(data.auth?.mode ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load API keys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => () => {
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
  }, []);

  const copyInto = async (value: string, kind: 'endpoint' | 'token') => {
    const ok = await copyText(value);
    if (!ok) {
      setActionError('Copy failed. Select the value and copy it manually.');
      return;
    }
    setActionError('');
    setCopied(kind);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(null), 2000);
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nameError = validateMcpTokenName(name);
    if (nameError) {
      setActionError(nameError);
      return;
    }
    setCreating(true);
    setActionError('');
    try {
      const result = await createMcpToken({ name: name.trim(), expiresInDays: expiryInDays(expiry) });
      const record: McpToken = {
        id: result.id,
        name: result.name,
        scopes: result.scopes,
        created_at: result.created_at,
        expires_at: result.expires_at,
        last_used_at: result.last_used_at,
        revoked_at: result.revoked_at,
      };
      setCreated({ token: result.token, record });
      setTokens((previous) => (previous ? [record, ...previous] : [record]));
      setName('');
      setExpiry(90);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create the key.');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setActionError('');
    try {
      await revokeMcpToken(id);
      const revokedAt = Date.now();
      setTokens((previous) => previous?.map((token) => (
        token.id === id ? { ...token, revoked_at: revokedAt } : token
      )) ?? previous);
      setConfirmId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not revoke the key.');
    } finally {
      setRevokingId(null);
    }
  };

  const endpoint = `${window.location.origin}/mcp`;
  const listed = tokens ?? [];
  const modeNote = mode ? MODE_NOTES[mode] : null;

  return (
    <div className="mcp-panel">
      <section className="mcp-section">
        <div className="mcp-section-head">
          <h3 className="mcp-section-title">MCP access</h3>
          <p className="mcp-section-copy">
            AI agents can read this dashboard's ranked data over the Model Context Protocol. Keys are
            read-only, scoped to <code>mcp:read</code>, stored as SHA-256 hashes, and can be revoked at
            any time.
          </p>
        </div>

        {modeNote && <p className={`mcp-auth-note is-${modeNote.tone}`}>{modeNote.text}</p>}

        <div className="mcp-endpoint-row">
          <div className="mcp-endpoint-copy">
            <span className="mcp-label">Endpoint</span>
            <code className="mcp-endpoint">{endpoint}</code>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copyInto(endpoint, 'endpoint')}>
            {copied === 'endpoint' ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </section>

      {actionError && <p className="mcp-error" role="alert">{actionError}</p>}

      {created && (
        <section className="mcp-token-reveal" aria-live="polite">
          <div className="mcp-section-head">
            <h3 className="mcp-reveal-title">Copy this key now</h3>
            <p className="mcp-section-copy">
              It is shown once and cannot be recovered. Store it in the agent's secret configuration
              before switching tabs or closing Settings; leaving this screen hides it permanently.
            </p>
          </div>
          <code className="mcp-token-code">{created.token}</code>
          <div className="mcp-reveal-actions">
            <Button type="button" size="sm" onClick={() => void copyInto(created.token, 'token')}>
              {copied === 'token' ? 'Copied' : 'Copy key'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>Done</Button>
          </div>
        </section>
      )}

      <section className="mcp-section" aria-busy={loading || undefined}>
        <div className="mcp-section-heading-row">
          <h3 className="mcp-section-title">Keys</h3>
          <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {tokens === null && loading && <p className="mcp-muted">Loading keys…</p>}

        {loadError && (
          <div className="mcp-load-error" role="alert">
            <p className="mcp-error">{loadError}</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>Try again</Button>
          </div>
        )}

        {tokens !== null && !loadError && listed.length === 0 && (
          <p className="mcp-empty">No API keys yet. Create one below and paste it into the agent's MCP configuration.</p>
        )}

        {tokens !== null && !loadError && listed.length > 0 && (
          <ul className="mcp-key-list">
            {listed.map((token) => {
              const status = mcpTokenStatus(token);
              const confirming = confirmId === token.id;
              return (
                <li key={token.id} className="mcp-key-row">
                  <div className="mcp-key-head">
                    <strong className="mcp-key-name">{token.name}</strong>
                    <span className={`mcp-key-status is-${status}`}>{mcpTokenStatusLabel(status)}</span>
                  </div>
                  <p className="mcp-key-meta">
                    <span className="mcp-key-id">…{mcpTokenIdHint(token.id)}</span>
                    <span>{token.scopes.join(' ')}</span>
                    <span>{describeMcpExpiry(token)}</span>
                    <span>{describeMcpLastUsed(token)}</span>
                  </p>
                  {status === 'active' && (
                    confirming ? (
                      <div className="mcp-key-confirm" role="group" aria-label={`Revoke ${token.name}`}>
                        <span>Revoke this key? Agents using it lose access immediately.</span>
                        <div className="mcp-key-confirm-actions">
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            disabled={revokingId === token.id}
                            onClick={() => void handleRevoke(token.id)}
                          >
                            {revokingId === token.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                          <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <Button type="button" variant="ghost" size="xs" className="mcp-key-revoke" onClick={() => setConfirmId(token.id)}>
                        Revoke
                      </Button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!created && (
        <section className="mcp-section">
          <div className="mcp-section-head">
            <h3 className="mcp-section-title">Create a key</h3>
            <p className="mcp-section-copy">Name it for the device or agent that will use it, so a single credential can be retired alone.</p>
          </div>
          <form className="mcp-create-form" onSubmit={(event) => void handleCreate(event)}>
            <div className="mcp-field">
              <Label htmlFor="mcp-key-name" className="mcp-field-label">Name</Label>
              <Input
                id="mcp-key-name"
                value={name}
                maxLength={60}
                autoComplete="off"
                placeholder="Laptop agent"
                onChange={(event) => setName(event.target.value)}
                aria-invalid={Boolean(name) && validateMcpTokenName(name) !== null}
              />
            </div>
            <div className="mcp-field">
              <Label htmlFor="mcp-key-expiry" className="mcp-field-label">Expiry</Label>
              <select
                id="mcp-key-expiry"
                className="mcp-select"
                value={String(expiry)}
                onChange={(event) => setExpiry(parseExpiryChoice(event.target.value))}
              >
                {MCP_EXPIRY_OPTIONS.map((option) => (
                  <option key={option.label} value={String(option.value)}>{option.label}</option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm" className="mcp-create-button" disabled={creating}>
              {creating ? 'Creating…' : 'Create key'}
            </Button>
          </form>
          <p className="mcp-note">
            Only the SHA-256 hash is stored. Revocation is immediate. Prefer an expiry for anything
            automated; use one key per agent.
          </p>
        </section>
      )}
    </div>
  );
}
