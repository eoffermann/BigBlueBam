import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StorageDriver } from '@bigbluebam/storage';
import {
  ENGINE_TIMEOUT_MS,
  EVIDENCE_COPY_LEASE_MS,
  EVIDENCE_COPY_TIMEOUT_MS,
  EVIDENCE_COPY_WRITE_RESERVE_MS,
  EVIDENCE_INGEST_START_CUTOFF_MS,
  estimateCopyMs,
  evidenceCopyBudgetMs,
} from '../src/engine/budgets.js';
import type { EngineDeps } from '../src/engine/context.js';
import { copyFromBin } from '../src/engine/evidence-store.js';

// evidence-ingest copies (#222) and copy cleanup (#223), without a database: the budget
// arithmetic, and copyFromBin destroying both streams when the put never finishes.

describe('evidence-ingest copy budget (#222)', () => {
  it('a copy started at the start cutoff, plus its write reserve, ends inside the engine timeout', () => {
    for (const elapsed of [0, 5_000, EVIDENCE_INGEST_START_CUTOFF_MS]) {
      expect(elapsed + evidenceCopyBudgetMs(elapsed) + EVIDENCE_COPY_WRITE_RESERVE_MS).toBeLessThanOrEqual(ENGINE_TIMEOUT_MS);
    }
    expect(evidenceCopyBudgetMs(ENGINE_TIMEOUT_MS)).toBe(0);
  });

  it('small files fit a call; a 90 MB file does not and goes to a background copy', () => {
    expect(estimateCopyMs(200 * 1024)).toBeLessThan(evidenceCopyBudgetMs(EVIDENCE_INGEST_START_CUTOFF_MS));
    expect(estimateCopyMs(90 * 1024 * 1024)).toBeGreaterThan(evidenceCopyBudgetMs(0));
  });

  it('the copy lease outlives the longest copy, so no retry starts a second copy', () => {
    expect(EVIDENCE_COPY_LEASE_MS).toBeGreaterThan(EVIDENCE_COPY_TIMEOUT_MS);
  });
});

function fakeSql() {
  const tx = Object.assign(async () => [], { json: (v: unknown) => v });
  return { begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as EngineDeps['sql'];
}

function deps(storage: StorageDriver): EngineDeps {
  const log = { info() {}, warn() {}, error() {} };
  return { sql: fakeSql(), storage, putTimeoutMs: 50, log } as unknown as EngineDeps;
}

describe('copyFromBin cleanup (#223)', () => {
  it('destroys the Bin read stream and the upload stream when the put never finishes', async () => {
    const source = new PassThrough();
    source.write(Buffer.from('report bytes'));
    let uploadStream: NodeJS.ReadableStream | null = null;
    const bucket = {
      put: (_k: string, body: NodeJS.ReadableStream) => {
        uploadStream = body;
        return new Promise(() => {});
      },
    } as unknown as StorageDriver;
    const bin = { getStream: async () => ({ stream: source, contentType: 'application/pdf', size: 12 }) } as unknown as StorageDriver;
    await expect(copyFromBin(deps(bucket), bin, 'org-1', { object_key: 'bin/x', size: 12, content_type: 'application/pdf' }, 30)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(source.destroyed).toBe(true);
    expect((uploadStream as unknown as PassThrough).destroyed).toBe(true);
  });

  it('destroys a Bin stream that only arrives after its GET timed out', async () => {
    const late = Readable.from([Buffer.from('late')]);
    let release: (v: unknown) => void = () => {};
    const bin = {
      getStream: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    } as unknown as StorageDriver;
    const bucket = { put: async () => ({}) } as unknown as StorageDriver;
    await expect(copyFromBin(deps(bucket), bin, 'org-1', { object_key: 'bin/x', size: 4, content_type: 'text/plain' }, 30)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    release({ stream: late, contentType: 'text/plain', size: 4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(late.destroyed).toBe(true);
  });
});
