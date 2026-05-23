import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  briefDocuments,
  briefCollaborators,
  projectMemberships,
} from '../db/schema/index.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}


declare module 'fastify' {
  interface FastifyRequest {
    document?: {
      id: string;
      org_id: string;
      project_id: string | null;
      folder_id: string | null;
      title: string;
      slug: string;
      status: string;
      visibility: string;
      created_by: string;
      updated_by: string | null;
      pinned: boolean;
      word_count: number;
      [key: string]: unknown;
    };
  }
}

/**
 * Document read-access guard.
 *
 * Loads a document by :id param (UUID or slug), checks org isolation,
 * visibility rules:
 *   - private: only owner or collaborator
 *   - project: project members (or owner/collaborator)
 *   - organization: all org members
 *
 * Attaches the document to `request.document` for downstream handlers.
 */
export function requireDocumentAccess() {
  return async function checkDocumentAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Document id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Accept UUID or slug
    const isUuid = UUID_REGEX.test(id);
    const condition = isUuid
      ? eq(briefDocuments.id, id)
      : eq(briefDocuments.slug, id);

    const [doc] = await db
      .select()
      .from(briefDocuments)
      .where(condition)
      .limit(1);

    if (!doc) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Org isolation
    if (doc.org_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    (request as any).document = doc;

    if (request.user.is_superuser) return;

    // Organization visibility — all org members can see
    if (doc.visibility === 'organization') return;

    // Check if user is owner or collaborator
    const isOwner = doc.created_by === request.user.id;
    if (isOwner) return;

    const [collab] = await db
      .select({ id: briefCollaborators.id })
      .from(briefCollaborators)
      .where(
        and(
          eq(briefCollaborators.document_id, doc.id),
          eq(briefCollaborators.user_id, request.user.id),
        ),
      )
      .limit(1);

    if (collab) return;

    // Project visibility — require project membership
    if (doc.visibility === 'project') {
      if (doc.project_id) {
        const [membership] = await db
          .select({ id: projectMemberships.id })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.project_id, doc.project_id),
              eq(projectMemberships.user_id, request.user.id),
            ),
          )
          .limit(1);

        if (membership) return;
      }

      // No project_id and not owner/collaborator — deny
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Private visibility — only owner/collaborator (already checked above)
    if (doc.visibility === 'private') {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found',
          details: [],
          request_id: request.id,
        },
      });
    }
  };
}

/**
 * Document edit-access guard.
 *
 * Extends read access to verify the user has edit permission:
 *   - SuperUser: always allowed
 *   - Admin / Owner (org role): allowed on any document in their org
 *   - Creator: always allowed on own documents
 *   - Collaborator with 'edit' permission: allowed
 *   - Everyone else: denied
 */
export function requireDocumentEditAccess() {
  return async function checkDocumentEditAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Document id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Load document if not already loaded by a prior middleware
    let doc = (request as any).document;
    if (!doc) {
      const isUuid = UUID_REGEX.test(id);
      const condition = isUuid
        ? eq(briefDocuments.id, id)
        : eq(briefDocuments.slug, id);

      const [found] = await db
        .select()
        .from(briefDocuments)
        .where(condition)
        .limit(1);

      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Document not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      doc = found;
      (request as any).document = doc;
    }

    // Org isolation
    if (doc.org_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Document not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    // Admin / Owner org role can edit any document in org
    if (roleLevel(request.user.role) >= roleLevel('admin')) return;

    // Creator can always edit
    if (doc.created_by === request.user.id) return;

    // Check collaborator with edit permission
    const [collab] = await db
      .select({ permission: briefCollaborators.permission })
      .from(briefCollaborators)
      .where(
        and(
          eq(briefCollaborators.document_id, doc.id),
          eq(briefCollaborators.user_id, request.user.id),
        ),
      )
      .limit(1);

    if (collab && collab.permission === 'edit') return;

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to modify this document',
        details: [],
        request_id: request.id,
      },
    });
  };
}
