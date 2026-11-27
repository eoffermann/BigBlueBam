import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DelayedError, type Job } from 'bullmq';
import JSZip from 'jszip';
import type { StorageDriver } from '@bigbluebam/storage';
import type { BastionPacketContents } from '@bigbluebam/shared';
import { processBastionObjectBackupJob } from '../jobs/bastion-object-backup.job.js';
import {
  createBastionPacketStorage,
  MAX_HELD_DEFERRALS,
  processBastionExportPacketJob,
  renderSummaryPdf,
} from '../jobs/bastion-export-packet.job.js';

// M9 worker jobs (Bastion spec 7, 7.2, 9.7): the off-site mirror after each backup, the audit
// packet, and the backup job's enqueue (a failing mirror or enqueue never fails the backup).

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const job = <T>(data: T, id = 'j1') => ({ id, data }) as unknown as Job<T>;
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });

const mirrorResult = (over: Record<string, unknown> = {}) => ({
  status: 'completed',
  mirrored: 3,
  bytes: 300,
  failed: 0,
  removed_redacted: 0,
  seals_and_records: 1,
  remaining: 0,
  cursor: null,
  complete: true,
  error: null,
  ...over,
});

describe('bastion-object-backup', () => {
  const BACKUP = '00000000-0000-4000-8000-0000000b0001';

  it('calls mirror-objects with the backup id until it reports complete', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(ok(mirrorResult({ status: 'running', complete: false, remaining: 10 })))
      .mockResolvedValueOnce(ok(mirrorResult()));
    const recordMirrorFailure = vi.fn();
    const r = await processBastionObjectBackupJob(job({ backup_id: BACKUP }), silent, { post, recordMirrorFailure });
    expect(r?.status).toBe('completed');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe('/v1/internal/engines/mirror-objects');
    expect(post.mock.calls[0]?.[1]).toEqual({ backup_id: BACKUP });
    expect(recordMirrorFailure).not.toHaveBeenCalled();
  });

  it('an unreachable bastion-api records the mirror as failed (never the backup) and fails the job', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const recordMirrorFailure = vi.fn().mockResolvedValue(undefined);
    await expect(
      processBastionObjectBackupJob(job({ backup_id: BACKUP }), silent, { post, recordMirrorFailure, sleep: async () => {} }),
    ).rejects.toThrow(/mirror-objects returned 503/);
    expect(recordMirrorFailure).toHaveBeenCalledWith(BACKUP, expect.stringContaining('503'));
  });

  it('not configured is a quiet success', async () => {
    const post = vi.fn().mockResolvedValue(ok(mirrorResult({ status: 'not_configured', mirrored: 0 })));
    const r = await processBastionObjectBackupJob(job({ backup_id: BACKUP }), silent, { post, recordMirrorFailure: vi.fn() });
    expect(r?.status).toBe('not_configured');
  });

  it('a result that drifts from the shared contract fails loudly', async () => {
    const post = vi.fn().mockResolvedValue(ok({ ...mirrorResult(), status: 'sideways' }));
    await expect(processBastionObjectBackupJob(job({ backup_id: BACKUP }), silent, { post, recordMirrorFailure: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow(
      /mirror-objects result does not match the shared contract/,
    );
  });
});

// ── backup-database.job.ts: the enqueue after `completed` ───────────────────────────────

const executed: string[] = [];
vi.mock('../utils/db.js', () => ({
  getDb: () => ({
    execute: async (q: { queryChunks?: Array<{ value?: string[] } | unknown> }) => {
      const text = (q.queryChunks ?? [])
        .map((c) => (c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value) ? ((c as { value: string[] }).value).join('') : '?'))
        .join('');
      executed.push(text.replace(/\s+/g, ' ').trim());
      if (/SHOW server_version/.test(text)) return [{ server_version: '16.4' }];
      return [];
    },
  }),
}));
vi.mock('../utils/storage.js', () => ({
  putObjectFromFile: vi.fn().mockResolvedValue(undefined),
  removeObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    const out = args[args.indexOf('--file') + 1] as string;
    void fs.writeFile(out, 'PGDMP fake').then(() => child.emit('close', 0));
    return child;
  },
}));

