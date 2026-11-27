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
vi.mock('../src/lib/bureau-events.js', () => ({ emitSummonIssued: vi.fn(async () => undefined) }));
vi.mock('../src/services/presence-publisher.service.js', () => ({ publishUserTarget: vi.fn() }));

const { fanOutSummon, reportDenials, FANOUT_INLINE_LIMIT, SUMMON_FANOUT_ATTEMPTS } = await import(
  '../src/services/summon.service.js'
);
const { publishUserTarget } = await import('../src/services/presence-publisher.service.js');

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

  // #341: a small summon (<= FANOUT_INLINE_LIMIT) used to fan out inline even when a
  // recipient's access check was UNAVAILABLE, recording it as a final no_access with no retry.
  const few = [{ userId: 'gilligan', name: 'Gilligan', outcome: 'pending' as const }];
  const base = {
    summonId: 's2',
    orgId: 'o1',
    summonerId: 'skipper',
    summonerName: 'Skipper',
    targetUrl: '/board/boards/x',
    targetApp: 'board',
    recipients: few,
  };

  it('offloads a small summon to the retrying worker when an access check was unavailable', async () => {
    add.mockClear();
    const publish = vi.fn(async () => 1);
    await fanOutSummon({
      ...base,
      redis: { publish } as never,
      denied: [{ userId: 'mary-ann', name: 'Mary Ann', outcome: 'no_access', reason: 'degraded_timeout' }],
    } as never);
    expect(add).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps a small summon inline when every deny is a real answer', async () => {
    add.mockClear();
    const publish = vi.fn(async () => 1);
    await fanOutSummon({
      ...base,
      redis: { publish } as never,
      denied: [{ userId: 'mary-ann', name: 'Mary Ann', outcome: 'no_access', reason: 'not_a_collaborator' }],
    } as never);
    expect(add).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not offer an unavailable check to the summoner as a denial to grant', async () => {
    vi.mocked(publishUserTarget).mockClear();
    await reportDenials({
      redis: {} as never,
      summonId: 's3',
      summonerId: 'skipper',
      canShare: true,
      denied: [
        { userId: 'mary-ann', name: 'Mary Ann', outcome: 'no_access', reason: 'degraded_http_error' },
        { userId: 'ginger', name: 'Ginger', outcome: 'no_access', reason: 'not_a_collaborator' },
      ],
    });
    const payload = JSON.stringify(vi.mocked(publishUserTarget).mock.calls[0]);
    expect(payload).toContain('ginger');
    expect(payload).not.toContain('mary-ann');

    vi.mocked(publishUserTarget).mockClear();
    await reportDenials({
      redis: {} as never,
      summonId: 's4',
      summonerId: 'skipper',
      canShare: true,
      denied: [{ userId: 'mary-ann', name: 'Mary Ann', outcome: 'no_access', reason: 'degraded_timeout' }],
    });
    expect(publishUserTarget).not.toHaveBeenCalled();
  });
});
