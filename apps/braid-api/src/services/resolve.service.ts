import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { BraidResolveResult } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { braidProfiles, braidIdentities, entityLinks } from '../db/schema/index.js';
import { acquireResolveLock } from '../lib/advisory-lock.js';
import { enqueueBraidIngest } from '../lib/queue.js';
import { preflightAccess } from '../lib/can-access.client.js';
import { AccessDeniedError, RateLimitError } from '../lib/errors.js';
import { env } from '../env.js';
import { isAdminViewer, type BraidResolveInput, type Viewer } from './types.js';

type BraidTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// bond.company is the only company-kinded source; bill.client can be either but the
// request path never matches, so it seeds as a person and the worker refines kind.
function inferKind(sourceType: string): 'person' | 'company' {
  return sourceType === 'bond.company' ? 'company' : 'person';
}

// Follow the merged_into_id chain to the live active survivor (spec 4.5 ST5).
async function followToSurvivor(
  tx: BraidTx,
  orgId: string,
  startId: string,
): Promise<{ id: string; kind: string; identity_count: number } | null> {
  let currentId = startId;
  for (let hops = 0; hops < 32; hops++) {
    const [row] = await tx
      .select({
        id: braidProfiles.id,
        kind: braidProfiles.kind,
        status: braidProfiles.status,
        merged_into_id: braidProfiles.merged_into_id,
        identity_count: braidProfiles.identity_count,
      })
      .from(braidProfiles)
      .where(and(eq(braidProfiles.id, currentId), eq(braidProfiles.organization_id, orgId)))
      .limit(1);
    if (!row) return null;
    if (row.status === 'merged_away' && row.merged_into_id) {
      currentId = row.merged_into_id;
      continue;
    }
    return { id: row.id, kind: row.kind, identity_count: row.identity_count };
  }
  return null;
}

async function enforceRateLimit(redis: Redis, orgId: string, askerId: string): Promise<void> {
  const key = `braid:resolve:rl:${orgId}:${askerId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, env.RESOLVE_RATE_LIMIT_WINDOW_MS);
    }
    if (count > env.RESOLVE_RATE_LIMIT_MAX) throw new RateLimitError();
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    // Redis unavailable: do not wedge resolve on a rate-limiter outage.
  }
}

// Resolve a source record to its stable golden id (spec 5.1). preflight the INPUT
// record first (deny -> not_found, never a golden id); then, in a locked transaction,
// identity-first upsert: mint a bare singleton profile ONLY when the identity row is
// genuinely new. Suppress identity_count for non-admin askers.
export async function resolve(
  redis: Redis,
  orgId: string,
  input: BraidResolveInput,
  viewer: Viewer,
): Promise<BraidResolveResult> {
  const asker = input.asker_user_id ?? viewer.id;
  await enforceRateLimit(redis, orgId, asker);

  // Input-record preflight. The source_type doubles as the can_access entity_type;
  // an unsupported type or a denied record both fail closed to not_found.
  const allowed = await preflightAccess(asker, input.source_type, input.source_id);
  if (!allowed) throw new AccessDeniedError();

  const admin = isAdminViewer(viewer);

  const result = await db.transaction<BraidResolveResult>(async (tx) => {
    // Serialize concurrent resolves for the SAME source record so two of them cannot
    // each mint an orphan (spec ST-r2-2).
    await acquireResolveLock(tx, orgId, input.source_type, input.source_id);

    const [existing] = await tx
      .select({ profile_id: braidIdentities.profile_id })
      .from(braidIdentities)
      .where(
        and(
          eq(braidIdentities.organization_id, orgId),
          eq(braidIdentities.source_type, input.source_type),
          eq(braidIdentities.source_id, input.source_id),
        ),
      )
      .limit(1);

    if (existing) {
      const live = await followToSurvivor(tx, orgId, existing.profile_id);
      if (!live) throw new AccessDeniedError();
      return {
        profile_id: live.id,
        kind: live.kind as BraidResolveResult['kind'],
        identity_count: admin ? live.identity_count : null,
        created: false,
      };
    }

    // Genuinely new: mint a bare singleton (no matching in the request path). The
    // worker re-scores and clusters it (M6).
    const kind = inferKind(input.source_type);
    const [profile] = await tx
      .insert(braidProfiles)
      .values({ organization_id: orgId, kind, status: 'active', identity_count: 1, confidence: '1.00' })
      .returning({ id: braidProfiles.id });
    const profileId = profile!.id;

    await tx.insert(braidIdentities).values({
      organization_id: orgId,
      profile_id: profileId,
      source_type: input.source_type,
      source_id: input.source_id,
      match_keys: {},
      raw_attributes: {},
      link_confidence: '1.00',
      link_kind: 'seed',
    });

    // Durable cross-app link (spec 7.2).
    await tx
      .insert(entityLinks)
      .values({
        org_id: orgId,
        src_type: 'braid.profile',
        src_id: profileId,
        dst_type: input.source_type,
        dst_id: input.source_id,
        link_kind: 'related_to',
      })
      .onConflictDoNothing();

    return {
      profile_id: profileId,
      kind,
      identity_count: admin ? 1 : null,
      created: true,
    };
  });

  // Enqueue the freshly-seeded identity so the worker clusters it normally (spec 5.1). Done
  // AFTER commit so the identity row is visible to the worker; best-effort, the nightly
  // rescan source-diff is the fallback if the enqueue is dropped.
  if (result.created) {
    await enqueueBraidIngest({
      orgId,
      sourceType: input.source_type,
      sourceId: input.source_id,
      seeded: true,
    });
  }

  return result;
}
