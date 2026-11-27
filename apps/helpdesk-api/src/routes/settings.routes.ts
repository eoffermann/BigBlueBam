import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { helpdeskSettings } from '../db/schema/helpdesk-settings.js';
import { projects } from '../db/schema/bbb-refs.js';
import { requireAdminAuth } from '../lib/admin-auth.js';

const updateSettingsSchema = z.object({
  require_email_verification: z.boolean().optional(),
  allowed_email_domains: z.array(z.string()).optional(),
  default_project_id: z.string().uuid().nullable().optional(),
  default_phase_id: z.string().uuid().nullable().optional(),
  default_priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  categories: z.array(z.string()).optional(),
  welcome_message: z.string().nullable().optional(),
  auto_close_days: z.number().int().min(0).optional(),
  notify_on_status_change: z.boolean().optional(),
  notify_on_agent_reply: z.boolean().optional(),
});

/**
 * The org an admin route acts on. requireAdminAuth (lib/admin-auth.ts) has
 * already resolved it (X-Org-Slug, else the caller's own org) and proved the
 * caller administers it, so a missing value here is a wiring bug, not a
 * reason to fall back to some other org's row.
 */
function adminOrgId(request: FastifyRequest): string {
  const orgId = request.tenantContext.orgId;
  if (!orgId) throw new Error('helpdesk admin route reached without a tenant org');
  return orgId;
}

export default async function settingsRoutes(fastify: FastifyInstance) {
  // GET /helpdesk/public-settings — public, safe-to-expose fields only
  // Used by the registration form and landing page; no auth required.
  fastify.get('/helpdesk/public-settings', async (_request, reply) => {
    const [settings] = await db
      .select()
      .from(helpdeskSettings)
      .limit(1);

    if (!settings) {
      return reply.send({
        data: {
          require_email_verification: false,
          categories: [],
          welcome_message: null,
        },
      });
    }

    return reply.send({
      data: {
        require_email_verification: settings.require_email_verification,
        categories: settings.categories,
        welcome_message: settings.welcome_message,
      },
    });
  });

  // GET /helpdesk/settings — full config (requires admin auth)
  // Exposes internal fields like default_project_id and allowed_email_domains
  // that must not leak to unauthenticated callers (HB-13).
  // Scoped to the org requireAdminAuth resolved and authorized.
  fastify.get('/helpdesk/settings', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const orgId = adminOrgId(request);
    const [settings] = await db
      .select()
      .from(helpdeskSettings)
      .where(eq(helpdeskSettings.org_id, orgId))
      .limit(1);

    if (!settings) {
      // Return defaults if no settings exist
      return reply.send({
        data: {
          require_email_verification: false,
          allowed_email_domains: [],
          default_project_id: null,
          default_phase_id: null,
          default_priority: 'medium',
          categories: [],
          welcome_message: null,
          auto_close_days: 0,
          notify_on_status_change: true,
          notify_on_agent_reply: true,
        },
      });
    }

    return reply.send({ data: settings });
  });

  // PATCH /helpdesk/settings — update config (requires admin auth)
  // Scoped to the org requireAdminAuth resolved and authorized.
  fastify.patch('/helpdesk/settings', { preHandler: [requireAdminAuth] }, async (request, reply) => {
    const data = updateSettingsSchema.parse(request.body);

    const orgId = adminOrgId(request);
    const [existing] = await db
      .select()
      .from(helpdeskSettings)
      .where(eq(helpdeskSettings.org_id, orgId))
      .limit(1);

    if (existing) {
      // Update existing
      const updates: Record<string, unknown> = {};
      if (data.require_email_verification !== undefined) updates.require_email_verification = data.require_email_verification;
      if (data.allowed_email_domains !== undefined) updates.allowed_email_domains = data.allowed_email_domains;
      if (data.default_project_id !== undefined) updates.default_project_id = data.default_project_id;
      if (data.default_phase_id !== undefined) updates.default_phase_id = data.default_phase_id;
      if (data.default_priority !== undefined) updates.default_priority = data.default_priority;
      if (data.categories !== undefined) updates.categories = data.categories;
      if (data.welcome_message !== undefined) updates.welcome_message = data.welcome_message;
      if (data.auto_close_days !== undefined) updates.auto_close_days = data.auto_close_days;
      if (data.notify_on_status_change !== undefined) updates.notify_on_status_change = data.notify_on_status_change;
      if (data.notify_on_agent_reply !== undefined) updates.notify_on_agent_reply = data.notify_on_agent_reply;

      if (Object.keys(updates).length === 0) {
        return reply.send({ data: existing });
      }

      const [updated] = await db
        .update(helpdeskSettings)
        .set(updates)
        .where(eq(helpdeskSettings.id, existing.id))
        .returning();

      return reply.send({ data: updated });
    }

    // Create the org's first settings row.
    const [created] = await db
      .insert(helpdeskSettings)
      .values({
        org_id: orgId,
        ...data,
        categories: data.categories ?? [],
        allowed_email_domains: data.allowed_email_domains ?? [],
      })
      .returning();

    return reply.status(201).send({ data: created });
  });

  // GET /helpdesk/admin/projects: list the tenant org's projects with
  // their uuids, for admin surfaces that need to populate a "default
  // project" picker. Scoped to the org requireAdminAuth resolved and
  // authorized (X-Org-Slug, else the caller's own org).
  fastify.get(
    '/helpdesk/admin/projects',
    { preHandler: [requireAdminAuth] },
    async (request, reply) => {
      const orgId = adminOrgId(request);

      const rows = await db
        .select({ id: projects.id, slug: projects.slug, name: projects.name })
        .from(projects)
        .where(and(eq(projects.org_id, orgId), eq(projects.is_archived, false)))
        .orderBy(asc(projects.name));

      return reply.send({ data: rows });
    },
  );
}
