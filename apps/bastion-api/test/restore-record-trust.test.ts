import { describe, expect, it } from 'vitest';
import type { EngineDeps } from '../src/engine/context.js';
import { bucketRestoreRecords, restoreObjectKey, restoreRecordPayload } from '../src/engine/restore.js';
import { type RestoreRecordPayload, sealSignerFromSeed, signRestoreRecord, signSeal } from '../src/lib/ledger-canonical.js';
import { fakeBucket } from './db/engine-harness.js';

// Issue #208: restore record objects (restores/<org>/<id>.json) count only when signed with a
// published seal key, exactly as #199 does for seal objects. Anything else is ignored and counted.

const ORG = '00000000-0000-4000-8000-0000ba574208';
const ID = '11111111-2222-4333-8444-555555555208';
const signer = sealSignerFromSeed('5'.repeat(64));

function depsWith(bucket: ReturnType<typeof fakeBucket>) {
  const errors: string[] = [];
  const log = { info() {}, warn() {}, error: (_o: unknown, m?: string) => void errors.push(m ?? '') };
  const deps = { storage: bucket, putTimeoutMs: 5_000, sealKeys: new Map([[signer.keyId, signer.publicKeyHex]]), log } as unknown as EngineDeps;
  return { deps, errors };
}

const payload = (over: Partial<RestoreRecordPayload> = {}): RestoreRecordPayload => ({
  ...restoreRecordPayload(
    {
      id: ID,
      organization_id: ORG,
      detected_at: new Date('2026-11-26T10:00:00.000Z'),
      db_head_seq: '1',
      bucket_seal_date: '2026-11-25',
      bucket_epoch: 1,
      bucket_head_seq: '4',
      bucket_head_hash: 'a'.repeat(64),
      lost_from_seq: '2',
      lost_to_seq: '4',
      provisional_epoch: 2,
      platform_restore_id: null,
      status: 'unmatched',
      resolution: null,
      resolved_at: null,
    },
    signer.keyId,
  ),
  ...over,
});

const put = (bucket: ReturnType<typeof fakeBucket>, key: string, body: unknown) =>
  bucket.objects.set(key, { body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), contentType: 'application/json', modifiedAt: new Date() });

describe('restore record trust (#208)', () => {
  it('a record signed with the seal key is listed, with integer seqs and ISO times', async () => {
    const bucket = fakeBucket();
    const p = payload();
    put(bucket, restoreObjectKey(ORG, ID), { ...p, signature: signRestoreRecord(p, signer), public_key_hex: signer.publicKeyHex });
    const { deps, errors } = depsWith(bucket);
    const res = await bucketRestoreRecords(deps, ORG);
    expect(res.rejected).toBe(0);
    expect(errors).toEqual([]);
    expect(res.records).toEqual([{ ...p, object_key: restoreObjectKey(ORG, ID) }]);
    expect(res.records[0]).toMatchObject({ lost_from_seq: 2, lost_to_seq: 4, detected_at: '2026-11-26T10:00:00.000Z' });
  });

  it('forged records are ignored and counted: unsigned, tampered, wrong key, a seal signature, moved, garbage', async () => {
    const bucket = fakeBucket();
    const p = payload();
    const good = signRestoreRecord(p, signer);
    const rogue = sealSignerFromSeed('7'.repeat(64));
    const rogueP = payload({ id: '11111111-2222-4333-8444-000000000003', signing_key_id: rogue.keyId });
    const ids = ['01', '02', '03', '04', '05', '06', '07'].map((n) => `11111111-2222-4333-8444-0000000000${n}`);
    // The pre-#208 shape: the bare row, no signature (what anyone with the storage key could plant).
    put(bucket, restoreObjectKey(ORG, ids[0]!), { id: ids[0], organization_id: ORG, status: 'acknowledged', resolution: 'restore_acknowledged', bucket_epoch: 1, lost_from_seq: 1, lost_to_seq: 9 });
    // A genuine record's signature over different contents.
    const tampered = payload({ id: ids[1]! });
    put(bucket, restoreObjectKey(ORG, ids[1]!), { ...tampered, lost_to_seq: 99, signature: signRestoreRecord(tampered, signer) });
    // Signed by a key Bastion never published.
    put(bucket, restoreObjectKey(ORG, rogueP.id), { ...rogueP, signature: signRestoreRecord(rogueP, rogue) });
    // A seal's signature does not stand for a record (the canonical bytes differ).
    const sealSig = signSeal({ org: ORG, seal_date: '2026-11-25', epoch: 1, head_seq: 4, head_hash: 'a'.repeat(64), signing_key_id: signer.keyId }, signer);
    const asSeal = payload({ id: ids[3]! });
    put(bucket, restoreObjectKey(ORG, ids[3]!), { ...asSeal, signature: sealSig });
    // A genuine, correctly signed record copied under another id.
    put(bucket, restoreObjectKey(ORG, ids[4]!), { ...p, signature: good });
    // Not JSON at all.
    put(bucket, restoreObjectKey(ORG, ids[5]!), '{not json');
    // Signed for a different org but planted under this org's prefix.
    const other = payload({ id: ids[6]!, organization_id: '00000000-0000-4000-8000-000000000999' });
    put(bucket, restoreObjectKey(ORG, ids[6]!), { ...other, signature: signRestoreRecord(other, signer) });

    const { deps, errors } = depsWith(bucket);
    const res = await bucketRestoreRecords(deps, ORG);
    expect(res.records).toEqual([]);
    expect(res.rejected).toBe(7);
    expect(errors).toHaveLength(7);
    expect(errors.every((m) => /unverifiable restore record object ignored/.test(m))).toBe(true);
  });

  it('a record stays verifiable after a key change while the old key is still published', async () => {
    const bucket = fakeBucket();
    const old = sealSignerFromSeed('9'.repeat(64));
    const p = payload({ signing_key_id: old.keyId });
    put(bucket, restoreObjectKey(ORG, ID), { ...p, signature: signRestoreRecord(p, old) });
    const { deps } = depsWith(bucket);
    (deps.sealKeys as Map<string, string>).set(old.keyId, old.publicKeyHex);
    expect((await bucketRestoreRecords(deps, ORG)).records).toHaveLength(1);
  });
});
