import Redis from 'ioredis';
import { env } from '../env.js';

// Redis-PubSub publisher for the /braid/ws org-scoped realtime hub (spec 5.2).
//
// Frames are REFS-ONLY: candidate.created { candidate_id, score }, profile.merged
// { surviving_profile_id, affected_identities }, profile.split { ... }. No PII, no
// evidence in the frame; the SPA fetches through the per-caller filtered read path.
// The publisher opens one lazy connection; the ws handler subscribes to the same
// `braid:events` channel and fans each frame to sockets in the target room.

const CHANNEL = 'braid:events';

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    // Connect eagerly-on-first-use; ioredis auto-connects on first command with
    // lazyConnect, so an explicit connect is optional. Swallow connection errors
    // so a Redis blip never breaks a truth-changing operation.
    publisher.on('error', () => {});
  }
  return publisher;
}

export function braidRoom(orgId: string): string {
  return `braid:org:${orgId}`;
}

export interface BraidFrame {
  type: 'candidate.created' | 'profile.merged' | 'profile.split' | 'profile.matched';
  data: Record<string, unknown>;
}

// Fire-and-forget: never throws. A realtime frame is a hint to refetch, so losing
// one is harmless (the read path is authoritative).
export async function publishBraidFrame(orgId: string, frame: BraidFrame): Promise<void> {
  try {
    await getPublisher().publish(
      CHANNEL,
      JSON.stringify({ room: braidRoom(orgId), event: frame }),
    );
  } catch {
    // ignore
  }
}

export const BRAID_WS_CHANNEL = CHANNEL;
