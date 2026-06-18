/**
 * Banter Feed shared domain (docs/plans/banter-feed-design-document.md).
 *
 * The taxonomy, default weights, flag bitsets, weight merging, subscription
 * resolution, and read-time scoring all live here so the two sides that need
 * them cannot drift:
 *  - apps/banter-api ranks the feed at read time (§6) using effectiveWeights +
 *     scoreEntry.
 *  - apps/worker classifies events and runs shouldSurface (§4.5) using the
 *     category policy (broad_surface / notification_policy) and
 *     resolveSubscriptionState.
 *
 * The category WEIGHTS (W) and the global knobs are tunable (stored in the
 * banter_feed_weights JSONB, editable at platform + org levels). The per-category
 * POLICY (broad_surface, notification_policy) is fixed product behavior and lives
 * here as a code constant, not in the tunable weight set.
 */

// ---------------------------------------------------------------------------
// Scopes and subscription states (§5)
// ---------------------------------------------------------------------------

export type FeedScopeType = 'item' | 'channel' | 'project' | 'source';
export type FeedSubscriptionState = 'following' | 'unfollowed' | 'muted';
export type FeedNotificationPolicy = 'always' | 'direct_only' | 'never';

/** The apps a feed entry / subscription scope can belong to (`source`). */
export const FEED_SOURCES = [
  'banter',
  'bam',
  'brief',
  'beacon',
  'board',
  'bond',
  'bell', // Helpdesk
  'book',
  'bill',
  'bearing',
  'blank',
  'bolt',
] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

/** Most-specific-first ordering used by subscription resolution (§5.2). */
export const SCOPE_PRECEDENCE: readonly FeedScopeType[] = [
  'item',
  'channel',
  'project',
  'source',
] as const;

// ---------------------------------------------------------------------------
// Relationship / interaction flag bitsets (§7.1)
// ---------------------------------------------------------------------------
//
// relationship_flags: the viewer's direct relationship to the entity (drives
// Path A inclusion and the affinity boost).
// interaction_flags: the viewer's own past actions on the entity (drives the
// interaction boost).

export const RELATIONSHIP_FLAGS = {
  ASSIGNEE: 1 << 0,
  AUTHOR: 1 << 1,
  WATCHER: 1 << 2,
  MENTIONED: 1 << 3,
  COMMENTER: 1 << 4,
  REACTOR: 1 << 5,
  APPROVER: 1 << 6,
} as const;

export const INTERACTION_FLAGS = {
  COMMENTED: 1 << 0,
  REACTED: 1 << 1,
  AUTHORED: 1 << 2,
  MENTIONED: 1 << 3,
} as const;

/** A non-zero relationship bitset means the viewer has a DIRECT relationship. */
export function hasDirectRelationship(relationshipFlags: number): boolean {
  return relationshipFlags !== 0;
}

// ---------------------------------------------------------------------------
// Category taxonomy (§8) — fixed policy
// ---------------------------------------------------------------------------

export interface CategoryPolicy {
  /** Does Path B (followed-scope broad surfacing) apply, or is this direct-only? */
  broad_surface: boolean;
  /** When does this category fire a notification? */
  notification_policy: FeedNotificationPolicy;
}

export const CATEGORY_POLICY: Record<string, CategoryPolicy> = {
  'approval.awaiting_me': { broad_surface: false, notification_policy: 'always' },
  'mention.cross_app': { broad_surface: false, notification_policy: 'always' },
  'banter.mention': { broad_surface: false, notification_policy: 'always' },
  'bam.task.assigned_to_me': { broad_surface: false, notification_policy: 'always' },
  'bam.task.comment_on_my_task': { broad_surface: false, notification_policy: 'direct_only' },
  'banter.thread.reply': { broad_surface: true, notification_policy: 'direct_only' },
  'bell.ticket.updated': { broad_surface: true, notification_policy: 'direct_only' },
  'bam.task.state_changed': { broad_surface: true, notification_policy: 'direct_only' },
  'beacon.entry.activity': { broad_surface: true, notification_policy: 'direct_only' },
  'book.event.invited': { broad_surface: true, notification_policy: 'always' },
  'brief.document.edited': { broad_surface: true, notification_policy: 'never' },
  'bolt.run.failed_mine': { broad_surface: false, notification_policy: 'always' },
  'bond.deal.updated': { broad_surface: true, notification_policy: 'never' },
  'bearing.kr.progress': { broad_surface: true, notification_policy: 'never' },
  'banter.channel_post': { broad_surface: true, notification_policy: 'never' },
  'bill.invoice.activity': { broad_surface: true, notification_policy: 'never' },
  'brief.document.created': { broad_surface: true, notification_policy: 'never' },
  'board.canvas_edited': { broad_surface: false, notification_policy: 'never' },
  'blank.form.response': { broad_surface: true, notification_policy: 'never' },
  'source.generic_activity': { broad_surface: true, notification_policy: 'never' },
  // banter.dm routes to the DM view and does NOT create a Feed entry (§12.2).
  'banter.dm': { broad_surface: false, notification_policy: 'always' },
};

