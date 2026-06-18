import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterFeedSubscriptions } from '../db/schema/index.js';
import {
  resolveSubscriptionState,
  type EntityScopes,
  type FeedScopeType,
  type FeedSubscriptionState,
  type SubscriptionRow,
} from '@bigbluebam/shared';

/**
 * Feed subscription service (banter-feed-design-document.md §5).
 *
 * Default-on model: we persist ONLY deviations (unfollowed / muted, plus the
 * rare explicit re-following row that overrides a broader opt-out). The absence
 * of a row means "use the effective default" (following). Resolution walks from
 * most-specific scope (item) to least-specific (source); the shared
 * resolveSubscriptionState encodes that precedence.
 */

export interface FeedSubscriptionRecord {
  id: string;
  scope_type: FeedScopeType;
  scope_source: string;
  scope_id: string | null;
  state: FeedSubscriptionState;
  origin: string;
  created_at: Date;
  updated_at: Date;
}

/** All explicit rows for a user (optionally filtered to one source). */
export async function listSubscriptions(
  userId: string,
  source?: string,
): Promise<FeedSubscriptionRecord[]> {
  const where = source
    ? and(
        eq(banterFeedSubscriptions.user_id, userId),
        eq(banterFeedSubscriptions.scope_source, source),
      )
    : eq(banterFeedSubscriptions.user_id, userId);

  const rows = await db
    .select({
      id: banterFeedSubscriptions.id,
      scope_type: banterFeedSubscriptions.scope_type,
      scope_source: banterFeedSubscriptions.scope_source,
      scope_id: banterFeedSubscriptions.scope_id,
      state: banterFeedSubscriptions.state,
      origin: banterFeedSubscriptions.origin,
      created_at: banterFeedSubscriptions.created_at,
      updated_at: banterFeedSubscriptions.updated_at,
    })
    .from(banterFeedSubscriptions)
    .where(where);

  return rows as FeedSubscriptionRecord[];
}

/** Load the user's rows in the shape the shared resolver expects. */
async function loadResolverRows(userId: string): Promise<SubscriptionRow[]> {
  const rows = await db
    .select({
      scope_type: banterFeedSubscriptions.scope_type,
      scope_source: banterFeedSubscriptions.scope_source,
      scope_id: banterFeedSubscriptions.scope_id,
      state: banterFeedSubscriptions.state,
    })
    .from(banterFeedSubscriptions)
    .where(eq(banterFeedSubscriptions.user_id, userId));
  return rows as SubscriptionRow[];
}

/** Effective subscription state for an entity, given its scopes (§5.2). */
export async function resolveEffectiveState(
  userId: string,
  scopes: EntityScopes,
): Promise<FeedSubscriptionState> {
  const rows = await loadResolverRows(userId);
  return resolveSubscriptionState(rows, scopes);
}

function scopeMatch(scopeId: string | null) {
  return scopeId == null
    ? isNull(banterFeedSubscriptions.scope_id)
    : eq(banterFeedSubscriptions.scope_id, scopeId);
}

/**
 * Upsert a subscription. When the requested state is 'following' AND nothing
 * broader is opting the scope out, we delete the explicit row instead of
 * writing one (the default already yields 'following'). We only persist a
 * 'following' row when it has to OVERRIDE a broader unfollowed/muted scope.
 * 'unfollowed' / 'muted' always persist.
 *
 * Manual find-then-write (rather than ON CONFLICT) because the unique index is
 * on a COALESCE(scope_id, sentinel) expression, which Drizzle can't target.
 */
export async function upsertSubscription(input: {
  userId: string;
  orgId: string;
  scopeType: FeedScopeType;
  scopeSource: string;
  scopeId: string | null;
  state: FeedSubscriptionState;
  origin?: 'manual' | 'auto';
}): Promise<{ state: FeedSubscriptionState; row_kept: boolean }> {
  const { userId, orgId, scopeType, scopeSource, scopeId, state } = input;
  const origin = input.origin ?? 'manual';

  if (state === 'following') {
    // Would the scope already resolve to 'following' without an explicit row
    // here? Resolve against the user's OTHER rows (this exact scope removed).
    const others = (await loadResolverRows(userId)).filter(
      (r) =>
        !(
          r.scope_type === scopeType &&
          r.scope_source === scopeSource &&
          (r.scope_id ?? null) === (scopeId ?? null)
        ),
    );
    const scopes: EntityScopes = {
      source: scopeSource,
      itemId: scopeType === 'item' ? scopeId : null,
      channelId: scopeType === 'channel' ? scopeId : null,
      projectId: scopeType === 'project' ? scopeId : null,
    };
    const wouldBe = resolveSubscriptionState(others, scopes);
    if (wouldBe === 'following') {
      // Default already covers it — drop any explicit row, store nothing.
      await db
        .delete(banterFeedSubscriptions)
        .where(
          and(
            eq(banterFeedSubscriptions.user_id, userId),
            eq(banterFeedSubscriptions.scope_type, scopeType),
            eq(banterFeedSubscriptions.scope_source, scopeSource),
            scopeMatch(scopeId),
          ),
        );
      return { state: 'following', row_kept: false };
    }
    // else: fall through and persist an explicit 'following' override.
  }

  const [existing] = await db
    .select({ id: banterFeedSubscriptions.id })
    .from(banterFeedSubscriptions)
    .where(
      and(
        eq(banterFeedSubscriptions.user_id, userId),
        eq(banterFeedSubscriptions.scope_type, scopeType),
        eq(banterFeedSubscriptions.scope_source, scopeSource),
        scopeMatch(scopeId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(banterFeedSubscriptions)
      .set({ state, origin, updated_at: new Date() })
      .where(eq(banterFeedSubscriptions.id, existing.id));
  } else {
    await db.insert(banterFeedSubscriptions).values({
      org_id: orgId,
      user_id: userId,
      scope_type: scopeType,
      scope_source: scopeSource,
      scope_id: scopeId,
      state,
      origin,
    });
  }
  return { state, row_kept: true };
}

/** Remove one explicit row by id (revert that scope to its default). */
export async function deleteSubscriptionById(
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(banterFeedSubscriptions)
    .where(
      and(
        eq(banterFeedSubscriptions.id, id),
        eq(banterFeedSubscriptions.user_id, userId),
      ),
    );
}

/**
 * Remove any explicit rows for a channel scope — called when a user leaves a
 * channel so a stale follow/mute does not linger (§5.1, §10.3).
 */
export async function clearChannelSubscriptions(
  userId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(banterFeedSubscriptions)
    .where(
      and(
        eq(banterFeedSubscriptions.user_id, userId),
        eq(banterFeedSubscriptions.scope_type, 'channel'),
        eq(banterFeedSubscriptions.scope_source, 'banter'),
        eq(banterFeedSubscriptions.scope_id, channelId),
      ),
    );
}
