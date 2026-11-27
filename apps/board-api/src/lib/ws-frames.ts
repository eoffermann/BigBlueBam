// Issue #177: every client-to-server frame the Board WebSocket hub
// (ws/handler.ts) accepts, mapped to the catalog ids of its REST twin, and
// checked per frame by the suite-wide gate from @bigbluebam/permissions (see
// ws-frames.ts there for the map conventions). scripts/check-permission-catalog.mjs
// fails CI when the hub handles a frame this map does not name.
//
// Board's scene REST routes gate on the board ACL (requireBoardAccess /
// requireBoardEditAccess) with shadowOnly() catalog telemetry, so the socket
// does the same: the hub's checkBoardAccess / canEdit / lock checks block, and
// the shadow: ids feed the resolver's divergence telemetry without blocking.

import { createHttpPermissionChecker, createWsFrameGate } from '@bigbluebam/permissions';
import { env } from '../env.js';

export const WS_FRAME_PERMISSIONS = {
  // REST twin: GET /boards/:id/scene (requireBoardAccess, shadowOnly('board.board_scene.get')).
  join_board: ['shadow:board.board_scene.get'],
  // REST twin: PUT /boards/:id/scene (requireBoardEditAccess, shadowOnly('board.board_scene.update')).
  scene_update: ['shadow:board.board_scene.update'],
  // Cursor presence is visible to everyone viewing the board: a read.
  cursor_update: ['shadow:board.board_scene.get'],
  ping: [],
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