export function categoryPolicy(category: string): CategoryPolicy {
  return CATEGORY_POLICY[category] ?? CATEGORY_POLICY['source.generic_activity']!;
}

// ---------------------------------------------------------------------------
// Tunable weights (§8) — the JSONB shape
// ---------------------------------------------------------------------------

export interface FeedWeights {
  /** Per-category base weight W. */
  categories: Record<string, number>;
  /** Recency decay exponent (higher = newer dominates harder). */
  gravity: number;
  /** Hours added to age to dampen the brand-new spike / avoid div-by-zero. */
  recency_offset: number;
  /** How much social proof (replies/reactions/participants) lifts an item. */
  engagement_weight: number;
  interaction_boost: {
    commented: number;
    reacted: number;
    authored: number;
    mentioned: number;
  };
  affinity_boost: {
    assignee: number;
    watcher: number;
    contributor: number;
  };
  /** Multiplier applied once an entry is seen (sinks, does not vanish). */
  seen_multiplier: number;
  /** How far back the candidate scan reaches. */
  candidate_window_days: number;
  /** Additive floor for approval.awaiting_me and unread direct mentions. */
  must_see_floor: number;
}

/** Shipped defaults — a fresh install has sane behavior before any tuning. */
export const PLATFORM_DEFAULTS: FeedWeights = {
  categories: {
    'approval.awaiting_me': 3.0,
    'mention.cross_app': 2.8,
    'banter.mention': 3.0,
    'bam.task.assigned_to_me': 2.5,
    'bam.task.comment_on_my_task': 2.2,
    'banter.thread.reply': 1.8,
    'bell.ticket.updated': 1.8,
    'bam.task.state_changed': 1.6,
    'beacon.entry.activity': 1.6,
    'book.event.invited': 1.5,
    'brief.document.edited': 1.5,
    'bolt.run.failed_mine': 1.5,
    'bond.deal.updated': 1.4,
    'bearing.kr.progress': 1.3,
    'banter.channel_post': 1.2,
    'bill.invoice.activity': 1.2,
    'brief.document.created': 1.0,
    'board.canvas_edited': 1.0,
    'blank.form.response': 0.9,
    'source.generic_activity': 0.8,
    'banter.dm': 2.5,
  },
  gravity: 1.5,
  recency_offset: 2.0,
  engagement_weight: 0.15,
  interaction_boost: {
    commented: 0.6,
    reacted: 0.3,
    authored: 0.8,
    mentioned: 0.7,
  },
  affinity_boost: {
    assignee: 0.8,
    watcher: 0.4,
    contributor: 0.5,
  },
  seen_multiplier: 0.4,
  candidate_window_days: 30,
  must_see_floor: 1000,
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Partial overrides as stored in a platform or org weights row. */
export type FeedWeightsOverride = DeepPartial<FeedWeights>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge: later sources win; objects merge, scalars replace. */
function deepMerge<T>(...sources: Array<unknown>): T {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out as T;
}

/**
 * effectiveWeights(org) = deepMerge(PLATFORM_DEFAULTS, platformRow, orgRow).
 * Either override may be undefined.
 */
export function effectiveWeights(
  platformOverride?: FeedWeightsOverride | null,
  orgOverride?: FeedWeightsOverride | null,
): FeedWeights {
  return deepMerge<FeedWeights>(
    PLATFORM_DEFAULTS,
    platformOverride ?? {},
    orgOverride ?? {},
  );
}

/**
 * Cache-key version: bump either level to invalidate. platform * 1e6 + org so
 * the two integer versions compose into one monotonic-enough key (§7.2).
 */
export function weightsVersion(platformVersion: number, orgVersion: number): number {
  return platformVersion * 1_000_000 + orgVersion;
}

// ---------------------------------------------------------------------------
// Subscription resolution (§5.2) — most specific scope wins
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  scope_type: FeedScopeType;
  scope_source: string;
  scope_id: string | null;
  state: FeedSubscriptionState;
}

/** The scopes an entity belongs to, for resolution (any may be absent). */
export interface EntityScopes {
  source: string;
  itemType?: string; // unused for matching; entity_id is the key
  itemId?: string | null;
  channelId?: string | null;
  projectId?: string | null;
}

/**
 * Walk from most-specific (item) to least-specific (source) and take the first
 * explicit row that matches. Absence of any row → the configured default
 * (normally 'following'). This lets a user unfollow a whole source yet follow
 * one item under it, or follow a source broadly yet mute one noisy channel.
 */
