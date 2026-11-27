// Issue #166: the Bureau WebSocket hub performs the same actions as the REST
// routes (knock, summon, door/lock, status, chat, presence), so every frame
// type is gated by the same bureau.* catalog ids, through the same resolver
// call (@bigbluebam/permissions resolveViaHttp) the REST plugin makes.
//
// Every `case '<type>':` in routes/ws.routes.ts MUST have an entry here.
// scripts/check-permission-catalog.mjs fails CI when one is missing, and
// test/ws-permissions.test.ts asserts the same. An empty list means the frame
// is always allowed for an authenticated socket; that is reserved for frames
// that only end or leave something the caller started (leaving must never be
// blocked) and the keepalive.

import {
  createHttpPermissionChecker,
  createWsFrameGate,
  type WsPermissionCheck,
} from '@bigbluebam/permissions';
import { env } from '../env.js';

export const WS_FRAME_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // Presence streaming. REST: GET floors (bureau.floor.read), presence (bureau.presence.read).
  subscribe_floor: ['bureau.floor.read', 'bureau.presence.read'],
  enter_room: ['bureau.room.read', 'bureau.presence.read'],
  location_update: ['bureau.presence.read'],
  leave_room: [],
  heartbeat: [],
  // REST: PATCH /v1/status.
  set_status: ['bureau.status.update'],
  // REST: PATCH /v1/rooms/:id/door.
  set_door: ['bureau.room.write'],
  lock_room: ['bureau.room.write'],
  // REST: POST /v1/knocks and POST /v1/knocks/:id/respond.
  knock: ['bureau.knock.create'],
  knock_respond: ['bureau.knock.respond'],
  // REST: GET room chat (bureau.chat.read). Sending had no catalog id before #166.
  chat_join: ['bureau.chat.read'],
  chat_send: ['bureau.chat.write'],
  chat_leave: [],
  // Answering a ring joins the call. REST: POST call join (bureau.call.join).
  ring_respond: ['bureau.call.join'],
  // REST: POST /v1/summon, summon read, grant access.
  summon: ['bureau.summon.create'],
  summon_respond: ['bureau.summon.read'],
  summon_grant_access: ['bureau.summon.grant_access'],
  // "Bring" is a consensual multi-person summon: starting one needs the
  // summon grant, answering one is the recipient side of a summon.
  bring_start: ['bureau.summon.create'],
  bring_respond: ['bureau.summon.read'],
  bring_cancel: [],
  bring_leave: [],
};

export type { WsPermissionCheck };

// The suite-wide per-frame gate (issue #177, @bigbluebam/permissions). Fails
// closed in enforce mode when the resolver gives no answer: unlike the REST
// routes there is no legacy role gate behind most of these frames.
export const wsFrameGate = createWsFrameGate(
  WS_FRAME_PERMISSIONS,
  createHttpPermissionChecker({
    mode: env.BBB_PERMISSIONS_ENFORCE,
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
    onUnknown: 'deny',
  }),
);

/** Test seam. */
export function setWsPermissionCheckForTests(fn: WsPermissionCheck): void {
  wsFrameGate.setCheckerForTests(fn);
}

/**
 * Returns the first catalog id the caller lacks for this frame type, or null
 * when the frame may run. Unknown frame types return null here; the hub's
 * default branch answers those with UNKNOWN_TYPE and runs nothing.
 */
export async function deniedPermissionForFrame(
  type: string,
  caller: { user_id: string; org_id: string | null },
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<string | null> {
  const denial = await wsFrameGate.check(type, caller, logger);
  return denial?.code === 'PERMISSION_DENIED' ? denial.permission_id : null;
}
