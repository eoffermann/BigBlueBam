// Shared harness for the DB-backed M4 gate tests: a real Postgres, the real engine code, an
// in-memory bucket (it survives a simulated database restore, exactly like the real one), and a
// movable clock. Nothing here imports env.ts.

import { Readable } from 'node:stream';
import postgres from 'postgres';
import type { ObjectStat, StorageDriver } from '@bigbluebam/storage';
import type { EngineDeps, EngineLog } from '../../src/engine/context.js';
import { makeRunInOrgScopeRead } from '../../src/engine/read-scope.js';
import type { SealCacheEntry } from '../../src/engine/restore.js';
import { createHmac } from 'node:crypto';
import { canonicalJson, sealSignerFromSeed, sha256Hex } from '../../src/lib/ledger-canonical.js';

export const DATABASE_URL = process.env.DATABASE_URL;

export interface FakeBucket extends StorageDriver {
  objects: Map<string, { body: Buffer; contentType: string; modifiedAt: Date }>;
  failPuts: boolean;
}

export function fakeBucket(): FakeBucket {
  const objects = new Map<string, { body: Buffer; contentType: string; modifiedAt: Date }>();
  const bucket: FakeBucket = {
    kind: 's3',
    capabilities: {} as never,
    objects,
    failPuts: false,
    async healthCheck() {
      return { ok: true, latencyMs: 0 };
    },
    async put(key, body, opts) {
      if (bucket.failPuts) throw new Error('bucket unavailable (test)');
      let buf: Buffer;
      if (Buffer.isBuffer(body)) buf = body;
      else {
        const chunks: Buffer[] = [];
        for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
        buf = Buffer.concat(chunks);
      }
      objects.set(key, { body: buf, contentType: opts?.contentType ?? 'application/octet-stream', modifiedAt: new Date() });
      return { key, size: buf.length, integrity: sha256Hex(buf) };
    },
    async getStream(key) {
      const o = objects.get(key);
      if (!o) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
      return { stream: Readable.from([o.body]), contentType: o.contentType, size: o.body.length };
    },
    async stat(key) {
      const o = objects.get(key);
      return o ? ({ key, size: o.body.length, integrity: sha256Hex(o.body), modifiedAt: o.modifiedAt } as ObjectStat) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return {
        objects: [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, o]) => ({ key, size: o.body.length, integrity: sha256Hex(o.body), modifiedAt: o.modifiedAt })),
      };
    },
  };
  return bucket;
}

export const quietLog: EngineLog & { lines: string[] } = {
  lines: [],
  info(_o, m) {
    if (m) quietLog.lines.push(m);
  },
  warn(_o, m) {
    if (m) quietLog.lines.push(m);
  },
  error(_o, m) {
    if (m) quietLog.lines.push(m);
  },
};

export interface Clock {
  offsetMs: number;
  now: () => Date;
}

export function clock(): Clock {
  const c: Clock = { offsetMs: 0, now: () => new Date(Date.now() + c.offsetMs) };
  return c;
}

export function makeDeps(
  sql: postgres.Sql,
  opts: { bucket?: StorageDriver | null; clock?: Clock; readSql?: postgres.Sql; sealCache?: Map<string, SealCacheEntry>; leaseMs?: number } = {},
): EngineDeps {
  const cursors = new Map<string, string>();
  const c = opts.clock ?? clock();
  const signer = sealSignerFromSeed('5'.repeat(64));
  return {
    sql,
    runRead: makeRunInOrgScopeRead({ primary: sql, read: opts.readSql ?? sql, statementTimeoutMs: 8000 }),
    storage: opts.bucket === undefined ? fakeBucket() : opts.bucket,
    log: quietLog,
    now: c.now,
    signer,
    sealKeys: new Map([[signer.keyId, signer.publicKeyHex]]),
    pdKeyId: 'pd:test',
    pdHmac: (data: unknown) => createHmac('sha256', Buffer.from('7'.repeat(64), 'hex')).update(canonicalJson(data)).digest('hex'),
    probeTimeoutMs: 8000,
    putTimeoutMs: 2000,
    leaseMs: opts.leaseMs ?? 300_000,
    cursors: { get: async (k) => cursors.get(k) ?? null, set: async (k, v) => void cursors.set(k, v) },
    sealCache: opts.sealCache ?? new Map(),
  };
}

export interface SeededOrg {
  org: string;
  owner: string;
  framework: string;
  controls: string[];
  assertions: string[];
}

/**
 * One org with an owner, an active framework, and `controls` controls each with `perControl`
 * confirmed keys.* probe assertions and an applicable requirement link. Evaluation slot 00:00 UTC
 * so a nightly run is always due.
 */
