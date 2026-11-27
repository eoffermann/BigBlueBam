import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';

/**
 * Issue #246 (BCN-1): Beacon slugs are unique per org, and every slug lookup is
 * org-scoped. Runs the real upsert service and the real lookup helper against a
 * migrated database. SKIPS LOUDLY without DATABASE_URL.
 *
 * Fails without the fix: on the old global unique key the second org's upsert
 * either overwrote the first org's row (old code on a global-key DB) or 500'd on the
 * ON CONFLICT (slug) target (old code on a per-org-key DB).
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[beacon-api/slug-org-scope] SKIPPING: DATABASE_URL is not set. Point it at a migrated ' +
      'database to exercise the cross-tenant slug checks.',
  );
}

vi.mock('../../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unset:unset@localhost:1/unset',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    LOG_LEVEL: 'silent',
  },
}));

const run = crypto.randomBytes(4).toString('hex');
const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();
const SLUG = `shared-slug-${run}`;

describe.skipIf(!DATABASE_URL)('beacon slugs are per-org (#246)', () => {
  let sql: postgres.Sql;
  let userA: string;
  let userB: string;
  let victimId: string;
  let closeDb: () => Promise<void>;
  const actorA = () => ({ id: userA, org_id: ORG_A, role: 'member', is_superuser: false });
  const actorB = () => ({ id: userB, org_id: ORG_B, role: 'member', is_superuser: false });

  beforeAll(async () => {
    sql = postgres(DATABASE_URL ?? '', { max: 2 });
    await sql`INSERT INTO organizations (id, name, slug) VALUES
              (${ORG_A}, 'Slug Org A', ${`slug-a-${run}`}),
              (${ORG_B}, 'Slug Org B', ${`slug-b-${run}`})`;
    [{ id: userA }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash)
              VALUES (${ORG_A}, ${`a-${run}@slug.test`}, 'A', 'x') RETURNING id`;
    [{ id: userB }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash)
              VALUES (${ORG_B}, ${`b-${run}@slug.test`}, 'B', 'x') RETURNING id`;

    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');
    const victim = await upsertEntryBySlug(
      { slug: SLUG, title: 'Victim article', body_markdown: 'org B secret body' }, actorB());
    victimId = victim.data.id;
    const { connection } = await import('../../src/db/index.js');
    closeDb = () => connection.end();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM beacon_versions WHERE beacon_id IN
              (SELECT id FROM beacon_entries WHERE organization_id IN (${ORG_A}, ${ORG_B}))`;
    await sql`DELETE FROM beacon_verifications WHERE beacon_id IN
              (SELECT id FROM beacon_entries WHERE organization_id IN (${ORG_A}, ${ORG_B}))`;
    await sql`DELETE FROM beacon_entries WHERE organization_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM users WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
    await sql.end();
    await closeDb?.();
  });

  it('cross-tenant upsert-by-slug creates a row in the caller org and never touches the other org', async () => {
    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');

    const first = await upsertEntryBySlug(
      { slug: SLUG, title: 'Attacker title', body_markdown: 'attacker body' }, actorA());
    expect(first.created).toBe(true);
    expect(first.data.organization_id).toBe(ORG_A);
    expect(first.data.id).not.toBe(victimId);
    expect(first.data.body_markdown).toBe('attacker body');

    // A second call updates the caller's own row, still not the victim's.
    const second = await upsertEntryBySlug(
      { slug: SLUG, title: 'Attacker title v2', body_markdown: 'attacker body v2' }, actorA());
    expect(second.created).toBe(false);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.version).toBe(2);

    const [victim] = await sql`SELECT organization_id, title, body_markdown, version
                               FROM beacon_entries WHERE id = ${victimId}`;
    expect(victim).toMatchObject({
      organization_id: ORG_B,
      title: 'Victim article',
      body_markdown: 'org B secret body',
      version: 1,
    });
  });

  it('two orgs can hold the same slug, and a second row with the same slug in one org is rejected', async () => {
    const rows = await sql`SELECT organization_id FROM beacon_entries WHERE slug = ${SLUG} ORDER BY organization_id`;
    expect(rows.map((r) => r.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());

    await expect(
      sql`INSERT INTO beacon_entries (slug, title, body_markdown, created_by, owned_by, organization_id, expires_at)
          VALUES (${SLUG}, 'dup', 'dup', ${userA}, ${userA}, ${ORG_A}, now() + interval '30 days')`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('slug lookups resolve within the caller org (getBeacon and the shared lookup helper)', async () => {
    const { getBeacon } = await import('../../src/services/beacon.service.js');
    const ownA = await getBeacon(SLUG, userA, ORG_A);
    expect(ownA?.organization_id).toBe(ORG_A);
    const ownB = await getBeacon(SLUG, userB, ORG_B);
    expect(ownB?.id).toBe(victimId);

    const { db } = await import('../../src/db/index.js');
    const { beaconEntries } = await import('../../src/db/schema/index.js');
    const { beaconRefLookup } = await import('../../src/lib/beacon-ref.js');

    // Non-SuperUser in org A: only org A's row matches, whatever the physical order.
    const lookupA = beaconRefLookup(SLUG, ORG_A, false);
    const matchesA = await db.select({ org: beaconEntries.organization_id }).from(beaconEntries).where(lookupA.where);
    expect(matchesA.map((r) => r.org)).toEqual([ORG_A]);

    // SuperUser in org A: may see both, but their own org's row comes first.
    const lookupSu = beaconRefLookup(SLUG, ORG_A, true);
    const [first] = await db
      .select({ org: beaconEntries.organization_id })
      .from(beaconEntries)
      .where(lookupSu.where)
      .orderBy(lookupSu.orderBy)
      .limit(1);
    expect(first?.org).toBe(ORG_A);
  });

  // #280: the upsert and beacon_update run in one transaction with the version bumped under the
  // row lock, so parallel writers neither 500 nor drop content, and history stays contiguous.
  const versionsOf = async (id: string) =>
    (await sql`SELECT version, body_markdown FROM beacon_versions WHERE beacon_id = ${id} ORDER BY version`).map((r) => ({
      version: Number(r.version),
      body: String(r.body_markdown),
    }));

  it('two parallel upserts creating the same slug: one creates, the other is applied as v2, no throw', async () => {
    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');
    const slug = `race-create-${run}`;
    const results = await Promise.all([
      upsertEntryBySlug({ slug, title: 'one', body_markdown: 'body one' }, actorA()),
      upsertEntryBySlug({ slug, title: 'two', body_markdown: 'body two' }, actorA()),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const id = results[0]!.data.id;
    expect(results[1]!.data.id).toBe(id);
    const [row] = await sql`SELECT version, body_markdown FROM beacon_entries WHERE id = ${id}`;
    expect(Number(row!.version)).toBe(2);
    const history = await versionsOf(id);
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    // The loser's content was applied (the old ON CONFLICT dropped it), and the live row is v2.
    expect(new Set(history.map((v) => v.body))).toEqual(new Set(['body one', 'body two']));
    expect(row!.body_markdown).toBe(history[1]!.body);
  });

  it('two parallel upserts updating an existing slug write contiguous versions, no throw', async () => {
    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');
    const slug = `race-update-${run}`;
    const created = await upsertEntryBySlug({ slug, title: 'base', body_markdown: 'base body' }, actorA());
    await Promise.all([
      upsertEntryBySlug({ slug, title: 'x', body_markdown: 'body x' }, actorA()),
      upsertEntryBySlug({ slug, title: 'y', body_markdown: 'body y' }, actorA()),
    ]);
    const history = await versionsOf(created.data.id);
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    const [row] = await sql`SELECT version, body_markdown FROM beacon_entries WHERE id = ${created.data.id}`;
    expect(Number(row!.version)).toBe(3);
    expect(row!.body_markdown).toBe(history[2]!.body);
  });

  it('two parallel beacon_update calls write contiguous versions whose snapshots match the row', async () => {
    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');
    const { updateBeacon } = await import('../../src/services/beacon.service.js');
    const slug = `race-edit-${run}`;
    const created = await upsertEntryBySlug({ slug, title: 'edit base', body_markdown: 'edit base' }, actorA());
    await Promise.all([
      updateBeacon(created.data.id, { body_markdown: 'edit p' }, userA, ORG_A),
      updateBeacon(created.data.id, { title: 'edit q title' }, userA, ORG_A),
    ]);
    const history = await versionsOf(created.data.id);
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    const [row] = await sql`SELECT version, title, body_markdown FROM beacon_entries WHERE id = ${created.data.id}`;
    expect(Number(row!.version)).toBe(3);
    // Both edits survive (title from q, body from p), and the v3 snapshot equals the live row.
    expect(row).toMatchObject({ title: 'edit q title', body_markdown: 'edit p' });
    expect(history[2]!.body).toBe('edit p');
  });

  // #299: the slug upsert applies the same edit rule as PUT /beacons/:id. Fails without the fix:
  // the member's upsert rewrote the row, flipped it to Organization and appended a version.
  it("a member upserting another user's Private or Organization slug changes nothing (#299)", async () => {
    const { upsertEntryBySlug } = await import('../../src/services/entry-upsert.service.js');
    const [{ id: userC }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash)
              VALUES (${ORG_A}, ${`c-${run}@slug.test`}, 'C', 'x') RETURNING id`;
    const mallory = { id: String(userC), org_id: ORG_A, role: 'member', is_superuser: false };

    const privSlug = `private-plan-${run}`;
    const priv = await upsertEntryBySlug(
      { slug: privSlug, title: 'Private plan', body_markdown: 'alice secret', visibility: 'Private' }, actorA());
    await expect(
      upsertEntryBySlug(
        { slug: privSlug, title: 'x', body_markdown: 'x', visibility: 'Organization' }, mallory),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SLUG_UNAVAILABLE' });

    const orgSlug = `org-policy-${run}`;
    const pol = await upsertEntryBySlug(
      { slug: orgSlug, title: 'Policy', body_markdown: 'policy body', visibility: 'Organization' }, actorA());
    await expect(
      upsertEntryBySlug({ slug: orgSlug, title: 'x', body_markdown: 'x' }, mallory),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    for (const [entry, body, visibility] of [
      [priv, 'alice secret', 'Private'],
      [pol, 'policy body', 'Organization'],
    ] as const) {
      const [row] = await sql`SELECT version, visibility, body_markdown FROM beacon_entries WHERE id = ${entry.data.id}`;
      expect(row).toMatchObject({ version: 1, visibility, body_markdown: body });
      expect((await versionsOf(entry.data.id)).map((v) => v.version)).toEqual([1]);
    }
  });

  // #304: createBeacon claims its slug with ON CONFLICT (organization_id, slug) DO NOTHING inside
  // the same transaction as the v1 snapshot. Fails without the fix: both creates probed the clean
  // slug as free and the second 500'd on beacon_entries_org_slug_key.
  it('two parallel creates with the same title both succeed, each with exactly one v1 (#304)', async () => {
    const { createBeacon } = await import('../../src/services/beacon.service.js');
    const title = `Same Title ${run}`;
    const results = await Promise.all([
      createBeacon({ title, body_markdown: 'one' }, userA, ORG_A),
      createBeacon({ title, body_markdown: 'two' }, userA, ORG_A),
    ]);
    expect(new Set(results.map((r) => r.slug)).size).toBe(2);
    expect(results.map((r) => r.slug)).toContain(`same-title-${run}`);
    for (const r of results) {
      expect((await versionsOf(r.id)).map((v) => v.version)).toEqual([1]);
    }
  });

  // #304: verification_count is bumped in SQL under the row lock. Fails without the fix: both
  // verifies read N and wrote N + 1.
  it('two parallel verifies both count (#304)', async () => {
    const { createBeacon } = await import('../../src/services/beacon.service.js');
    const { verifyBeacon } = await import('../../src/services/verification.service.js');
    const b = await createBeacon({ title: `Verify race ${run}`, body_markdown: 'v' }, userA, ORG_A);
    await sql`UPDATE beacon_entries SET status = 'Active' WHERE id = ${b.id}`;
    await Promise.all([
      verifyBeacon(b.id, userA, { type: 'Manual', outcome: 'Updated' }, ORG_A),
      verifyBeacon(b.id, userA, { type: 'Manual', outcome: 'Updated' }, ORG_A),
    ]);
    const [row] = await sql`SELECT verification_count FROM beacon_entries WHERE id = ${b.id}`;
    expect(Number(row!.verification_count)).toBe(2);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM beacon_verifications WHERE beacon_id = ${b.id}`;
    expect(n).toBe(2);
  });

  // #304: a transition validates against the status as of its row lock and its UPDATE is
  // predicated on that status. Fails without the fix: both Active -> PendingReview calls passed
  // assertTransition on a stale Active read and both "succeeded".
  it('two parallel identical transitions: exactly one wins, the other gets 409 (#304)', async () => {
    const { createBeacon } = await import('../../src/services/beacon.service.js');
    const { transitionBeacon } = await import('../../src/services/lifecycle.service.js');
    const b = await createBeacon({ title: `Transition race ${run}`, body_markdown: 't' }, userA, ORG_A);
    await sql`UPDATE beacon_entries SET status = 'Active' WHERE id = ${b.id}`;
    const settled = await Promise.allSettled([
      transitionBeacon(b.id, 'PendingReview', userA, undefined, ORG_A),
      transitionBeacon(b.id, 'PendingReview', userA, undefined, ORG_A),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
    const [row] = await sql`SELECT status FROM beacon_entries WHERE id = ${b.id}`;
    expect(row!.status).toBe('PendingReview');
  });
});
