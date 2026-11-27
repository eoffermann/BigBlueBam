import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOLT_PUBLISH_TIMEOUT_DEFAULT_MS,
  nestBoltPayload,
  publishBoltEvent,
  publishBoltEventChecked,
  resolveBoltPublishTimeoutMs,
} from './bolt-events.js';

// Issue #125: publishBoltEvent must not hang when bolt-api accepts the connection and
// never answers.

const ORG = '00000000-0000-0000-0000-000000000001';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('publishBoltEvent timeout', () => {
  const saved = { ...process.env };
  let server: Server | undefined;

  beforeEach(() => {
    delete process.env.BOLT_PUBLISH_TIMEOUT_MS;
  });

  afterEach(async () => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('defaults to 5000 ms and honours BOLT_PUBLISH_TIMEOUT_MS', () => {
    expect(resolveBoltPublishTimeoutMs()).toBe(BOLT_PUBLISH_TIMEOUT_DEFAULT_MS);
    expect(BOLT_PUBLISH_TIMEOUT_DEFAULT_MS).toBe(5000);
    process.env.BOLT_PUBLISH_TIMEOUT_MS = '250';
    expect(resolveBoltPublishTimeoutMs()).toBe(250);
    process.env.BOLT_PUBLISH_TIMEOUT_MS = 'garbage';
    expect(resolveBoltPublishTimeoutMs()).toBe(5000);
    process.env.BOLT_PUBLISH_TIMEOUT_MS = '-1';
    expect(resolveBoltPublishTimeoutMs()).toBe(5000);
  });

  it('resolves within the timeout against a never-responding server and logs a warning', async () => {
    let requests = 0;
    // Accepts the request and never writes a response.
    server = createServer(() => {
      requests += 1;
    });
    process.env.BOLT_API_INTERNAL_URL = await listen(server);
    process.env.BOLT_PUBLISH_TIMEOUT_MS = '200';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const started = Date.now();
    await expect(publishBoltEvent('thing.happened', 'bam', {}, ORG)).resolves.toBeUndefined();
    const elapsed = Date.now() - started;

    expect(requests).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3000);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(logged).toMatchObject({ level: 'warn', event_type: 'thing.happened', source: 'bam', timeout_ms: 200 });
  });

  it('does not warn when bolt-api answers', async () => {
    server = createServer((_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    process.env.BOLT_API_INTERNAL_URL = await listen(server);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishBoltEvent('thing.happened', 'bam', {}, ORG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming INTERNAL_SERVICE_SECRET, when bolt-api refuses the secret (#248)', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"UNAUTHORIZED"}}');
    });
    process.env.BOLT_API_INTERNAL_URL = await listen(server);
    delete process.env.INTERNAL_SERVICE_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(publishBoltEvent('ticket.created', 'helpdesk', {}, ORG)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(logged.msg).toContain('INTERNAL_SERVICE_SECRET');
    expect(logged).toMatchObject({ source: 'helpdesk', internal_service_secret_set: false });
  });

  it('never throws when bolt-api is unreachable', async () => {
    process.env.BOLT_API_INTERNAL_URL = 'http://127.0.0.1:1';
    await expect(publishBoltEvent('thing.happened', 'bam', {}, ORG)).resolves.toBeUndefined();
  });

  it('publishBoltEvent and publishBoltEventChecked send the identical ingest request (#200)', async () => {
    process.env.BOLT_API_INTERNAL_URL = 'http://bolt-api:4006';
    process.env.INTERNAL_SERVICE_SECRET = 's'.repeat(32);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 202 }));
    await publishBoltEvent('thing.happened', 'bam', { a: 1 }, ORG, 'u1');
    expect(await publishBoltEventChecked('thing.happened', 'bam', { a: 1 }, ORG, 'u1')).toEqual({ ok: true, status: 202 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [a, b] = fetchSpy.mock.calls.map(([url, init]) => ({ url, headers: init?.headers, body: init?.body, method: init?.method }));
    expect(a).toEqual(b);
    expect(JSON.parse(String(a!.body))).toEqual({ event_type: 'thing.happened', source: 'bam', payload: { a: 1 }, org_id: ORG, actor_id: 'u1', actor_type: 'user' });
  });

  it('sends dotted payload keys as nested objects, the shape Bolt reads (#316)', async () => {
    process.env.BOLT_API_INTERNAL_URL = 'http://bolt-api:4006';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 202 }));
    const payload = { 'diagram.id': 'd1', 'diagram.name': 'Map', 'org.id': ORG, node_count: 3 };
    await publishBoltEvent('diagram.generated', 'blueprint', payload, ORG);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.payload).toEqual({ diagram: { id: 'd1', name: 'Map' }, org: { id: ORG }, node_count: 3 });
    // The caller's object is not mutated.
    expect(payload).toEqual({ 'diagram.id': 'd1', 'diagram.name': 'Map', 'org.id': ORG, node_count: 3 });
  });

  it('publishBoltEventChecked reports a timeout as timedOut with no status', async () => {
    server = createServer(() => {
      // never answers
    });
    process.env.BOLT_API_INTERNAL_URL = await listen(server);
    process.env.BOLT_PUBLISH_TIMEOUT_MS = '100';
    expect(await publishBoltEventChecked('thing.happened', 'bam', {}, ORG)).toMatchObject({ ok: false, status: null, timedOut: true, timeoutMs: 100 });
  });
});

describe('nestBoltPayload (#316)', () => {
  it('merges dotted keys into an existing nested object without mutating it', () => {
    const actor = { id: 'u1' };
    const out = nestBoltPayload({ actor, 'actor.name': 'Skipper', 'board.id': 'b1', 'board.project.id': 'p1' });
    expect(out).toEqual({ actor: { id: 'u1', name: 'Skipper' }, board: { id: 'b1', project: { id: 'p1' } } });
    expect(actor).toEqual({ id: 'u1' });
  });

  it('leaves keys it cannot nest: a collision with a scalar, an existing leaf, empty or unsafe segments', () => {
    expect(nestBoltPayload({ org: 'acme', 'org.id': 'o1' })).toEqual({ org: 'acme', 'org.id': 'o1' });
    expect(nestBoltPayload({ org: { id: 'a' }, 'org.id': 'b' })).toEqual({ org: { id: 'a' }, 'org.id': 'b' });
    expect(nestBoltPayload({ 'a..b': 1, '__proto__.x': 2 })).toEqual({ 'a..b': 1, '__proto__.x': 2 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not touch dotted keys below the top level or non-dotted payloads', () => {
    const p = { changes: { 'board.name': 'x' }, list: [{ 'a.b': 1 }] };
    expect(nestBoltPayload(p)).toEqual(p);
  });
});
