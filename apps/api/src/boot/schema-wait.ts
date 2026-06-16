import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from '../db/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The set of migration ids bundled in this build that are NOT yet recorded in
 * `schema_migrations`. Pure, so it's unit-testable. ids are filenames minus the
 * `.sql` suffix (matching how the migrate runner records them).
 */
export function pendingMigrations(expectedFiles: string[], applied: Set<string>): string[] {
  return expectedFiles
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .filter((id) => !applied.has(id))
    .sort();
}

/**
 * Boot-time schema-readiness gate.
 *
 * On Railway there is no docker-compose `depends_on: service_completed_successfully`
 * gate, so the `api` service can start serving BEFORE the one-shot `migrate`
 * service has applied the latest migrations — a window where new code queries a
 * column/table that doesn't exist yet (PostgresError 42703) until migrate
 * finishes and it self-heals. Those errors are *expected* but noisy; we'd
 * rather prevent them than ignore them.
 *
 * Block here until `schema_migrations` contains every migration bundled in this
 * image. The api image COPYs `infra/postgres/migrations` -> `./migrations` (the
 * same files the migrate service runs), so the bundled set is exactly this
 * build's expected schema. During a rolling deploy the new instance stays
 * un-listening (and thus un-healthy) until the schema catches up, so Railway
 * keeps routing to the old instance (old code + old schema, which match) — zero
 * error window.
 *
 * No-ops where it can't determine the expected set (no migrations dir — some
 * dev/test contexts) and in local docker-compose where migrate already ran
 * first via `depends_on` (the gate finds nothing pending and returns at once).
 *
 *   - BBB_SCHEMA_WAIT_DISABLED=1  → skip the gate entirely (escape hatch).
 *   - BBB_SCHEMA_WAIT_SECONDS     → timeout (default 90). On timeout it logs
 *     loudly and proceeds rather than deadlocking the service on a genuinely
 *     stuck migrate.
 */
export async function waitForSchemaReady(logger: Logger): Promise<void> {
  if (process.env.BBB_SCHEMA_WAIT_DISABLED === '1') {
    logger.warn('schema-wait: disabled via BBB_SCHEMA_WAIT_DISABLED');
    return;
  }

  const dir = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'migrations');
  if (!existsSync(dir)) {
    logger.warn(
      { dir },
      'schema-wait: migrations dir not found; skipping readiness gate (dev/test?)',
    );
    return;
  }

  const expectedFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  if (expectedFiles.length === 0) return;
  const tip = pendingMigrations(expectedFiles, new Set()).at(-1);

  const timeoutMs =
    Math.max(1, Number(process.env.BBB_SCHEMA_WAIT_SECONDS ?? 90)) * 1000;
  const start = Date.now();
  let pollMs = 500;
  let waited = false;

  for (;;) {
    let applied = new Set<string>();
    try {
      const rows = (await db.execute(
        sql`SELECT id FROM schema_migrations`,
      )) as unknown as Array<{ id: string }>;
      applied = new Set(rows.map((r) => r.id));
    } catch {
      // schema_migrations may not exist yet on a brand-new DB — keep waiting.
    }

    const pending = pendingMigrations(expectedFiles, applied);
    if (pending.length === 0) {
      if (waited) {
        logger.info({ tip, waited_ms: Date.now() - start }, 'schema-wait: schema is current');
      }
      return;
    }

    if (Date.now() - start > timeoutMs) {
      logger.error(
        {
          tip,
          pending_count: pending.length,
          pending: pending.slice(0, 5),
          waited_seconds: Math.round((Date.now() - start) / 1000),
        },
        'schema-wait: timed out waiting for migrate; starting anyway — DB is behind, expect transient 42703s until migrate completes',
      );
      return;
    }

    waited = true;
    logger.warn(
      { tip, pending_count: pending.length, next_pending: pending[0] },
      'schema-wait: waiting for the migrate service to apply pending migrations…',
    );
    await sleep(pollMs);
    pollMs = Math.min(Math.round(pollMs * 1.5), 3000);
  }
}
