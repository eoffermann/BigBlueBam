// Issue #177: every client-to-server frame the Bam WebSocket hub
// (plugins/websocket.ts, served at /b3/ws) accepts, mapped to the catalog ids of
// its REST twin, and checked per frame by the suite-wide gate from
// @bigbluebam/permissions (see ws-frames.ts there for the map conventions).
// scripts/check-permission-catalog.mjs fails CI when the hub handles a frame this
// map does not name.
//
// The api resolves permissions in-process (fastify.canResolve), not over HTTP
// like the satellites, so the probe is built per connection from the socket's
// authenticated user.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWsFrameGate, type WsFrameGate } from '@bigbluebam/permissions';
import { env } from '../env.js';

export const WS_FRAME_PERMISSIONS = {
  // Join a project room. REST twin: GET /projects/:id (shadowOnly('bam.project.get'));
  // the hub's canJoinProjectRoom (same org + project membership) is the gate.
  subscribe: ['shadow:bam.project.get'],
  unsubscribe: [],
  ping: [],
} as const satisfies Record<string, readonly string[]>;

/** The user fields the in-process permission context loader reads. */
export interface WsGateUser {
  id: string;
  is_superuser: boolean;
  active_org_id: string;
  kind?: string;
  api_key_scope?: string | null;
}

/**
 * A per-connection gate whose probe asks the in-process resolver about this
 * socket's user, with requireCan's mode semantics ('off' and 'warn' allow).
 */
export function createApiWsFrameGate(fastify: FastifyInstance, user: WsGateUser): WsFrameGate {
  const subject = { user: { kind: 'human', api_key_scope: null, ...user }, params: {} } as unknown as FastifyRequest;
  // A three-valued mode (off | warn | on, parsed by env.ts's z.enum), read the
  // way @bigbluebam/permissions reads opts.mode.
  const mode: 'off' | 'warn' | 'on' = env.BBB_PERMISSIONS_ENFORCE;
  return createWsFrameGate(WS_FRAME_PERMISSIONS, async (_caller, permissionId) => {
    if (mode === 'off') return true;
    const allowed = await fastify.canResolve(subject, permissionId);
    return mode === 'warn' ? true : allowed;
  });
}
