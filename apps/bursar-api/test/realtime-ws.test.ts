import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #121: the Bursar SPA connects to /bursar/ws (spec 11.1) but bursar-api served no
// WebSocket. These cover the hub's authorization and fan-out and the publisher frames the SPA's
// useBursarRealtime parses ({ type, room, payload }).

vi.mock('../src/env.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../src/services/requests.service.js', () => ({ getRequest: vi.fn() }));
vi.mock('../src/plugins/auth.js', () => ({ requireAuth: vi.fn() }));

const { authorizeRooms, fanOut, MAX_ROOMS_PER_SOCKET } = await import('../src/ws/bursar-ws.js');
const realtime = await import('../src/lib/realtime.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const FOREIGN_REQ = '44444444-4444-4444-8444-444444444444';
const VENDOR = '55555555-5555-4555-8555-555555555555';

const viewer = { id: '66666666-6666-4666-8666-666666666666', org_id: ORG } as never;
const deps = { requestVisible: vi.fn(async (_v: unknown, id: string) => id === REQ) };

describe('bursar ws room authorization (#121)', () => {
  it('joins the caller own org room and visible request rooms only', async () => {
    const rooms = await authorizeRooms(
      viewer,
      [`org:${ORG}`, `org:${OTHER_ORG}`, `request:${REQ}`, `request:${FOREIGN_REQ}`, `vendor:${VENDOR}`, 'request:not-a-uuid', 'garbage'],
      deps,
    );
    expect(rooms).toEqual([`org:${ORG}`, `request:${REQ}`]);
  });

  it('caps rooms per socket, counting rooms already joined', async () => {
    const many = Array.from({ length: 40 }, () => `request:${REQ}`).map((r, i) => r.replace(/.$/, String(i % 10)));
    const allVisible = { requestVisible: vi.fn(async () => true) };
    const rooms = await authorizeRooms(viewer, many, allVisible, MAX_ROOMS_PER_SOCKET - 2);
    expect(rooms.length).toBeLessThanOrEqual(2);
  });

  it('treats a failing visibility check as not visible', async () => {
    const failing = { requestVisible: vi.fn(async () => { throw new Error('db down'); }) };
    expect(await authorizeRooms(viewer, [`request:${REQ}`], failing)).toEqual([]);
  });
});

describe('bursar ws fan-out (#121)', () => {
  const frame = { type: 'leveling.progress' as const, room: `request:${REQ}`, payload: { offer: 1, offer_count: 3 } };

  it('delivers only to sockets of the same org that joined the room', () => {
    const a = { orgId: ORG, rooms: new Set([`request:${REQ}`]), send: vi.fn() };
    const b = { orgId: ORG, rooms: new Set([`org:${ORG}`]), send: vi.fn() };
    const c = { orgId: OTHER_ORG, rooms: new Set([`request:${REQ}`]), send: vi.fn() };
    expect(fanOut([a, b, c], { org_id: ORG, frame })).toBe(1);
    expect(JSON.parse(a.send.mock.calls[0]![0] as string)).toEqual(frame);
    expect(b.send).not.toHaveBeenCalled();
    expect(c.send).not.toHaveBeenCalled();
  });

  it('ignores malformed envelopes and survives a throwing socket', () => {
    const dead = { orgId: ORG, rooms: new Set([`request:${REQ}`]), send: vi.fn(() => { throw new Error('closed'); }) };
    const live = { orgId: ORG, rooms: new Set([`request:${REQ}`]), send: vi.fn() };
    expect(fanOut([dead, live], { org_id: ORG, frame })).toBe(1);
    expect(fanOut([live], { org_id: '', frame } as never)).toBe(0);
    expect(fanOut([live], { org_id: ORG } as never)).toBe(0);
  });
});

describe('bursar realtime publishers (#121)', () => {
  afterEach(() => realtime.__setBursarPublisherForTests(null));

  it('leveling.progress carries offer n/N and is followed by matrix.updated on the request room', async () => {
    const publish = vi.fn(async () => 1);
    realtime.__setBursarPublisherForTests({ publish } as never);
    await realtime.publishLevelingProgress(ORG, REQ, { runId: 'r1', status: 'running', done: false, processedOffer: 0, offerCount: 3 });
    const sent = publish.mock.calls.map((c) => JSON.parse((c as unknown as [string, string])[1]));
    expect((publish.mock.calls[0] as unknown as [string])[0]).toBe(realtime.BURSAR_WS_CHANNEL);
    expect(sent).toEqual([
      { org_id: ORG, frame: { type: 'leveling.progress', room: `request:${REQ}`, payload: { run_id: 'r1', status: 'running', done: false, offer: 1, offer_count: 3 } } },
      { org_id: ORG, frame: { type: 'matrix.updated', room: `request:${REQ}`, payload: { run_id: 'r1', done: false } } },
    ]);
  });

  it('scope.progress carries chunk n/N', async () => {
    const publish = vi.fn(async () => 1);
    realtime.__setBursarPublisherForTests({ publish } as never);
    await realtime.publishScopeProgress(ORG, REQ, { runId: 'd1', status: 'succeeded', done: true, processedChunk: 4, chunkCount: 5 });
    const [, raw] = publish.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(raw).frame).toEqual({
      type: 'scope.progress',
      room: `request:${REQ}`,
      payload: { run_id: 'd1', status: 'succeeded', done: true, chunk: 5, chunk_count: 5 },
    });
  });

  it('never throws when Redis is down', async () => {
    realtime.__setBursarPublisherForTests({ publish: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) } as never);
    await expect(realtime.publishScopeProgress(ORG, REQ, { runId: 'd1', status: 'running', done: false, processedChunk: null, chunkCount: 2 })).resolves.toBeUndefined();
  });
});

describe('bursar-api serves /ws (#121)', () => {
  it('server.ts registers @fastify/websocket and the hub', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
    expect(src).toMatch(/register\(websocket/);
    expect(src).toMatch(/register\(registerBursarWs\)/);
  });
});
