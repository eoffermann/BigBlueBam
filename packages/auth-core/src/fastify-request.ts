// request.user, sessionId, impersonator and isImpersonating as the satellite auth plugin
// (createSatelliteAuth) sets them. A separate entry point so only the satellites import it:
// apps/api declares its own, differently shaped, request.user.
//
//   import '@bigbluebam/auth-core/fastify-request';
import type { SatelliteAuthUser } from './satellite-plugin.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SatelliteAuthUser | null;
    sessionId: string | null;
    impersonator: SatelliteAuthUser | null;
    isImpersonating: boolean;
  }
}
