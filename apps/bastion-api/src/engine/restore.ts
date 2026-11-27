// Restore detection by identity (spec 3.4). The bucket holds signed seal objects that survive a
// database restore. The database entry at the highest bucket-sealed (epoch, head_seq) must exist
// and carry that seal's head_hash; anything else means history was lost.
//
// The highest seal is taken across ALL seal objects for the org, not the newest by date. Seal
// identities are cached per org; the bucket is re-listed when the cache is older than a minute
// or when max(platform_restores.completed_at) changes, so an in-place restore from the Backup
// app (no bastion-api restart) is caught on the next append batch. The SQL identity check
// itself runs on every batch (it is one indexed lookup).
//
// On a mismatch: a bastion_ledger_restores row with the lost range and a provisional epoch; the
// range also goes to the bucket as restores/<org>/<id>.json; ledger.restore_detected is published
// (plus evidence.integrity_failed when no completed platform restore lines up); appends for the
// org stay blocked until an owner resolves the row.

import { randomUUID } from 'node:crypto';
import { type ObjectStat, type StorageDriver, withStorageTimeout } from '@bigbluebam/storage';
import {
  compareEpochSeq,
  type RestoreRecordPayload,
  signRestoreRecord,
  verifyRestoreRecord,
  verifySeal,
} from '../lib/ledger-canonical.js';
import { type EngineDeps, orgTx, type Tx } from './context.js';
import { enqueueBastionEvent } from './outbox.js';
import { lockLedger } from './ledger.js';

export interface SealIdentity {
  org: string;
  seal_date: string;
  epoch: number;
  head_seq: number;
  head_hash: string;
  signing_key_id: string;
  signature: string;
  sealed_at: string | null;
  object_key: string;
}

export interface SealCacheEntry {
  keys: Set<string>;
  seals: SealIdentity[];
  /** Objects under seals/<org>/ ignored because they are malformed or do not verify. */
  rejected: number;
  refreshedAt: number;
  restoreMarker: string | null;
}

export class StorageUnavailableError extends Error {
  constructor(message = 'Evidence storage is not available.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

const CACHE_TTL_MS = 60_000;

export const sealObjectKey = (org: string, sealDate: string) => `seals/${org}/${sealDate}.json`;
export const restoreObjectKey = (org: string, id: string) => `restores/${org}/${id}.json`;

async function readJson(deps: EngineDeps, key: string): Promise<unknown> {
  const storage = deps.storage;
  if (!storage) throw new StorageUnavailableError();
  const { stream } = await withStorageTimeout('get', storage.getStream(key), deps.putTimeoutMs);
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function listAll(deps: EngineDeps, prefix: string): Promise<string[]> {
  const storage = deps.storage;
  if (!storage) throw new StorageUnavailableError();
  return (await listObjects(storage, prefix, deps.putTimeoutMs)).map((o) => o.key);
}

/**
 * The objects under a prefix one page at a time, starting after `startAfter`, until the listing
 * says there are no more. No page cap: a listing is either complete or it throws (#313). A
 * cursor that does not advance is an error, never a silent stop.
 */
export async function* listPages(storage: StorageDriver, prefix: string, timeoutMs: number, startAfter?: string): AsyncGenerator<ObjectStat[]> {
  let cursor = startAfter;
  for (;;) {
    const res = await withStorageTimeout('list', storage.list(prefix, cursor), timeoutMs);
    if (res.objects.length > 0) yield res.objects;
    if (!res.cursor) return;
    if (res.cursor === cursor) throw new Error(`Listing ${prefix} did not advance past ${cursor}.`);
    cursor = res.cursor;
  }
}

/** Every object under a prefix (the seal check). */
export async function listObjects(storage: StorageDriver, prefix: string, timeoutMs: number): Promise<ObjectStat[]> {
  const out: ObjectStat[] = [];
  for await (const page of listPages(storage, prefix, timeoutMs)) out.push(...page);
  return out;
}

// Column ranges the identity is written into (0275_bastion_evidence.sql). bucket_epoch and
// provisional_epoch are `integer` and provisional_epoch is max epoch + 1, so the largest
// acceptable epoch leaves room for that increment; the seq columns are `bigint`, which holds
// every JS safe integer.
const MAX_SEAL_EPOCH = 2_147_483_646;
const SEAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEAD_HASH_RE = /^[0-9a-f]{64}$/;

/** Shape and range check only. Trust comes from verifySeal in refreshSeals. */
export function parseSeal(raw: unknown, key: string): SealIdentity | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.epoch !== 'number' || typeof o.head_seq !== 'number') return null;
  const epoch = o.epoch;
  const seq = o.head_seq;
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > MAX_SEAL_EPOCH) return null;
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof o.head_hash !== 'string' || !HEAD_HASH_RE.test(o.head_hash)) return null;
  if (typeof o.org !== 'string' || typeof o.seal_date !== 'string' || !SEAL_DATE_RE.test(o.seal_date)) return null;
  if (typeof o.signing_key_id !== 'string' || typeof o.signature !== 'string') return null;
  return {
    org: o.org,
    seal_date: o.seal_date,
    epoch,
    head_seq: seq,
    head_hash: o.head_hash,
    signing_key_id: o.signing_key_id,
    signature: o.signature,
    sealed_at: typeof o.sealed_at === 'string' ? o.sealed_at : null,
    object_key: key,
  };
}

