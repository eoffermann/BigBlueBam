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

// #342: an agent's admin scope is vouched for by the org admin who created it. When that
// creator is demoted or removed, the agent's admin keys in that org drop to read_write.
run('Service/agent keys follow their creator (real Postgres)', () => {
  const sql = postgres(DB_URL ?? 'postgres://x@localhost/x', { max: 2, onnotice: () => {} });
  const database = drizzle(sql) as unknown as typeof import('../src/db/index.js').db;
  const tag = `${Date.now()}d`;
  let org = '';
  let other = '';
  let skipper = '';
  let professor = '';
  let su = '';
  let bot = '';
  let agent = '';
  let suBot = '';
  let botOther = '';

  const scopeOf = async (userId: string, orgId: string) =>
    (await sql`SELECT scope FROM api_keys WHERE user_id = ${userId} AND org_id = ${orgId}`).map((r) => r.scope as string);
  const addKey = (userId: string, orgId: string, name: string) =>
    sql`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
        VALUES (${userId}, ${orgId}, ${name}, '!', ${`q${name}`.slice(0, 8)}, 'admin')`;
  const addUser = async (email: string, kind: string, createdBy: string | null, isSuperuser = false) => {
    const [row] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind, created_by, is_superuser)
      VALUES (${org}, ${`${email}-${tag}@keyrec.test`}, ${email}, '!', ${kind}, ${createdBy}, ${isSuperuser}) RETURNING id`;
    return row!.id as string;
  };

  beforeAll(async () => {
    [{ id: org }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Gilligan Travel delegated', ${`deleg-${tag}`}) RETURNING id`;
    [{ id: other }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Howell Holdings delegated', ${`deleg-o-${tag}`}) RETURNING id`;
    skipper = await addUser('skipper', 'human', null);
    professor = await addUser('professor', 'human', null);
    su = await addUser('superuser', 'human', null, true);
    bot = await addUser('coconut-bot', 'service', skipper);
    agent = await addUser('rescue-agent', 'agent', skipper);
    suBot = await addUser('su-bot', 'service', su);
    botOther = await addUser('luau-bot', 'service', skipper);
    for (const u of [skipper, professor, su, bot, agent, suBot]) {
      await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${u}, ${org})`;
    }
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${skipper}, ${other}), (${botOther}, ${other})`;
    await setUserOrgRole(skipper, org, 'owner', {}, database);
    await setUserOrgRole(skipper, other, 'owner', {}, database);
    await setUserOrgRole(professor, org, 'owner', {}, database);
    await setUserOrgRole(su, org, 'owner', {}, database);
    for (const u of [bot, agent, suBot]) await setUserOrgRole(u, org, 'member', {}, database);
    await setUserOrgRole(botOther, other, 'member', {}, database);
    await addKey(bot, org, 'bot');
    await addKey(agent, org, 'agent');
    await addKey(suBot, org, 'subot');
    await addKey(botOther, other, 'botother');
  });

  afterAll(async () => {
    const ids = [skipper, professor, su, bot, agent, suBot, botOther];
    await sql`DELETE FROM api_keys WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM account_group_memberships WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM organization_memberships WHERE org_id IN (${org}, ${other})`;
    await sql`UPDATE users SET created_by = NULL WHERE id = ANY(${ids})`;
    await sql`DELETE FROM users WHERE id = ANY(${ids})`;
    await sql`DELETE FROM organizations WHERE id IN (${org}, ${other})`;
    await sql.end();
  });

  it("keeps the agents' admin keys while their creator stays an org admin", async () => {
    await setUserOrgRole(skipper, org, 'admin', {}, database);
    expect(await scopeOf(bot, org)).toEqual(['admin']);
    expect(await scopeOf(agent, org)).toEqual(['admin']);
  });

  it('downgrades the service and agent accounts the creator made when the creator is demoted', async () => {
    await setUserOrgRole(skipper, org, 'member', {}, database);
    expect(await scopeOf(bot, org)).toEqual(['read_write']);
    expect(await scopeOf(agent, org)).toEqual(['read_write']);
    // Other creators' agents and the creator's agents in other orgs are untouched.
    expect(await scopeOf(suBot, org)).toEqual(['admin']);
    expect(await scopeOf(botOther, other)).toEqual(['admin']);
  });

  it("downgrades the creator's agents in an org the creator is removed from", async () => {
    await clearUserOrgRole(skipper, other, database);
    expect(await scopeOf(botOther, other)).toEqual(['read_write']);
  });

  it('keeps vouching when the creator is a SuperUser', async () => {
    await setUserOrgRole(su, org, 'member', {}, database);
    expect(await scopeOf(suBot, org)).toEqual(['admin']);
  });
});
