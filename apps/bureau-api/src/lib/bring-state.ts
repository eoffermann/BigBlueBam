/**
 * Live state for Bureau "Bring" (follow-the-leader) sessions.
 *
 * A leader pulls one or more co-located users along as they navigate the suite,
 * until either side cancels — used to lead a tour, run sprint planning, etc.
 * The state is ephemeral (like a call), so it lives in Redis only — no DB table:
 *
 *   bureau:bring:leader:{org}:{leaderId}     SET of active follower userIds
 *   bureau:bring:follower:{org}:{followerId} STRING leaderId the user follows
 *   bureau:bring:req:{requestId}             JSON pending request (TTL 90s)
 *
 * Keyed by USER (not socket): a follower with two tabs follows from both, and a
 * single tab closing does not end the session (the WS cleanup only tears down on
 * the user's last tab). One follower follows at most one leader at a time.
 */
import type Redis from 'ioredis';

const REQUEST_TTL_SECONDS = 90;

const leaderKey = (org: string, leaderId: string) => `bureau:bring:leader:${org}:${leaderId}`;
const followerKey = (org: string, followerId: string) =>
  `bureau:bring:follower:${org}:${followerId}`;
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

/** Mark `followerId` as actively following `leaderId`. Returns the follower count. */
export async function startFollow(
  redis: Redis,
  org: string,
  leaderId: string,
  followerId: string,
): Promise<number> {
  await redis.sadd(leaderKey(org, leaderId), followerId);
  await redis.set(followerKey(org, followerId), leaderId);
  return redis.scard(leaderKey(org, leaderId));
}

/** Stop a follower following its leader (idempotent). Returns the remaining count. */
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
  return redis.scard(leaderKey(org, leaderId));
}

export async function getFollowers(
  redis: Redis,
  org: string,
  leaderId: string,
): Promise<string[]> {
  return redis.smembers(leaderKey(org, leaderId));
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
  if (followers.length === 0) return [];
  const pipe = redis.pipeline();
  for (const f of followers) pipe.del(followerKey(org, f));
  pipe.del(leaderKey(org, leaderId));
  await pipe.exec();
  return followers;
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