describe('backup-database enqueues the off-site evidence copy only after `completed`', () => {
  const env = { DATABASE_URL: 'postgres://x', BACKUP_KEY_PREFIX: 'backups/platform', BACKUP_RETENTION_COUNT: 0 } as never;

  it('records completed first, then enqueues with the backup id', async () => {
    executed.length = 0;
    const order: string[] = [];
    const enqueue = vi.fn(async (id: string) => {
      order.push(`enqueue:${id}`);
      order.push(...executed.filter((e) => /status = 'completed'/.test(e)).map(() => 'completed-before-enqueue'));
    });
    const { processBackupJob } = await import('../jobs/backup-database.job.js');
    await processBackupJob(job({ backup_id: 'b-1', kind: 'manual' as const }), silent, env, { enqueueBastionMirror: enqueue });
    expect(enqueue).toHaveBeenCalledWith('b-1');
    expect(order).toEqual(['enqueue:b-1', 'completed-before-enqueue']);
  });

  it('a failing enqueue leaves the backup completed (no failed update)', async () => {
    executed.length = 0;
    const { processBackupJob } = await import('../jobs/backup-database.job.js');
    await expect(
      processBackupJob(job({ backup_id: 'b-2', kind: 'manual' as const }), silent, env, {
        enqueueBastionMirror: async () => {
          throw new Error('redis down');
        },
      }),
    ).resolves.toBeUndefined();
    expect(executed.some((e) => /status = 'completed'/.test(e))).toBe(true);
    expect(executed.some((e) => /status = 'failed'/.test(e))).toBe(false);
  });
});

// ── bastion-export-packet ────────────────────────────────────────────────────────────────

function memoryStorage(seed: Record<string, Buffer>) {
  const objects = new Map(Object.entries(seed));
  const driver = {
    kind: 'local',
    capabilities: {},
    healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    put: async (key: string, body: NodeJS.ReadableStream | Buffer) => {
      if (Buffer.isBuffer(body)) {
        objects.set(key, body);
        return { key, size: body.length, integrity: 'x' };
      }
      const chunks: Buffer[] = [];
      for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      const all = Buffer.concat(chunks);
      objects.set(key, all);
      return { key, size: all.length, integrity: 'x' };
    },
    getStream: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' });
      return { stream: Readable.from([b]), contentType: 'application/json', size: b.length };
    },
    stat: async (key: string) => (objects.has(key) ? { key, size: objects.get(key)!.length, integrity: 'x', modifiedAt: new Date() } : null),
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async () => ({ objects: [] }),
  } as unknown as StorageDriver;
  return { driver, objects };
}

const ORG = '00000000-0000-4000-8000-0000000c0001';
const PACKET = '00000000-0000-4000-8000-0000000c0002';
const SNAP = '00000000-0000-4000-8000-0000000c0003';
const SNAP2 = '00000000-0000-4000-8000-0000000c0004';
const MANUAL = '00000000-0000-4000-8000-0000000c0005';
const ATT = '00000000-0000-4000-8000-0000000c0006';
const evidenceDoc = Buffer.from('{"outcome":"pass"}');
const sha = (b: Buffer) => require('node:crypto').createHash('sha256').update(b).digest('hex') as string;

