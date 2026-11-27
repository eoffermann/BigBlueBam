import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';

/**
 * Issue #246 (BNC-1): executeWidgetQuery / refreshWidgetQuery called getWidget
 * without the caller's org, so any user could run any org's widget by id, and
 * the widget result cache key had no org segment. Runs the real services
 * against a migrated database. SKIPS LOUDLY without DATABASE_URL.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bench-api/widget-org-scope] SKIPPING: DATABASE_URL is not set. Point it at a migrated ' +
      'database to exercise the cross-tenant widget checks.',
  );
}

vi.mock('../../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unset:unset@localhost:1/unset',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    LOG_LEVEL: 'silent',
    QUERY_TIMEOUT_MS: 10000,
    CACHE_TTL_SECONDS: 60,
  },
}));

const run = crypto.randomBytes(4).toString('hex');
const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();

/** Minimal in-memory stand-in for the ioredis calls CacheService makes. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    setex: async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (store.delete(k)) n++;
      return n;
    },
  };
}

describe.skipIf(!DATABASE_URL)('bench widgets are org-scoped (#246)', () => {
  let sql: postgres.Sql;
  let widgetB: string;
  let redis: ReturnType<typeof fakeRedis>;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL ?? '', { max: 2 });
    await sql`INSERT INTO organizations (id, name, slug) VALUES
              (${ORG_A}, 'Widget Org A', ${`w-a-${run}`}),
              (${ORG_B}, 'Widget Org B', ${`w-b-${run}`})`;
    const [userRow] = await sql`INSERT INTO users (org_id, email, display_name, password_hash)
              VALUES (${ORG_B}, ${`wb-${run}@w.test`}, 'B', 'x') RETURNING id`;
    const userB = userRow!.id;
    const [dashRow] = await sql`INSERT INTO bench_dashboards (organization_id, name, created_by)
              VALUES (${ORG_B}, 'Org B dashboard', ${userB}) RETURNING id`;
    const dashB = dashRow!.id;
    [{ id: widgetB }] = await sql`INSERT INTO bench_widgets
              (dashboard_id, name, widget_type, data_source, entity, query_config)
              VALUES (${dashB}, 'Org B widget', 'kpi_card', 'bam', 'tasks',
                      ${sql.json({ measures: [{ field: 'id', agg: 'count', alias: 'n' }] })})
              RETURNING id`;

    redis = fakeRedis();
    const { CacheService } = await import('../../src/services/cache.service.js');
    const widgetService = await import('../../src/services/widget.service.js');
    widgetService.setCacheService(new CacheService(redis as never));
    const { connection } = await import('../../src/db/index.js');
    closeDb = () => connection.end();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM bench_dashboards WHERE organization_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM users WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await sql`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
    await sql.end();
    await closeDb?.();
  });

  it("getWidget / executeWidgetQuery / refreshWidgetQuery 404 on another org's widget id", async () => {
    const svc = await import('../../src/services/widget.service.js');
    await expect(svc.getWidget(widgetB, ORG_A)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.executeWidgetQuery(widgetB, ORG_A)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.refreshWidgetQuery(widgetB, ORG_A)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.updateWidget(widgetB, { name: 'pwned' }, ORG_A)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.deleteWidget(widgetB, ORG_A)).rejects.toMatchObject({ statusCode: 404 });

    const [row] = await sql`SELECT name FROM bench_widgets WHERE id = ${widgetB}`;
    expect(row?.name).toBe('Org B widget');
  });

  it("another org cannot read the owner's cached widget result", async () => {
    // Owner's cached result lives under an org-namespaced key.
    redis.store.set(`bench:query:${ORG_B}:${widgetB}`, JSON.stringify({ rows: [{ n: 42 }] }));
    // The pre-fix shared slot must not be consulted by anyone.
    redis.store.set(`bench:query:${widgetB}`, JSON.stringify({ rows: [{ n: 666 }] }));

    const svc = await import('../../src/services/widget.service.js');
    await expect(svc.executeWidgetQuery(widgetB, ORG_A)).rejects.toMatchObject({ statusCode: 404 });

    const own = (await svc.executeWidgetQuery(widgetB, ORG_B)) as { rows: Array<{ n: number }>; cached?: boolean };
    expect(own.cached).toBe(true);
    expect(own.rows[0]?.n).toBe(42);
  });
});
