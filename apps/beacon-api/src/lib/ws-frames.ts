// Issue #177: every client-to-server frame the Beacon Yjs co-editing socket
// (ws/handler.ts) accepts, mapped to the catalog ids of its REST twin, and
// checked per frame by the suite-wide gate from @bigbluebam/permissions (see
// ws-frames.ts there for the map conventions and classifyYjsFrame for the frame
// names). scripts/check-permission-catalog.mjs fails CI when the map does not
// name every Yjs frame type.
//
// Beacon's REST twins gate on the article ACL (requireBeaconReadAccess /
// requireBeaconEditAccess) with shadowOnly() catalog telemetry, so the socket
// does the same: the hub's connect-time access check and per-frame canEdit
// check block, and the shadow: ids feed divergence telemetry without blocking.

import { createHttpPermissionChecker, createWsFrameGate } from '@bigbluebam/permissions';
import { env } from '../env.js';

export const WS_FRAME_PERMISSIONS = {
  // Ask for the document state. REST twin: GET /beacons/:id.
  sync_step1: ['shadow:beacon.beacon.get'],
  // Change the shared document (sync step 2 or update). REST twin: PUT /beacons/:id.
  sync_update: ['shadow:beacon.beacon.update'],
  // Cursor/presence, visible to everyone with the article open: a read.
  awareness: ['shadow:beacon.beacon.get'],
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
