import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMcpExpiry,
  describeMcpLastUsed,
  expiryInDays,
  formatMcpDate,
  mcpTokenIdHint,
  mcpTokenStatus,
  mcpTokenStatusLabel,
  parseExpiryChoice,
  validateMcpTokenName,
} from '../apps/web/src/lib/mcp-tokens.ts';

const token = (overrides = {}) => ({
  id: '53b47a1d-63f9-4988-89a3-001f567cc174',
  name: 'laptop',
  scopes: ['mcp:read'],
  created_at: Date.UTC(2026, 8, 21, 12),
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  ...overrides,
});

test('a key is active until it expires, and revoked always wins', () => {
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(mcpTokenStatus(token({ expires_at: now + 1 }), now), 'active');
  assert.equal(mcpTokenStatus(token({ expires_at: now }), now), 'expired');
  assert.equal(mcpTokenStatus(token({ expires_at: now + 1, revoked_at: now - 1 }), now), 'revoked');
  assert.equal(mcpTokenStatus(token({ revoked_at: now - 1, expires_at: now - 1 }), now), 'revoked');
  assert.equal(mcpTokenStatusLabel('active'), 'Active');
  assert.equal(mcpTokenStatusLabel('expired'), 'Expired');
  assert.equal(mcpTokenStatusLabel('revoked'), 'Revoked');
});

test('the id hint never shows the whole identifier', () => {
  const id = token().id;
  assert.equal(mcpTokenIdHint(id), '53b47a1d');
  assert.equal(mcpTokenIdHint(id).length, 8);
  assert.equal(mcpTokenIdHint(id).includes('-'), false);
});

test('name validation mirrors the server rule', () => {
  assert.match(validateMcpTokenName(''), /name/i);
  assert.match(validateMcpTokenName('   '), /name/i);
  assert.equal(validateMcpTokenName(' laptop '), null);
  assert.equal(validateMcpTokenName('x'.repeat(60)), null);
  assert.match(validateMcpTokenName('x'.repeat(61)), /60/);
  assert.match(validateMcpTokenName('bad\nname'), /characters/);
});

test('expiry choices map to the API field, including no expiry', () => {
  assert.equal(expiryInDays(30), 30);
  assert.equal(expiryInDays(365), 365);
  assert.equal(expiryInDays('never'), null);
  assert.equal(parseExpiryChoice('30'), 30);
  assert.equal(parseExpiryChoice('365'), 365);
  assert.equal(parseExpiryChoice('never'), 'never');
  assert.equal(parseExpiryChoice('nonsense'), 90);
});

test('dates render in campus time, not the device timezone', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo';
    // 2026-01-02T03:00Z is still Jan 1 in Toronto.
    assert.equal(formatMcpDate(Date.UTC(2026, 0, 2, 3, 0)), 'Jan 1, 2026');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('expiry and last-used copy is explicit about absence and the past', () => {
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(describeMcpExpiry(token(), now), 'No expiry');
  assert.equal(describeMcpExpiry(token({ expires_at: Date.UTC(2026, 11, 1, 12) }), now), 'Expires Dec 1, 2026');
  assert.equal(describeMcpExpiry(token({ expires_at: Date.UTC(2026, 8, 1, 12) }), now), 'Expired Sep 1, 2026');
  assert.equal(describeMcpLastUsed(token()), 'Never used');
  assert.equal(describeMcpLastUsed(token({ last_used_at: Date.UTC(2026, 9, 20, 12) })), 'Last used Oct 20, 2026');
});
