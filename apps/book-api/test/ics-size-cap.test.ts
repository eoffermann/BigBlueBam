import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { IcsCalendarProvider } from '../src/services/calendar-providers/ics-provider.js';

// #322: the ICS feed must be size-capped while streaming. A feed that never
// ends must be rejected once it crosses the 5MB cap, not buffered in full
// first (an endless feed would never resolve and would grow memory forever).

const CAP = 5 * 1024 * 1024;
let server: http.Server;
let port = 0;
let endlessBytesSent = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/endless.ics') {
      // No Content-Length: the only way to bound it is to stop reading.
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.write('BEGIN:VCALENDAR\r\n');
      const chunk = Buffer.alloc(64 * 1024, 'X');
      const pump = () => {
        while (!res.destroyed && res.write(chunk)) endlessBytesSent += chunk.length;
        if (!res.destroyed) res.once('drain', pump);
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
      return;
    }
    if (req.url === '/declared-huge.ics') {
      res.writeHead(200, { 'Content-Type': 'text/calendar', 'Content-Length': String(CAP * 4) });
      res.write('BEGIN:VCALENDAR\r\n');
      return; // never finishes; a Content-Length over the cap is refused up front
    }
    if (req.url === '/ok.ics') {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@b\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nSUMMARY:Coconut Count\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  process.env.EGRESS_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const provider = new IcsCalendarProvider();
const fetchFeed = (path: string) =>
  provider.fetchEvents({ feedUrl: `http://127.0.0.1:${port}${path}` } as never, new Date(0), new Date());

describe('ICS feed size cap (#322)', () => {
  it('rejects an endless feed once it crosses the cap, without reading it all', async () => {
    await expect(fetchFeed('/endless.ics')).rejects.toThrow(/Feed too large/);
    // The reader stopped near the cap; socket buffers allow some slack but
    // nowhere near an unbounded read.
    expect(endlessBytesSent).toBeLessThan(CAP * 3);
  });

  it('rejects up front when Content-Length already exceeds the cap', async () => {
    await expect(fetchFeed('/declared-huge.ics')).rejects.toThrow(/Feed too large/);
  });

  it('still parses a normal feed', async () => {
    const events = await fetchFeed('/ok.ics');
    expect(events).toHaveLength(1);
  });
});