export function resolveSubscriptionState(
  rows: SubscriptionRow[],
  scopes: EntityScopes,
  defaultState: FeedSubscriptionState = 'following',
): FeedSubscriptionState {
  for (const scopeType of SCOPE_PRECEDENCE) {
    const match = rows.find((r) => {
      if (r.scope_type !== scopeType) return false;
      if (r.scope_source !== scopes.source) return false;
      switch (scopeType) {
        case 'item':
          return scopes.itemId != null && r.scope_id === scopes.itemId;
        case 'channel':
          return scopes.channelId != null && r.scope_id === scopes.channelId;
        case 'project':
          return scopes.projectId != null && r.scope_id === scopes.projectId;
        case 'source':
          return r.scope_id == null;
      }
    });
    if (match) return match.state;
  }
  return defaultState;
}

// ---------------------------------------------------------------------------
// shouldSurface (§4.5)
// ---------------------------------------------------------------------------

export type SurfaceDecision = 'include' | 'drop';

/**
 * The §4.5 decision, minus the can_access gate (which the caller MUST apply
 * first — it requires a DB/visibility lookup). Given that the entity is
 * accessible, decide inclusion from the subscription state, the direct
 * relationship, and the category's broad-surface policy.
 */
export function shouldSurface(input: {
  subscriptionState: FeedSubscriptionState;
  relationshipFlags: number;
  category: string;
}): SurfaceDecision {
  if (input.subscriptionState === 'muted') return 'drop'; // hard veto (§4.4)
  if (hasDirectRelationship(input.relationshipFlags)) return 'include'; // Path A
  if (
    input.subscriptionState === 'following' &&
    categoryPolicy(input.category).broad_surface
  ) {
    return 'include'; // Path B
  }
  return 'drop';
}

// ---------------------------------------------------------------------------
// Scoring (§6.2) — read time
// ---------------------------------------------------------------------------

export interface ScorableEntry {
  category: string;
  published_at: Date | string;
  last_activity_at: Date | string;
  relationship_flags: number;
  interaction_flags: number;
  engagement_count: number;
  seen_at: Date | string | null;
}

export interface ScoreBreakdown {
  score: number;
  weight: number;
  recency: number;
  affinity: number;
  interaction: number;
  engagement: number;
  seen_multiplier: number;
  must_see_floor: number;
  effective_time_ms: number;
  age_hours: number;
}

function toMs(t: Date | string): number {
  return t instanceof Date ? t.getTime() : new Date(t).getTime();
}

/**
 * The §6.2 score for one candidate entry and the current effective weights.
 * `nowMs` is passed in (not read from the clock) so callers can score a whole
 * page against one consistent instant and unit tests stay deterministic.
 */
export function scoreEntry(
  entry: ScorableEntry,
  weights: FeedWeights,
  nowMs: number,
): ScoreBreakdown {
  const effectiveTimeMs = Math.max(toMs(entry.published_at), toMs(entry.last_activity_at));
  const ageHours = Math.max(0, (nowMs - effectiveTimeMs) / 3_600_000);
  const recency = 1 / Math.pow(ageHours + weights.recency_offset, weights.gravity);

  const W = weights.categories[entry.category] ?? weights.categories['source.generic_activity'] ?? 1;

  // Affinity from direct relationships.
  let affinity = 0;
  const rf = entry.relationship_flags;
  if (rf & RELATIONSHIP_FLAGS.ASSIGNEE) affinity += weights.affinity_boost.assignee;
  if (rf & RELATIONSHIP_FLAGS.WATCHER) affinity += weights.affinity_boost.watcher;
  if (rf & RELATIONSHIP_FLAGS.AUTHOR) affinity += weights.affinity_boost.contributor;

  // Interaction from the viewer's own past actions.
  let interaction = 0;
  const iff = entry.interaction_flags;
  if (iff & INTERACTION_FLAGS.COMMENTED) interaction += weights.interaction_boost.commented;
  if (iff & INTERACTION_FLAGS.REACTED) interaction += weights.interaction_boost.reacted;
  if (iff & INTERACTION_FLAGS.AUTHORED) interaction += weights.interaction_boost.authored;
  if (iff & INTERACTION_FLAGS.MENTIONED) interaction += weights.interaction_boost.mentioned;

  const engagement = Math.log1p(Math.max(0, entry.engagement_count));
  const seenMultiplier = entry.seen_at ? weights.seen_multiplier : 1;

  let score =
    W *
    recency *
    (1 + affinity + interaction) *
    (1 + weights.engagement_weight * engagement) *
    seenMultiplier;

  // Additive must-see floor (§6.2): pin approvals + unread direct mentions to
  // the top regardless of age.
  let mustSeeFloor = 0;
  const isUnreadMention =
    (entry.category === 'mention.cross_app' || entry.category === 'banter.mention') &&
    !entry.seen_at;
  if (entry.category === 'approval.awaiting_me' || isUnreadMention) {
    mustSeeFloor = weights.must_see_floor;
    score += mustSeeFloor;
  }

  return {
    score,
    weight: W,
    recency,
    affinity,
    interaction,
    engagement,
    seen_multiplier: seenMultiplier,
    must_see_floor: mustSeeFloor,
    effective_time_ms: effectiveTimeMs,
    age_hours: ageHours,
  };
}
