/**
 * Beacon notification service — enqueues lifecycle notifications (§6.2)
 * to the shared BullMQ `notifications` queue used by all BigBlueBam apps.
 */

import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BeaconEventType =
  | 'beacon.pending_review'
  | 'beacon.agent_verified'
  | 'beacon.agent_challenged'
  | 'beacon.grace_halfway'
  | 'beacon.archived';

export interface BeaconEvent {
  type: BeaconEventType;
  beaconId: string;
  /** Explicit recipient list — when omitted, resolved from owner + project admins */
  recipientIds?: string[];
  /** Extra context stored in the notification payload */
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<BeaconEventType, string> = {
  'beacon.pending_review': 'lifecycle',
  'beacon.agent_verified': 'verification',
  'beacon.agent_challenged': 'verification',
  'beacon.grace_halfway': 'lifecycle',
  'beacon.archived': 'lifecycle',
};

const TITLE_MAP: Record<BeaconEventType, string> = {
  'beacon.pending_review': 'Beacon needs review',
  'beacon.agent_verified': 'Beacon auto-verified',
  'beacon.agent_challenged': 'Beacon challenged — action required',
  'beacon.grace_halfway': 'Beacon grace period halfway',
  'beacon.archived': 'Beacon archived',
};

// ---------------------------------------------------------------------------
// Queue (lazy init)
// ---------------------------------------------------------------------------

let _queue: Queue | null = null;

function getQueue(redisUrl: string): Queue {
  if (!_queue) {
    const url = new URL(redisUrl);
    _queue = new Queue('notifications', {
      connection: {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
      },
      // Bound job history so this producer cannot refill Redis (OOM root cause).
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
    });
  }
  return _queue;
}

// ---------------------------------------------------------------------------
// notifyBeaconEvent
// ---------------------------------------------------------------------------

export async function notifyBeaconEvent(
  event: BeaconEvent,
  redisUrl?: string,
): Promise<void> {
  const effectiveRedisUrl = redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

  // Resolve beacon metadata
  const beaconRows: any[] = await db.execute(sql`
    SELECT id, slug, title, owned_by, project_id, organization_id
    FROM beacon_entries
    WHERE id = ${event.beaconId}
    LIMIT 1
  `);

  const beacon = beaconRows[0];
  if (!beacon) return;

  // Resolve recipients
  let recipientIds = event.recipientIds;
  if (!recipientIds || recipientIds.length === 0) {
    recipientIds = await resolveRecipients(event.type, beacon);
  }

  if (recipientIds.length === 0) return;

  const deepLink = `/beacon/b/${beacon.slug}`;
  const queue = getQueue(effectiveRedisUrl);

  for (const recipientId of recipientIds) {
    await queue.add('beacon-notification', {
      recipient_id: recipientId,
      source_app: 'beacon',
      category: CATEGORY_MAP[event.type],
      title: TITLE_MAP[event.type],
      body: `"${beacon.title}" requires attention.`,
      deep_link: deepLink,
      beacon_id: beacon.id,
      event_type: event.type,
      organization_id: beacon.organization_id,
      project_id: beacon.project_id,
      ...(event.context ?? {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/**
 * Per §6.2:
 *   beacon.pending_review  → owner + project admins
 *   beacon.agent_verified  → owner (FYI)
 *   beacon.agent_challenged → owner (action required)
 *   beacon.grace_halfway   → owner + project admins
 *   beacon.archived        → owner + project admins
 */
async function resolveRecipients(
  eventType: BeaconEventType,
  beacon: { owned_by: string; project_id: string | null; organization_id: string },
): Promise<string[]> {
  const ownerOnly: BeaconEventType[] = [
    'beacon.agent_verified',
    'beacon.agent_challenged',
  ];

  if (ownerOnly.includes(eventType)) {
    return [beacon.owned_by];
  }

  // Owner + project admins
  const ids = new Set<string>([beacon.owned_by]);

  if (beacon.project_id) {
    const adminRows: any[] = await db.execute(sql`
      SELECT user_id FROM project_memberships
      WHERE project_id = ${beacon.project_id}
        AND role IN ('admin', 'owner')
    `);
    for (const row of adminRows) {
      ids.add(row.user_id);
    }
  }

  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function closeNotificationQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}
