// SQL migration runner.
//
// Reads every file from MIGRATIONS_DIR in lexicographic order, applies any
// that have not yet been recorded in `schema_migrations`, and records their
// SHA-256 checksum. If a previously-applied migration's checksum has changed
// the runner aborts loudly; migrations must be append-only and immutable.
//
// NOTE: the checksum is computed over the SQL *body*: the leading block of
// `--` comment lines and blank lines is stripped before hashing. This lets
// maintainers edit the documented header (`-- Why:` / `-- Client impact:`)
// without invalidating the fingerprint. Any change to executable SQL still
// trips the mismatch guard. See `bodyChecksum()` below.
//
// Migration files are expected to be idempotent (IF NOT EXISTS, ADD COLUMN
// IF NOT EXISTS, etc.) so that re-running against a DB in an unknown state
// is safe. Each file is applied inside a single transaction; any error
// aborts that file and halts the runner.
//
// Intended to run as a one-shot container (docker-compose `migrate` service)
// that must complete successfully before api/helpdesk-api/banter-api/worker
// start. Running it against an already-up-to-date DB is a no-op.

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'migrations');

interface MigrationFile {
  id: string; // filename without .sql (e.g. "0001_baseline")
  filename: string;
  sql: string;
  checksum: string;
  // One-time migration aid: checksum of the full file (including the
  // header comment block). Older DBs recorded this form. If a stored
  // checksum matches `legacyChecksum` we re-stamp it to the new body
  // checksum in place rather than aborting.
  legacyChecksum: string;
}

interface AppliedRow {
  id: string;
  checksum: string;
  applied_at: Date;
}

// Compute the checksum over the SQL *body* only, i.e. strip the leading
// comment-only header (blank lines and lines starting with `--`) before
// hashing. This lets us edit/amend migration header blocks (the
// documented `-- Why:` / `-- Client impact:` fields, etc.) without
// triggering a checksum mismatch on already-applied migrations. Only the
// executable SQL is fingerprinted; changing any non-comment character
// will still abort the runner as intended.
function bodyChecksum(sql: string): string {
  const lines = sql.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('--')) {
      i++;
      continue;
    }
    break;
  }
  const body = lines.slice(i).join('\n');
  return createHash('sha256').update(body).digest('hex');
}

function loadMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    throw new Error(
      `Migrations directory does not exist: ${dir}\nSet MIGRATIONS_DIR or bundle the migrations/ folder into the image.`,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((filename) => {
    const fullPath = join(dir, filename);
    const sql = readFileSync(fullPath, 'utf8');
    const checksum = bodyChecksum(sql);
    const legacyChecksum = createHash('sha256').update(sql).digest('hex');
    return {
      id: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum,
      legacyChecksum,
    };
  });
}

async function ensureTrackingTable(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(sql: postgres.Sql): Promise<Map<string, AppliedRow>> {
  const rows = await sql<AppliedRow[]>`SELECT id, checksum, applied_at FROM schema_migrations`;
  const byId = new Map<string, AppliedRow>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

async function applyMigration(sql: postgres.Sql, migration: MigrationFile): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(migration.sql);
    await tx`
      INSERT INTO schema_migrations (id, checksum)
      VALUES (${migration.id}, ${migration.checksum})
      ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()
    `;
  });
}

// Bootstrap hook: guarantee that at least one superuser exists as early as
// possible in the migration sequence. Migration 0023_beacon_tables.sql seeds a
// system-scope row in `beacon_expiry_policies` whose `set_by` column is a
// NOT NULL FK to users(id) resolved via
//   (SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1)
// On a fresh database there is no superuser yet, the subquery returns NULL,
// and the migration aborts. The runner then halts and no further migration
// can run, so the fix has to live outside the migration files themselves
// (editing 0023 would invalidate its checksum on every existing deployment).
//
// This hook runs after every migration. As soon as the `users` table and the
// `is_superuser` column are both present, it seeds a sentinel organization
// and a locked, non-login superuser that subsequent migrations can reference.
// It is fully idempotent: pre-0000 it is a no-op, post-bootstrap it short
// circuits on the superuser existence check.
const BOOTSTRAP_ORG_ID = '00000000-0000-0000-0000-000000000003';
const BOOTSTRAP_USER_ID = '00000000-0000-0000-0000-000000000004';
const BOOTSTRAP_USER_EMAIL = 'system-bootstrap@bigbluebam.internal';

