import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';
import { mirrorObjects, restoreObjectsFromBackup } from '../../src/engine/objects.js';
import { sha256Hex } from '../../src/lib/ledger-canonical.js';
import { DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * The off-site mirror against REAL object storage (spec 9.7, M9 gate "tested locally against a
 * second MinIO bucket"): the Bastion bucket and the off-site bucket are two buckets on a
 * throwaway MinIO. Runs only with BASTION_MINIO_TEST_ENDPOINT (+ _ACCESS_KEY, _SECRET_KEY) and
 * DATABASE_URL (a throwaway database: it inserts a platform_backups row).
 */

const ENDPOINT = process.env.BASTION_MINIO_TEST_ENDPOINT;
const run = !!(DATABASE_URL && ENDPOINT);
if (!run) console.warn('[bastion-api/m9-minio] SKIPPING: set DATABASE_URL and BASTION_MINIO_TEST_ENDPOINT to run against real MinIO.');

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

describe.skipIf(!run)('M9 off-site mirror on real MinIO buckets', () => {
  let sql: postgres.Sql;
  let org = '';
  let backupId = '';
  const driver = (bucket: string): StorageDriver =>
    createBootstrapDriver({
      S3_ENDPOINT: ENDPOINT!,
      S3_REGION: 'us-east-1',
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: process.env.BASTION_MINIO_TEST_ACCESS_KEY ?? 'm9test',
      S3_SECRET_KEY: process.env.BASTION_MINIO_TEST_SECRET_KEY ?? 'm9testsecret123',
    });

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    if (org) await wipeOrg(sql, org);
    if (backupId) await sql`DELETE FROM platform_backups WHERE id = ${backupId}`;
    await sql.end();
  });

  it('copies evidence and seals to the second bucket, records completed, and restore-objects copies them back', async () => {
    const stamp = Date.now();
    const bastion = driver(`m9-bastion-${stamp}`);
    const offsite = driver(`m9-offsite-${stamp}`);
    const s = await seedOrg(sql, 'm9minio', 1, 1);
    org = s.org;
    const engine = makeDeps(sql, { bucket: bastion });
    const body = Buffer.from(JSON.stringify({ evidence: 'two-step report', at: stamp }));
    const key = `evidence/${org}/${sha256Hex(body)}.json`;
    await bastion.put(key, body, { contentType: 'application/json', size: body.length });
    await bastion.put(`seals/${org}/2026-11-25.json`, Buffer.from('{"seal":true}'), { contentType: 'application/json' });
    await sql`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count, created_at)
              VALUES (${org}, ${sha256Hex(body)}, ${key}, ${body.length}, 1, now() - interval '2 hours')`;
    const [b] = await sql`INSERT INTO platform_backups (kind, status, started_at, completed_at) VALUES ('manual', 'completed', now(), now()) RETURNING id`;
    backupId = b!.id as string;

    let res = await mirrorObjects(engine, offsite, { backup_id: backupId });
    for (let i = 0; !res.complete && i < 10; i++) res = await mirrorObjects(engine, offsite, { backup_id: backupId });
    expect(res.status).toBe('completed');
    expect((await offsite.stat(key))?.size).toBe(body.length);
    expect(await offsite.stat(`seals/${org}/2026-11-25.json`)).not.toBeNull();
    expect((await sql`SELECT status, bastion_mirror_status FROM platform_backups WHERE id = ${backupId}`)[0]).toEqual({ status: 'completed', bastion_mirror_status: 'completed' });

    // A destination with wrong credentials: the pass fails, the backup stays completed.
    const wrong = createBootstrapDriver({ S3_ENDPOINT: ENDPOINT!, S3_REGION: 'us-east-1', S3_BUCKET: `m9-offsite-${stamp}`, S3_ACCESS_KEY: 'nobody', S3_SECRET_KEY: 'wrongwrong' });
    await sql`UPDATE bastion_evidence_objects SET mirrored_at = NULL WHERE organization_id = ${org}`;
    const failed = await mirrorObjects(engine, wrong, { backup_id: backupId });
    expect(failed.status).toBe('failed');
    expect((await sql`SELECT status, bastion_mirror_status FROM platform_backups WHERE id = ${backupId}`)[0]).toEqual({ status: 'completed', bastion_mirror_status: 'failed' });

    // The Bastion bucket loses the object; restore-objects --from-backup puts it back.
    await bastion.delete(key);
    const lines: string[] = [];
    const restored = await restoreObjectsFromBackup(offsite, bastion, (l) => lines.push(l));
    expect(restored.failed).toBe(0);
    expect(restored.copied).toBeGreaterThanOrEqual(1);
    const back = await bastion.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of back.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe(body.toString());
    expect(lines.at(-1)).toMatch(/^objects \d+\/\d+/);
  });
});
