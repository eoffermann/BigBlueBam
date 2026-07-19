// The /burn/ws fan-out publisher. Spec 6.2.
//
// Redis PubSub, refs and coarse bands only, PROJECT-SCOPED delivery. Rooms are keyed per
// (org, project):
//
//   burn:org:<org>:admin            every frame for the org (owner/admin/superuser)
//   burn:org:<org>:proj:<project>   frames for a chain linked to that project
//
// A frame reaches a subscriber only when that subscriber passes the 2.4 point 6 predicate
// for a project linked to the frame's chain. There is NO `:proj:none` room: a chain with no
// linked projects is read_all-only (see lib/project-scope.ts), so its frames go to the admin
// room and nowhere else. That asymmetry with Bulwark's `proj:none` room is deliberate and is
// the same D4 inversion the project predicate exists to avoid.
//
// ── FRAMES ARE ADVISORY-ONLY ─────────────────────────────────────────────────────────
//
// No frame is load-bearing for correctness. The client refetches the affected TanStack Query
// keys on reconnect rather than replaying a backlog, so a dropped frame, a Redis blip, or a
// socket that missed an hour costs a refetch and nothing else. That is why every publish
// path here swallows its errors: a realtime hint that fails must never fail the write that
// produced it.
//
// ── WHAT MAY TRAVEL ──────────────────────────────────────────────────────────────────
//
// Refs (ids) and coarse bands. No client names, no clause text, no dollars, no percentages.
// The frame shapes are pinned by burnWsFrameSchema in @bigbluebam/shared and validated
// before publish, so a future field cannot be added on the publisher side alone.

import Redis from 'ioredis';
import { burnWsFrameSchema, type BurnWsFrame } from '@bigbluebam/shared';
import { env } from '../env.js';

export const BURN_WS_CHANNEL = 'burn:events';

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    publisher.on('error', () => {
      // Swallowed on purpose: an unhandled 'error' on an ioredis client is a process-level
      // crash, and a realtime publisher must never be able to take burn-api down.
    });
  }
  return publisher;
}

export function burnAdminRoom(orgId: string): string {
  return `burn:org:${orgId}:admin`;
}

export function burnProjectRoom(orgId: string, projectId: string): string {
  return `burn:org:${orgId}:proj:${projectId}`;
}

export interface BurnEnvelope {
  room: string;
  event: BurnWsFrame;
}

async function publishToRoom(room: string, frame: BurnWsFrame): Promise<void> {
  try {
    await getPublisher().publish(BURN_WS_CHANNEL, JSON.stringify({ room, event: frame }));
  } catch {
    // advisory only
  }
}

/**
 * Fire-and-forget project-scoped publish. Never throws.
 *
 * `projectIds` are the projects linked to the frame's chain, resolved by the CALLER (which
 * is already inside an org-scoped transaction and already knows them). Resolving them here
 * would mean a DB round trip on the write path for a hint the client can live without.
 *
 * An empty `projectIds` means a zero-project chain: admin room only.
 */
export async function publishBurnFrame(
  orgId: string,
  projectIds: readonly string[],
  frame: BurnWsFrame,
): Promise<void> {
  const parsed = burnWsFrameSchema.safeParse(frame);
  if (!parsed.success) {
    // A malformed frame is a programming error, not a runtime condition. Dropping it is
    // strictly better than publishing an unvalidated shape into the fan-out, because the
    // schema is the only thing standing between "coarse band" and "dollar amount".
    return;
  }
  await publishToRoom(burnAdminRoom(orgId), parsed.data);
  const seen = new Set<string>();
  for (const projectId of projectIds) {
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    await publishToRoom(burnProjectRoom(orgId, projectId), parsed.data);
  }
}

export async function closeBurnPublisher(): Promise<void> {
  if (publisher) {
    try {
      await publisher.quit();
    } catch {
      /* ignore */
    }
    publisher = null;
  }
}
