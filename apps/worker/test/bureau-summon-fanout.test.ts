import { describe, it, expect, vi, beforeEach } from 'vitest';

// #330: a transient outage of the app that answers the access check used to
// flip every pending recipient to a FINAL no_access and complete the job, so
// nobody was summoned and nothing retried. Checks were serial at 4 s each.

const { execute, resolveCrossAppAccess, publishBoltEvent } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveCrossAppAccess: vi.fn(),
  publishBoltEvent: vi.fn(async () => {}),
}));

vi.mock('../src/utils/db.js', () => ({ getDb: () => ({ execute }) }));
vi.mock('../src/utils/bolt-events.js', () => ({ publishBoltEvent }));
vi.mock('@bigbluebam/shared/cross-app-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bigbluebam/shared/cross-app-access')>()),
  resolveCrossAppAccess,
}));

import {
  processBureauSummonFanoutJob,
  SummonFanoutDegradedError,
  type BureauSummonFanoutJobData,
} from '../src/jobs/bureau-summon-fanout.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SUMMONER = '22222222-2222-4222-8222-222222222222';
const SUMMON = '33333333-3333-4333-8333-333333333333';
const env = {
  INTERNAL_SERVICE_SECRET: 's',
  BBB_API_INTERNAL_URL: 'http://api:4000',
  BOARD_INTERNAL_URL: 'http://board-api:4008',
  BRIEF_INTERNAL_URL: 'http://brief-api:4005',
} as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const ALLOW = { allowed: true, canShare: false, reason: 'allowed' };
const DENY = { allowed: false, canShare: false, reason: 'not_a_member' };
const DOWN = { allowed: false, canShare: false, reason: 'degraded_http_error', degraded: true };

type Recipient = { userId: string; outcome: string; reason?: string | null };

let row: { recipients: Recipient[] };
let persisted: Recipient[] | null;

function setupDb(recipients: Recipient[]) {
  row = { recipients };
  persisted = null;
  execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(query.queryChunks ?? '');
    if (text.includes('FROM bureau_summons')) {
      return [
        {
          id: SUMMON,
          org_id: ORG,
          summoner_id: SUMMONER,
          summoner_name: 'Skipper',
          from_room_id: null,
          target_url: '/board/boards/lagoon',
          target_app: 'board',
          target_label: 'Lagoon map',
          livekit_room_hint: null,
          recipients: JSON.parse(JSON.stringify(row.recipients)),
        },
      ];
    }
    if (text.includes('bureau_settings')) return [];
    if (text.includes('UPDATE bureau_summons')) {
      const json = (query.queryChunks ?? []).find((c) => typeof c === 'string' && c.startsWith('[')) as string;
      persisted = JSON.parse(json);
      row.recipients = persisted!;
      return [];
    }
    return [];
  });
}

function makeJob(attemptsMade: number, data: Partial<BureauSummonFanoutJobData> = {}) {
  const job = {
    id: 'j1',
    data: { summonId: SUMMON, orgId: ORG, summonerId: SUMMONER, ...data } as BureauSummonFanoutJobData,
    opts: { attempts: 5 },
    attemptsMade,
    updateData: vi.fn(async (d: BureauSummonFanoutJobData) => {
      job.data = d;
    }),
  };
  return job;
}

const recipients = (n: number): Recipient[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, outcome: 'pending' }));

const incomingTo = (redis: { publish: ReturnType<typeof vi.fn> }) =>
  redis.publish.mock.calls
    .filter(([, payload]) => JSON.parse(payload as string).type === 'summon_incoming')
    .map(([channel]) => channel as string);

