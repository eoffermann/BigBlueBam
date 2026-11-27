import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';

/**
 * Issue #246 (BRG-1): GET /key-results/export?goal_id=<another org's goal> used to
 * export that org's key results, because listKeyResults had no org predicate.
 * Runs the real service against a migrated database. SKIPS LOUDLY without
 * DATABASE_URL.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bearing-api/key-results-org-scope] SKIPPING: DATABASE_URL is not set. Point it at a ' +
      'migrated database to exercise the cross-tenant key-result export check.',
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

describe.skipIf(!DATABASE_URL)('bearing key results are org-scoped (#246)', () => {
  let sql: postgres.Sql;
  let goalB: string;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL ?? '', { max: 2 });
    await sql`INSERT INTO organizations (id, name, slug) VALUES
              (${ORG_A}, 'KR Org A', ${`kr-a-${run}`}),
              (${ORG_B}, 'KR Org B', ${`kr-b-${run}`})`;
    const [{ id: userB }] = await sql<[{ id: string }]>`INSERT INTO users (org_id, email, display_name, password_hash)
              VALUES (${ORG_B}, ${`krb-${run}@kr.test`}, 'B', 'x') RETURNING id`;
    const [{ id: periodB }] = await sql<[{ id: string }]>`INSERT INTO bearing_periods
              (organization_id, name, period_type, starts_at, ends_at, created_by)
              VALUES (${ORG_B}, 'Q4', 'quarter', '2026-10-01', '2026-12-31', ${userB}) RETURNING id`;
    [{ id: goalB }] = await sql`INSERT INTO bearing_goals (organization_id, period_id, title, owner_id, created_by)
              VALUES (${ORG_B}, ${periodB}, 'Org B secret goal', ${userB}, ${userB}) RETURNING id`;
    await sql`INSERT INTO bearing_key_results (goal_id, title, target_value) VALUES
              (${goalB}, 'Org B secret KR 1', 10), (${goalB}, 'Org B secret KR 2', 20)`;
    const { connection } = await import('../../src/db/index.js');
    closeDb = () => connection.end();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM bearing_goals WHERE organization_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM bearing_periods WHERE organization_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM users WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
    await sql.end();
    await closeDb?.();
  });

  it("another org's goal id yields no key results", async () => {
    const { listKeyResults } = await import('../../src/services/key-result.service.js');
    const { data } = await listKeyResults(goalB, ORG_A);
    expect(data).toEqual([]);
  });

  it("the owning org still gets its goal's key results", async () => {
    const { listKeyResults } = await import('../../src/services/key-result.service.js');
    const { data } = await listKeyResults(goalB, ORG_B);
    expect(data.map((kr) => kr.title).sort()).toEqual(['Org B secret KR 1', 'Org B secret KR 2']);
    expect(data.every((kr) => kr.goal_id === goalB)).toBe(true);
  });
});
