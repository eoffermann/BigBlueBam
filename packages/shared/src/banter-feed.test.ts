import { describe, expect, it } from 'vitest';
import {
  CATEGORY_POLICY,
  PLATFORM_DEFAULTS,
  RELATIONSHIP_FLAGS,
  INTERACTION_FLAGS,
  effectiveWeights,
  weightsVersion,
  resolveSubscriptionState,
  shouldSurface,
  scoreEntry,
  hasDirectRelationship,
  type SubscriptionRow,
} from './banter-feed.js';

describe('effectiveWeights', () => {
  it('returns the platform defaults when no overrides are given', () => {
    const w = effectiveWeights();
    expect(w.gravity).toBe(1.5);
    expect(w.categories['banter.channel_post']).toBe(1.2);
    expect(w.must_see_floor).toBe(1000);
  });

  it('deep-merges org overrides over platform over defaults', () => {
    const w = effectiveWeights(
      { gravity: 2.0, categories: { 'banter.channel_post': 5 } },
      { categories: { 'banter.channel_post': 9, 'bond.deal.updated': 7 } },
    );
    // org wins over platform-override on the same key
    expect(w.categories['banter.channel_post']).toBe(9);
    // platform-override wins over default where org is silent
    expect(w.gravity).toBe(2.0);
    // org-only key lands
    expect(w.categories['bond.deal.updated']).toBe(7);
    // untouched default survives
    expect(w.categories['approval.awaiting_me']).toBe(3.0);
    // nested object merge does not drop sibling keys
    expect(w.affinity_boost.assignee).toBe(0.8);
  });

  it('does not mutate PLATFORM_DEFAULTS', () => {
    effectiveWeights({ gravity: 99 }, { categories: { x: 1 } });
    expect(PLATFORM_DEFAULTS.gravity).toBe(1.5);
    expect(PLATFORM_DEFAULTS.categories['x']).toBeUndefined();
  });
});

describe('weightsVersion', () => {
  it('composes platform and org versions into one monotonic key', () => {
    expect(weightsVersion(1, 1)).toBe(1_000_001);
    expect(weightsVersion(2, 0)).toBe(2_000_000);
    expect(weightsVersion(2, 0)).toBeGreaterThan(weightsVersion(1, 999_999));
  });
});

describe('resolveSubscriptionState', () => {
  const scopes = {
    source: 'board',
    itemId: 'board-1',
    channelId: null,
    projectId: 'proj-1',
  };

  it('defaults to following with no rows', () => {
    expect(resolveSubscriptionState([], scopes)).toBe('following');
  });

  it('most-specific item row beats a source row', () => {
    const rows: SubscriptionRow[] = [
      { scope_type: 'source', scope_source: 'board', scope_id: null, state: 'unfollowed' },
      { scope_type: 'item', scope_source: 'board', scope_id: 'board-1', state: 'following' },
    ];
    expect(resolveSubscriptionState(rows, scopes)).toBe('following');
  });

  it('source-level mute applies when no finer row exists', () => {
    const rows: SubscriptionRow[] = [
      { scope_type: 'source', scope_source: 'board', scope_id: null, state: 'muted' },
    ];
    expect(resolveSubscriptionState(rows, scopes)).toBe('muted');
  });

  it('project row beats source row but loses to item row', () => {
    const rows: SubscriptionRow[] = [
      { scope_type: 'source', scope_source: 'board', scope_id: null, state: 'unfollowed' },
      { scope_type: 'project', scope_source: 'board', scope_id: 'proj-1', state: 'muted' },
    ];
    expect(resolveSubscriptionState(rows, scopes)).toBe('muted');
  });

  it('ignores rows for a different source', () => {
    const rows: SubscriptionRow[] = [
      { scope_type: 'source', scope_source: 'bam', scope_id: null, state: 'muted' },
    ];
    expect(resolveSubscriptionState(rows, scopes)).toBe('following');
  });
});

describe('shouldSurface', () => {
  it('muted scope drops even direct items (hard veto)', () => {
    expect(
      shouldSurface({
        subscriptionState: 'muted',
        relationshipFlags: RELATIONSHIP_FLAGS.ASSIGNEE,
        category: 'bam.task.assigned_to_me',
      }),
    ).toBe('drop');
  });

  it('direct relationship surfaces even when unfollowed (Path A)', () => {
    expect(
      shouldSurface({
        subscriptionState: 'unfollowed',
        relationshipFlags: RELATIONSHIP_FLAGS.ASSIGNEE,
        category: 'bam.task.assigned_to_me',
      }),
    ).toBe('include');
  });

  it('followed broad-surface category surfaces without a direct relationship (Path B)', () => {
    expect(
      shouldSurface({
        subscriptionState: 'following',
        relationshipFlags: 0,
        category: 'banter.channel_post',
      }),
    ).toBe('include');
  });

  it('non-broad-surface category does NOT surface via Path B (board canvas edit)', () => {
    expect(
      shouldSurface({
        subscriptionState: 'following',
        relationshipFlags: 0,
        category: 'board.canvas_edited',
      }),
    ).toBe('drop');
  });

  it('unfollowed scope drops broad items (Path B off)', () => {
    expect(
      shouldSurface({
        subscriptionState: 'unfollowed',
        relationshipFlags: 0,
        category: 'banter.channel_post',
      }),
    ).toBe('drop');
  });
});

