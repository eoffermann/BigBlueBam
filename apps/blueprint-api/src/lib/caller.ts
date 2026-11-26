import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from './errors.js';

/**
 * The authenticated caller. requireAuth has run on every route that uses
 * this, so the user is set; this narrows the type without a non-null
 * assertion and fails closed if a route is ever wired without requireAuth.
 */
export function caller(request: FastifyRequest) {
  const user = request.user;
  if (!user) throw new ForbiddenError('Authentication required');
  return user;
}
