// The FastifyRequest augmentation (user, sessionId, isImpersonating) is declared in
// ../plugins/auth.ts. This file deliberately does not import it at runtime: that module opens
// a database pool at import time, and these guards must be unit-testable without one.
import type { FastifyReply, FastifyRequest } from 'fastify';

// Vouching guards (spec 2.8). Exported for the milestones that add the vouching routes
// (attest, manual evidence, link review, assertion confirm and reject, both decide routes,
// questionnaire approve, auditor-room create/revoke/unlock, redaction, restore acknowledgement).
//
// Use them as preHandlers AFTER the global auth hook has run:
//   { preHandler: [requireSession, rejectWhenImpersonating, fastify.requireCan('...')] }

export type AuthMethod = 'session' | 'api_key';

/**
 * How the caller authenticated. A request counts as a session only when it carried a valid
 * cookie session and no API-key scope. Mirrors apps/api/src/routes/proposals.routes.ts (#136)
 * so Bastion and the platform decide route record the same value.
 */
export function authMethodOf(request: FastifyRequest): AuthMethod | null {
  if (!request.user) return null;
  return request.sessionId && request.user.api_key_scope === null ? 'session' : 'api_key';
}

function send403(request: FastifyRequest, reply: FastifyReply, code: string, message: string, issue: string) {
  return reply.status(403).send({
    error: {
      code,
      message,
      details: [{ field: 'auth', issue }],
      request_id: request.id,
    },
  });
}

function send401(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: [],
      request_id: request.id,
    },
  });
}

/**
 * Impersonation cannot vouch. A SuperUser acting as someone else may read, but may not sign,
 * accept, approve or decide on that person's behalf.
 */
export async function rejectWhenImpersonating(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return send401(request, reply);
  if (request.isImpersonating) {
    return send403(
      request,
      reply,
      'IMPERSONATION_NOT_ALLOWED',
      'You are viewing Bastion as another person. Only that person can do this; stop impersonating and ask them to do it themselves.',
      'impersonating',
    );
  }
}

/**
 * Vouching needs a session, not an API key (issue #136). users.kind on an API-key request is
 * the key owner's kind, so a human's bbam_ key used by an MCP-connected agent would otherwise
 * pass a bare kind === 'human' check.
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return send401(request, reply);
  if (authMethodOf(request) !== 'session') {
    return send403(
      request,
      reply,
      'SESSION_REQUIRED',
      'This needs a person signed in to Bastion. API keys (and therefore MCP and agent callers) cannot do it.',
      'api_key',
    );
  }
}
