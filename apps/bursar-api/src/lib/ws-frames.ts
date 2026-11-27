// Issues #121, #177: every client-to-server frame the Bursar WebSocket hub (ws/bursar-ws.ts)
// accepts, mapped to the catalog ids of its REST twin, and checked per frame by the suite-wide
// gate from @bigbluebam/permissions. scripts/check-permission-catalog.mjs fails CI when the hub
// handles a frame this map does not name.

import { createHttpPermissionChecker, createWsFrameGate } from '@bigbluebam/permissions';
import { env } from '../env.js';
import { BURSAR_PERMISSIONS_MODE, BURSAR_PERMISSIONS_ON_UNKNOWN } from '../boot/assert-permissions-enforce.js';

export const WS_FRAME_PERMISSIONS = {
  // Join request/org rooms for progress frames. REST twin: GET /requests/:id
  // (requireCan('bursar.request.read')). The hub also checks each room's request is in the
  // caller's org.
  subscribe: ['bursar.request.read'],
} as const satisfies Record<string, readonly string[]>;

// Same hardcoded, fail-closed posture as bursar-api's REST permissions plugin.
export const wsFrameGate = createWsFrameGate(
  WS_FRAME_PERMISSIONS,
  createHttpPermissionChecker({
    mode: BURSAR_PERMISSIONS_MODE,
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
    onUnknown: BURSAR_PERMISSIONS_ON_UNKNOWN,
  }),
);
