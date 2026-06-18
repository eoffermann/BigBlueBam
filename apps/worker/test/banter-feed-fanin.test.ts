// Banter Feed fan-in worker tests (docs/plans/banter-feed-design-document.md §10).
//
// Drives the core handleFeedFanin decision tree with a fake FeedFaninDeps and
// asserts which (user, category, flags) entries get upserted. The real db /
// can_access / BullMQ wiring is covered separately; this focuses on the
// Path A / Path B inclusion logic and the can_access + subscription gates.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import {
  handleFeedFanin,
  feedFaninCounters,
  type FeedFaninDeps,
} from '../src/jobs/banter-feed-fanin.job.js';
import { RELATIONSHIP_FLAGS, type BanterFeedFaninJobData } from '@bigbluebam/shared';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ACTOR = 'user-actor';
const MENTIONED = 'user-mentioned';
const FOLLOWER = 'user-follower';
const UNFOLLOWER = 'user-unfollower';

function baseJob(overrides: Partial<BanterFeedFaninJobData> = {}): BanterFeedFaninJobData {
  return {
    entity_type: 'banter.message',
    entity_id: 'msg-1',
    source: 'banter',
    org_id: 'org-1',
    actor_id: ACTOR,
    root_entity_type: null,
    root_entity_id: null,
    channel_id: 'chan-1',
    project_id: null,
    published_at: '2026-06-18T00:00:00.000Z',
    last_activity_at: '2026-06-18T00:00:00.000Z',
    engagement_count: 0,
    broad_category: 'banter.channel_post',
    broad_scope: 'channel',
    ...overrides,
  };
}

interface Upsert {
  userId: string;
  category: string;
  relationshipFlags: number;
}

function makeDeps(over: {
  access?: (u: string) => boolean;
  state?: (u: string) => 'following' | 'unfollowed' | 'muted';
  broad?: string[];
}): { deps: FeedFaninDeps; upserts: Upsert[] } {
  const upserts: Upsert[] = [];
  const deps: FeedFaninDeps = {
    canAccess: vi.fn(async (u: string) => (over.access ? over.access(u) : true)),
    resolveState: vi.fn(async (u: string) => (over.state ? over.state(u) : 'following')),
    enumerateBroadCandidates: vi.fn(async () => over.broad ?? []),
    upsertEntry: vi.fn(async (p) => {
      upserts.push({
        userId: p.userId,
        category: p.category,
        relationshipFlags: p.relationshipFlags,
      });
    }),
    logger,
  };
  return { deps, upserts };
}

beforeEach(() => {
  for (const k of Object.keys(feedFaninCounters)) {
    (feedFaninCounters as Record<string, number>)[k] = 0;
  }
});

describe('handleFeedFanin', () => {
  it('upserts a banter.channel_post entry for a following channel member', async () => {
    const { deps, upserts } = makeDeps({ broad: [FOLLOWER] });
    await handleFeedFanin(baseJob(), deps);
    expect(upserts).toEqual([
      { userId: FOLLOWER, category: 'banter.channel_post', relationshipFlags: 0 },
    ]);
  });

  it('excludes the actor from their own feed', async () => {
    const { deps, upserts } = makeDeps({ broad: [ACTOR, FOLLOWER] });
    await handleFeedFanin(baseJob(), deps);
    expect(upserts.map((u) => u.userId)).toEqual([FOLLOWER]);
  });

  it('a direct mention surfaces as banter.mention even when the user unfollowed', async () => {
    const { deps, upserts } = makeDeps({
      state: (u) => (u === MENTIONED ? 'unfollowed' : 'following'),
    });
    await handleFeedFanin(
      baseJob({
        direct_recipients: [
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.MENTIONED, category: 'banter.mention' },
        ],
        broad_category: null,
        broad_scope: null,
      }),
      deps,
    );
    expect(upserts).toEqual([
      {
        userId: MENTIONED,
        category: 'banter.mention',
        relationshipFlags: RELATIONSHIP_FLAGS.MENTIONED,
      },
    ]);
  });

  it('mute is the hard veto — drops even a direct mention', async () => {
    const { deps, upserts } = makeDeps({ state: () => 'muted' });
    await handleFeedFanin(
      baseJob({
        direct_recipients: [
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.MENTIONED, category: 'banter.mention' },
        ],
        broad_category: null,
      }),
      deps,
    );
    expect(upserts).toEqual([]);
    expect(feedFaninCounters.direct_dropped_muted).toBe(1);
  });

  it('can_access denial drops a direct recipient (the §4.1 hard gate)', async () => {
    const { deps, upserts } = makeDeps({ access: (u) => u !== MENTIONED });
    await handleFeedFanin(
      baseJob({
        direct_recipients: [
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.MENTIONED, category: 'banter.mention' },
        ],
        broad_category: null,
      }),
      deps,
    );
    expect(upserts).toEqual([]);
    expect(feedFaninCounters.direct_dropped_access).toBe(1);
  });

  it('a broad recipient who unfollowed gets no entry (Path B off)', async () => {
    const { deps, upserts } = makeDeps({
      broad: [FOLLOWER, UNFOLLOWER],
      state: (u) => (u === UNFOLLOWER ? 'unfollowed' : 'following'),
    });
    await handleFeedFanin(baseJob(), deps);
    expect(upserts.map((u) => u.userId)).toEqual([FOLLOWER]);
    expect(feedFaninCounters.broad_dropped_not_following).toBe(1);
  });

  it('board.canvas_edited does not broad-surface (broad_surface=false)', async () => {
    const { deps, upserts } = makeDeps({ broad: [FOLLOWER] });
    await handleFeedFanin(
      baseJob({ broad_category: 'board.canvas_edited', source: 'board', entity_type: 'board.board' }),
      deps,
    );
    expect(upserts).toEqual([]);
  });

  it('a direct recipient is not double-written as a broad recipient', async () => {
    const { deps, upserts } = makeDeps({ broad: [MENTIONED, FOLLOWER] });
    await handleFeedFanin(
      baseJob({
        direct_recipients: [
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.MENTIONED, category: 'banter.mention' },
        ],
      }),
      deps,
    );
    // MENTIONED gets the direct banter.mention; FOLLOWER gets the broad post.
    expect(upserts).toEqual([
      { userId: MENTIONED, category: 'banter.mention', relationshipFlags: RELATIONSHIP_FLAGS.MENTIONED },
      { userId: FOLLOWER, category: 'banter.channel_post', relationshipFlags: 0 },
    ]);
  });

  it('dedupes a user who is both mentioned and a thread participant (mention wins)', async () => {
    const { deps, upserts } = makeDeps({ broad_category: undefined } as never);
    await handleFeedFanin(
      baseJob({
        direct_recipients: [
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.COMMENTER, category: 'banter.thread.reply' },
          { user_id: MENTIONED, relationship_flags: RELATIONSHIP_FLAGS.MENTIONED, category: 'banter.mention' },
        ],
        broad_category: null,
      }),
      deps,
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.category).toBe('banter.mention');
    // both flags OR-ed together
    expect(upserts[0]!.relationshipFlags).toBe(
      RELATIONSHIP_FLAGS.COMMENTER | RELATIONSHIP_FLAGS.MENTIONED,
    );
  });
});
