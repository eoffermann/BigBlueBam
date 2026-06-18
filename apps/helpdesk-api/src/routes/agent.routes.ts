import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, or, sql, ilike } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { tickets } from '../db/schema/tickets.js';
import { ticketMessages } from '../db/schema/ticket-messages.js';
import { projects, users, tasks } from '../db/schema/bbb-refs.js';
import { helpdeskUsers } from '../db/schema/helpdesk-users.js';
import { helpdeskAgentApiKeys } from '../db/schema/helpdesk-agent-api-keys.js';
import { helpdeskSettings } from '../db/schema/helpdesk-settings.js';

/** Escape LIKE/ILIKE metacharacters so user input is treated as literal text. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}
import {
  broadcastTicketMessage,
  broadcastTicketStatusChanged,
  broadcastTicketUpdated,
} from '../services/realtime.js';
import { mirrorTicketMessageToTask, mirrorTicketClosedToTask } from '../lib/task-sync.js';
import { logTicketActivity } from '../lib/ticket-activity.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

const updateTicketSchema = z.object({
  status: z.enum(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  category: z.string().max(100).optional(),
});

const agentMessageSchema = z.object({
  body: z.string().min(1),
  is_internal: z.boolean().default(false),
  author_name: z.string().min(1).max(100).optional(),
  author_id: z.string().uuid().optional(),
});

/**
 * Identity resolved from an authenticated agent request.
 * `userId`/`orgId` are only populated if a valid Bam session cookie accompanied
 * the request (indicating a logged-in human agent). Even when a session is
 * present, a valid X-Agent-Key / Bearer token is still required for auth —
 * the session alone does NOT grant access (see HB-12).
 */
interface AgentIdentity {
  userId: string | null;
  userDisplayName: string | null;
  orgId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Bam user id of the agent whose X-Agent-Key authenticated this
     * request. Populated by requireAgentAuth once the key is verified.
     * Distinct from the session-cookie-derived identity used for
     * org-scoping / message authorship: the key is the authoritative
     * authentication factor (HB-28 + HB-49), while the session cookie
     * is purely informational.
     */
    agentUserId: string | null;
  }
}

/**
 * Look up a Bam user + org from a session cookie. Returns null if the session
 * is missing, invalid, or expired. This is used ONLY to enrich the request
 * with caller identity (for org-scoping and authorship) — it is NOT an
 * authentication mechanism on its own (see HB-12).
 */