/** True only when the seal's Ed25519 signature verifies against a published key. */
export function sealIsAuthentic(seal: SealIdentity, keys: Map<string, string>): boolean {
  return verifySeal(
    {
      org: seal.org,
      seal_date: seal.seal_date,
      epoch: seal.epoch,
      head_seq: seal.head_seq,
      head_hash: seal.head_hash,
      signing_key_id: seal.signing_key_id,
    },
    seal.signature,
    keys,
  );
}

async function restoreMarker(deps: EngineDeps): Promise<string | null> {
  const rows = await deps.sql`SELECT max(completed_at)::text AS m FROM platform_restores WHERE status = 'completed'`;
  return (rows[0]?.m as string | null) ?? null;
}

/** The org's bucket seal identities (cached). Throws StorageUnavailableError without a bucket. */
export async function refreshSeals(deps: EngineDeps, orgId: string, force = false): Promise<SealCacheEntry> {
  if (!deps.storage) throw new StorageUnavailableError();
  const marker = await restoreMarker(deps);
  const cached = deps.sealCache.get(orgId);
  if (cached && !force && Date.now() - cached.refreshedAt < CACHE_TTL_MS && cached.restoreMarker === marker) {
    return cached;
  }
  const entry: SealCacheEntry = cached ?? { keys: new Set(), seals: [], rejected: 0, refreshedAt: 0, restoreMarker: null };
  const keys = await listAll(deps, `seals/${orgId}/`);
  for (const key of keys) {
    if (entry.keys.has(key)) continue;
    let raw: unknown;
    try {
      raw = await readJson(deps, key);
    } catch (err) {
      if (err instanceof SyntaxError) raw = null;
      else throw err;
    }
    entry.keys.add(key);
    // The bucket is writable by every service holding the shared storage key, so an object
    // under seals/<org>/ is only a trust anchor when its signature verifies (spec 3.4).
    const seal = parseSeal(raw, key);
    const reason = !seal
      ? 'malformed or out of range'
      : seal.org !== orgId
        ? 'names a different organization'
        : !sealIsAuthentic(seal, deps.sealKeys)
          ? 'signature does not verify against any published key'
          : null;
    if (reason || !seal) {
      entry.rejected += 1;
      deps.log.error(
        { organization_id: orgId, object_key: key, reason, rejected_total: entry.rejected },
        'bastion-ledger: unsigned seal object ignored',
      );
      continue;
    }
    entry.seals.push(seal);
  }
  entry.refreshedAt = Date.now();
  entry.restoreMarker = marker;
  deps.sealCache.set(orgId, entry);
  return entry;
}

export function highestSeal(seals: SealIdentity[]): SealIdentity | null {
  let best: SealIdentity | null = null;
  for (const s of seals) {
    if (!best || compareEpochSeq({ epoch: s.epoch, seq: s.head_seq }, { epoch: best.epoch, seq: best.head_seq }) > 0) best = s;
  }
  return best;
}

