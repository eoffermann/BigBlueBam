// Symmetric-auth checks for surface-huddle token mints.
//
// Three match paths, all pinned here:
//   1. id-routed entity surfaces — the entity id appears in the session
//      URL (/brief/documents/{id}).
//   2. slug-routed entity surfaces — the URL carries no id, so the match
//      runs on the SDK-reported locationSurfaceId (the bug behind the
//      2026-06-12 "invite-accept 403s in #general" incident).
//   3. URL-derived surfaces ('url' pseudo-app) — the id is re-derived
//      from the session URL with the shared hash.
//
// Fake ioredis exposes only what the service touches: smembers +
// pipeline().hmget(...).exec().

import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { deriveUrlSurfaceId } from '@bigbluebam/shared';
import { isUserOnSurface } from '../src/services/surface-presence.service.js';

interface FakeSession {
  orgId: string;
  locationApp: string;
  locationUrl: string;
  locationSurfaceId?: string;
}

function fakeRedis(sessionsByUser: Record<string, FakeSession[]>): Redis {
  const sessions = new Map<string, FakeSession>();
  const idsByUser = new Map<string, string[]>();
  for (const [userId, list] of Object.entries(sessionsByUser)) {
    const ids: string[] = [];
    list.forEach((s, i) => {
      const id = `${userId}-sess-${i}`;
      sessions.set(id, s);
      ids.push(id);
    });
    idsByUser.set(userId, ids);
  }
  return {
    async smembers(key: string) {
      const m = /^bureau:user:(.+):sessions$/.exec(key);
      return m ? (idsByUser.get(m[1]!) ?? []) : [];
    },
    pipeline() {
      const calls: Array<{ sessionId: string; fields: string[] }> = [];
      const pipe = {
        hmget(key: string, ...fields: string[]) {
          const m = /^bureau:sess:(.+)$/.exec(key);
          calls.push({ sessionId: m?.[1] ?? '', fields });
          return pipe;
        },
        async exec() {
          return calls.map(({ sessionId, fields }) => {
            const sess = sessions.get(sessionId);
            const values = fields.map((f) =>
              sess ? ((sess as unknown as Record<string, string>)[f] ?? null) : null,
            );
            return [null, values] as [null, (string | null)[]];
          });
        },
      };
      return pipe;
    },
  } as unknown as Redis;
}

const ORG = 'org-1';
const USER = 'user-1';

describe('isUserOnSurface — entity surfaces', () => {
  it('matches when the entity id appears in the session URL (id-routed pages)', async () => {
    const redis = fakeRedis({
      [USER]: [
        { orgId: ORG, locationApp: 'brief', locationUrl: 'https://x/brief/documents/doc-123' },
      ],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'brief', 'doc-123')).toBe(true);
  });

  it('matches slug-routed pages via the SDK-reported surface id (the #general fix)', async () => {
    const channelId = '2d41d949-c896-44dd-9429-05133a5bdfdb';
    const redis = fakeRedis({
      [USER]: [
        {
          orgId: ORG,
          locationApp: 'banter',
          locationUrl: 'https://x/banter/channels/general', // no id anywhere
          locationSurfaceId: channelId,
        },
      ],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'banter', channelId)).toBe(true);
  });

  it('rejects when neither the URL nor the reported surface id matches', async () => {
    const redis = fakeRedis({
      [USER]: [
        {
          orgId: ORG,
          locationApp: 'banter',
          locationUrl: 'https://x/banter/channels/general',
          locationSurfaceId: 'some-other-channel',
        },
      ],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'banter', 'not-that-channel')).toBe(false);
  });

  it('rejects cross-org sessions even with a matching surface id', async () => {
    const redis = fakeRedis({
      [USER]: [
        {
          orgId: 'org-2',
          locationApp: 'banter',
          locationUrl: 'https://x/banter/channels/general',
          locationSurfaceId: 'chan-1',
        },
      ],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'banter', 'chan-1')).toBe(false);
  });

  it('rejects app mismatches (surface id reported from a different app)', async () => {
    const redis = fakeRedis({
      [USER]: [
        {
          orgId: ORG,
          locationApp: 'brief',
          locationUrl: 'https://x/brief/documents/whatever',
          locationSurfaceId: 'chan-1',
        },
      ],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'banter', 'chan-1')).toBe(false);
  });
});

describe('isUserOnSurface — URL-derived surfaces', () => {
  it('matches when the id re-derives from the session URL', async () => {
    const url = 'https://x/b3/projects/abc';
    const id = deriveUrlSurfaceId(url)!;
    const redis = fakeRedis({
      [USER]: [{ orgId: ORG, locationApp: 'b3', locationUrl: url }],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'url', id)).toBe(true);
  });

  it('rejects when the session is on a different page', async () => {
    const id = deriveUrlSurfaceId('https://x/b3/projects/abc')!;
    const redis = fakeRedis({
      [USER]: [{ orgId: ORG, locationApp: 'b3', locationUrl: 'https://x/b3/projects/xyz' }],
    });
    expect(await isUserOnSurface(redis, USER, ORG, 'url', id)).toBe(false);
  });

  it('fails closed with no sessions at all', async () => {
    const redis = fakeRedis({});
    expect(await isUserOnSurface(redis, USER, ORG, 'url', 'u0123456789abcdef0')).toBe(false);
  });
});