async function resolveSessionIdentity(sessionCookie: string | undefined): Promise<AgentIdentity | null> {
  if (!sessionCookie) return null;
  try {
    const result = await db.execute(
      sql`SELECT u.id AS user_id, u.display_name, u.org_id
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.id = ${sessionCookie} AND s.expires_at > now()
          LIMIT 1`,
    );
    const row = Array.isArray(result) ? result[0] : (result as any).rows?.[0];
    if (!row) return null;
    return {
      userId: (row as any).user_id ?? null,
      userDisplayName: (row as any).display_name ?? null,
      orgId: (row as any).org_id ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Verify the request has a valid per-agent API key (HB-28 + HB-49).
 *
 * Agents MUST present a token via the X-Agent-Key header (Bearer form is
 * NOT supported on this route, since Bearer collides with end-customer
 * JWTs on other helpdesk routes). The token is of the form
 * `hdag_<base64url>`; its first 8 chars are the key_prefix we index on,
 * and the full token is Argon2id-verified against the stored hash in
 * helpdesk_agent_api_keys.
 *
 * This used to accept a raw shared secret from env.AGENT_API_KEY with a
 * timing-safe string compare, and would also fall back to a Bam session
 * cookie alone (HB-49) — both removed here:
 *   - The shared secret had no audit trail, couldn't be rotated per-
 *     agent, and wasn't hashed at rest.
 *   - Session-cookie fallback meant any logged-in Bam end-user could
 *     call helpdesk agent endpoints with no role check against
 *     organization_memberships — a fragile cross-app auth surface.
 *
 * Per-agent rows give us a real audit trail (bbb_user_id on the key),
 * per-key rotation via revoked_at / expires_at, and Argon2id hashing at
 * rest matching the bbam_ API key model.
 */
async function requireAgentAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = request.headers['x-agent-key'] as string | undefined;

  if (!token || token.length < 9) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or malformed X-Agent-Key header',
        details: [],
        request_id: request.id,
      },
    });
  }

  const prefix = token.slice(0, 8);

  const candidates = await db
    .select({
      id: helpdeskAgentApiKeys.id,
      bbb_user_id: helpdeskAgentApiKeys.bbb_user_id,
      key_hash: helpdeskAgentApiKeys.key_hash,
      expires_at: helpdeskAgentApiKeys.expires_at,
      revoked_at: helpdeskAgentApiKeys.revoked_at,
      user_is_active: users.is_active,
    })
    .from(helpdeskAgentApiKeys)
    .innerJoin(users, eq(users.id, helpdeskAgentApiKeys.bbb_user_id))
    .where(eq(helpdeskAgentApiKeys.key_prefix, prefix))
    .limit(10);

  // DoS mitigation (same as apps/api/src/plugins/auth.ts): an 8-char
  // random prefix has ~2.8e14 combinations so natural collisions are
  // vanishingly rare. Seeing >3 candidates suggests an attacker is
  // trying to force multiple Argon2 verifications per request, so we
  // cap verification to the first candidate and log a warning.
  const verifyCandidates = candidates.length > 3 ? candidates.slice(0, 1) : candidates;
  if (candidates.length > 3) {
    request.log.warn(
      { prefix, candidate_count: candidates.length },
      'Suspicious number of helpdesk agent key candidates for prefix; limiting to first candidate',
    );
  }

  const now = new Date();
  for (const candidate of verifyCandidates) {
    // Always run argon2.verify BEFORE checking expiry/revoked so that
    // expired-but-valid-hash and invalid-hash keys take the same wall
    // time — otherwise short-circuiting would leak (via timing) whether
    // a given prefix corresponds to a real key.
    // A malformed stored hash (e.g. truncated column, bad migration)
    // causes argon2.verify to throw; treat that as a verification
    // failure so one corrupt row doesn't 500 every request sharing
    // its prefix.
    let valid = false;
    try {
      valid = await argon2.verify(candidate.key_hash, token);
    } catch (err) {
      request.log.warn({ err, candidate_id: candidate.id }, 'argon2.verify threw on agent key candidate; treating as invalid');
    }
    if (!valid) continue;
    if (candidate.revoked_at && new Date(candidate.revoked_at) <= now) continue;
    if (candidate.expires_at && new Date(candidate.expires_at) <= now) continue;
    if (!candidate.user_is_active) continue;

    request.agentUserId = candidate.bbb_user_id;

    // Fire-and-forget last_used_at update — don't block the response on it.
    db.update(helpdeskAgentApiKeys)
      .set({ last_used_at: now })
      .where(eq(helpdeskAgentApiKeys.id, candidate.id))
      .catch((err) => {
        request.log.warn({ err }, 'Failed to update helpdesk_agent_api_keys.last_used_at');
      });

    return;
  }

  return reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid agent API key',
      details: [],
      request_id: request.id,
    },
  });
}

/**
 * Resolve a display name for the agent who authenticated this request,
 * for attribution in mirrored Bam task comments (HB-50). Prefers the Bam
 * user's display_name, falling back to email, then a static label.
 * Best-effort — never throws.
 */
async function resolveAgentDisplayName(agentUserId: string | null): Promise<string> {
  if (!agentUserId) return 'Support Agent';
  try {
    const [row] = await db
      .select({ display_name: users.display_name, email: users.email })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    return row?.display_name ?? row?.email ?? 'Support Agent';
  } catch {
    return 'Support Agent';
  }
}

/**
 * Resolve the org_id for the agent user associated with the authenticated
 * agent API key. The agent key's bbb_user_id is set on request.agentUserId
 * by requireAgentAuth. Returns null if the user cannot be found.
 */
async function resolveAgentOrgId(agentUserId: string | null): Promise<string | null> {
  if (!agentUserId) return null;
  try {
    const [row] = await db
      .select({ org_id: users.org_id })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    return (row?.org_id as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Determine the effective org_id for an agent request. Prefers the session
 * cookie's org (if present), then falls back to the agent key user's org.
 * Returns null only if neither source yields an org.
 */
async function resolveRequestOrgId(
  sessionCookie: string | undefined,
  agentUserId: string | null,
): Promise<string | null> {
  const identity = await resolveSessionIdentity(sessionCookie);
  if (identity?.orgId) return identity.orgId;
  return resolveAgentOrgId(agentUserId);
}

/**
 * Verify that a ticket belongs to the given org by joining through its
 * project. Returns false if the ticket has no project_id or the project
 * belongs to a different org.
 */
async function ticketBelongsToOrg(ticketId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ org_id: projects.org_id })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.project_id))
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row?.org_id === orgId;
}

