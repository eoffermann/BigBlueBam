// Bureau troubleshooting pass (2026-06-10) — unit tests for ring.service.
//
// The headline regression this file guards: the outbound ring frame's
// envelope type MUST be 'ring_incoming'. The bureau-client SDK subscribes
// with client.on('ring_incoming', ...) (packages/bureau-client/src/
// ring-handler.tsx); the service originally published `type: 'ring'`,
// which no client listened for — every ring silently vanished and the
// IncomingCallOverlay never rendered.
//
// Also covered: the short-lived Redis ring record (bureau:ring:{token})
// and its one-shot consumption via takeRingRecord, which the WS hub's
// ring_respond handler uses to validate + route `ring_responded` back to
// the caller.

import { describe, it, expect, beforeEach } from 'vitest';

import { ringUser, takeRingRecord } from '../src/services/ring.service.js';

// ─────────────────────────────────────────────────────────────────────
// Minimal ioredis mock: string SET/GET/DEL with EX accepted-but-ignored,
// plus publish capture.
// ─────────────────────────────────────────────────────────────────────

class MockRedis {
  strings = new Map<string, string>();
  published: Array<{ channel: string; message: string }> = [];

  async set(
    key: string,
    value: string,
    _ex?: string,
    _ttl?: number,
  ): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }
}

describe('ring.service — ringUser', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = new MockRedis();
  });

  it("publishes a 'ring_incoming' envelope (NOT 'ring') on the recipient's user channel", async () => {
    await ringUser(
      redis as never,
      'from-1',
      'Eddie',
      'to-1',
      'org-1',
      'brief',
      'doc-123',
      'Q3 Roadmap',
    );

    expect(redis.published).toHaveLength(1);
    const { channel, message } = redis.published[0]!;
    expect(channel).toBe('user:to-1');

    const envelope = JSON.parse(message) as {
      type: string;
      data: Record<string, unknown>;
    };
    // This is the exact string the bureau-client RingHandler subscribes to.
    expect(envelope.type).toBe('ring_incoming');
    expect(envelope.data.type).toBe('ring_incoming');
    expect(envelope.data.from_user_id).toBe('from-1');
    expect(envelope.data.from_user_name).toBe('Eddie');
    expect(envelope.data.surface_app).toBe('brief');
    expect(envelope.data.surface_id).toBe('doc-123');
    expect(envelope.data.surface_label).toBe('Q3 Roadmap');
    expect(typeof envelope.data.ring_token).toBe('string');
    expect(typeof envelope.data.expires_at).toBe('string');
  });

  it('returns the ring_token + expires_at + delivered count', async () => {
    const result = await ringUser(
      redis as never,
      'from-1',
      'Eddie',
      'to-1',
      'org-1',
      'board',
      'b-1',
      null,
    );
    expect(result.ring_token.length).toBeGreaterThan(0);
    expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now());
    expect(result.delivered).toBe(1);
  });

  it('stores a server-side ring record keyed by the token', async () => {
    const { ring_token } = await ringUser(
      redis as never,
      'from-1',
      'Eddie',
      'to-1',
      'org-1',
      'bond',
      'deal-9',
      null,
    );
    const raw = redis.strings.get(`bureau:ring:${ring_token}`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      fromUserId: 'from-1',
      toUserId: 'to-1',
      orgId: 'org-1',
      surfaceApp: 'bond',
      surfaceId: 'deal-9',
    });
  });
});

describe('ring.service — takeRingRecord', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = new MockRedis();
  });

  it('returns the record once, then null (one-shot respond)', async () => {
    const { ring_token } = await ringUser(
      redis as never,
      'from-1',
      'Eddie',
      'to-1',
      'org-1',
      'brief',
      'doc-1',
      null,
    );

    const first = await takeRingRecord(redis as never, ring_token);
    expect(first).toEqual({
      fromUserId: 'from-1',
      toUserId: 'to-1',
      orgId: 'org-1',
      surfaceApp: 'brief',
      surfaceId: 'doc-1',
    });

    // Second respond (other device, replay, forgery) finds nothing.
    expect(await takeRingRecord(redis as never, ring_token)).toBeNull();
  });

  it('returns null for unknown or empty tokens', async () => {
    expect(await takeRingRecord(redis as never, 'nope')).toBeNull();
    expect(await takeRingRecord(redis as never, '')).toBeNull();
  });

  it('consumes-and-rejects corrupt records', async () => {
    redis.strings.set('bureau:ring:bad', '{not json');
    expect(await takeRingRecord(redis as never, 'bad')).toBeNull();
    expect(redis.strings.has('bureau:ring:bad')).toBe(false);
  });
});
