import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkUrl } from '@bigbluebam/egress-guard';
import { IcsCalendarProvider } from '../src/services/calendar-providers/ics-provider.js';

// Issue #247: scripts/seed-gilligan/book-connections.mjs hosts the "Rescue Watch Rota" ICS feed
// on the stack's MinIO and registers it as a Book connection; the connection never reached
// 'active' because book-api's egress guard refuses private feed hosts. This rehearses the
// seeder's exact fixture through book-api's real path (the create-time checkUrl, the sync-time
// safeFetch + parse) with a stand-in for MinIO on a private address, and checks that
// docker-compose.yml allowlists the exact host:port the seeder registers.

const repoRoot = resolve(__dirname, '..', '..', '..');
const seederPath = join(repoRoot, 'scripts', 'seed-gilligan', 'book-connections.mjs');

interface Seeder {
  buildIcs(): string;
  feedUrlFor(endpoint?: string): string;
  DEFAULT_S3_ENDPOINT: string;
  FEED_BUCKET: string;
  FEED_KEY: string;
  ROTA: unknown[];
}

let seeder: Seeder;
let server: Server;
let port: number;

beforeAll(async () => {
  process.env.BBB_SEED_IMPORT_ONLY = '1';
  seeder = (await import(pathToFileURL(seederPath).href)) as Seeder;
  const ics = seeder.buildIcs();
  server = createServer((req, res) => {
    if (req.url === `/${seeder.FEED_BUCKET}/${seeder.FEED_KEY}`) {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(ics);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.BBB_SEED_IMPORT_ONLY;
  await new Promise<void>((r) => server.close(() => r()));
});

const saved = process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
afterEach(() => {
  if (saved === undefined) delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
  else process.env.EGRESS_ALLOW_PRIVATE_HOSTS = saved;
});

describe('GILLIGAN Book connection feed rehearsal (#247)', () => {
  it('without the allowlist the seeded feed is refused: the reported failure', async () => {
    delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    const feedUrl = seeder.feedUrlFor(`http://127.0.0.1:${port}`);
    expect((await checkUrl(feedUrl)).safe).toBe(false);
    await expect(new IcsCalendarProvider().fetchEvents({ feedUrl } as never, new Date(0), new Date())).rejects.toThrow(
      /private\/internal/i,
    );
  });

  it('with the feed host:port allowlisted, create passes and sync imports every rota event', async () => {
    process.env.EGRESS_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
    const feedUrl = seeder.feedUrlFor(`http://127.0.0.1:${port}`);
    expect((await checkUrl(feedUrl)).safe).toBe(true);
    const events = await new IcsCalendarProvider().fetchEvents({ feedUrl } as never, new Date(0), new Date());
    expect(events).toHaveLength(seeder.ROTA.length);
    expect(events.map((e) => (e as { title?: string; summary?: string }).title ?? (e as { summary?: string }).summary)).toContain(
      'Rescue Watch: Dawn Horizon Sweep',
    );
  });

  it("docker-compose.yml allowlists exactly the host:port the seeder registers for book-api", () => {
    const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
    const start = compose.indexOf('\n  book-api:');
    expect(start).toBeGreaterThan(0);
    const next = compose.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = compose.slice(start, next === -1 ? undefined : start + 1 + next);
    const m = /EGRESS_ALLOW_PRIVATE_HOSTS=\$\{EGRESS_ALLOW_PRIVATE_HOSTS-([^}]*)\}/.exec(block);
    expect(m, 'book-api sets an EGRESS_ALLOW_PRIVATE_HOSTS default').not.toBeNull();
    const allowed = m![1]!.split(',').map((s) => s.trim());
    expect(allowed).toContain(new URL(seeder.feedUrlFor(seeder.DEFAULT_S3_ENDPOINT)).host);
  });
});
