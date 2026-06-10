// Unit tests for the surface-huddle symmetric-auth gate
// (bureau troubleshooting 2026-06-10): isUserOnSurface / its grace-polled
// wrapper. These pin the cross-org eavesdropping fix — a caller may only
// mint a huddle token for a surface they actually have a live, org-scoped
// presence session on.

import { describe, it, expect, vi } from 'vitest';
import {
  isUserOnSurface,
  isUserOnSurfaceWithGrace,
} from '../src/services/surface-presence.service.js';

// ─────────────────────────────────────────────────────────────────────
// Minimal ioredis mock — only smembers + pipeline().hmget().exec().
// ─────────────────────────────────────────────────────────────────────

interface Session {
  orgId: string;
  locationApp: string;
  locationUrl: string;
}

function makeRedis(
  userSessions: Record<string, string[]>,
  sessions: Record<string, Session>,
) {
  return {
    async smembers(key: string): Promise<string[]> {
      // key shape: bureau:user:{userId}:sessions
      const userId = key.split(':')[2];
      return userSessions[userId] ?? [];
    },
    pipeline() {
      const ops: string[] = [];
      const api = {
        hmget(key: string, ..._fields: string[]) {
          // key shape: bureau:sess:{sessionId}
          ops.push(key.split(':')[2]!);
          return api;
        },
        async exec(): Promise<Array<[Error | null, Array<string | null>]>> {
          return ops.map((sid) => {
            const s = sessions[sid];
            if (!s) return [null, [null, null, null]] as [null, Array<string | null>];
            return [null, [s.orgId, s.locationApp, s.locationUrl]] as [
              null,
              Array<string | null>,
            ];
          });
        },
      };
      return api;
    },
  } as unknown as import('ioredis').default;
}

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const USER = 'user-a';
const SURFACE_ID = '11111111-1111-4111-8111-111111111111';

describe('isUserOnSurface', () => {
  it('allows a user whose live session reports the matching app + surface id', async () => {
    const redis = makeRedis(
      { [USER]: ['s1'] },
      { s1: { orgId: ORG, locationApp: 'brief', locationUrl: `/brief/d/${SURFACE_ID}` } },
    );
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', SURFACE_ID)).toBe(true);
  });

  it('denies when the user has no live session at all (cross-org probe)', async () => {
    const redis = makeRedis({}, {});
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', SURFACE_ID)).toBe(false);
  });

  it('denies when the session belongs to a different org (cross-org id collision)', async () => {
    const redis = makeRedis(
      { [USER]: ['s1'] },
      { s1: { orgId: OTHER_ORG, locationApp: 'brief', locationUrl: `/brief/d/${SURFACE_ID}` } },
    );
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', SURFACE_ID)).toBe(false);
  });

  it('denies when the app matches but the surface id is not in the url', async () => {
    const redis = makeRedis(
      { [USER]: ['s1'] },
      { s1: { orgId: ORG, locationApp: 'brief', locationUrl: '/brief/d/some-other-doc' } },
    );
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', SURFACE_ID)).toBe(false);
  });

  it('denies when the surface id matches but the app differs', async () => {
    const redis = makeRedis(
      { [USER]: ['s1'] },
      { s1: { orgId: ORG, locationApp: 'board', locationUrl: `/board/c/${SURFACE_ID}` } },
    );
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', SURFACE_ID)).toBe(false);
  });

  it('fails closed on empty inputs', async () => {
    const redis = makeRedis({ [USER]: ['s1'] }, { s1: { orgId: ORG, locationApp: 'brief', locationUrl: `/x/${SURFACE_ID}` } });
    expect(await isUserOnSurface(redis, '', ORG, 'brief', SURFACE_ID)).toBe(false);
    expect(await isUserOnSurface(redis, USER, '', 'brief', SURFACE_ID)).toBe(false);
    expect(await isUserOnSurface(redis, USER, ORG, '', SURFACE_ID)).toBe(false);
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', '')).toBe(false);
  });
});

describe('isUserOnSurfaceWithGrace', () => {
  it('returns immediately when the session is already present (no delay)', async () => {
    const redis = makeRedis(
      { [USER]: ['s1'] },
      { s1: { orgId: ORG, locationApp: 'brief', locationUrl: `/brief/d/${SURFACE_ID}` } },
    );
    const ok = await isUserOnSurfaceWithGrace(redis, USER, ORG, 'brief', SURFACE_ID, {
      attempts: 4,
      delayMs: 50,
    });
    expect(ok).toBe(true);
  });

  it('recovers when the session lands mid-grace (simulated WS race)', async () => {
    let landed = false;
    // smembers returns the session only after the first poll, mimicking the
    // location_update arriving over WS just after the REST mint.
    const redis = {
      async smembers(_key: string): Promise<string[]> {
        return landed ? ['s1'] : [];
      },
      pipeline() {
        const api = {
          hmget(_key: string, ..._f: string[]) {
            return api;
          },
          async exec() {
            return [[null, [ORG, 'brief', `/brief/d/${SURFACE_ID}`]]];
          },
        };
        return api;
      },
    } as unknown as import('ioredis').default;
    setTimeout(() => {
      landed = true;
    }, 120);
    const ok = await isUserOnSurfaceWithGrace(redis, USER, ORG, 'brief', SURFACE_ID, {
      attempts: 5,
      delayMs: 80,
    });
    expect(ok).toBe(true);
  });

  it('gives up after exhausting attempts when never present (cross-org)', async () => {
    const redis = makeRedis({}, {});
    const spy = vi.fn();
    const ok = await isUserOnSurfaceWithGrace(redis, USER, ORG, 'brief', SURFACE_ID, {
      attempts: 3,
      delayMs: 1,
    });
    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
