import { describe, it, expect, vi, beforeAll } from 'vitest';
import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { apiKeyLookup } from '@bigbluebam/auth-core';

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
      // The shared @bigbluebam/auth-core key queries (migration 0345, #353): the lookup-id match
      // and the legacy prefix bucket, each joined to users; plus adopting a lookup id.
      if (sql.includes('auth_adopt_api_key_lookup(')) {
        const row = rows.find((r) => r.id === params[0] && !r.key_lookup);
        if (row) row.key_lookup = params[1];
        return [];
      }
      const byLookup = sql.includes('FROM auth_api_key_by_lookup(');
      if (byLookup || sql.includes('FROM auth_api_key_legacy_candidates(')) {
        return rows
          .filter((r) => (byLookup ? r.key_lookup === params[0] : r.key_prefix === params[0] && !r.key_lookup))
          .map((r) => ({
            ...r,
            owner_org_id: r.org_id,
            owner_email: 'skipper@gilligantravel.example',
            owner_display_name: 'Skipper',
            owner_avatar_url: null,
            owner_timezone: 'UTC',
            owner_is_active: r.is_active,
            owner_is_superuser: r.is_superuser,
            owner_kind: r.kind ?? 'human',
          }));
      }
      if (sql.includes('auth_touch_api_key(')) return [];
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
    expect(await verifyBamApiKey(req, TOKEN)).toEqual({
      userId: 'u1',
      keyOrgId: ORG_A,
      scope: 'admin',
      isSuperuser: false,
      kind: 'human',
    });
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

  // #343: a rotated predecessor with no expires_at must stop at the end of its grace window.
  it('rejects a rotated key with no expires_at after its grace window', async () => {
    const longAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    rows.splice(0, rows.length, key({ expires_at: null, rotated_at: longAgo, rotation_grace_expires_at: past }));
    expect(await verifyBamApiKey(req, TOKEN)).toBeNull();
  });

  it("rejects an inactive user's key", async () => {
    rows.splice(0, rows.length, key({ is_active: false }));
    expect(await verifyBamApiKey(req, TOKEN)).toBeNull();
  });

  // #353: a legacy key gains its lookup id on first use, then is found by it.
  it('records a lookup id on a legacy key and then finds the key by it', async () => {
    rows.splice(0, rows.length, key());
    expect(await verifyBamApiKey(req, TOKEN)).not.toBeNull();
    expect(rows[0]?.key_lookup).toBe(apiKeyLookup(TOKEN));
    executed.length = 0;
    expect(await verifyBamApiKey(req, TOKEN)).not.toBeNull();
    expect(executed.some((q) => q.includes('auth_api_key_legacy_candidates('))).toBe(false);
  });

  // #352: helpdesk has no Bam project context, so a project-restricted key does not authenticate.
  it('refuses a project-restricted key and accepts an empty restriction', async () => {
    rows.splice(0, rows.length, key({ project_ids: ['11111111-1111-4111-8111-111111111111'] }));
    expect(await verifyBamApiKey(req, TOKEN)).toBeNull();
    rows.splice(0, rows.length, key({ project_ids: [] }));
    expect(await verifyBamApiKey(req, TOKEN)).not.toBeNull();
  });
});
