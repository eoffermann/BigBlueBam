import { describe, it, expect, vi, beforeAll } from 'vitest';
import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// #325: helpdesk-api verifies a Bam API key sent as Bearer with the same rules
// as apps/api (prefix lookup, Argon2id, expiry with rotation grace, active user).

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const TOKEN = 'bbam_abcDEF123_secret_part';
const rows: Array<Record<string, unknown>> = [];
const dialect = new PgDialect();
const executed: string[] = [];

vi.mock('../src/db/index.js', () => ({
  db: {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      executed.push(sql);
      if (sql.includes('FROM api_keys')) return rows.filter((r) => r.key_prefix === params[0]);
      if (sql.startsWith('UPDATE api_keys')) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
  },
}));

import { bamBearerToken, verifyBamApiKey } from '../src/lib/bam-api-key.js';

const req = { log: { warn: vi.fn() }, headers: {} } as never;
let hash = '';

function key(overrides: Record<string, unknown> = {}) {
  return {
    id: 'k1',
    key_prefix: TOKEN.slice(0, 8),
    key_hash: hash,
    org_id: ORG_A,
    scope: 'admin',
    expires_at: null,
    rotated_at: null,
    rotation_grace_expires_at: null,
    user_id: 'u1',
    is_active: true,
    is_superuser: false,
    ...overrides,
  };
}

describe('verifyBamApiKey', () => {
  beforeAll(async () => {
    hash = await argon2.hash(TOKEN, { type: argon2.argon2id });
  });

  it('extracts only bbam_ Bearer tokens', () => {
    expect(bamBearerToken({ headers: { authorization: `Bearer ${TOKEN}` } } as never)).toBe(TOKEN);
    expect(bamBearerToken({ headers: { authorization: 'Bearer some.jwt.value' } } as never)).toBeNull();
    expect(bamBearerToken({ headers: {} } as never)).toBeNull();
  });

  it('accepts a valid key and returns its pinned org and scope', async () => {
    rows.splice(0, rows.length, key());
    expect(await verifyBamApiKey(req, TOKEN)).toEqual({ userId: 'u1', keyOrgId: ORG_A, scope: 'admin', isSuperuser: false });
  });

  it('rejects a wrong secret with the right prefix', async () => {
    rows.splice(0, rows.length, key());
    expect(await verifyBamApiKey(req, `${TOKEN}x`)).toBeNull();
  });

  it('rejects an expired key, but honors the rotation grace window', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    rows.splice(0, rows.length, key({ expires_at: past }));
    expect(await verifyBamApiKey(req, TOKEN)).toBeNull();
    rows.splice(0, rows.length, key({ expires_at: past, rotated_at: past, rotation_grace_expires_at: future }));
    expect(await verifyBamApiKey(req, TOKEN)).not.toBeNull();
  });

  it("rejects an inactive user's key", async () => {
    rows.splice(0, rows.length, key({ is_active: false }));
    expect(await verifyBamApiKey(req, TOKEN)).toBeNull();
  });
});
