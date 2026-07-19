import Redis from 'ioredis';
import { env } from '../env.js';

// Redis-PubSub publisher for the /bulwark/ws realtime hub (spec 5.2).
//
// Frames are REFS-ONLY and project-scoped (SK1): deadline.armed { deadline_id,
// obligation_id, due_at }, waiver.risk_detected { risk_id, severity, contract_id },
// notice.drafted { deadline_id, proposal_id }, compliance.expiring { compliance_doc_id,
// vendor_tier_id }. No clause text, no PII; the SPA fetches through the per-caller filtered
// read path. The publisher opens one lazy connection; the ws handler subscribes to the same
// `bulwark:events` channel and fans each frame to sockets in the target room.
//
// NOTE: project-scoped fan-out (dropping a frame for a contract whose project the subscriber
// is not a member of) is wired in a later milestone; this M1 hub establishes the transport.

const CHANNEL = 'bulwark:events';

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    // ioredis auto-connects on first command with lazyConnect. Swallow connection errors
    // so a Redis blip never breaks a truth-changing operation.
    publisher.on('error', () => {});
  }
  return publisher;
}

export function bulwarkRoom(orgId: string): string {
  return `bulwark:org:${orgId}`;
}

export interface BulwarkFrame {
  type: 'deadline.armed' | 'waiver.risk_detected' | 'notice.drafted' | 'compliance.expiring';
  data: Record<string, unknown>;
}

// Fire-and-forget: never throws. A realtime frame is a hint to refetch, so losing one is
// harmless (the read path is authoritative).
export async function publishBulwarkFrame(orgId: string, frame: BulwarkFrame): Promise<void> {
  try {
    await getPublisher().publish(
      CHANNEL,
      JSON.stringify({ room: bulwarkRoom(orgId), event: frame }),
    );
  } catch {
    // ignore
  }
}

export const BULWARK_WS_CHANNEL = CHANNEL;
