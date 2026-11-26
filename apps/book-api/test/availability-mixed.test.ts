import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// §18 Wave 5 misc — mixed availability service tests
// ---------------------------------------------------------------------------
//
// Exercises findMeetingTimeForMixedRoster across three scenarios:
//   1. humans-only roster → conflict check runs for every attendee.
//   2. mixed roster with respect_working_hours_for_humans_only=true → agents
//      and service accounts are dropped from the conflict intersection.
//   3. agent-only roster → the full window is a single slot regardless of
//      calendar state.
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    execute: mockExecute,
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4012,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    PUBLIC_URL: 'http://localhost',
    COOKIE_SECURE: false,
  },
}));

// ---------------------------------------------------------------------------
// Chain helpers — drizzle's fluent builder returns `this`-like objects on
// every call; the test lets callers preset the final awaited result per chain.
// ---------------------------------------------------------------------------

function makeChain(result: unknown[]): any {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.limit = vi.fn().mockResolvedValue(result);
  return obj;
}

const HUMAN_A = '11111111-1111-1111-1111-111111111111';
const HUMAN_B = '22222222-2222-2222-2222-222222222222';
const AGENT = '33333333-3333-3333-3333-333333333333';
const SERVICE = '44444444-4444-4444-4444-444444444444';

describe('findMeetingTimeForMixedRoster (§18 Wave 5)', () => {
  let service: typeof import('../src/services/availability.service.js');
  let schema: typeof import('../src/db/schema/index.js');
  let refs: typeof import('../src/db/schema/bbb-refs.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSelect.mockReset();
    vi.resetModules();
    service = await import('../src/services/availability.service.js');
    // Same module instances the service just loaded, so table identity matches.
    schema = await import('../src/db/schema/index.js');
    refs = await import('../src/db/schema/bbb-refs.js');
  });

  /**
   * Answer db.select() by the table passed to .from(), not by call order.
   * Working-hours rows are handed out per call in roster order: each concurrent
   * getAvailability() issues its working-hours query synchronously, in map order,
   * before its first await. Events and external events are always empty here.
   */
  function routeSelects(plan: { kinds: unknown[]; workingHours?: unknown[][] }): string[] {
    const wh = [...(plan.workingHours ?? [])];
    const calls: string[] = [];
    mockSelect.mockImplementation(() => {
      let result: unknown[] = [];
      const chain: any = {};
      chain.from = vi.fn((table: unknown) => {
        if (table === refs.users) {
          calls.push('kinds');
          result = plan.kinds;
        } else if (table === schema.bookWorkingHours) {
          calls.push('working_hours');
          result = wh.shift() ?? [];
        } else if (table === schema.bookEvents) {
          calls.push('events');
          result = [];
        } else if (table === schema.bookExternalEvents) {
          calls.push('external');
          result = [];
        } else {
          throw new Error('availability-mixed test: unexpected table');
        }
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(async () => result);
      chain.then = (resolve: Function, reject?: Function) =>
        Promise.resolve(result).then(resolve as any, reject as any);
      return chain;
    });
    return calls;
  }

  // These three tests used to be it.skip'd as "test-fixture debt": they queued
  // one mock result per db.select() call in a fixed order, but the service pulls
  // every human's availability concurrently (Promise.all), so the calls
  // interleave and each user received another query's rows. routeSelects()
  // below answers by TABLE instead, which is order-independent.
  it('humans-only roster: runs the normal availability intersection', async () => {
    // HUMAN_A and HUMAN_B both work Mon-Fri 09:00-17:00 with no events.
    const calls = routeSelects({
      kinds: [
        { id: HUMAN_A, kind: 'human' },
        { id: HUMAN_B, kind: 'human' },
      ],
      workingHours: [workingHoursRowsForWeek(), workingHoursRowsForWeek()],
    });

    const result = await service.findMeetingTimeForMixedRoster({
      user_ids: [HUMAN_A, HUMAN_B],
      duration_minutes: 30,
      window: {
        since: '2026-04-20T00:00:00Z',
        until: '2026-04-21T00:00:00Z',
      },
    });

    expect(result.slots.length).toBeGreaterThan(0);
    // Every slot must list both humans as attendees marked available.
    for (const slot of result.slots) {
      expect(slot.attendees).toHaveLength(2);
      expect(slot.attendees.map((a) => a.user_id).sort()).toEqual(
        [HUMAN_A, HUMAN_B].sort(),
      );
      expect(slot.attendees.every((a) => a.kind === 'human')).toBe(true);
      expect(slot.attendees.every((a) => a.available)).toBe(true);
    }
    // 1 kinds lookup + 3 selects per human.
    expect(calls.sort()).toEqual(
      ['kinds', 'working_hours', 'working_hours', 'events', 'events', 'external', 'external'].sort(),
    );
    // Slots are 30-minute meetings inside Monday 09:00-17:00 UTC.
    expect(result.slots[0]!.start).toBe('2026-04-20T09:00:00.000Z');
  });

  it('mixed roster: agents and service accounts are skipped from conflict detection', async () => {
    // resolveUserKinds says HUMAN_A is human, AGENT is agent, SERVICE is service.
    // Then only HUMAN_A's calendar is consulted.
    routeSelects({
      kinds: [
        { id: HUMAN_A, kind: 'human' },
        { id: AGENT, kind: 'agent' },
        { id: SERVICE, kind: 'service' },
      ],
      // HUMAN_A only
      workingHours: [workingHoursRowsForWeek()],
    });

    const result = await service.findMeetingTimeForMixedRoster({
      user_ids: [HUMAN_A, AGENT, SERVICE],
      duration_minutes: 30,
      window: {
        since: '2026-04-20T00:00:00Z',
        until: '2026-04-21T00:00:00Z',
      },
      respect_working_hours_for_humans_only: true,
    });

    expect(result.slots.length).toBeGreaterThan(0);
    // Precisely one extra select should have been consumed per human, plus
    // the one initial kinds-resolution query. 1 + (3 selects per human) = 4.
    expect(mockSelect).toHaveBeenCalledTimes(4);
    // Attendees: HUMAN_A labeled 'human', AGENT labeled 'agent', SERVICE labeled 'service'.
    for (const slot of result.slots) {
      const byId = new Map(slot.attendees.map((a) => [a.user_id, a]));
      expect(byId.get(HUMAN_A)?.kind).toBe('human');
      expect(byId.get(AGENT)?.kind).toBe('agent');
      expect(byId.get(SERVICE)?.kind).toBe('service');
      expect(byId.get(AGENT)?.available).toBe(true);
      expect(byId.get(SERVICE)?.available).toBe(true);
    }
  });

  it('agent-only roster: returns the full window as a single slot', async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([
        { id: AGENT, kind: 'agent' },
        { id: SERVICE, kind: 'service' },
      ]),
    );

    const result = await service.findMeetingTimeForMixedRoster({
      user_ids: [AGENT, SERVICE],
      duration_minutes: 30,
      window: {
        since: '2026-04-20T00:00:00Z',
        until: '2026-04-21T00:00:00Z',
      },
    });

    // Only the resolveUserKinds call should have hit the db; no human
    // availability pull since there are no humans in the roster.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]!.start).toBe('2026-04-20T00:00:00Z');
    expect(result.slots[0]!.end).toBe('2026-04-21T00:00:00Z');
    expect(result.slots[0]!.attendees).toHaveLength(2);
    expect(result.slots[0]!.attendees.every((a) => a.available)).toBe(true);
  });

  it('agent-only roster with window smaller than duration returns no slots', async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ id: AGENT, kind: 'agent' }]));

    const result = await service.findMeetingTimeForMixedRoster({
      user_ids: [AGENT],
      duration_minutes: 60,
      window: {
        since: '2026-04-20T00:00:00Z',
        until: '2026-04-20T00:30:00Z',
      },
    });

    expect(result.slots).toHaveLength(0);
  });

  it('respect_working_hours_for_humans_only=false treats everyone as human', async () => {
    // Both IDs go through the per-user availability pull. AGENT is now treated
    // like a human and has no working hours configured, so it has no slots and
    // the intersection with HUMAN_A is empty.
    routeSelects({
      kinds: [
        { id: HUMAN_A, kind: 'human' },
        { id: AGENT, kind: 'agent' },
      ],
      workingHours: [workingHoursRowsForWeek(), []],
    });

    const result = await service.findMeetingTimeForMixedRoster({
      user_ids: [HUMAN_A, AGENT],
      duration_minutes: 30,
      window: {
        since: '2026-04-20T00:00:00Z',
        until: '2026-04-21T00:00:00Z',
      },
      respect_working_hours_for_humans_only: false,
    });

    // 1 (kinds) + 3 for HUMAN_A + 1 for AGENT: getAvailability returns as soon
    // as a user has no working hours, before the two event queries.
    expect(mockSelect).toHaveBeenCalledTimes(5);
    // AGENT had no working hours, so intersection with HUMAN_A is empty.
    expect(result.slots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workingHoursRowsForWeek() {
  // Monday-Friday 09:00-17:00 UTC. The 2026-04-20 test window starts on
  // Monday, so at least one working-hours row must match the day_of_week.
  return [1, 2, 3, 4, 5].map((d) => ({
    id: `wh-${d}`,
    user_id: '',
    day_of_week: d,
    start_time: '09:00:00',
    end_time: '17:00:00',
    timezone: 'UTC',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  }));
}