export default async function agentRoutes(fastify: FastifyInstance) {
  fastify.decorateRequest('agentUserId', null);


  // GET /tickets — list tickets visible to the caller (HB-6: org-scoped).
  //
  // Scoping model: the caller's org is resolved from (1) a valid Bam session
  // cookie or (2) the agent API key's bbb_user_id → users.org_id. If neither
  // yields an org, the request is rejected with 403 to prevent cross-org
  // data leaks. Tickets with no project_id (unlinked) are excluded from the
  // scoped view since they cannot be attributed to an org.
  fastify.get('/tickets', { preHandler: [requireAgentAuth] }, async (request, reply) => {
    const query = request.query as { status?: string; project_id?: string };
    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);

    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const conditions = [] as any[];
    if (query.status) conditions.push(eq(tickets.status, query.status));
    if (query.project_id) conditions.push(eq(tickets.project_id, query.project_id));

    // Always org-scoped: join through projects to filter by org.
    conditions.push(eq(projects.org_id, scopeOrgId));
    const rows = await db
      .select({
        id: tickets.id,
        ticket_number: tickets.ticket_number,
        helpdesk_user_id: tickets.helpdesk_user_id,
        task_id: tickets.task_id,
        project_id: tickets.project_id,
        subject: tickets.subject,
        description: tickets.description,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        created_at: tickets.created_at,
        updated_at: tickets.updated_at,
        resolved_at: tickets.resolved_at,
        closed_at: tickets.closed_at,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.project_id))
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(tickets.updated_at));

    return reply.send({ data: rows });
  });

  // GET /tickets/by-number/:number — Resolve a ticket by its human-readable
  // ticket_number. Leading '#' is stripped. Returns the ticket record
  // (org-scoped) enriched with requester and task-derived assignee info,
  // or { data: null } if not found. Registered before /tickets/:id so the
  // static segment wins the match on Fastify's router.
  fastify.get('/tickets/by-number/:number', { preHandler: [requireAgentAuth] }, async (request, reply) => {
    const { number: rawNumber } = request.params as { number: string };
    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);

    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Strip leading '#' and parse as positive integer.
    const stripped = String(rawNumber ?? '').trim().replace(/^#/, '');
    const parsed = Number.parseInt(stripped, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== stripped) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'number must be a positive integer (optionally prefixed with #)',
          details: [{ field: 'number', issue: 'invalid' }],
          request_id: request.id,
        },
      });
    }

    // Org-scoped lookup via projects. Left-join tasks/users so we can
    // surface assignee_id / assignee_name when the ticket mirrors to a
    // Bam task; tickets themselves carry no assignee column.
    const [row] = await db
      .select({
        id: tickets.id,
        ticket_number: tickets.ticket_number,
        helpdesk_user_id: tickets.helpdesk_user_id,
        task_id: tickets.task_id,
        project_id: tickets.project_id,
        subject: tickets.subject,
        description: tickets.description,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        created_at: tickets.created_at,
        updated_at: tickets.updated_at,
        resolved_at: tickets.resolved_at,
        closed_at: tickets.closed_at,
        requester_email: helpdeskUsers.email,
        requester_name: helpdeskUsers.display_name,
        assignee_id: tasks.assignee_id,
        assignee_name: users.display_name,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.project_id))
      .innerJoin(helpdeskUsers, eq(helpdeskUsers.id, tickets.helpdesk_user_id))
      .leftJoin(tasks, eq(tasks.id, tickets.task_id))
      .leftJoin(users, eq(users.id, tasks.assignee_id))
      .where(and(eq(tickets.ticket_number, parsed), eq(projects.org_id, scopeOrgId)))
      .limit(1);

    return reply.send({ data: row ?? null });
  });

  // GET /tickets/search?q=...&status=...&assignee_id=... — Fuzzy search
  // tickets by subject + description within the caller's org. Returns up
  // to 20 rows ordered by most-recently-updated. Optional filters narrow
  // by status and by (task) assignee_id. Registered before /tickets/:id
  // so the static segment wins routing.
  fastify.get('/tickets/search', { preHandler: [requireAgentAuth] }, async (request, reply) => {
    const query = request.query as { q?: string; status?: string; assignee_id?: string };
    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);

    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const q = (query.q ?? '').trim();
    if (q.length === 0) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'q query parameter is required',
          details: [{ field: 'q', issue: 'required' }],
          request_id: request.id,
        },
      });
    }
    if (q.length > 500) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'q must be 500 characters or fewer',
          details: [{ field: 'q', issue: 'too_long' }],
          request_id: request.id,
        },
      });
    }

    const escaped = escapeLike(q);
    const pattern = `%${escaped}%`;

    const conditions: any[] = [
      eq(projects.org_id, scopeOrgId),
      or(ilike(tickets.subject, pattern), ilike(tickets.description, pattern))!,
    ];
    if (query.status) conditions.push(eq(tickets.status, query.status));
    if (query.assignee_id) conditions.push(eq(tasks.assignee_id, query.assignee_id));

    const rows = await db
      .select({
        id: tickets.id,
        number: tickets.ticket_number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        requester_email: helpdeskUsers.email,
        requester_name: helpdeskUsers.display_name,
        assignee_id: tasks.assignee_id,
        assignee_name: users.display_name,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.project_id))
      .innerJoin(helpdeskUsers, eq(helpdeskUsers.id, tickets.helpdesk_user_id))
      .leftJoin(tasks, eq(tasks.id, tickets.task_id))
      .leftJoin(users, eq(users.id, tasks.assignee_id))
      .where(and(...conditions))
      .orderBy(desc(tickets.updated_at))
      .limit(20);

    return reply.send({ data: rows });
  });

  // GET /tickets/:id — full ticket detail including internal messages (org-scoped)
  fastify.get('/tickets/:id', { preHandler: [requireAgentAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);

    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify ticket belongs to the agent's org via its project
    if (!(await ticketBelongsToOrg(id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Include ALL messages (including internal)
    const messages = await db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticket_id, id))
      .orderBy(ticketMessages.created_at);

    return reply.send({
      data: {
        ...ticket,
        messages,
      },
    });
  });

  // POST /tickets/:id/messages — agent posts a message (org-scoped)
  fastify.post('/tickets/:id/messages', {
    preHandler: [requireAgentAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = agentMessageSchema.parse(request.body);

    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);
    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify ticket exists
    const [ticket] = await db
      .select({
        id: tickets.id,
        task_id: tickets.task_id,
        first_response_at: tickets.first_response_at,
        status: tickets.status,
      })
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Verify ticket belongs to the agent's org
    if (!(await ticketBelongsToOrg(id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // HB-14: Resolve author identity from the authenticated session FIRST.
    // If a valid Bam session accompanies the request, the session's user ID
    // is authoritative — the client may NOT override it via author_id in the
    // body. If no session is present (X-Agent-Key only), the caller MUST
    // supply author_id AND that UUID must correspond to a real user row; we
    // also require the user to belong to the target ticket's org (derived
    // from the ticket's project). This prevents a holder of the shared agent
    // key from forging messages as arbitrary/non-existent users.
    const identity = await resolveSessionIdentity(request.cookies?.session);

    let authorId: string;
    let authorName: string;

    if (identity?.userId) {
      // Session-authenticated human agent — identity is server-determined.
      authorId = identity.userId;
      authorName = data.author_name ?? identity.userDisplayName ?? 'Support Agent';
    } else {
      // X-Agent-Key only: require explicit, validated author_id.
      if (!data.author_id) {
        return reply.status(400).send({
          error: {
            code: 'AUTHOR_REQUIRED',
            message: 'author_id is required when not authenticated via a Bam session',
            details: [{ field: 'author_id', issue: 'required' }],
            request_id: request.id,
          },
        });
      }

      // Look up the ticket's org (via its linked project) so we can verify
      // the supplied author_id belongs to it.
      const [ticketOrg] = await db
        .select({ org_id: projects.org_id })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.project_id))
        .where(eq(tickets.id, id))
        .limit(1);

      if (!ticketOrg?.org_id) {
        return reply.status(400).send({
          error: {
            code: 'TICKET_NOT_SCOPED',
            message: 'Ticket is not linked to a project/org; cannot validate author_id without a session',
            details: [],
            request_id: request.id,
          },
        });
      }

      const authorLookup = await db.execute(
        sql`SELECT id, display_name, org_id FROM users WHERE id = ${data.author_id} LIMIT 1`,
      );
      const authorRow = Array.isArray(authorLookup)
        ? (authorLookup[0] as any)
        : (authorLookup as any).rows?.[0];

      if (!authorRow) {
        return reply.status(400).send({
          error: {
            code: 'AUTHOR_NOT_FOUND',
            message: 'author_id does not correspond to a known user',
            details: [{ field: 'author_id', issue: 'not_found' }],
            request_id: request.id,
          },
        });
      }

      if (authorRow.org_id !== ticketOrg.org_id) {
        return reply.status(403).send({
          error: {
            code: 'AUTHOR_ORG_MISMATCH',
            message: "author_id belongs to a different org than the ticket's project",
            details: [{ field: 'author_id', issue: 'org_mismatch' }],
            request_id: request.id,
          },
        });
      }

      authorId = authorRow.id;
      authorName = data.author_name ?? authorRow.display_name ?? 'Support Agent';
    }

    // HB-18: `is_internal` is agent-controlled and the server trusts the
    // agent to set it correctly. There is no server-side enforcement that
    // distinguishes "internal notes" from "customer-visible replies" beyond
    // this boolean — an agent (or compromised agent-key holder) can post
    // either. When an internal note is created, log it so that mis-flagged
    // messages can be audited after-the-fact. Consider promoting this to a
    // separate endpoint / scoped permission in a future iteration.
    if (data.is_internal) {
      fastify.log.info({ ticketId: id, authorId }, 'Internal note created');
    }

    const [message] = await db
      .insert(ticketMessages)
      .values({
        ticket_id: id,
        author_type: 'agent',
        author_id: authorId,
        author_name: authorName,
        body: data.body,
        is_internal: data.is_internal,
      })
      .returning();

    // Only broadcast public (non-internal) messages to the ticket room so that
    // customer websocket subscribers don't receive internal notes. Internal
    // notes could be delivered via a future agent-only room.
    if (message && message.is_internal === false) {
      await broadcastTicketMessage(id, {
        id: message.id,
        ticket_id: id,
        body: message.body,
        author_type: 'agent',
        author_name: authorName,
        is_internal: message.is_internal,
        created_at: message.created_at,
      });

      // HB-50: Mirror the agent message onto the linked Bam task so the
      // customer-facing audit trail survives if the ticket is later deleted.
      // Internal notes are intentionally NOT mirrored — they must not leak
      // into the customer-visible Bam task comment thread.
      await mirrorTicketMessageToTask(ticket.task_id, authorName, message.body, request.log);
    }

    // HB-45: audit every agent message (including internal notes, so
    // mis-flagged internal-vs-public decisions can be reconstructed).
    if (message) {
      await logTicketActivity({
        ticketId: id,
        actorType: 'agent',
        actorId: authorId,
        action: 'message.posted',
        details: { message_id: message.id, is_internal: message.is_internal },
        logger: request.log,
      });
    }

    // G4 / SLA tracking: stamp first_response_at on the ticket the first
    // time an agent posts a PUBLIC (non-internal) message. This is the
    // field the SLA breach sweeper (out-of-scope for Wave 2) will use to
    // decide whether the first-response SLA was met.
    if (message && message.is_internal === false && ticket.first_response_at === null) {
      await db
        .update(tickets)
        .set({ first_response_at: message.created_at ?? new Date(), updated_at: new Date() })
        .where(eq(tickets.id, id));
    }

    // G3: ticket.message_posted Bolt event for agent replies (including
    // internal notes, so Bolt rules can fan out on internal annotations).
    if (message) {
      void publishBoltEvent(
        'ticket.message_posted',
        'helpdesk',
        {
          ticket_id: id,
          message_id: message.id,
          author_type: 'agent',
          author_id: authorId,
          is_internal: message.is_internal,
        },
        scopeOrgId,
        authorId,
        'agent',
      );
    }

    // TODO: If not internal and notify_on_agent_reply is enabled, queue email to client

    return reply.status(201).send({ data: message });
  });

  // PATCH /tickets/:id — update ticket status, priority, category (org-scoped)
  fastify.patch('/tickets/:id', {
    preHandler: [requireAgentAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = updateTicketSchema.parse(request.body);

    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);
    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (!(await ticketBelongsToOrg(id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [existing] = await db
      .select({
        id: tickets.id,
        task_id: tickets.task_id,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
      })
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    const updates: Record<string, unknown> = {};
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === 'resolved') {
        updates.resolved_at = new Date();
      } else if (data.status === 'closed') {
        updates.closed_at = new Date();
      }
    }
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.category !== undefined) updates.category = data.category;

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({
        error: {
          code: 'NO_CHANGES',
          message: 'No fields to update',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [updated] = await db
      .update(tickets)
      .set(updates)
      .where(eq(tickets.id, id))
      .returning();

    if (updated && data.status !== undefined) {
      await broadcastTicketStatusChanged(id, data.status);
      // HB-50: Mirror ticket closure onto the linked Bam task so the audit
      // trail survives if the ticket is later deleted.
      if (data.status === 'closed') {
        const agentName = await resolveAgentDisplayName(request.agentUserId);
        await mirrorTicketClosedToTask(existing.task_id, agentName, request.log);
      }
    }

    // HB-45: audit every changed field on the PATCH. We emit one row per
    // field that actually changed (from != to) so that timelines read as
    // discrete events rather than a combined blob. 'closed' and 'reopened'
    // get their own higher-level events in addition to status_changed so
    // the timeline surfaces lifecycle transitions prominently.
    if (updated) {
      const agentActorId = request.agentUserId;
      if (data.status !== undefined && data.status !== existing.status) {
        await logTicketActivity({
          ticketId: id,
          actorType: 'agent',
          actorId: agentActorId,
          action: 'ticket.status_changed',
          details: { from: existing.status, to: data.status },
          logger: request.log,
        });
        if (data.status === 'closed') {
          await logTicketActivity({
            ticketId: id,
            actorType: 'agent',
            actorId: agentActorId,
            action: 'ticket.closed',
            details: { from: existing.status },
            logger: request.log,
          });
        } else if (
          (existing.status === 'closed' || existing.status === 'resolved') &&
          (data.status === 'open' || data.status === 'in_progress')
        ) {
          await logTicketActivity({
            ticketId: id,
            actorType: 'agent',
            actorId: agentActorId,
            action: 'ticket.reopened',
            details: { from: existing.status, to: data.status },
            logger: request.log,
          });
        }
      }
      if (data.priority !== undefined && data.priority !== existing.priority) {
        await logTicketActivity({
          ticketId: id,
          actorType: 'agent',
          actorId: agentActorId,
          action: 'ticket.priority_changed',
          details: { from: existing.priority, to: data.priority },
          logger: request.log,
        });
      }
      if (data.category !== undefined && data.category !== existing.category) {
        await logTicketActivity({
          ticketId: id,
          actorType: 'agent',
          actorId: agentActorId,
          action: 'ticket.category_changed',
          details: { from: existing.category, to: data.category },
          logger: request.log,
        });
      }

      // G3: Bolt events matching the activity log rows above. Emitted only
      // on real transitions (from !== to) so Bolt rules don't fire on
      // no-op PATCHes.
      const nowIso = new Date().toISOString();
      if (data.status !== undefined && data.status !== existing.status) {
        void publishBoltEvent(
          'ticket.status_changed',
          'helpdesk',
          {
            ticket_id: id,
            from: existing.status,
            to: data.status,
          },
          scopeOrgId,
          agentActorId ?? undefined,
          'agent',
        );
        if (data.status === 'closed') {
          void publishBoltEvent(
            'ticket.closed',
            'helpdesk',
            {
              ticket_id: id,
              'ticket.closed_by': agentActorId,
              'ticket.closed_at': nowIso,
              from: existing.status,
            },
            scopeOrgId,
            agentActorId ?? undefined,
            'agent',
          );
        } else if (
          (existing.status === 'closed' || existing.status === 'resolved') &&
          (data.status === 'open' || data.status === 'in_progress')
        ) {
          void publishBoltEvent(
            'ticket.reopened',
            'helpdesk',
            {
              ticket_id: id,
              'ticket.reopened_by': agentActorId,
              'ticket.reopened_at': nowIso,
              from: existing.status,
              to: data.status,
            },
            scopeOrgId,
            agentActorId ?? undefined,
            'agent',
          );
        }
      }
    }

    return reply.send({ data: updated });
  });

  // POST /tickets/:id/close — close a ticket (org-scoped)
  fastify.post('/tickets/:id/close', {
    preHandler: [requireAgentAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);
    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (!(await ticketBelongsToOrg(id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [ticket] = await db
      .select({ id: tickets.id, status: tickets.status, task_id: tickets.task_id })
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [updated] = await db
      .update(tickets)
      .set({
        status: 'closed',
        closed_at: new Date(),
      })
      .where(eq(tickets.id, id))
      .returning();

    if (updated) {
      await broadcastTicketStatusChanged(id, 'closed');
      // HB-50: Mirror ticket closure onto the linked Bam task so the audit
      // trail survives if the ticket is later deleted.
      const agentName = await resolveAgentDisplayName(request.agentUserId);
      await mirrorTicketClosedToTask(ticket.task_id, agentName, request.log);

      // HB-45: audit closure + corresponding status change.
      if (ticket.status !== 'closed') {
        await logTicketActivity({
          ticketId: id,
          actorType: 'agent',
          actorId: request.agentUserId,
          action: 'ticket.status_changed',
          details: { from: ticket.status, to: 'closed' },
          logger: request.log,
        });
      }
      await logTicketActivity({
        ticketId: id,
        actorType: 'agent',
        actorId: request.agentUserId,
        action: 'ticket.closed',
        details: { from: ticket.status },
        logger: request.log,
      });

      // G3: ticket.closed (+ status_changed when it was a real transition).
      void publishBoltEvent(
        'ticket.closed',
        'helpdesk',
        {
          ticket_id: id,
          'ticket.closed_by': request.agentUserId,
          'ticket.closed_at': new Date().toISOString(),
          from: ticket.status,
        },
        scopeOrgId,
        request.agentUserId ?? undefined,
        'agent',
      );
      if (ticket.status !== 'closed') {
        void publishBoltEvent(
          'ticket.status_changed',
          'helpdesk',
          {
            ticket_id: id,
            from: ticket.status,
            to: 'closed',
          },
          scopeOrgId,
          request.agentUserId ?? undefined,
          'agent',
        );
      }
    }

    return reply.send({ data: updated });
  });

  // HB-55: POST /tickets/:id/merge — agent-side TRUE merge. Moves all
  // messages from the source ticket onto the primary, sets
  // `source.duplicate_of = primary.id`, stamps `merged_at` / `merged_by`
  // on the source, and closes the source. Also drops a system note on the
  // primary so its timeline records the inbound merge. Unlike the
  // customer-side mark-duplicate, this is a real data move and should be
  // treated as destructive (no customer unmark path — see DELETE
  // /helpdesk/tickets/:id/mark-duplicate).
  //
  // Guards:
  //   - source != primary (400)
  //   - primary exists (404)
  //   - primary is not itself a duplicate — no chains (400 PRIMARY_IS_DUPLICATE)
  //   - primary is not closed (400 PRIMARY_CLOSED)
  //   - source is not already merged (409 ALREADY_MERGED) — avoids double-move
  //
  // Cross-org enforcement: both source and primary tickets must belong to
  // the agent's org, preventing cross-org data leaks during merge.
  fastify.post('/tickets/:id/merge', {
    preHandler: [requireAgentAuth],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ primary_ticket_id: z.string().uuid() }).parse(request.body ?? {});

    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);
    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (!(await ticketBelongsToOrg(id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Source ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (!(await ticketBelongsToOrg(body.primary_ticket_id, scopeOrgId))) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Primary ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (body.primary_ticket_id === id) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A ticket cannot be merged into itself',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [source] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);

    if (!source) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Source ticket not found', details: [], request_id: request.id },
      });
    }

    if (source.merged_at) {
      return reply.status(409).send({
        error: {
          code: 'ALREADY_MERGED',
          message: 'Source ticket has already been merged',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [primary] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, body.primary_ticket_id))
      .limit(1);

    if (!primary) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Primary ticket not found', details: [], request_id: request.id },
      });
    }

    if (primary.duplicate_of) {
      return reply.status(400).send({
        error: {
          code: 'PRIMARY_IS_DUPLICATE',
          message: 'The specified primary ticket is itself a duplicate. Merge into its primary instead.',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (primary.status === 'closed') {
      return reply.status(400).send({
        error: {
          code: 'PRIMARY_CLOSED',
          message: 'The specified primary ticket is closed and cannot accept merges.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const agentName = await resolveAgentDisplayName(request.agentUserId);
    const mergedAt = new Date();

    // Transaction: move messages → flip source → add system note on primary.
    // We do NOT move the source's `description` or any activity log rows —
    // those stay on the source so the audit trail of the source ticket is
    // preserved verbatim.
    const result = await db.transaction(async (tx) => {
      const moved = await tx
        .update(ticketMessages)
        .set({ ticket_id: primary.id })
        .where(eq(ticketMessages.ticket_id, source.id))
        .returning({ id: ticketMessages.id });

      await tx
        .update(tickets)
        .set({
          duplicate_of: primary.id,
          merged_at: mergedAt,
          merged_by: request.agentUserId,
          status: 'closed',
          closed_at: mergedAt,
          updated_at: mergedAt,
        })
        .where(eq(tickets.id, source.id));

      // System note on PRIMARY announcing the inbound merge.
      await tx.insert(ticketMessages).values({
        ticket_id: primary.id,
        author_type: 'system',
        author_id: '00000000-0000-0000-0000-000000000000',
        author_name: 'System',
        body: `Merged from ticket #${source.ticket_number} by ${agentName}`,
        is_internal: false,
      });

      return { messages_moved: moved.length };
    });

    // Broadcasts: source gets a "merged" event + status change to closed;
    // primary gets a generic updated event so connected subscribers
    // refetch (the newly moved messages will arrive with it).
    await broadcastTicketUpdated(source.id, {
      event: 'ticket.merged',
      merged_into: primary.id,
      merged_into_number: primary.ticket_number,
    });
    await broadcastTicketStatusChanged(source.id, 'closed');
    await broadcastTicketUpdated(primary.id, {
      event: 'ticket.merge_received',
      from_ticket_id: source.id,
      from_ticket_number: source.ticket_number,
      messages_moved: result.messages_moved,
    });

    // Audit on both tickets.
    await logTicketActivity({
      ticketId: source.id,
      actorType: 'agent',
      actorId: request.agentUserId,
      action: 'ticket.merged',
      details: {
        primary_id: primary.id,
        primary_number: primary.ticket_number,
        messages_moved: result.messages_moved,
      },
      logger: request.log,
    });
    await logTicketActivity({
      ticketId: source.id,
      actorType: 'agent',
      actorId: request.agentUserId,
      action: 'ticket.status_changed',
      details: { from: source.status, to: 'closed', reason: 'merged' },
      logger: request.log,
    });
    await logTicketActivity({
      ticketId: primary.id,
      actorType: 'agent',
      actorId: request.agentUserId,
      action: 'ticket.merge_received',
      details: {
        source_id: source.id,
        source_number: source.ticket_number,
        messages_moved: result.messages_moved,
      },
      logger: request.log,
    });

    // TODO(HB-7): once the bbb-client task-sync helper exposes a merge
    // hook, update both linked tasks' activity logs (source: "ticket
    // merged into #<primary>"; primary: "ticket merged from #<source>").
    // For now this is recorded only in the helpdesk ticket_activity_log.

    return reply.send({
      data: {
        source_id: source.id,
        primary_id: primary.id,
        messages_moved: result.messages_moved,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /agents/queue -- Agent ticket queue (filterable by assignee, status,
  // SLA state). Returns tickets with SLA-breach badges computed from
  // sla_breached_at and the imminent-breach formula (first_response_at is
  // NULL and ticket is > 75% of SLA target age).
  // -------------------------------------------------------------------------
  const queueQuerySchema = z.object({
    assignee_id: z.string().uuid().optional(),
    status: z.string().optional(),
    sla_state: z.enum(['breached', 'imminent', 'ok', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });

  fastify.get('/agents/queue', { preHandler: [requireAgentAuth] }, async (request, reply) => {
    const query = queueQuerySchema.parse(request.query);
    const scopeOrgId = await resolveRequestOrgId(request.cookies?.session, request.agentUserId);

    if (!scopeOrgId) {
      return reply.status(403).send({
        error: {
          code: 'ORG_CONTEXT_REQUIRED',
          message: 'Organization context is required.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const conditions: any[] = [eq(projects.org_id, scopeOrgId)];

    if (query.status) {
      conditions.push(eq(tickets.status, query.status));
    } else {
      // Default: exclude closed tickets
      conditions.push(
        or(
          eq(tickets.status, 'open'),
          eq(tickets.status, 'in_progress'),
          eq(tickets.status, 'waiting_on_customer'),
        )!,
      );
    }

    // If assignee_id is provided, filter by the linked task's assignee.
    // Tickets are linked to tasks via task_id; the task carries the assignee.
    if (query.assignee_id) {
      conditions.push(eq(tasks.assignee_id, query.assignee_id));
    }

    const limit = Math.min(query.limit ?? 50, 100);
    const offset = query.offset ?? 0;

    const rows = await db
      .select({
        id: tickets.id,
        ticket_number: tickets.ticket_number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        task_id: tickets.task_id,
        created_at: tickets.created_at,
        updated_at: tickets.updated_at,
        first_response_at: tickets.first_response_at,
        sla_breached_at: tickets.sla_breached_at,
        assignee_name: users.display_name,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.project_id))
      .leftJoin(tasks, eq(tasks.id, tickets.task_id))
      .leftJoin(users, eq(users.id, tasks.assignee_id))
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(tickets.updated_at))
      .limit(limit)
      .offset(offset);

    // SLA target: the org's configured first-response window (default 8h),
    // not a hardcoded 4h.
    const [hdSettings] = await db
      .select({ slaMinutes: helpdeskSettings.sla_first_response_minutes })
      .from(helpdeskSettings)
      .where(eq(helpdeskSettings.org_id, scopeOrgId))
      .limit(1);
    const SLA_TARGET_MS = (hdSettings?.slaMinutes ?? 480) * 60 * 1000;
    const SLA_IMMINENT_THRESHOLD = 0.75;
    const now = Date.now();

    const enriched = rows.map((row) => {
      let slaState: 'breached' | 'imminent' | 'ok' = 'ok';

      if (row.sla_breached_at) {
        slaState = 'breached';
      } else if (!row.first_response_at) {
        // No first response yet -- check if we're approaching the SLA target
        const age = now - new Date(row.created_at).getTime();
        if (age > SLA_TARGET_MS) {
          slaState = 'breached';
        } else if (age > SLA_TARGET_MS * SLA_IMMINENT_THRESHOLD) {
          slaState = 'imminent';
        }
      }

      return { ...row, sla_state: slaState };
    });

    // Filter by SLA state if requested
    const filtered =
      query.sla_state && query.sla_state !== 'all'
        ? enriched.filter((r) => r.sla_state === query.sla_state)
        : enriched;

    return reply.send({ data: filtered });
  });
}