async function ensureSuperuserSentinel(sql: postgres.Sql): Promise<void> {
  // Guard 1: does the `users` table exist yet?
  const usersTable = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'users'
    ) AS exists
  `;
  if (!usersTable[0]?.exists) return;

  // Guard 2: does the `is_superuser` column exist yet? (Added in 0000 in
  // current history, but guarded anyway so the hook is safe against future
  // reshuffles.)
  const superuserCol = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users'
        AND column_name = 'is_superuser'
    ) AS exists
  `;
  if (!superuserCol[0]?.exists) return;

  // Guard 3: does a superuser already exist? If so nothing to do.
  const existing = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM users WHERE is_superuser = true
  `;
  if (existing[0] && Number(existing[0].count) > 0) {
    return;
  }

  // Also guard the `organizations` table, since users.org_id is NOT NULL FK.
  const orgsTable = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'organizations'
    ) AS exists
  `;
  if (!orgsTable[0]?.exists) return;

  // Seed the sentinel org + superuser inside one transaction. Both rows use
  // fixed UUIDs so re-runs are harmless. The password_hash is the literal
  // '!' string, which Argon2id cannot verify, so the account is unloginable.
  // Role is left at the `users_role_check` default-friendly 'owner' value so
  // the row satisfies the role CHECK constraint.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO organizations (id, name, slug, plan, settings)
      VALUES (
        ${BOOTSTRAP_ORG_ID}::uuid,
        'BigBlueBam Bootstrap',
        '__bbb_bootstrap__',
        'free',
        '{"internal": true, "hidden": true}'::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // Insert by id first, then fall back to a by-email insert in case a
    // prior environment already owns the sentinel email with a different id.
    await tx`
      INSERT INTO users (
        id, org_id, email, display_name, password_hash, role,
        is_active, is_superuser
      )
      VALUES (
        ${BOOTSTRAP_USER_ID}::uuid,
        ${BOOTSTRAP_ORG_ID}::uuid,
        ${BOOTSTRAP_USER_EMAIL},
        'BigBlueBam System',
        '!',
        'owner',
        true,
        true
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO users (
        id, org_id, email, display_name, password_hash, role,
        is_active, is_superuser
      )
      VALUES (
        ${BOOTSTRAP_USER_ID}::uuid,
        ${BOOTSTRAP_ORG_ID}::uuid,
        ${BOOTSTRAP_USER_EMAIL},
        'BigBlueBam System',
        '!',
        'owner',
        true,
        true
      )
      ON CONFLICT (email) DO NOTHING
    `;
  });

  console.log(
    '[migrate] bootstrap: seeded sentinel superuser (system-bootstrap@bigbluebam.internal) to satisfy downstream FK seeds',
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log(`[migrate] migrations dir: ${MIGRATIONS_DIR}`);
  const migrations = loadMigrations(MIGRATIONS_DIR);
  console.log(`[migrate] found ${migrations.length} migration file(s)`);

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await ensureTrackingTable(sql);
    const applied = await getApplied(sql);

    let appliedCount = 0;
    let skippedCount = 0;

    for (const m of migrations) {
      const prior = applied.get(m.id);
      if (prior) {
        if (prior.checksum !== m.checksum) {
          // The recorded checksum may also be a legacy full-file hash
          // (from before body-only hashing was introduced). If it matches
          // the current full-file hash, the SQL body is unchanged; quiet
          // re-stamp. Otherwise, allow an opt-in rescue via env var for
          // the one-time header-addition rollout.
          if (prior.checksum === m.legacyChecksum) {
            console.log(
              `[migrate] re-stamping ${m.filename} (legacy full-file checksum → body-only)`,
            );
            await sql`
              UPDATE schema_migrations
              SET checksum = ${m.checksum}
              WHERE id = ${m.id}
            `;
            skippedCount++;
            continue;
          }
          if (process.env.MIGRATE_ALLOW_HEADER_RESTAMP === '1') {
            console.warn(
              `[migrate] MIGRATE_ALLOW_HEADER_RESTAMP=1 → re-stamping ${m.filename} (caller asserts SQL body unchanged; only header comments edited)`,
            );
            await sql`
              UPDATE schema_migrations
              SET checksum = ${m.checksum}
              WHERE id = ${m.id}
            `;
            skippedCount++;
            continue;
          }
          throw new Error(
            `[migrate] CHECKSUM MISMATCH on ${m.filename}\n  recorded: ${prior.checksum}\n  current:  ${m.checksum}\n  Migrations are immutable (SQL body only; header comments are not hashed).\n  If you only edited the header comment block and the SQL body is\n  unchanged, rerun once with MIGRATE_ALLOW_HEADER_RESTAMP=1.\n  Otherwise: create a new migration file to amend.`,
          );
        }
        skippedCount++;
        continue;
      }
      // Ensure a sentinel superuser exists before we apply the next file.
      // See `ensureSuperuserSentinel` for the rationale; on a fresh DB this
      // is what unblocks 0023_beacon_tables from the NOT NULL `set_by` FK.
      await ensureSuperuserSentinel(sql);
      console.log(`[migrate] applying ${m.filename}`);
      await applyMigration(sql, m);
      appliedCount++;
    }

    console.log(`[migrate] done: ${appliedCount} applied, ${skippedCount} already up-to-date`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
