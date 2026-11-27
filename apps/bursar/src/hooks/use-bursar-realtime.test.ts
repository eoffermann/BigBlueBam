import { describe, expect, it } from 'vitest';
import { parseBursarFrame } from './use-bursar-realtime';

// #374: the SPA re-declared the /bursar/ws frame as `type: string`, so a rename on either side
// compiled and silently turned realtime off. It now parses against @bigbluebam/shared's contract.
const REQ = 'request:33333333-3333-4333-8333-333333333333';

describe('parseBursarFrame', () => {
  it('accepts the event frames bursar-api publishes', () => {
    const f = parseBursarFrame(
      JSON.stringify({ type: 'leveling.progress', room: REQ, payload: { run_id: 'r1', status: 'running', done: false, offer: 1, offer_count: 3 } }),
    );
    expect(f?.type).toBe('leveling.progress');
    if (f?.type === 'leveling.progress') expect(f.payload.offer_count).toBe(3);
    expect(parseBursarFrame(JSON.stringify({ type: 'matrix.updated', room: REQ, payload: { run_id: 'r1', done: true } }))?.type).toBe(
      'matrix.updated',
    );
  });

  it('accepts the hub control frames', () => {
    expect(parseBursarFrame(JSON.stringify({ type: 'ready', rooms: [REQ] }))?.type).toBe('ready');
    expect(parseBursarFrame(JSON.stringify({ type: 'subscribed', rooms: [REQ], joined: [] }))?.type).toBe('subscribed');
    expect(
      parseBursarFrame(
        JSON.stringify({ type: 'error', code: 'PERMISSION_DENIED', frame_type: 'subscribe', permission_id: 'bursar.request.read', message: 'no' }),
      )?.type,
    ).toBe('error');
  });

  it('drops unknown types, malformed payloads and non-JSON', () => {
    expect(parseBursarFrame(JSON.stringify({ type: 'leveling.progres', room: REQ, payload: {} }))).toBeNull();
    expect(parseBursarFrame(JSON.stringify({ type: 'leveling.progress', room: REQ, payload: { offer: 'one' } }))).toBeNull();
    expect(parseBursarFrame('ping')).toBeNull();
  });
});
