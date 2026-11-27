// The /bursar/ws fan-out publisher (spec 11.1, issue #121).
//
// Redis PubSub on one channel; each envelope names the org and the room it is for, and the hub
// (../ws/bursar-ws.ts) delivers it only to sockets of that org that joined that room.
//
// Rooms (spec 11.1):
//   org:<org_id>        any member of the org who may read requests
//   request:<id>        scope.progress, leveling.progress, matrix.updated for one request
//   vendor:<id>         reserved by the spec; no server event targets it yet (see the hub)
//
// The frame shapes are NOT declared here: they are @bigbluebam/shared's bursar-realtime schemas
// (#374), which the SPA's useBursarRealtime safeParses, so both ends compile against one contract.
//
// ── FRAMES ARE ADVISORY ONLY ─────────────────────────────────────────────────────────
// GET /requests/:id/leveling-runs polled at 5 s is the authoritative progress source (spec 11.1);
// a frame only makes the UI refetch sooner. So every publish swallows its errors: a realtime
// hint that fails must never fail the write that produced it. Frames carry refs and counts only,
// never prices, clause text or vendor names, so the seal and financial-flooring rules (spec 5.6)
// have nothing to act on.

import Redis from 'ioredis';
import type { BursarEventFrame, BursarEventPayload, BursarEventType } from '@bigbluebam/shared';
import { env } from '../env.js';

export const BURSAR_WS_CHANNEL = 'bursar:events';

/** What travels on the Redis channel. The hub checks org_id before it looks at the room. */
export interface BursarEnvelope {
  org_id: string;
  frame: BursarEventFrame;
}

export const orgRoom = (orgId: string) => `org:${orgId}`;
export const requestRoom = (requestId: string) => `request:${requestId}`;
export const vendorRoom = (vendorId: string) => `vendor:${vendorId}`;

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    publisher.on('error', () => {
      // Swallowed on purpose: an unhandled 'error' on an ioredis client crashes the process,
      // and a realtime publisher must never take bursar-api down.
    });
  }
  return publisher;
}

/** Test seam: replace the publisher (or pass null to restore the lazy default). */
export function __setBursarPublisherForTests(p: Pick<Redis, 'publish'> | null): void {
  publisher = p as Redis | null;
}

/** Publish one frame to one room of one org. Best effort; never throws. */
export async function publishBursarFrame<T extends BursarEventType>(
  orgId: string,
  room: string,
  type: T,
  payload: BursarEventPayload<T>,
): Promise<void> {
  // The generic pairs type with its payload at every call site; TS cannot narrow the union back
  // from a generic T, hence the cast.
  const envelope: BursarEnvelope = { org_id: orgId, frame: { type, room, payload } as BursarEventFrame };
  try {
    await getPublisher().publish(BURSAR_WS_CHANNEL, JSON.stringify(envelope));
  } catch {
    /* advisory: the 5 s poll carries progress */
  }
}

/** A scope-derivation slice finished (spec 11.1 scope.progress). */
export function publishScopeProgress(
  orgId: string,
  requestId: string,
  r: { runId: string; status: string; done: boolean; processedChunk: number | null; chunkCount: number },
): Promise<void> {
  return publishBursarFrame(orgId, requestRoom(requestId), 'scope.progress', {
    run_id: r.runId,
    status: r.status,
    done: r.done,
    chunk: r.processedChunk === null ? null : r.processedChunk + 1,
    chunk_count: r.chunkCount,
  });
}

/**
 * A leveling slice finished (spec 11.1 leveling.progress, "offer n/N"). A slice processes one
 * whole offer, so node and window progress inside the offer is not observable here; the frame
 * carries the offer position, and the run row (polled) carries the rest.
 */
export async function publishLevelingProgress(
  orgId: string,
  requestId: string,
  r: { runId: string; status: string; done: boolean; processedOffer: number | null; offerCount: number },
): Promise<void> {
  await publishBursarFrame(orgId, requestRoom(requestId), 'leveling.progress', {
    run_id: r.runId,
    status: r.status,
    done: r.done,
    offer: r.processedOffer === null ? null : r.processedOffer + 1,
    offer_count: r.offerCount,
  });
  // Every processed offer writes coverage and totals, so the matrix has changed.
  if (r.processedOffer !== null || r.done) {
    await publishBursarFrame(orgId, requestRoom(requestId), 'matrix.updated', { run_id: r.runId, done: r.done });
  }
}