/** True when the DB holds the sealed entry with the sealed epoch and hash. */
export async function dbMatchesSeal(q: Tx | EngineDeps['sql'], orgId: string, seal: SealIdentity): Promise<boolean> {
  const rows = await q`SELECT epoch, entry_hash FROM bastion_ledger_entries
                        WHERE organization_id = ${orgId} AND seq = ${seal.head_seq}`;
  const row = rows[0];
  return !!row && Number(row.epoch) === seal.epoch && row.entry_hash === seal.head_hash;
}

export interface LedgerIdentityCheck {
  highest: SealIdentity | null;
  /** An unresolved restore row: appends are blocked until an owner resolves it. */
  blockedBy: string | null;
  opened: string | null;
}

/**
 * The check that runs at boot, at the start of every append batch, and in every seal run.
 * Never automatically benign: a mismatch always opens (or finds) a restore row.
 */
export async function checkLedgerIdentity(deps: EngineDeps, orgId: string): Promise<LedgerIdentityCheck> {
  const entry = await refreshSeals(deps, orgId);
  const highest = highestSeal(entry.seals);
  let opened: string | null = null;
  if (highest && !(await dbMatchesSeal(deps.sql, orgId, highest))) {
    const known = await deps.sql`
      SELECT id FROM bastion_ledger_restores
       WHERE organization_id = ${orgId} AND bucket_epoch = ${highest.epoch}
         AND bucket_head_seq = ${highest.head_seq} AND bucket_head_hash = ${highest.head_hash}
       LIMIT 1`;
    if (known.length === 0) opened = await openRestore(deps, orgId, highest, entry.seals);
  }
  const unresolved = await deps.sql`
    SELECT id FROM bastion_ledger_restores
     WHERE organization_id = ${orgId} AND resolution IS NULL
     ORDER BY detected_at LIMIT 1`;
  return { highest, blockedBy: (unresolved[0]?.id as string | undefined) ?? null, opened };
}

async function openRestore(deps: EngineDeps, orgId: string, highest: SealIdentity, seals: SealIdentity[]): Promise<string | null> {
  // The lost range starts after the newest seal the database still agrees with.
  const older = [...seals]
    .filter((s) => compareEpochSeq({ epoch: s.epoch, seq: s.head_seq }, { epoch: highest.epoch, seq: highest.head_seq }) < 0)
    .sort((a, b) => compareEpochSeq({ epoch: b.epoch, seq: b.head_seq }, { epoch: a.epoch, seq: a.head_seq }));
  let lostFrom = 1;
  for (const s of older) {
    if (await dbMatchesSeal(deps.sql, orgId, s)) {
      lostFrom = s.head_seq + 1;
      break;
    }
  }
  const maxEpoch = seals.reduce((m, s) => Math.max(m, s.epoch), highest.epoch);
  const sealedAt = highest.sealed_at ?? `${highest.seal_date}T00:00:00.000Z`;
  const id = randomUUID();
  const created = await orgTx(deps.sql, orgId, async (tx) => {
    await lockLedger(tx, orgId);
    const again = await tx`
      SELECT id FROM bastion_ledger_restores
       WHERE organization_id = ${orgId} AND bucket_epoch = ${highest.epoch}
         AND bucket_head_seq = ${highest.head_seq} AND bucket_head_hash = ${highest.head_hash}
       LIMIT 1`;
    if (again.length > 0) return null;
    const head = await tx`SELECT max(seq) AS s FROM bastion_ledger_entries WHERE organization_id = ${orgId}`;
    const match = await tx`
      SELECT id FROM platform_restores
       WHERE status = 'completed' AND completed_at >= ${sealedAt}::timestamptz
       ORDER BY completed_at DESC LIMIT 1`;
    const platformRestoreId = (match[0]?.id as string | undefined) ?? null;
    const status = platformRestoreId ? 'pending_ack' : 'unmatched';
    await tx`
      INSERT INTO bastion_ledger_restores
        (id, organization_id, detected_at, db_head_seq, bucket_seal_date, bucket_epoch, bucket_head_seq,
         bucket_head_hash, lost_from_seq, lost_to_seq, provisional_epoch, platform_restore_id, status)
      VALUES (${id}, ${orgId}, ${deps.now()}, ${head[0]?.s ?? null}, ${highest.seal_date}::date, ${highest.epoch},
              ${highest.head_seq}, ${highest.head_hash}, ${lostFrom}, ${highest.head_seq}, ${maxEpoch + 1},
              ${platformRestoreId}, ${status})`;
    const refs = {
      restore_id: id,
      epoch: highest.epoch,
      lost_from_seq: lostFrom,
      lost_to_seq: highest.head_seq,
      status,
    };
    await enqueueBastionEvent('ledger.restore_detected', refs, tx, {
      orgId,
      idempotencyKey: `ledger.restore_detected:${id}`,
      orderingKey: `seal:${orgId}`,
    });
    if (!platformRestoreId) {
      await enqueueBastionEvent('evidence.integrity_failed', { ...refs, cause: 'unexplained_gap' }, tx, {
        orgId,
        idempotencyKey: `evidence.integrity_failed:restore:${id}`,
        orderingKey: `seal:${orgId}`,
      });
    }
    return { status, lostFrom };
  });
  if (!created) return null;
  deps.log.warn(
    { organization_id: orgId, restore_id: id, status: created.status, lost_from_seq: created.lostFrom, lost_to_seq: highest.head_seq },
    'bastion-ledger: the database is behind the bucket seal; appends are blocked until an owner resolves it',
  );
  // The lost range also lives in the bucket, so it survives a further database rewrite.
  await writeRestoreObject(deps, orgId, id);
  return id;
}

