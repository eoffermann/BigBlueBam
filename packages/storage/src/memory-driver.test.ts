import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createInMemoryStorageDriver } from './memory-driver.js';
import { isStorageNotFoundError } from './errors.js';

async function drain(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('in-memory storage driver (issue #163)', () => {
  it('round-trips buffers and streams, stats, lists, copies, deletes', async () => {
    const d = createInMemoryStorageDriver();
    await d.put('a/1.txt', Buffer.from('hello'), { contentType: 'text/plain' });
    await d.put('a/2.bin', Readable.from([Buffer.from('wor'), Buffer.from('ld')]));
    expect((await drain((await d.getStream('a/1.txt')).stream)).toString()).toBe('hello');
    expect((await d.getStream('a/2.bin')).contentType).toBe('application/octet-stream');
    expect((await d.stat('a/2.bin'))?.size).toBe(5);
    expect((await drain((await d.getRange!('a/2.bin', 1, 3)).stream)).toString()).toBe('orl');
    expect((await d.list('a/')).objects.map((o) => o.key).sort()).toEqual(['a/1.txt', 'a/2.bin']);
    await d.copyTo!('b/1.txt', 'a/1.txt');
    await d.delete('a/1.txt');
    expect(await d.stat('a/1.txt')).toBeNull();
    expect(d.objects.get('b/1.txt')?.body.toString()).toBe('hello');
  });

  it('reports a missing object the way isStorageNotFoundError recognizes', async () => {
    const d = createInMemoryStorageDriver();
    const err = await d.getStream('missing').catch((e: unknown) => e);
    expect(isStorageNotFoundError(err)).toBe(true);
  });
});
