import { z } from 'zod';

/**
 * The /bursar/ws wire contract (spec 11.1, #374), declared once for both ends:
 * bursar-api's publisher (lib/realtime.ts) and hub (ws/bursar-ws.ts) build these frames, and the
 * SPA's useBursarRealtime safeParses every incoming message against bursarServerFrameSchema, so a
 * rename on either side is a type error instead of a silently dead realtime path.
 *
 * Rooms: `org:<id>` and `request:<id>`. `vendor:<id>` is reserved by the spec but refused by the
 * hub until a server event targets it. Event frames are advisory: GET
 * /requests/:id/leveling-runs (polled at 5 s) is the source of truth, and a frame only makes the
 * UI refetch sooner. Payloads carry refs and counts only, never prices, clause text or vendor names.
 */

const room = z.string().min(1);

/** A scope-derivation slice finished. `chunk` is 1-based; null before the first slice. */
export const bursarScopeProgressFrameSchema = z.object({
  type: z.literal('scope.progress'),
  room,
  payload: z.object({
    run_id: z.string(),
    status: z.string(),
    done: z.boolean(),
    chunk: z.number().int().nullable(),
    chunk_count: z.number().int(),
  }),
});

/**
 * A leveling slice finished. A slice processes one whole offer, so the frame carries the offer
 * position only (n/N, 1-based); node and window progress live on the polled run row.
 */
export const bursarLevelingProgressFrameSchema = z.object({
  type: z.literal('leveling.progress'),
  room,
  payload: z.object({
    run_id: z.string(),
    status: z.string(),
    done: z.boolean(),
    offer: z.number().int().nullable(),
    offer_count: z.number().int(),
  }),
});

/** Coverage or totals changed for a request: refetch the matrix / exclusion diff. */
export const bursarMatrixUpdatedFrameSchema = z.object({
  type: z.literal('matrix.updated'),
  room,
  payload: z.object({
    run_id: z.string(),
    done: z.boolean(),
  }),
});

/** The three server events published on Redis and fanned out by the hub. */
export const bursarEventFrameSchema = z.discriminatedUnion('type', [
  bursarScopeProgressFrameSchema,
  bursarLevelingProgressFrameSchema,
  bursarMatrixUpdatedFrameSchema,
]);
export type BursarEventFrame = z.infer<typeof bursarEventFrameSchema>;
export type BursarEventType = BursarEventFrame['type'];
export type BursarEventPayload<T extends BursarEventType> = Extract<BursarEventFrame, { type: T }>['payload'];

/** Sent once after the upgrade, with the rooms joined from `?rooms=`. */
export const bursarReadyFrameSchema = z.object({
  type: z.literal('ready'),
  rooms: z.array(z.string()),
});

/** Reply to a client `subscribe`: every room now held, and which of the requested ones joined. */
export const bursarSubscribedFrameSchema = z.object({
  type: z.literal('subscribed'),
  rooms: z.array(z.string()),
  joined: z.array(z.string()),
});

/** A client frame the per-frame catalog gate refused. */
export const bursarErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['PERMISSION_DENIED', 'UNKNOWN_FRAME']),
  frame_type: z.string(),
  permission_id: z.string().optional(),
  message: z.string(),
});

/** Everything the hub may send a browser. */
export const bursarServerFrameSchema = z.discriminatedUnion('type', [
  bursarScopeProgressFrameSchema,
  bursarLevelingProgressFrameSchema,
  bursarMatrixUpdatedFrameSchema,
  bursarReadyFrameSchema,
  bursarSubscribedFrameSchema,
  bursarErrorFrameSchema,
]);
export type BursarServerFrame = z.infer<typeof bursarServerFrameSchema>;

/** The one client-to-server frame: join more rooms after open (the hub caps rooms per socket). */
export const bursarSubscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  rooms: z.array(z.string()),
});
export const bursarClientFrameSchema = z.discriminatedUnion('type', [bursarSubscribeFrameSchema]);
export type BursarClientFrame = z.infer<typeof bursarClientFrameSchema>;
