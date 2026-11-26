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
      { slug: SLUG, title: 'Victim article', body_markdown: 'org B secret body' },
      userB,
      ORG_B,
    );
    victimId = victim.data.id;
    const { connection } = await import('../../src/db/index.js');
    closeDb = () => connection.end();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM beacon_versions WHERE beacon_id IN
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
      { slug: SLUG, title: 'Attacker title', body_markdown: 'attacker body' },
      userA,
      ORG_A,
    );
    expect(first.created).toBe(true);
    expect(first.data.organization_id).toBe(ORG_A);
    expect(first.data.id).not.toBe(victimId);
    expect(first.data.body_markdown).toBe('attacker body');

    // A second call updates the caller's own row, still not the victim's.
    const second = await upsertEntryBySlug(
      { slug: SLUG, title: 'Attacker title v2', body_markdown: 'attacker body v2' },
      userA,
      ORG_A,
    );
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
});