const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))).toISOString();

/** The signed body of a restore record object, from its database row (#208). */
export function restoreRecordPayload(row: Record<string, unknown>, signingKeyId: string): RestoreRecordPayload {
  return {
    record: 'ledger_restore',
    id: String(row.id),
    organization_id: String(row.organization_id),
    detected_at: isoOrNull(row.detected_at) ?? '',
    db_head_seq: intOrNull(row.db_head_seq),
    bucket_seal_date: (row.bucket_seal_date as string | null) ?? null,
    bucket_epoch: intOrNull(row.bucket_epoch),
    bucket_head_seq: intOrNull(row.bucket_head_seq),
    bucket_head_hash: (row.bucket_head_hash as string | null) ?? null,
    lost_from_seq: intOrNull(row.lost_from_seq),
    lost_to_seq: intOrNull(row.lost_to_seq),
    provisional_epoch: Number(row.provisional_epoch),
    platform_restore_id: (row.platform_restore_id as string | null) ?? null,
    status: String(row.status),
    resolution: (row.resolution as string | null) ?? null,
    resolved_at: isoOrNull(row.resolved_at),
    signing_key_id: signingKeyId,
  };
}

/** A restore record read back from the bucket whose signature verified. */
export type RestoreRecord = RestoreRecordPayload & { object_key: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isNullableInt = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v));
const isNullableString = (v: unknown) => v === null || typeof v === 'string';

/**
 * Shape check of a restore record object plus its signature. Trust comes from
 * restoreRecordIsAuthentic; this only refuses what cannot even be checked.
 */
export function parseRestoreRecord(raw: unknown, key: string): { payload: RestoreRecordPayload; signature: string } | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.record !== 'ledger_restore') return null;
  if (typeof o.id !== 'string' || !UUID_RE.test(o.id) || typeof o.organization_id !== 'string') return null;
  if (typeof o.detected_at !== 'string' || typeof o.status !== 'string' || typeof o.signing_key_id !== 'string') return null;
  if (typeof o.signature !== 'string') return null;
  if (typeof o.provisional_epoch !== 'number' || !Number.isSafeInteger(o.provisional_epoch)) return null;
  for (const f of ['db_head_seq', 'bucket_epoch', 'bucket_head_seq', 'lost_from_seq', 'lost_to_seq'] as const) {
    if (!isNullableInt(o[f])) return null;
  }
  for (const f of ['bucket_seal_date', 'bucket_head_hash', 'platform_restore_id', 'resolution', 'resolved_at'] as const) {
    if (!isNullableString(o[f])) return null;
  }
  const payload: RestoreRecordPayload = {
    record: 'ledger_restore',
    id: o.id,
    organization_id: o.organization_id,
    detected_at: o.detected_at,
    db_head_seq: o.db_head_seq as number | null,
    bucket_seal_date: o.bucket_seal_date as string | null,
    bucket_epoch: o.bucket_epoch as number | null,
    bucket_head_seq: o.bucket_head_seq as number | null,
    bucket_head_hash: o.bucket_head_hash as string | null,
    lost_from_seq: o.lost_from_seq as number | null,
    lost_to_seq: o.lost_to_seq as number | null,
    provisional_epoch: o.provisional_epoch,
    platform_restore_id: o.platform_restore_id as string | null,
    status: o.status,
    resolution: o.resolution as string | null,
    resolved_at: o.resolved_at as string | null,
    signing_key_id: o.signing_key_id,
  };
  // The record must sit at its own key: a genuine record copied under another id is refused.
  if (key !== restoreObjectKey(payload.organization_id, payload.id)) return null;
  return { payload, signature: o.signature };
}

