import Redis from 'ioredis';
import { env } from '../env.js';

// Redis-PubSub publisher for the /bulwark/ws realtime hub (spec 5.2). Frames are REFS-ONLY and
// PROJECT-SCOPED (SK1): a frame reaches a subscriber only when that subscriber passes
// isProjectMember on the frame's contract project (org-admin override), the SAME predicate the
// REST query builder uses. This closes the read side that spec 2.5(2) flagged as the
// write-discoverability vector.
//
// Rooms are keyed per (org, project):
//   bulwark:org:<org>:admin           - every frame for the org (owner/admin/superuser)
//   bulwark:org:<org>:proj:<project>  - frames for a specific project's contracts
//   bulwark:org:<org>:proj:none       - frames for null-project contracts (org fallback, SK3)
// The publisher fans a frame to the admin room AND the specific project room; frames carrying
// owner/admin-floored info (notice.drafted -> bulwark.notice.draft) go to the admin room only.

const CHANNEL = 'bulwark:events';

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    publisher.on('error', () => {});
  }
  return publisher;
}

export function bulwarkAdminRoom(orgId: string): string {
  return `bulwark:org:${orgId}:admin`;
}
export function bulwarkProjectRoom(orgId: string, projectId: string | null): string {
  return `bulwark:org:${orgId}:proj:${projectId ?? 'none'}`;
}

export type BulwarkFrameType =
  | 'deadline.armed'
  | 'waiver.risk_detected'
  | 'notice.drafted'
  | 'compliance.expiring';

export interface BulwarkFrame {
  type: BulwarkFrameType;
  data: Record<string, unknown>;
}

// Frames whose payload is owner/admin-floored: delivered to the admin room only (SK1).
const ADMIN_ONLY_FRAMES: ReadonlySet<BulwarkFrameType> = new Set(['notice.drafted']);

async function publishToRoom(room: string, frame: BulwarkFrame): Promise<void> {
  try {
    await getPublisher().publish(CHANNEL, JSON.stringify({ room, event: frame }));
  } catch {
    // ignore: a realtime frame is a hint to refetch; the read path is authoritative.
  }
}

// Fire-and-forget project-scoped publish. Callers pass the owning contract's project_id (null
// for a no-project contract). Never throws.
export async function publishBulwarkFrame(
  orgId: string,
  projectId: string | null,
  frame: BulwarkFrame,
): Promise<void> {
  await publishToRoom(bulwarkAdminRoom(orgId), frame);
  if (!ADMIN_ONLY_FRAMES.has(frame.type)) {
    await publishToRoom(bulwarkProjectRoom(orgId, projectId), frame);
  }
}

export const BULWARK_WS_CHANNEL = CHANNEL;
