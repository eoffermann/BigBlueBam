import { describe, it, expect, vi } from 'vitest';

// #330: the worker throws on a degraded access check so BullMQ retries it. That only works if
// the job is enqueued with attempts and backoff; without them the first attempt is also the last
// and the worker records access_check_unavailable for everyone.

const { add } = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: 'j1' })) }));
vi.mock('bullmq', () => ({ Queue: vi.fn().mockImplementation(() => ({ add })) }));
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    BBB_API_INTERNAL_URL: 'http://api',
    BOARD_INTERNAL_URL: 'http://board',
    BRIEF_INTERNAL_URL: 'http://brief',
    BBB_PERMISSIONS_ENFORCE: 'off',
  },
}));
vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));
vi.mock('../src/services/cross-app-access.service.js', () => ({ resolveAccess: vi.fn() }));
vi.mock('../src/lib/bureau-events.js', () => ({ emitSummonIssued: vi.fn() }));
vi.mock('../src/services/presence-publisher.service.js', () => ({ publishUserTarget: vi.fn() }));

const { fanOutSummon, FANOUT_INLINE_LIMIT, SUMMON_FANOUT_ATTEMPTS } = await import('../src/services/summon.service.js');

describe('fanOutSummon offload', () => {
  it('enqueues the fan-out job with retries and exponential backoff', async () => {
    const recipients = Array.from({ length: FANOUT_INLINE_LIMIT + 1 }, (_, i) => ({
      userId: `u${i}`,
      name: null,
      outcome: 'pending' as const,
    }));
    await fanOutSummon({
      redis: {} as never,
      summonId: 's1',
      orgId: 'o1',
      summonerId: 'u-summoner',
      targetUrl: '/board/boards/x',
      targetApp: 'board',
      recipients,
    } as never);
    expect(add).toHaveBeenCalledTimes(1);
    const opts = (add.mock.calls[0] as unknown as [string, unknown, { attempts: number; backoff: { type: string } }])[2];
    expect(SUMMON_FANOUT_ATTEMPTS).toBeGreaterThan(1);
    expect(opts.attempts).toBe(SUMMON_FANOUT_ATTEMPTS);
    expect(opts.backoff.type).toBe('exponential');
  });
});