describe('bureau summon fan-out (#330)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps recipients pending and throws when the access check is unavailable, then succeeds on retry', async () => {
    setupDb(recipients(12));
    const redis = { publish: vi.fn(async () => 1) };

    // Attempt 1: the board api answers 503.
    resolveCrossAppAccess.mockResolvedValue(DOWN);
    const job = makeJob(0);
    await expect(processBureauSummonFanoutJob(job as never, redis as never, env, logger)).rejects.toBeInstanceOf(
      SummonFanoutDegradedError,
    );
    expect(row.recipients.every((r) => r.outcome === 'pending')).toBe(true);
    expect(row.recipients.some((r) => r.outcome === 'no_access')).toBe(false);
    expect(publishBoltEvent).not.toHaveBeenCalled();
    expect(incomingTo(redis)).toEqual([]);
    // It stopped asking once the peer was known down instead of waiting out 12 timeouts.
    expect(resolveCrossAppAccess.mock.calls.length).toBeLessThanOrEqual(8);

    // Attempt 2: the peer is back.
    resolveCrossAppAccess.mockReset();
    resolveCrossAppAccess.mockResolvedValue(ALLOW);
    job.attemptsMade = 1;
    await processBureauSummonFanoutJob(job as never, redis as never, env, logger);
    expect(incomingTo(redis).sort()).toEqual(recipients(12).map((r) => `user:${r.userId}`).sort());
    expect(row.recipients.every((r) => r.outcome === 'pending' && !r.reason)).toBe(true);
    expect(publishBoltEvent).toHaveBeenCalledTimes(1);
  });

  it('never notifies a recipient twice across a retry', async () => {
    setupDb(recipients(4));
    const redis = { publish: vi.fn(async () => 1) };
    // u0 and u1 allowed; u2 hits the outage; u3 is never checked.
    resolveCrossAppAccess.mockImplementation(async ({ userId }: { userId: string }) =>
      userId === 'u2' ? DOWN : ALLOW,
    );
    const job = makeJob(0);
    await expect(
      processBureauSummonFanoutJob(job as never, redis as never, env, logger, { checkConcurrency: 1 }),
    ).rejects.toBeInstanceOf(SummonFanoutDegradedError);
    expect(incomingTo(redis)).toEqual(['user:u0', 'user:u1']);
    expect(job.data.notifiedUserIds).toEqual(['u0', 'u1']);

    resolveCrossAppAccess.mockReset();
    resolveCrossAppAccess.mockResolvedValue(ALLOW);
    redis.publish.mockClear();
    job.attemptsMade = 1;
    await processBureauSummonFanoutJob(job as never, redis as never, env, logger, { checkConcurrency: 1 });
    expect(incomingTo(redis)).toEqual(['user:u2', 'user:u3']);
  });

  it('records a real deny as final no_access and completes', async () => {
    setupDb(recipients(2));
    const redis = { publish: vi.fn(async () => 1) };
    resolveCrossAppAccess.mockImplementation(async ({ userId }: { userId: string }) => (userId === 'u0' ? DENY : ALLOW));
    await processBureauSummonFanoutJob(makeJob(0) as never, redis as never, env, logger);
    expect(row.recipients.find((r) => r.userId === 'u0')).toMatchObject({ outcome: 'no_access', reason: 'not_a_member' });
    expect(incomingTo(redis)).toEqual(['user:u1']);
    expect(publishBoltEvent).toHaveBeenCalledTimes(1);
  });

  it('re-checks a recipient planSummon recorded as a degraded no_access', async () => {
    setupDb([{ userId: 'u0', outcome: 'no_access', reason: 'degraded_timeout' }, { userId: 'u1', outcome: 'pending' }]);
    const redis = { publish: vi.fn(async () => 1) };
    resolveCrossAppAccess.mockResolvedValue(ALLOW);
    await processBureauSummonFanoutJob(makeJob(0) as never, redis as never, env, logger);
    expect(incomingTo(redis).sort()).toEqual(['user:u0', 'user:u1']);
    expect(row.recipients.find((r) => r.userId === 'u0')).toMatchObject({ outcome: 'pending', reason: null });
  });

  it('on the last attempt records access_check_unavailable and completes instead of looping', async () => {
    setupDb(recipients(3));
    const redis = { publish: vi.fn(async () => 1) };
    resolveCrossAppAccess.mockResolvedValue(DOWN);
    await processBureauSummonFanoutJob(makeJob(4) as never, redis as never, env, logger);
    expect(row.recipients.every((r) => r.outcome === 'no_access' && r.reason === 'access_check_unavailable')).toBe(true);
    expect(publishBoltEvent).toHaveBeenCalledTimes(1);
  });

  it('runs checks concurrently, bounded by the concurrency limit', async () => {
    setupDb(recipients(20));
    const redis = { publish: vi.fn(async () => 1) };
    let inFlight = 0;
    let peak = 0;
    resolveCrossAppAccess.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ALLOW;
    });
    await processBureauSummonFanoutJob(makeJob(0) as never, redis as never, env, logger, { checkConcurrency: 4 });
    expect(peak).toBe(4);
    expect(incomingTo(redis)).toHaveLength(20);
  });
});
