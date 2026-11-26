import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Spec 4.6: "the probe is the gate". The CI assertion parses the spec 5.5 permission table
 * (the single source of truth) and checks every place that encodes the same fact:
 *   1. docs/permissions-action-manifest.json (generated from HAND_AUTHORED) has exactly the
 *      50 bastion.* ids with the table's is_read / destructive / confirm flags;
 *   2. the builtin-group-defaults migration's member exclusion list is exactly the floored
 *      rows and its viewer list exactly the rows marked `viewer`;
 *   3. (DB-backed, skips without DATABASE_URL) the applied permission_group_defaults grant
 *      every action to exactly the roles the table says, per action, not only per count.
 */

const ROOT = join(__dirname, '../../..');
const SPEC = join(ROOT, 'docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md');
const MANIFEST = join(ROOT, 'docs/permissions-action-manifest.json');
const MIGRATIONS = join(ROOT, 'infra/postgres/migrations');

interface SpecRow {
  id: string;
  is_read: boolean;
  floored: boolean;
  viewer: boolean;
  destructive: boolean;
  confirm: boolean;
}

function specRows(): SpecRow[] {
  const text = readFileSync(SPEC, 'utf8');
  const start = text.indexOf('### 5.5 Permissions');
  const end = text.indexOf('**Group grants:**', start);
  return text
    .slice(start, end)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('| `bastion.'))
    .map((l) => {
      const c = l.split('|').slice(1, -1).map((x) => x.trim());
      return {
        id: c[0]!.replace(/`/g, ''),
        is_read: c[1] === 'yes',
        floored: c[2] === 'yes',
        viewer: c[3] === 'yes',
        destructive: c[4] === 'yes',
        confirm: c[5] === 'yes',
      };
    });
}

/** Expected grant per builtin role, from the spec 5.5 "Group grants" rule. */
function expectedGrant(row: SpecRow, role: string): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'member') return !row.floored;
  if (role === 'viewer') return row.viewer;
  return false;
}

const ROWS = specRows();

describe('Bastion permission catalog matches spec 5.5', () => {
  it('the table has 50 actions; owner = admin = 50, member = 25, viewer = 10, guest = 0', () => {
    expect(ROWS).toHaveLength(50);
    const count = (role: string) => ROWS.filter((r) => expectedGrant(r, role)).length;
    expect([count('owner'), count('admin'), count('member'), count('viewer'), count('guest')]).toEqual([
      50, 50, 25, 10, 0,
    ]);
  });

  it('the manifest carries exactly those ids with the table flags', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      permissions: Array<{
        id: string;
        app: string;
        is_read: boolean;
        is_destructive: boolean;
        requires_confirmation: boolean;
        requires_superuser: boolean;
      }>;
    };
    const bastion = manifest.permissions.filter((p) => p.id.startsWith('bastion.'));
    expect(bastion.map((p) => p.id).sort()).toEqual(ROWS.map((r) => r.id).sort());
    for (const row of ROWS) {
      const p = bastion.find((x) => x.id === row.id)!;
      expect(
        { app: p.app, is_read: p.is_read, destructive: p.is_destructive, confirm: p.requires_confirmation, su: p.requires_superuser },
        row.id,
      ).toEqual({ app: 'bastion', is_read: row.is_read, destructive: row.destructive, confirm: row.confirm, su: false });
    }
  });

  it('the builtin-group-defaults migration lists exactly the floored and viewer rows', () => {
    const file = readdirSync(MIGRATIONS).find((f) => /^\d{4}_bastion_builtin_group_defaults\.sql$/.test(f));
    expect(file, 'bastion builtin group defaults migration').toBeDefined();
    const sql = readFileSync(join(MIGRATIONS, file!), 'utf8');
    const listAfter = (marker: string): string[] => {
      const at = sql.indexOf(marker);
      const open = sql.indexOf('(', at);
      const close = sql.indexOf(')', open);
      return [...sql.slice(open, close).matchAll(/'(bastion\.[a-z_.]+)'/g)].map((m) => m[1]!).sort();
    };
    expect(listAfter("WHEN 'member'")).toEqual(ROWS.filter((r) => r.floored).map((r) => r.id).sort());
    expect(listAfter("WHEN 'viewer'")).toEqual(ROWS.filter((r) => r.viewer).map((r) => r.id).sort());
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bastion-api/permission-catalog] SKIPPING the DB half: DATABASE_URL is not set, so the applied ' +
      'builtin group defaults cannot be compared with spec 5.5.',
  );
}

describe.skipIf(!DATABASE_URL)('applied builtin group defaults match spec 5.5 per action', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('every builtin role holds exactly the bastion.* actions the table grants it', async () => {
    const rows = await sql<Array<{ role: string; id: string; granted: boolean }>>`
      SELECT pg.legacy_role AS role, p.id, d.granted
        FROM permission_group_defaults d
        JOIN permissions p ON p.id = d.permission_id
        JOIN permission_groups pg ON pg.id = d.group_id
       WHERE p.app = 'bastion' AND pg.is_builtin AND pg.legacy_role IS NOT NULL`;
    const mismatches: string[] = [];
    for (const role of ['owner', 'admin', 'member', 'viewer', 'guest']) {
      for (const row of ROWS) {
        const actual = rows.find((r) => r.role === role && r.id === row.id)?.granted ?? false;
        if (actual !== expectedGrant(row, role)) mismatches.push(`${role} ${row.id}: ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
