import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as formService from '../services/form.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichForm, loadActor, loadOrg } from '../lib/bolt-enrich.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const FIELD_TYPES = [
  'short_text', 'long_text', 'email', 'phone', 'url', 'number',
  'single_select', 'multi_select', 'dropdown',
  'date', 'time', 'datetime',
  'file_upload', 'image_upload',
  'rating', 'scale', 'nps',
  'checkbox', 'toggle',
  'section_header', 'paragraph', 'hidden',
] as const;

const fieldSchema = z.object({
  field_key: z.string().min(1).max(60).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'field_key must be a safe identifier'),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  placeholder: z.string().max(255).optional(),
  field_type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  min_length: z.number().int().positive().optional(),
  max_length: z.number().int().positive().optional(),
  options: z.unknown().optional(),
  scale_min: z.number().int().optional(),
  scale_max: z.number().int().optional(),
  scale_min_label: z.string().max(100).optional(),
  scale_max_label: z.string().max(100).optional(),
  sort_order: z.number().int().optional(),
  page_number: z.number().int().positive().optional(),
  column_span: z.number().int().min(1).max(2).optional(),
  default_value: z.string().optional(),
});

const createFormSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  project_id: z.string().uuid().optional(),
  form_type: z.enum(['public', 'internal', 'embedded']).optional(),
  visibility: z.enum(['public', 'org', 'project']).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  requires_login: z.boolean().optional(),
  confirmation_type: z.enum(['message', 'redirect', 'page']).optional(),
  confirmation_message: z.string().max(5000).optional(),
  confirmation_redirect_url: z.string().url().optional(),
  theme_color: z.string().max(7).optional(),
  fields: z.array(fieldSchema).optional(),
});

const updateFormSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/).optional(),
  project_id: z.string().uuid().nullable().optional(),
  form_type: z.enum(['public', 'internal', 'embedded']).optional(),
  visibility: z.enum(['public', 'org', 'project']).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  requires_login: z.boolean().optional(),
  accept_responses: z.boolean().optional(),
  max_responses: z.number().int().positive().nullable().optional(),
  one_per_email: z.boolean().optional(),
  show_progress_bar: z.boolean().optional(),
  shuffle_fields: z.boolean().optional(),
  confirmation_type: z.enum(['message', 'redirect', 'page']).optional(),
  confirmation_message: z.string().max(5000).optional(),
  confirmation_redirect_url: z.string().url().nullable().optional(),
  header_image_url: z.string().url().nullable().optional(),
  theme_color: z.string().max(7).optional(),
  custom_css: z.string().max(10000).nullable().optional(),
  notify_on_submit: z.boolean().optional(),
  notify_emails: z.array(z.string().email()).optional(),
  notify_banter_channel_id: z.string().uuid().nullable().optional(),
  allowed_domains: z
    .array(z.string().min(1).max(253))
    .max(50)
    .nullable()
    .optional(),
  rate_limit_per_ip: z.number().int().positive().optional(),
  captcha_enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// CSS sanitization — strips dangerous CSS constructs (BLANK-005)
// ---------------------------------------------------------------------------

function sanitizeCss(css: string): string {
  return css
    // Strip url() to prevent data exfiltration and external resource loading
    .replace(/url\s*\([^)]*\)/gi, '/* [removed url()] */')
    // Strip @import to prevent loading external stylesheets
    .replace(/@import\b[^;]*;?/gi, '/* [removed @import] */')
    // Strip expression() (IE CSS expressions)
    .replace(/expression\s*\([^)]*\)/gi, '/* [removed expression()] */')
    // Strip behavior: (IE HTC bindings)
    .replace(/behavior\s*:[^;]*/gi, '/* [removed behavior] */')
    // Strip -moz-binding (Firefox XBL)
    .replace(/-moz-binding\s*:[^;]*/gi, '/* [removed -moz-binding] */');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function formRoutes(fastify: FastifyInstance) {
  // GET /forms — List forms
  fastify.get(
    '/forms',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const forms = await formService.listForms(request.user!.org_id, {
        status: query.status,
        project_id: query.project_id,
      });
      return reply.send({ data: forms });
    },
  );

  // POST /forms — Create form
  fastify.post(
    '/forms',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createFormSchema.parse(request.body);
      const form = await formService.createForm(body, request.user!.org_id, request.user!.id);
      return reply.status(201).send({ data: form });
    },
  );

  // GET /forms/:id — Get form with fields
  fastify.get<{ Params: { id: string } }>(
    '/forms/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const form = await formService.getForm(request.params.id, request.user!.org_id);
      return reply.send({ data: form });
    },
  );

  // PATCH /forms/:id — Update form
  fastify.patch<{ Params: { id: string } }>(
    '/forms/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateFormSchema.parse(request.body);
      // BLANK-005: Sanitize custom_css before storage
      if (body.custom_css) {
        body.custom_css = sanitizeCss(body.custom_css);
      }
      const form = await formService.updateForm(request.params.id, request.user!.org_id, body);
      return reply.send({ data: form });
    },
  );

  // DELETE /forms/:id — Delete form
  fastify.delete<{ Params: { id: string } }>(
    '/forms/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      await formService.deleteForm(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /forms/:id/publish — Publish form
  fastify.post<{ Params: { id: string } }>(
    '/forms/:id/publish',
    { preHandler: [requireAuth, fastify.requireCan('blank.form.publish')] },
    async (request, reply) => {
      const form = await formService.publishForm(request.params.id, request.user!.org_id);
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1)
      Promise.all([
        enrichForm(form.id),
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
      ])
        .then(([enriched, actor, org]) => {
          publishBoltEvent(
            'form.published',
            'blank',
            {
              form: enriched ?? {
                id: form.id,
                title: form.name,
                slug: form.slug,
                form_type: form.form_type,
              },
              actor,
              org,
            },
            request.user!.org_id,
            request.user!.id,
            'user',
          );
        })
        .catch(() => {});
      return reply.send({ data: form });
    },
  );

  // POST /forms/:id/close — Close form
  fastify.post<{ Params: { id: string } }>(
    '/forms/:id/close',
    { preHandler: [requireAuth, fastify.requireCan('blank.form.close')] },
    async (request, reply) => {
      const form = await formService.closeForm(request.params.id, request.user!.org_id);
      // Fire-and-forget enriched Bolt event. The submission count is the
      // interesting payload for rules that want to kick off a wrap-up report.
      Promise.all([
        enrichForm(form.id),
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
      ])
        .then(([enriched, actor, org]) => {
          publishBoltEvent(
            'form.closed',
            'blank',
            {
              form: enriched ?? {
                id: form.id,
                title: form.name,
                slug: form.slug,
                form_type: form.form_type,
              },
              total_submissions: form.submission_count ?? 0,
              actor,
              org,
            },
            request.user!.org_id,
            request.user!.id,
            'user',
          );
        })
        .catch(() => {});
      return reply.send({ data: form });
    },
  );

  // POST /forms/:id/duplicate — Clone form
  fastify.post<{ Params: { id: string } }>(
    '/forms/:id/duplicate',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const form = await formService.duplicateForm(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: form });
    },
  );

  // GET /forms/:id/embed-code — Get embed snippet
  fastify.get<{ Params: { id: string } }>(
    '/forms/:id/embed-code',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const publicUrl = (request.headers['x-forwarded-proto'] ?? 'http') + '://' + (request.headers.host ?? 'localhost');
      const result = await formService.getEmbedCode(request.params.id, request.user!.org_id, publicUrl);
      return reply.send({ data: result });
    },
  );
}