describe('scoreEntry', () => {
  const NOW = 1_700_000_000_000; // fixed instant
  const base = {
    category: 'banter.channel_post',
    relationship_flags: 0,
    interaction_flags: 0,
    engagement_count: 0,
    seen_at: null as Date | string | null,
  };
  const w = effectiveWeights();

  it('newer content scores higher than older content, all else equal', () => {
    const fresh = scoreEntry(
      { ...base, published_at: new Date(NOW - 3_600_000), last_activity_at: new Date(NOW - 3_600_000) },
      w,
      NOW,
    );
    const old = scoreEntry(
      { ...base, published_at: new Date(NOW - 72 * 3_600_000), last_activity_at: new Date(NOW - 72 * 3_600_000) },
      w,
      NOW,
    );
    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it('uses the later of published_at and last_activity_at for recency', () => {
    const bumped = scoreEntry(
      { ...base, published_at: new Date(NOW - 100 * 3_600_000), last_activity_at: new Date(NOW - 1 * 3_600_000) },
      w,
      NOW,
    );
    expect(bumped.age_hours).toBeCloseTo(1, 5);
  });

  it('seen entries sink (seen_multiplier < 1) but do not vanish', () => {
    const t = new Date(NOW - 3_600_000);
    const unseen = scoreEntry({ ...base, published_at: t, last_activity_at: t }, w, NOW);
    const seen = scoreEntry({ ...base, published_at: t, last_activity_at: t, seen_at: new Date(NOW) }, w, NOW);
    expect(seen.score).toBeGreaterThan(0);
    expect(seen.score).toBeCloseTo(unseen.score * w.seen_multiplier, 5);
  });

  it('approval.awaiting_me gets the additive must-see floor', () => {
    const t = new Date(NOW - 240 * 3_600_000); // very old
    const r = scoreEntry({ ...base, category: 'approval.awaiting_me', published_at: t, last_activity_at: t }, w, NOW);
    expect(r.must_see_floor).toBe(w.must_see_floor);
    expect(r.score).toBeGreaterThan(w.must_see_floor);
  });

  it('an unread direct mention gets the floor; a seen one does not', () => {
    const t = new Date(NOW - 240 * 3_600_000);
    const unread = scoreEntry({ ...base, category: 'banter.mention', published_at: t, last_activity_at: t }, w, NOW);
    const read = scoreEntry(
      { ...base, category: 'banter.mention', published_at: t, last_activity_at: t, seen_at: new Date(NOW) },
      w,
      NOW,
    );
    expect(unread.must_see_floor).toBe(w.must_see_floor);
    expect(read.must_see_floor).toBe(0);
  });

  it('affinity (assignee) and interaction (commented) lift the score', () => {
    const t = new Date(NOW - 3_600_000);
    const plain = scoreEntry({ ...base, published_at: t, last_activity_at: t }, w, NOW);
    const boosted = scoreEntry(
      {
        ...base,
        published_at: t,
        last_activity_at: t,
        relationship_flags: RELATIONSHIP_FLAGS.ASSIGNEE,
        interaction_flags: INTERACTION_FLAGS.COMMENTED,
      },
      w,
      NOW,
    );
    expect(boosted.affinity).toBeCloseTo(0.8, 5);
    expect(boosted.interaction).toBeCloseTo(0.6, 5);
    expect(boosted.score).toBeGreaterThan(plain.score);
  });
});

describe('taxonomy invariants', () => {
  it('every PLATFORM_DEFAULTS category has a policy entry', () => {
    for (const category of Object.keys(PLATFORM_DEFAULTS.categories)) {
      expect(CATEGORY_POLICY[category], `missing policy for ${category}`).toBeDefined();
    }
  });

  it('board.canvas_edited is direct-only (broad_surface=false)', () => {
    expect(CATEGORY_POLICY['board.canvas_edited']!.broad_surface).toBe(false);
  });

  it('hasDirectRelationship reflects a non-zero bitset', () => {
    expect(hasDirectRelationship(0)).toBe(false);
    expect(hasDirectRelationship(RELATIONSHIP_FLAGS.WATCHER)).toBe(true);
  });
});
