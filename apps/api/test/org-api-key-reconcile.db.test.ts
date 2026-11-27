import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

// #336 defense in depth: demoting a user below admin downgrades their
// admin-scope keys for that org, and removing them from the org deletes
// their keys for it. Service accounts keep their owner-delegated scope.
// Runs where DATABASE_URL points at a migrated database.

vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));

const { setUserOrgRole, clearUserOrgRole } = await import('../src/services/role-resolver.js');

const DB_URL = process.env.DATABASE_URL;
const run = DB_URL && !DB_URL.includes('test:test@localhost:5432/test') ? describe : describe.skip;

run('API keys follow org role changes (real Postgres)', () => {
  const sql = postgres(DB_URL ?? 'postgres://x@localhost/x', { max: 2, onnotice: () => {} });
  // The service's DbLike is the app's schema-bound db; this schema-less instance runs the same SQL.
  const database = drizzle(sql) as unknown as typeof import('../src/db/index.js').db;
  const tag = `${Date.now()}`;
  let org = '';
  let other = '';
  let alice = '';
  let svc = '';

  const scopes = async (userId: string, orgId: string) =>
    (await sql`SELECT scope FROM api_keys WHERE user_id = ${userId} AND org_id = ${orgId} ORDER BY name`).map(
      (r) => r.scope as string,
    );
  const addKey = (userId: string, orgId: string, name: string, scope: string) =>
    sql`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
        VALUES (${userId}, ${orgId}, ${name}, '!', ${`p${name}`.slice(0, 8)}, ${scope})`;

  beforeAll(async () => {
    [{ id: org }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Key reconcile', ${`keyrec-${tag}`}) RETURNING id`;
    [{ id: other }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Key reconcile other', ${`keyrec-o-${tag}`}) RETURNING id`;
    [{ id: alice }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                                VALUES (${org}, ${`alice-${tag}@keyrec.test`}, 'Alice', '!', 'human') RETURNING id`;
    [{ id: svc }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                              VALUES (${org}, ${`svc-${tag}@keyrec.test`}, 'Bot', '!', 'service') RETURNING id`;
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${alice}, ${org}), (${alice}, ${other}), (${svc}, ${org})`;
    await setUserOrgRole(alice, org, 'owner', {}, database);
    await setUserOrgRole(alice, other, 'owner', {}, database);
    await addKey(alice, org, 'a-admin', 'admin');
    await addKey(alice, org, 'b-rw', 'read_write');
    await addKey(alice, other, 'c-admin-other', 'admin');
    await addKey(svc, org, 'd-svc', 'admin');
  });

  afterAll(async () => {
    await sql`DELETE FROM api_keys WHERE user_id IN (${alice}, ${svc})`;
    await sql`DELETE FROM account_group_memberships WHERE user_id IN (${alice}, ${svc})`;
    await sql`DELETE FROM organization_memberships WHERE org_id IN (${org}, ${other})`;
    await sql`DELETE FROM users WHERE id IN (${alice}, ${svc})`;
    await sql`DELETE FROM organizations WHERE id IN (${org}, ${other})`;
    await sql.end();
  });

  it('keeps admin keys while the holder stays admin or owner', async () => {
    await setUserOrgRole(alice, org, 'admin', {}, database);
    expect(await scopes(alice, org)).toEqual(['admin', 'read_write']);
  });

  it('downgrades admin-scope keys in that org only when the holder is demoted to member', async () => {
    await setUserOrgRole(alice, org, 'member', {}, database);
    expect(await scopes(alice, org)).toEqual(['read_write', 'read_write']);
    expect(await scopes(alice, other)).toEqual(['admin']);
  });

  it('leaves a service account admin key alone (role member by design)', async () => {
    await setUserOrgRole(svc, org, 'member', {}, database);
    expect(await scopes(svc, org)).toEqual(['admin']);
  });

  it('deletes the holder keys for the org when the org role is cleared', async () => {
    await clearUserOrgRole(alice, org, database);
    expect(await scopes(alice, org)).toEqual([]);
    expect(await scopes(alice, other)).toEqual(['admin']);
  });
});