function contents(over: Partial<BastionPacketContents> = {}): BastionPacketContents {
  return {
    packet: {
      id: PACKET,
      organization_id: ORG,
      period_start: '2026-09-01',
      period_end: '2026-11-26',
      include_restricted: false,
      max_packet_bytes: 50 * 1024 * 1024,
      object_key: `packets/${ORG}/${PACKET}/00000000-0000-4000-8000-0000000c00aa.zip`,
    },
    organization_name: 'Gilligan Travel Ltd',
    framework: { id: '00000000-0000-4000-8000-0000000c0010', name: 'ISO 27001', template_key: 'iso27001', is_iso: true },
    generated_at: '2026-11-26T12:00:00.000Z',
    controls: [
      { control_key: 'auth.mfa', title: 'Everyone signs in with a second step', category: 'access', owner: 'The Professor', state: 'met', state_words: 'Met', reason: null, requirement_codes: ['A.5.17'], last_evaluated_at: '2026-11-26T03:00:00.000Z' },
      { control_key: 'keys.rotation', title: 'Keys are rotated — on time', category: 'keys', owner: 'Skipper', state: 'risk_accepted', state_words: 'Not met, risk accepted', reason: 'The owner accepted this risk until 2027-03-26.', requirement_codes: ['A.8.24'], last_evaluated_at: null },
    ],
    evidence: [
      { snapshot_id: SNAP, control_key: 'auth.mfa', outcome: 'pass', reason: null, recorded_at: '2026-11-26T03:00:00.000Z', object_key: `evidence/${ORG}/a.json`, content_sha256: sha(evidenceDoc), redacted: false, path: 'evidence/auth.mfa/2026-11-26-aaaa.json' },
      { snapshot_id: SNAP2, control_key: 'auth.mfa', outcome: 'pass', reason: null, recorded_at: '2026-11-25T03:00:00.000Z', object_key: `evidence/${ORG}/gone.json`, content_sha256: 'f'.repeat(64), redacted: false, path: 'evidence/auth.mfa/2026-11-25-bbbb.json' },
    ],
    files: [
      { manual_evidence_id: MANUAL, title: '2-Step report', kind: 'file', control_keys: ['auth.mfa'], object_key: `manual/${ORG}/m1`, content_sha256: sha(Buffer.from('%PDF-1.4 report')), size_bytes: 15, restricted: false, redacted: false, path: 'uploaded/auth.mfa/2-Step report-cccccccc.pdf' },
    ],
    attestations_csv: 'policy,version,person,read on,body sha256\r\nSecurity policy,3,Gilligan,2026-11-20T10:00:00.000Z,abc',
    exceptions_csv: 'control,title\r\nkeys.rotation,Radio Relay',
    drift_csv: 'control,title\r\n',
    soa_csv: 'ref_code,title,applicable\r\nA.7.1,Physical perimeters,No',
    seals: [{ seal_date: '2026-11-25', epoch: 1, head_seq: 110, head_hash: 'a'.repeat(64), signature: 'b'.repeat(128), signing_key_id: 'k1' }],
    public_keys: [{ signing_key_id: 'k1', public_key_hex: 'c'.repeat(64), current: true }],
    restore_notices: ['History lost by restore, epoch 1 entries 90 to 95'],
    holders: [{ holder_kind: 'attestation', holder_id: ATT }],
    ...over,
  };
}

function fakeApi(c: BastionPacketContents, calls: Array<Record<string, unknown>>) {
  return vi.fn(async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, ...body });
    if (path.endsWith('/verify-commitments')) {
      return ok({ results: (body.holders as Array<Record<string, string>>).map((h) => ({ ...h, result: 'intact' })) });
    }
    if (body.action === 'claim') return ok({ claimed: true, status: 'running', error: null, contents: c });
    return ok({ ok: true });
  });
}