export async function seedOrg(sql: postgres.Sql, tag: string, controls = 1, perControl = 1): Promise<SeededOrg> {
  const [o] = await sql`INSERT INTO organizations (name, slug) VALUES (${`Bastion M4 ${tag}`}, ${`bastion-m4-${tag}-${Date.now()}`}) RETURNING id`;
  const org = o!.id as string;
  const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                        VALUES (${org}, ${`m4-${tag}-${Date.now()}@bigbluebam.internal`}, 'M4 Owner', '!', 'human') RETURNING id`;
  const owner = u!.id as string;
  await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${owner}, ${org})`;
  await sql`INSERT INTO bastion_org_settings (organization_id, timezone, evaluation_hour_local, evaluation_minute_offset)
            VALUES (${org}, 'UTC', 0, 0)`;
  const [f] = await sql`INSERT INTO bastion_frameworks (organization_id, template_key, template_version, name, status, adopted_at)
                        VALUES (${org}, 'soc2', '2017', 'SOC 2', 'active', now()) RETURNING id`;
  const framework = f!.id as string;
  const controlIds: string[] = [];
  const assertionIds: string[] = [];
  const probes = ['keys.max_age', 'keys.unused_active', 'access.departed_still_holding', 'logging.audit_trail_alive'];
  for (let i = 0; i < controls; i++) {
    const [c] = await sql`INSERT INTO bastion_controls (organization_id, control_key, title, owner_user_id)
                          VALUES (${org}, ${`m4.control.${i}`}, ${`M4 control ${i}`}, ${owner}) RETURNING id`;
    const controlId = c!.id as string;
    controlIds.push(controlId);
    await sql`INSERT INTO bastion_control_requirements (organization_id, control_id, framework_id, ref_code, requirement_title, applicability)
              VALUES (${org}, ${controlId}, ${framework}, ${`CC${i}.1`}, 'Requirement', 'applicable')`;
    for (let j = 0; j < perControl; j++) {
      const probe = probes[(i + j) % probes.length]!;
      const [a] = await sql`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate,
                                        plain_statement, proposed_by, review_status, confirmed_by, confirmed_at)
        VALUES (${org}, ${controlId}, 'probe', ${probe}, 1, '{}'::jsonb, '{}'::jsonb, ${`check ${probe}`}, 'library', 'confirmed', ${owner}, now())
        RETURNING id`;
      assertionIds.push(a!.id as string);
    }
  }
  return { org, owner, framework, controls: controlIds, assertions: assertionIds };
}

/**
 * Remove a test org. The Bastion tables are immutable on purpose (DELETE raises), so cleanup runs
 * with session_replication_role = replica, which disables triggers AND the FK cascades; every
 * bastion_ table is therefore cleared explicitly before the org itself.
 */
export async function wipeOrg(sql: postgres.Sql, org: string): Promise<void> {
  await sql.begin(async (raw) => {
    const tx = raw as unknown as postgres.Sql;
    await tx`SET LOCAL session_replication_role = replica`;
    const tables = await tx`SELECT table_name FROM information_schema.columns
                             WHERE table_schema = 'public' AND table_name LIKE 'bastion\\_%' AND column_name = 'organization_id'`;
    for (const t of tables) await tx.unsafe(`DELETE FROM "${t.table_name as string}" WHERE organization_id = $1`, [org]);
    await tx`DELETE FROM api_keys WHERE org_id = ${org}`;
    await tx`DELETE FROM sessions WHERE active_org_id = ${org}`;
    await tx`DELETE FROM organization_memberships WHERE org_id = ${org}`;
    await tx`DELETE FROM users WHERE org_id = ${org}`;
    await tx`DELETE FROM organizations WHERE id = ${org}`;
  });
}

/**
 * Simulate restoring an older database dump for one org's ledger: every ledger entry, snapshot,
 * seal and outbox row written after `keepSeq` disappears (as it would in a dump taken then).
 * Triggers are bypassed exactly as a pg_restore into a fresh database bypasses them.
 */
export async function rewindLedger(sql: postgres.Sql, org: string, keepSeq: number, keepSealDates: string[]): Promise<void> {
  await sql.begin(async (raw) => {
    const tx = raw as unknown as postgres.Sql;
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM bastion_evidence_snapshots WHERE organization_id = ${org} AND ledger_seq > ${keepSeq}`;
    await tx`DELETE FROM bastion_ledger_entries WHERE organization_id = ${org} AND seq > ${keepSeq}`;
    await tx`DELETE FROM bastion_ledger_seals WHERE organization_id = ${org} AND NOT (seal_date::text = ANY (${keepSealDates}))`;
    await tx`DELETE FROM bastion_ledger_restores WHERE organization_id = ${org}`;
  });
}
