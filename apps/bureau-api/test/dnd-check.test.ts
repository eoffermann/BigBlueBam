// Workstream 15 — unit tests for the DND aggregator.
//
// Verifies isUserInDnd:
//   - returns false when the user has no live sessions at all,
//   - returns true if ANY of the user's sessions has status='dnd',
//   - returns false when every session reports a non-dnd status,
//   - treats stale/empty HGETs as not-dnd (the safe default per service docs),
//   - returns false for an empty userId (defensive null-guard).
//
// We use a small in-memory ioredis mock with the smembers/hget/pipeline
// surface the service touches.

import { describe, it, expect } from 'vitest';
import { isUserInDnd } from '../src/services/dnd-check.service.js';

class MockRedis {
  // sessions keyed by user.
  sessionsByUser = new Map<string, Set<string>>();
  // session HASHes.
  sessionHash = new Map<string, Map<string, string>>();

  setUserSessions(userId: string, ids: string[]) {
    this.sessionsByUser.set(userId, new Set(ids));
  }
  setSessionStatus(sessionId: string, status: string | null) {
    let hash = this.sessionHash.get(sessionId);
    if (!hash) {
      hash = new Map();
      this.sessionHash.set(sessionId, hash);
    }
    if (status === null) {
      hash.delete('status');
    } else {
      hash.set('status', status);
    }
  }
  /** Wipe the session HASH entirely, simulating a TTL lapse. */
  deleteSession(sessionId: string) {
    this.sessionHash.delete(sessionId);
  }

  async smembers(key: string): Promise<string[]> {
    const m = /^bureau:user:(.+):sessions$/.exec(key);
    if (!m) return [];
    const set = this.sessionsByUser.get(m[1]!);
    return set ? Array.from(set) : [];
  }
  async hget(key: string, field: string): Promise<string | null> {
    const m = /^bureau:sess:(.+)$/.exec(key);
    if (!m) return null;
    const hash = this.sessionHash.get(m[1]!);
    return hash?.get(field) ?? null;
  }
  pipeline() {
    const queued: Array<() => Promise<unknown>> = [];
    const p: any = {};
    p.hget = (key: string, field: string) => {
      queued.push(() => this.hget(key, field));
      return p;
    };
    p.exec = async () => {
      const out: Array<[Error | null, unknown]> = [];
      for (const fn of queued) {
        try {
          out.push([null, await fn()]);
        } catch (e) {
          out.push([e as Error, null]);
        }
      }
      return out;
    };
    return p;
  }
}

describe('isUserInDnd', () => {
  it('returns false for an empty userId (defensive guard)', async () => {
    const r = new MockRedis();
    expect(await isUserInDnd(r as any, '')).toBe(false);
  });

  it('returns false when the user has no live sessions', async () => {
    const r = new MockRedis();
    expect(await isUserInDnd(r as any, 'user-1')).toBe(false);
  });

  it("returns true when ANY of the user's sessions has status='dnd'", async () => {
    const r = new MockRedis();
    r.setUserSessions('user-1', ['sess-web', 'sess-desktop', 'sess-pip']);
    r.setSessionStatus('sess-web', 'available');
    r.setSessionStatus('sess-desktop', 'dnd');
    r.setSessionStatus('sess-pip', 'focus');
    expect(await isUserInDnd(r as any, 'user-1')).toBe(true);
  });

  it("returns true when only one session reports 'dnd'", async () => {
    const r = new MockRedis();
    r.setUserSessions('user-1', ['sess-1']);
    r.setSessionStatus('sess-1', 'dnd');
    expect(await isUserInDnd(r as any, 'user-1')).toBe(true);
  });

  it('returns false when every session reports a non-dnd status', async () => {
    const r = new MockRedis();
    r.setUserSessions('user-1', ['s1', 's2']);
    r.setSessionStatus('s1', 'available');
    r.setSessionStatus('s2', 'in_meeting');
    expect(await isUserInDnd(r as any, 'user-1')).toBe(false);
  });

  it('treats a session whose HASH has lapsed (HGET returns null) as not-dnd', async () => {
    const r = new MockRedis();
    r.setUserSessions('user-1', ['sess-stale', 'sess-live']);
    // sess-stale was reaped but the user-sessions SET still references it.
    r.deleteSession('sess-stale');
    r.setSessionStatus('sess-live', 'available');
    expect(await isUserInDnd(r as any, 'user-1')).toBe(false);
  });

  it('returns true when a non-stale session is dnd alongside a stale one', async () => {
    const r = new MockRedis();
    r.setUserSessions('user-1', ['sess-stale', 'sess-live']);
    r.deleteSession('sess-stale');
    r.setSessionStatus('sess-live', 'dnd');
    expect(await isUserInDnd(r as any, 'user-1')).toBe(true);
  });
});
