import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import { createPinnedLookup, safeDispatcher } from './index.js';

// The pinned lookup is consumed by Node's net.connect, not by our code. These tests dial a real
// local server through an undici Agent so the contract is checked where it is used: with
// autoSelectFamily (Node's default) net asks for `{ all: true }` and reads an array. The resolver
// is injected (it maps the test host to 127.0.0.1) and the block check is relaxed for loopback
// only, because a real public target would need the network.

const LOOPBACK = (host: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }]);
const allowLoopback = (address: string) => address !== '127.0.0.1';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => res.end('pinned ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('createPinnedLookup', () => {
  it('connects through net.connect with autoSelectFamily on (Node asks for all addresses)', async () => {
    const agent = new Agent({ connect: { lookup: createPinnedLookup(LOOPBACK, allowLoopback) as never, autoSelectFamily: true } });
    const res = await undiciFetch(`http://pinned.test:${port}/`, { dispatcher: agent });
    expect(await res.text()).toBe('pinned ok');
    await agent.close();
  });

  it('connects with autoSelectFamily off (Node asks for one address)', async () => {
    const agent = new Agent({ connect: { lookup: createPinnedLookup(LOOPBACK, allowLoopback) as never, autoSelectFamily: false } });
    const res = await undiciFetch(`http://pinned.test:${port}/`, { dispatcher: agent });
    expect(await res.text()).toBe('pinned ok');
    await agent.close();
  });

  it('answers an array for { all: true } and a single address otherwise', () => {
    const lookup = createPinnedLookup(LOOPBACK, () => false);
    lookup('h', { all: true }, (err, addr) => {
      expect(err).toBeNull();
      expect(addr).toEqual([{ address: '127.0.0.1', family: 4 }]);
    });
    lookup('h', {}, (err, addr, family) => {
      expect(err).toBeNull();
      expect(addr).toBe('127.0.0.1');
      expect(family).toBe(4);
    });
  });

  it('still refuses a host that resolves to a private address (the real block check)', async () => {
    const agent = new Agent({ connect: { lookup: createPinnedLookup(LOOPBACK) as never } });
    await expect(undiciFetch(`http://pinned.test:${port}/`, { dispatcher: agent })).rejects.toThrow();
    await agent.close();
  });

  it('safeDispatcher refuses a name that resolves to loopback instead of failing on the address shape', async () => {
    const err = await undiciFetch(`http://localhost:${port}/`, { dispatcher: safeDispatcher }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const cause = String((err as Error & { cause?: unknown }).cause ?? '');
    expect(cause).toMatch(/private\/internal/);
    expect(cause).not.toMatch(/Invalid IP address/);
  });
});
