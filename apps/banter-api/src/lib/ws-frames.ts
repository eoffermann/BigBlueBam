// Issue #177: every client-to-server frame the Banter WebSocket hub
// (ws/handler.ts) accepts, mapped to the catalog ids of its REST twin, and
// checked per frame by the suite-wide gate from @bigbluebam/permissions (see
// ws-frames.ts there for the map conventions). scripts/check-permission-catalog.mjs
// fails CI when the hub handles a frame this map does not name.

import { createHttpPermissionChecker, createWsFrameGate } from '@bigbluebam/permissions';
import { env } from '../env.js';

export const WS_FRAME_PERMISSIONS = {
  // REST twin: GET /v1/channels/:id/messages (requireAuth + requireChannelMember,
  // no catalog id). The hub runs the same org and membership checks.
  subscribe: [],
  unsubscribe: [],
  // A typing indicator announces a message about to be posted into the
  // channel. REST twin: POST /v1/channels/:id/messages
  // (requireCan('banter.channel_message.create')).
  'typing.start': ['banter.channel_message.create'],
  // Only ends what typing.start began; never blocked.
  'typing.stop': [],
} as const satisfies Record<string, readonly string[]>;

// onUnknown mirrors this app's REST requireCan (the HTTP plugin default).
export const wsFrameGate = createWsFrameGate(
  WS_FRAME_PERMISSIONS,
  createHttpPermissionChecker({
    mode: env.BBB_PERMISSIONS_ENFORCE,
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
    onUnknown: 'allow',
  }),
);