describe('bastion-export-packet', () => {
  it('builds the zip in the Bastion bucket with every part, commitment results and missing files named', async () => {
    const c = contents();
    const { driver, objects } = memoryStorage({
      [`evidence/${ORG}/a.json`]: evidenceDoc,
      [`manual/${ORG}/m1`]: Buffer.from('%PDF-1.4 report'),
    });
    const calls: Array<Record<string, unknown>> = [];
    const r = await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage: driver, progressEveryMs: 0 });
    expect(r).toBe('succeeded');
    const zipBytes = objects.get(c.packet.object_key);
    expect(zipBytes).toBeDefined();
    const zip = await JSZip.loadAsync(zipBytes!);
    const names = Object.keys(zip.files).sort();
    for (const n of ['manifest.json', 'controls.csv', 'controls.jsonl', 'attestations.csv', 'exceptions.csv', 'drift.csv', 'statement_of_applicability.csv', 'summary.pdf', c.evidence[0]!.path, c.files[0]!.path]) {
      expect(names, n).toContain(n);
    }
    expect(await zip.file(c.evidence[0]!.path)!.async('string')).toBe('{"outcome":"pass"}');
    expect(await zip.file(c.evidence[1]!.path)!.async('string')).toBe('Evidence file missing\n');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.personal_data_checks).toEqual([{ holder_kind: 'attestation', holder_id: ATT, result: 'intact', meaning: 'The recorded names still match.' }]);
    expect(manifest.public_keys).toHaveLength(1);
    expect(manifest.restore_notices).toEqual(['History lost by restore, epoch 1 entries 90 to 95']);
    const statuses = Object.fromEntries(manifest.evidence_files.map((e: { path: string; status: string }) => [e.path, e.status]));
    expect(statuses[c.evidence[0]!.path]).toBe('written');
    expect(statuses[c.evidence[1]!.path]).toBe('missing');
    expect(statuses[c.files[0]!.path]).toBe('written');
    // The commitments went through bastion-api (the worker holds no HMAC key), then finish.
    expect(calls.some((x) => x.path === '/v1/internal/engines/verify-commitments')).toBe(true);
    const finish = calls.find((x) => x.action === 'finish');
    expect(finish).toMatchObject({ object_key: c.packet.object_key, size_bytes: zipBytes!.length });
    // controls.csv is formula-neutralized through the shared helper (no raw leading '=').
    expect(await zip.file('controls.csv')!.async('string')).toContain('auth.mfa');
  });

  it('a packet over the size limit fails with a plain reason and leaves no object behind', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const c = contents({
      packet: { ...contents().packet, max_packet_bytes: 1024 },
      files: [{ ...contents().files[0]!, content_sha256: sha(big) }],
    });
    const { driver, objects } = memoryStorage({ [`evidence/${ORG}/a.json`]: evidenceDoc, [`manual/${ORG}/m1`]: big });
    const calls: Array<Record<string, unknown>> = [];
    const r = await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage: driver, progressEveryMs: 0 });
    expect(r).toBe('failed');
    expect(objects.has(c.packet.object_key)).toBe(false);
    expect(String(calls.find((x) => x.action === 'fail')?.error)).toMatch(/larger than the/);
  });

  it('a refused claim (an unfinished ISO SoA) builds nothing', async () => {
    const post = vi.fn().mockResolvedValue(ok({ claimed: false, status: 'failed', error: 'The Statement of Applicability is not finished', contents: null }));
    const { driver, objects } = memoryStorage({});
    expect(await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post, storage: driver })).toBe('failed');
    expect(objects.size).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a claim held by another attempt with a fresh heartbeat waits out the lease instead of completing (#326)', async () => {
    const post = vi.fn().mockResolvedValue(ok({ claimed: false, status: 'running', error: null, contents: null, retry_after_ms: 570_000 }));
    const { driver, objects } = memoryStorage({});
    const moveToDelayed = vi.fn(async () => {});
    const updateData = vi.fn(async () => {});
    const held = { id: 'j1', data: { organization_id: ORG, packet_id: PACKET }, moveToDelayed, updateData } as unknown as Job<{ organization_id: string; packet_id: string }>;
    const before = Date.now();
    await expect(processBastionExportPacketJob(held, silent, { post, storage: driver }, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    expect(updateData).toHaveBeenCalledWith({ organization_id: ORG, packet_id: PACKET, held_deferrals: 1 });
    const [at, token] = (moveToDelayed.mock.calls as unknown as Array<[number, string]>)[0]!;
    expect(at).toBeGreaterThanOrEqual(before + 570_000);
    expect(token).toBe('lock-token');
    expect(objects.size).toBe(0);

    // After every allowed wait the job gives up and leaves the packet to the attempt holding it.
    const spent = { ...held, data: { organization_id: ORG, packet_id: PACKET, held_deferrals: MAX_HELD_DEFERRALS } } as unknown as Job<{ organization_id: string; packet_id: string }>;
    expect(await processBastionExportPacketJob(spent, silent, { post, storage: driver }, 'lock-token')).toBe('skipped');
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
  });

  const fastLimits = { readLimits: { openTimeoutMs: 50, idleTimeoutMs: 50 }, progressEveryMs: 0, heartbeatEveryMs: 1_000 };

  it('an evidence GET that never answers fails the packet instead of hanging the worker (#311)', async () => {
    const c = contents();
    const { driver, objects } = memoryStorage({ [`manual/${ORG}/m1`]: Buffer.from('%PDF-1.4 report') });
    const realGet = driver.getStream.bind(driver);
    (driver as { getStream: StorageDriver['getStream'] }).getStream = (key: string) =>
      key === c.evidence[0]!.object_key ? new Promise(() => undefined) : realGet(key);
    const calls: Array<Record<string, unknown>> = [];
    const r = await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage: driver, ...fastLimits });
    expect(r).toBe('failed');
    expect(calls.some((x) => x.action === 'finish')).toBe(false);
    expect(String(calls.find((x) => x.action === 'fail')?.error)).toMatch(/did not answer/);
    expect(objects.has(c.packet.object_key)).toBe(false);
  }, 10_000);

  it('a storage error that is not "no such object" fails the packet; it is never written up as "Evidence file missing" (#311)', async () => {
    const c = contents();
    const { driver } = memoryStorage({ [`evidence/${ORG}/a.json`]: evidenceDoc, [`manual/${ORG}/m1`]: Buffer.from('%PDF-1.4 report') });
    (driver as { getStream: StorageDriver['getStream'] }).getStream = async () => {
      throw Object.assign(new Error('SlowDown: please reduce your request rate'), { code: 'SlowDown' });
    };
    const calls: Array<Record<string, unknown>> = [];
    const r = await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage: driver, ...fastLimits });
    expect(r).toBe('failed');
    expect(calls.some((x) => x.action === 'finish')).toBe(false);
  }, 10_000);

  it('a body that goes quiet is cut off by the idle timeout and its GET stream is destroyed (#311)', async () => {
    const c = contents();
    const { driver } = memoryStorage({ [`manual/${ORG}/m1`]: Buffer.from('%PDF-1.4 report') });
    const realGet = driver.getStream.bind(driver);
    let stalled: PassThrough | null = null;
    (driver as { getStream: StorageDriver['getStream'] }).getStream = async (key: string) => {
      if (key !== c.evidence[0]!.object_key) return realGet(key);
      stalled = new PassThrough();
      stalled.write(Buffer.from('{"outc'));
      return { stream: stalled, contentType: 'application/json', size: 100 };
    };
    const calls: Array<Record<string, unknown>> = [];
    const r = await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage: driver, ...fastLimits });
    expect(r).toBe('failed');
    expect(stalled).not.toBeNull();
    expect(stalled!.destroyed).toBe(true);
  }, 10_000);

  it('every attempt is its own claimant, even for the same BullMQ job id (#312)', async () => {
    const seen: string[] = [];
    const post = vi.fn(async (_p: string, body: Record<string, unknown>) => {
      seen.push(String(body.claimant));
      return ok({ claimed: false, status: 'running', error: null, contents: null });
    });
    const { driver } = memoryStorage({});
    await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }, 'same-job'), silent, { post: post as never, storage: driver });
    await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }, 'same-job'), silent, { post: post as never, storage: driver });
    expect(seen[0]).toMatch(/^worker-packet:same-job:/);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.length).toBeLessThanOrEqual(128);
  });

  it('a lost finish response is asked again, and the uploaded zip is never deleted once finish was sent (#312)', async () => {
    const c = contents();
    const seed = { [`evidence/${ORG}/a.json`]: evidenceDoc, [`manual/${ORG}/m1`]: Buffer.from('%PDF-1.4 report') };
    // 1. The first finish times out on the wire but committed; the retry finds its own success.
    {
      const { driver, objects } = memoryStorage(seed);
      const calls: Array<Record<string, unknown>> = [];
      const api = fakeApi(c, calls);
      let finishes = 0;
      const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (body.action === 'finish' && ++finishes === 1) {
          calls.push({ path, ...body });
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        }
        return api(path, body);
      });
      expect(await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: post as never, storage: driver, progressEveryMs: 0 })).toBe('succeeded');
      expect(objects.has(c.packet.object_key)).toBe(true);
      expect(finishes).toBe(2);
    }
    // 2. bastion-api never answers finish: the zip stays (the row may already point at it).
    {
      const { driver, objects } = memoryStorage(seed);
      const calls: Array<Record<string, unknown>> = [];
      const api = fakeApi(c, calls);
      const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (body.action === 'finish') throw new Error('socket hang up');
        return api(path, body);
      });
      expect(await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: post as never, storage: driver, progressEveryMs: 0 })).toBe('failed');
      expect(objects.has(c.packet.object_key)).toBe(true);
    }
    // 3. A definite "not yours" from finish: only this attempt's own zip is removed.
    {
      const { driver, objects } = memoryStorage(seed);
      const calls: Array<Record<string, unknown>> = [];
      const api = fakeApi(c, calls);
      const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (body.action === 'finish') return ok({ ok: false });
        return api(path, body);
      });
      expect(await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: post as never, storage: driver, progressEveryMs: 0 })).toBe('skipped');
      expect(objects.has(c.packet.object_key)).toBe(false);
    }
  });

  it('summary.pdf renders text outside WinAnsi (em dash in a title) without throwing', async () => {
    const pdf = await renderSummaryPdf(contents());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('the packet driver writes to BASTION_S3_BUCKET, never S3_BUCKET', () => {
    const d = createBastionPacketStorage({
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY: 'a',
      S3_SECRET_KEY: 'b',
      S3_REGION: 'us-east-1',
      BASTION_S3_BUCKET: 'bigbluebam-bastion',
    });
    // S3Driver keeps its bucket in a private field; read it the way a debugger would.
    expect((d as unknown as { bucket: string }).bucket).toBe('bigbluebam-bastion');
  });

  it('without S3 credentials there is no packet driver (issue #176: no default credentials)', () => {
    expect(
      createBastionPacketStorage({ S3_ENDPOINT: 'http://minio:9000', S3_REGION: 'us-east-1', BASTION_S3_BUCKET: 'bigbluebam-bastion' }),
    ).toBeNull();
  });
});

