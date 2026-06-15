/**
 * Live state for Bureau "Bring" (follow-the-leader) sessions.
 *
 * A leader pulls one or more co-located users along as they navigate the suite,
 * until either side cancels — used to lead a tour, run sprint planning, etc.
 * The state is ephemeral (like a call), so it lives in Redis only — no DB table:
 *
 *   bureau:bring:leader:{org}:{leaderId}     SET of active follower userIds (TTL'd)
 *   bureau:bring:follower:{org}:{followerId} STRING leaderId the user follows (TTL'd)
 *   bureau:bring:target:{org}:{leaderId}     JSON {url,app,label,leaderName} (TTL'd)
 *   bureau:bring:req:{requestId}             JSON pending request (TTL 90s)
 *
 * Keyed by USER (not socket): a follower with two tabs follows from both, and a
 * single tab closing does not end the session. One follower follows at most one
 * leader at a time.
 *
 * Reconnect resilience: a Bring is meant to lead people *across apps*, and a
 * cross-app navigation is a full page reload that closes and reopens the WS. So
 * the follow relationship must survive a brief disconnect. We give the follower
 * pointer, the leader set, and the leader's resume target a short TTL that the
 * owner's 15s heartbeat re-extends (touchBring). A truly-gone user stops
 * heartbeating and is reaped when the TTL lapses; getFollowers() additionally
 * reconciles the leader set on every read so the leader never fans navigation
 * out to a follower whose lease has expired. The leader's current location is
 * mirrored into the target key so a follower who reconnects mid-tour can be
 * resumed and caught up to wherever the leader is now.
 */
import type Redis from 'ioredis';

/** How long a follow lease / leader set / resume target survives without a
 *  heartbeat refresh. Comfortably longer than a page-reload gap (the WS client
 *  beats every 15s), short enough to reap a closed tab within ~1.5 min. */
const FOLLOW_TTL_SECONDS = 90;
const REQUEST_TTL_SECONDS = 90;

const leaderKey = (org: string, leaderId: string) => `bureau:bring:leader:${org}:${leaderId}`;
const followerKey = (org: string, followerId: string) =>
  `bureau:bring:follower:${org}:${followerId}`;
const targetKey = (org: string, leaderId: string) => `bureau:bring:target:${org}:${leaderId}`;
const requestKey = (requestId: string) => `bureau:bring:req:${requestId}`;

export interface BringRequest {
  requestId: string;
  orgId: string;
  leaderId: string;
  leaderName: string;
  followerId: string;
  url: string;
  app: string;
  label?: string;
}

/** The leader's current location, used to resume + catch up a reconnecting
 *  follower. Refreshed on every leader location_update + heartbeat. */
export interface BringTarget {
  url: string;
  app: string;
  label?: string;
  leaderName: string;
}

/** Mark `followerId` as actively following `leaderId`. Returns the live count. */
export async function startFollow(
  redis: Redis,
  org: string,
  leaderId: string,
  followerId: string,
): Promise<number> {
  await redis.sadd(leaderKey(org, leaderId), followerId);
  // The leader set is reaped if the leader stops heartbeating; refresh it so a
  // fresh follow keeps it alive.
  await redis.expire(leaderKey(org, leaderId), FOLLOW_TTL_SECONDS);
  await redis.set(followerKey(org, followerId), leaderId, 'EX', FOLLOW_TTL_SECONDS);
  return (await getFollowers(redis, org, leaderId)).length;
}

/** Stop a follower following its leader (idempotent). Returns the live count. */
export async function stopFollow(
  redis: Redis,
  org: string,
  leaderId: string,
  followerId: string,
): Promise<number> {
  await redis.srem(leaderKey(org, leaderId), followerId);
  // Only clear the follower pointer if it still points at this leader.
  const current = await redis.get(followerKey(org, followerId));
  if (current === leaderId) await redis.del(followerKey(org, followerId));
  return (await getFollowers(redis, org, leaderId)).length;
}

/**
 * Live followers of a leader. Reconciles the set on read: a member whose
 * follower pointer has lapsed (closed tab past its TTL) or repointed at another
 * leader is dropped from the set and excluded, so the leader never fans
 * navigation out to a follower who is no longer there.
 */
export async function getFollowers(
  redis: Redis,
  org: string,
  leaderId: string,
): Promise<string[]> {
  const members = await redis.smembers(leaderKey(org, leaderId));
  if (members.length === 0) return [];
  const pipe = redis.pipeline();
  for (const m of members) pipe.get(followerKey(org, m));
  const res = await pipe.exec();
  const live: string[] = [];
  const stale: string[] = [];
  members.forEach((m, i) => {
    const val = (res?.[i]?.[1] ?? null) as string | null;
    if (val === leaderId) live.push(m);
    else stale.push(m);
  });
  if (stale.length > 0) await redis.srem(leaderKey(org, leaderId), ...stale);
  return live;
}

export async function getLeader(
  redis: Redis,
  org: string,
  followerId: string,
): Promise<string | null> {
  return redis.get(followerKey(org, followerId));
}

/** End ALL of a leader's brings. Returns the follower ids that were active. */
export async function endLeaderBrings(
  redis: Redis,
  org: string,
  leaderId: string,
): Promise<string[]> {
  const followers = await redis.smembers(leaderKey(org, leaderId));
  const pipe = redis.pipeline();
  for (const f of followers) pipe.del(followerKey(org, f));
  pipe.del(leaderKey(org, leaderId));
  pipe.del(targetKey(org, leaderId));
  await pipe.exec();
  return followers;
}

/** Store/refresh the leader's current location for follower resume + catch-up. */
export async function setBringTarget(
  redis: Redis,
  org: string,
  leaderId: string,
  target: BringTarget,
): Promise<void> {
  await redis.set(targetKey(org, leaderId), JSON.stringify(target), 'EX', FOLLOW_TTL_SECONDS);
}

export async function getBringTarget(
  redis: Redis,
  org: string,
  leaderId: string,
): Promise<BringTarget | null> {
  const raw = await redis.get(targetKey(org, leaderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BringTarget;
  } catch {
    return null;
  }
}

/**
 * Re-extend the caller's bring leases so a brief reconnect (a cross-app
 * navigation reload) doesn't drop the session: refreshes the follower pointer
 * (if following) and the leader set + target (if leading). No-ops on whichever
 * keys don't exist for this user.
 */
export async function touchBring(redis: Redis, org: string, userId: string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.expire(followerKey(org, userId), FOLLOW_TTL_SECONDS);
  pipe.expire(leaderKey(org, userId), FOLLOW_TTL_SECONDS);
  pipe.expire(targetKey(org, userId), FOLLOW_TTL_SECONDS);
  await pipe.exec();
}

/** A leader is "alive" while their target lease is unexpired (heartbeat-kept).
 *  A follower whose leader is no longer alive self-ejects. */
export async function isBringLeaderAlive(
  redis: Redis,
  org: string,
  leaderId: string,
): Promise<boolean> {
  return (await redis.exists(targetKey(org, leaderId))) === 1;
}

export async function createRequest(redis: Redis, req: BringRequest): Promise<void> {
  await redis.set(requestKey(req.requestId), JSON.stringify(req), 'EX', REQUEST_TTL_SECONDS);
}

/** Read and consume a pending request (one-shot). */
export async function takeRequest(
  redis: Redis,
  requestId: string,
): Promise<BringRequest | null> {
  const raw = await redis.get(requestKey(requestId));
  if (!raw) return null;
  await redis.del(requestKey(requestId));
  try {
    return JSON.parse(raw) as BringRequest;
  } catch {
    return null;
  }
}
