import { describe, expect, it } from 'vitest';
import { restoreObjectsFromBackup } from '../src/engine/objects.js';
import { fakeBucket } from './db/engine-harness.js';

// restore-objects --from-backup (spec 9.7) against in-memory buckets. No database: the command
// copies storage to storage, and asks the database only which keys were redacted.

const ORG = '00000000-0000-4000-8000-0000000d0001';
const put = (b: ReturnType<typeof fakeBucket>, key: string, body = key) =>
  b.objects.set(key, { body: Buffer.from(body), contentType: 'application/json', modifiedAt: new Date() });

describe('restore-objects --from-backup', () => {
  it('lists every page with no cap and copies everything, logging from the first page (#313)', async () => {
    const mirror = fakeBucket();
    // One key per page: more pages than the old 1,000-page ceiling.
    mirror.pageSize = 1;
    for (let i = 0; i < 1005; i++) put(mirror, `evidence/${ORG}/${String(i).padStart(5, '0')}.json`);
    const bucket = fakeBucket();
    const lines: string[] = [];
    let firstProgressAtList = -1;
    const res = await restoreObjectsFromBackup(mirror, bucket, (l) => {
      lines.push(l);
      if (firstProgressAtList < 0 && /^objects \d+/.test(l)) firstProgressAtList = mirror.listCalls;
    });
    expect(res.listed).toBe(1005);
    expect(res.copied).toBe(1005);
    expect(bucket.objects.size).toBe(1005);
    // Progress appears long before the listing is done (streamed page by page).
    expect(firstProgressAtList).toBeGreaterThan(0);
    expect(firstProgressAtList).toBeLessThan(100);
    expect(lines.at(-1)).toMatch(/listing complete/);
  });

  it('a listing that fails stops the restore with an error instead of reporting success (#313)', async () => {
    const mirror = fakeBucket();
    mirror.pageSize = 2;
    for (let i = 0; i < 6; i++) put(mirror, `evidence/${ORG}/${i}.json`);
    const realList = mirror.list.bind(mirror);
    mirror.list = async (prefix, cursor) => {
      if (cursor) throw new Error('SlowDown (test)');
      return realList(prefix, cursor);
    };
    await expect(restoreObjectsFromBackup(mirror, fakeBucket(), () => undefined)).rejects.toThrow(/SlowDown/);
  });

  it('never copies redacted files back, removes a redacted copy already there, and says when it could not check (#310)', async () => {
    const mirror = fakeBucket();
    const kept = `manual/${ORG}/kept`;
    const redacted = `manual/${ORG}/redacted`;
    const redactedEvidence = `evidence/${ORG}/${'e'.repeat(64)}.json`;
    const seal = `seals/${ORG}/2026-11-25.json`;
    for (const k of [kept, redacted, redactedEvidence, seal]) put(mirror, k);
    const lookup = async (org: string) => new Set(org === ORG ? [redacted, redactedEvidence] : []);

    const bucket = fakeBucket();
    put(bucket, redactedEvidence); // an earlier unchecked run copied it back
    const res = await restoreObjectsFromBackup(mirror, bucket, () => undefined, { redactedKeys: lookup });
    expect(res.redaction_checked).toBe(true);
    expect(res.redacted_skipped).toBe(2);
    expect(bucket.objects.has(kept)).toBe(true);
    expect(bucket.objects.has(seal)).toBe(true);
    expect(bucket.objects.has(redacted)).toBe(false);
    expect(bucket.objects.has(redactedEvidence)).toBe(false);

    // No database: everything is copied, and the result says the check did not run.
    const blind = await restoreObjectsFromBackup(mirror, fakeBucket(), () => undefined);
    expect(blind.redaction_checked).toBe(false);
    expect(blind.copied).toBe(4);
  });
});