// Packet smoke on REAL object storage with differing buckets (M9 gate): the shared uploads
// bucket (S3_BUCKET) and Bastion's bucket (BASTION_S3_BUCKET) are two buckets on one MinIO; the
// zip must land in Bastion's and never in the shared one. Runs only with BASTION_MINIO_TEST_ENDPOINT.
const MINIO = process.env.BASTION_MINIO_TEST_ENDPOINT;
describe.skipIf(!MINIO)('bastion-export-packet on real MinIO with differing buckets', () => {
  it('writes the packet to BASTION_S3_BUCKET, never S3_BUCKET', async () => {
    const { createBootstrapDriver } = await import('@bigbluebam/storage');
    const stamp = Date.now();
    const creds = { S3_ENDPOINT: MINIO!, S3_REGION: 'us-east-1', S3_ACCESS_KEY: process.env.BASTION_MINIO_TEST_ACCESS_KEY ?? 'm9test', S3_SECRET_KEY: process.env.BASTION_MINIO_TEST_SECRET_KEY ?? 'm9testsecret123' };
    const env = { ...creds, S3_BUCKET: `m9-uploads-${stamp}`, BASTION_S3_BUCKET: `m9-bastion-${stamp}` };
    const uploads = createBootstrapDriver({ ...creds, S3_BUCKET: env.S3_BUCKET });
    await uploads.put('sentinel.txt', Buffer.from('shared bucket'));
    const storage = createBastionPacketStorage(env)!;
    const c = contents();
    await storage.put(c.evidence[0]!.object_key!, evidenceDoc, { contentType: 'application/json' });
    await storage.put(c.files[0]!.object_key!, Buffer.from('%PDF-1.4 report'), { contentType: 'application/pdf' });
    const calls: Array<Record<string, unknown>> = [];
    expect(await processBastionExportPacketJob(job({ organization_id: ORG, packet_id: PACKET }), silent, { post: fakeApi(c, calls) as never, storage, progressEveryMs: 0 })).toBe('succeeded');
    const st = await storage.stat(c.packet.object_key);
    expect(st?.size).toBeGreaterThan(0);
    expect(await uploads.stat(c.packet.object_key)).toBeNull();
    const got = await storage.getStream(c.packet.object_key);
    const chunks: Buffer[] = [];
    for await (const ch of got.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(ch));
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['manifest.json', 'statement_of_applicability.csv', 'summary.pdf', c.evidence[0]!.path]));
    expect(calls.find((x) => x.action === 'finish')).toMatchObject({ size_bytes: st!.size });
  });
});

// Keep the PassThrough import used (stream typing for the in-memory driver).
void PassThrough;
