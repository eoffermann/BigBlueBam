import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOLT_PUBLISH_TIMEOUT_DEFAULT_MS,
  publishBoltEvent,
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

  it('never throws when bolt-api is unreachable', async () => {
    process.env.BOLT_API_INTERNAL_URL = 'http://127.0.0.1:1';
    await expect(publishBoltEvent('thing.happened', 'bam', {}, ORG)).resolves.toBeUndefined();
  });
});