/** True only when the record's Ed25519 signature verifies against a published seal key. */
export function restoreRecordIsAuthentic(rec: { payload: RestoreRecordPayload; signature: string }, keys: Map<string, string>): boolean {
  return verifyRestoreRecord(rec.payload, rec.signature, keys);
}

/** Write (or rewrite) restores/<org>/<id>.json from the row, signed (#208). Best effort; retried by the seal run. */
export async function writeRestoreObject(deps: EngineDeps, orgId: string, restoreId: string): Promise<boolean> {
  if (!deps.storage) return false;
  const rows = await orgTx(deps.sql, orgId, (tx) => tx`
    SELECT id, organization_id, detected_at, db_head_seq, bucket_seal_date::text AS bucket_seal_date, bucket_epoch,
           bucket_head_seq, bucket_head_hash, lost_from_seq, lost_to_seq, provisional_epoch, platform_restore_id,
           status, resolution, resolved_at
      FROM bastion_ledger_restores WHERE organization_id = ${orgId} AND id = ${restoreId}`);
  const row = rows[0];
  if (!row) return false;
  const key = restoreObjectKey(orgId, restoreId);
  const payload = restoreRecordPayload(row as Record<string, unknown>, deps.signer.keyId);
  const signature = signRestoreRecord(payload, deps.signer);
  const body = Buffer.from(JSON.stringify({ ...payload, signature, public_key_hex: deps.signer.publicKeyHex }));
  try {
    await withStorageTimeout('put', deps.storage.put(key, body, { contentType: 'application/json', size: body.length }), deps.putTimeoutMs);
  } catch (err) {
    deps.log.warn({ organization_id: orgId, restore_id: restoreId, err: (err as Error).message }, 'bastion-ledger: could not write the restore record object; will retry');
    return false;
  }
  await orgTx(deps.sql, orgId, (tx) => tx`UPDATE bastion_ledger_restores SET object_key = ${key}
                                           WHERE organization_id = ${orgId} AND id = ${restoreId}`);
  return true;
}

export interface BucketRestoreRecords {
  records: RestoreRecord[];
  /** Objects under restores/<org>/ ignored because they are unreadable, malformed or do not verify. */
  rejected: number;
}

/**
 * Every lost range recorded in the bucket (survives a database rewrite). The bucket is writable by
 * every service holding the shared storage key, so a record counts only when its signature
 * verifies against a published seal key (#208, as #199 does for seals); anything else is
 * ignored, counted and logged.
 */
export async function bucketRestoreRecords(deps: EngineDeps, orgId: string): Promise<BucketRestoreRecords> {
  if (!deps.storage) return { records: [], rejected: 0 };
  const keys = await listAll(deps, `restores/${orgId}/`);
  const out: BucketRestoreRecords = { records: [], rejected: 0 };
  for (const key of keys) {
    let raw: unknown = null;
    let readable = true;
    try {
      raw = await readJson(deps, key);
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw err;
      readable = false;
    }
    const rec = readable ? parseRestoreRecord(raw, key) : null;
    const reason = !readable
      ? 'unreadable'
      : !rec
        ? 'malformed, unsigned or not at its own key'
        : rec.payload.organization_id !== orgId
          ? 'names a different organization'
          : !restoreRecordIsAuthentic(rec, deps.sealKeys)
            ? 'signature does not verify against any published key'
            : null;
    if (reason || !rec) {
      out.rejected += 1;
      deps.log.error(
        { organization_id: orgId, object_key: key, reason, rejected_total: out.rejected },
        'bastion-ledger: unverifiable restore record object ignored',
      );
      continue;
    }
    out.records.push({ ...rec.payload, object_key: key });
  }
  return out;
}
