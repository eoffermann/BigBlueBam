// API key project restriction (#352).
//
// An API key may be minted with api_keys.project_ids: the UI, CLI (--project-id) and docs all
// promise "the key can only access resources within those projects". Until #352 no service read
// it. The rule now lives here, once:
//
//   - keyProjectRestriction: which projects a key is confined to (null = unrestricted). An empty
//     array is treated as unrestricted, because the create forms send [] for "no restriction".
//   - keyProjectAllows: whether a restricted key may touch one project. A request whose project
//     is unknown (org-wide routes, non-project resources, every satellite app) is refused: the
//     restriction fails closed outside Bam projects.
//   - checkKeyProjectAccess / keyProjectAccessChecked: the per-request record a project guard
//     leaves, which apps/api's fail-closed final gate (requireKeyProjectChecked) reads, so a
//     restricted key is refused on any route that never established its project.
//   - refuseProjectRestrictedKey: the satellites' answer. They have no Bam project context, so a
//     project-restricted key is refused at authentication.

import type { FastifyReply, FastifyRequest } from 'fastify';

/** The request.user field carrying a key's project restriction (null: none, or session auth). */
export interface ProjectRestrictedUser {
  api_key_project_ids?: readonly string[] | null;
}

/** The projects a key is confined to, or null when it is unrestricted (NULL or empty). */
export function keyProjectRestriction(projectIds: readonly string[] | null | undefined): string[] | null {
  return projectIds && projectIds.length > 0 ? [...projectIds] : null;
}

/** Whether a key with this restriction may act on `projectId`. Unknown project: refused. */
export function keyProjectAllows(
  restriction: readonly string[] | null | undefined,
  projectId: string | null | undefined,
): boolean {
  if (!restriction || restriction.length === 0) return true;
  return typeof projectId === 'string' && restriction.includes(projectId);
}

function restrictionOf(request: FastifyRequest): readonly string[] | null {
  const user = (request as unknown as { user?: ProjectRestrictedUser | null }).user;
  return keyProjectRestriction(user?.api_key_project_ids ?? null);
}

/** True when the request authenticated with a project-restricted API key. */
export function isKeyProjectRestricted(request: FastifyRequest): boolean {
  return restrictionOf(request) !== null;
}

/**
 * Probe form of checkKeyProjectAccess: the same answer, but it records nothing, so a handler
 * asking about some other project cannot satisfy the fail-closed final gate.
 */
export function keyProjectAllowsRequest(request: FastifyRequest, projectId: string | null | undefined): boolean {
  return keyProjectAllows(restrictionOf(request), projectId);
}

const checkedRequests = new WeakSet<object>();

/**
 * A project guard's question: may this request's credential act on `projectId`? Always true for
 * sessions and unrestricted keys. For a restricted key, true only for a listed project, and the
 * request is then recorded as checked (keyProjectAccessChecked).
 */
export function checkKeyProjectAccess(request: FastifyRequest, projectId: string | null | undefined): boolean {
  const restriction = restrictionOf(request);
  if (!restriction) return true;
  if (!keyProjectAllows(restriction, projectId)) return false;
  checkedRequests.add(request);
  return true;
}

/** Whether a project guard has admitted this request's restricted key to a listed project. */
export function keyProjectAccessChecked(request: FastifyRequest): boolean {
  return checkedRequests.has(request);
}

export const KEY_PROJECT_RESTRICTED = 'API_KEY_PROJECT_RESTRICTED';

function sendRestricted(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.status(403).send({
    error: { code: KEY_PROJECT_RESTRICTED, message, details: [], request_id: request.id },
  });
}

/**
 * apps/api's fail-closed final gate: a project-restricted key is refused unless a project guard
 * (requireProjectAccess, requireProjectAccessForEntity, or requireCan with a project scope)
 * admitted it to a listed project earlier in this request. Org-wide and non-project routes
 * therefore refuse restricted keys.
 */
export async function requireKeyProjectChecked(request: FastifyRequest, reply: FastifyReply) {
  if (!isKeyProjectRestricted(request) || keyProjectAccessChecked(request)) return;
  return sendRestricted(
    request,
    reply,
    'This API key is restricted to specific projects and this request is not scoped to one of them',
  );
}

/**
 * Satellite services hold no Bam project context, so a project-restricted key cannot be
 * confined there; it is refused outright. Returns the sent reply when refused, else undefined.
 */
export function refuseProjectRestrictedKey(
  request: FastifyRequest,
  reply: FastifyReply,
  projectIds: readonly string[] | null | undefined,
) {
  if (!keyProjectRestriction(projectIds)) return undefined;
  return sendRestricted(
    request,
    reply,
    'This API key is restricted to specific Bam projects and cannot be used with this service',
  );
}
