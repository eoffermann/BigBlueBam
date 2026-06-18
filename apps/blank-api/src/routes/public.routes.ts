import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import * as formService from '../services/form.service.js';
import * as submissionService from '../services/submission.service.js';
import { processRoutingRules } from '../services/routing.service.js';
import { renderFormHtml } from '../lib/form-renderer.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichSubmission, loadOrg } from '../lib/bolt-enrich.js';
import { uploadFile, buildBlankStorageKey } from '../lib/storage.js';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Public form endpoints (no auth required)
// ---------------------------------------------------------------------------

// Attachment descriptors are produced by the POST /forms/:slug/upload endpoint
// below (which stores the bytes in MinIO) and echoed back here on submit so the
// worker file-process job can validate and record the real object keys.
const attachmentSchema = z.object({
  field_key: z.string().max(60).optional(),
  filename: z.string().max(255),
  content_type: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
  storage_key: z.string().max(1024),
});

const submitSchema = z.object({
  response_data: z.record(z.unknown()),
  email: z.string().email().optional(),
  captcha_token: z.string().optional(),
  attachments: z.array(attachmentSchema).max(50).optional(),
});

// File-type allowlist for public uploads. SVG is always blocked (embedded
// scripts), mirroring the Bam upload route (BAM-006).
const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/zip',
];
const BLOCKED_MIME_TYPES = ['image/svg+xml'];

function isAllowedMimeType(mimeType: string): boolean {
  const mt = mimeType.split(';')[0]!.trim().toLowerCase();
  if (BLOCKED_MIME_TYPES.includes(mt)) return false;
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mt.startsWith(prefix))) return true;
  if (ALLOWED_MIME_EXACT.includes(mt)) return true;
  return false;
}

/**
 * Gate a public submission against the form's `requires_login` and
 * `allowed_domains` settings. Returns an error envelope to send (with status)
 * when the submission must be rejected, or null when it may proceed.
 *
 * - requires_login: the submitter must be an authenticated user (request.user).
 * - allowed_domains: the submitter email's domain must be in the allowlist.
 *   The email is taken from the authenticated user, the explicit `email`
 *   field, or a `response_data.email` value, in that order.
 */
function checkAccessGate(
  form: { requires_login: boolean; allowed_domains: string[] | null },
  ctx: { authenticated: boolean; email: string | undefined; requestId: string },
): { status: number; body: unknown } | null {
  if (form.requires_login && !ctx.authenticated) {
    return {
      status: 401,
      body: {
        error: {
          code: 'LOGIN_REQUIRED',
          message: 'You must be signed in to submit this form',
          details: [],
          request_id: ctx.requestId,
        },
      },
    };
  }

  const domains = (form.allowed_domains ?? [])
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  if (domains.length > 0) {
    const email = ctx.email?.trim().toLowerCase();
    const domain = email && email.includes('@') ? email.split('@').pop() : undefined;
    const ok = domain ? domains.includes(domain) : false;
    if (!ok) {
      return {
        status: 403,
        body: {
          error: {
            code: 'DOMAIN_NOT_ALLOWED',
            message: domain
              ? `Submissions from "${domain}" are not allowed for this form`
              : 'A valid email address from an allowed domain is required to submit this form',
            details: [{ field: 'email', issue: 'domain_not_allowed' }],
            request_id: ctx.requestId,
          },
        },
      };
    }
  }

  return null;
}

export default async function publicRoutes(fastify: FastifyInstance) {
  // Multipart handling is scoped to this (public) plugin so the authenticated
  // routes are unaffected. Used by POST /forms/:slug/upload below.
  await fastify.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_FILE_SIZE },
  });

  // GET /forms/:slug — Render public form as HTML page
  fastify.get<{ Params: { slug: string } }>(
    '/forms/:slug',
    async (request, reply) => {
      const form = await formService.getFormBySlug(request.params.slug, {
        userId: request.user?.id,
        userOrgId: request.user?.org_id,
      });

      if (!form.accept_responses) {
        return reply
          .type('text/html')
          .send(renderClosedFormHtml(form.name, form.theme_color ?? '#3b82f6'));
      }

      const html = renderFormHtml(form);
      return reply.type('text/html').send(html);
    },
  );

  // GET /forms/:slug/definition — Get form field definitions
  fastify.get<{ Params: { slug: string } }>(
    '/forms/:slug/definition',
    async (request, reply) => {
      const form = await formService.getFormBySlug(request.params.slug, {
        userId: request.user?.id,
        userOrgId: request.user?.org_id,
      });
      return reply.send({
        data: {
          id: form.id,
          name: form.name,
          description: form.description,
          slug: form.slug,
          form_type: form.form_type,
          accept_responses: form.accept_responses,
          show_progress_bar: form.show_progress_bar,
          confirmation_type: form.confirmation_type,
          confirmation_message: form.confirmation_message,
          confirmation_redirect_url: form.confirmation_redirect_url,
          header_image_url: form.header_image_url,
          theme_color: form.theme_color,
          custom_css: form.custom_css,
          fields: form.fields,
        },
      });
    },
  );

  // POST /forms/:slug/submit — Submit a response
  fastify.post<{ Params: { slug: string } }>(
    '/forms/:slug/submit',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const body = submitSchema.parse(request.body);
      const form = await formService.getFormBySlug(request.params.slug, {
        userId: request.user?.id,
        userOrgId: request.user?.org_id,
      });

      // BLANK-008: Enforce CAPTCHA when enabled on the form
      if (form.captcha_enabled) {
        if (!body.captcha_token) {
          return reply.status(400).send({
            error: {
              code: 'CAPTCHA_REQUIRED',
              message: 'CAPTCHA verification is required for this form',
              details: [{ field: 'captcha_token', issue: 'required' }],
              request_id: request.id,
            },
          });
        }
        // Verify token with configured provider (Turnstile/reCAPTCHA/hCaptcha)
        const captchaSecret = process.env.CAPTCHA_SECRET_KEY;
        if (captchaSecret) {
          const verifyUrl = process.env.CAPTCHA_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
          try {
            const res = await fetch(verifyUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `secret=${encodeURIComponent(captchaSecret)}&response=${encodeURIComponent(body.captcha_token)}`,
            });
            const result = await res.json() as { success?: boolean };
            if (!result.success) {
              return reply.status(400).send({
                error: { code: 'CAPTCHA_FAILED', message: 'CAPTCHA verification failed', details: [], request_id: request.id },
              });
            }
          } catch {
            // If verification service is down, reject to be safe
            return reply.status(503).send({
              error: { code: 'CAPTCHA_UNAVAILABLE', message: 'CAPTCHA verification service unavailable', details: [], request_id: request.id },
            });
          }
        }
        // If CAPTCHA_SECRET_KEY not configured, token presence is all we can check
      }

      if (!form.accept_responses) {
        return reply.status(400).send({
          error: {
            code: 'FORM_CLOSED',
            message: 'This form is no longer accepting responses',
            details: [],
            request_id: request.id,
          },
        });
      }

      // BLANK: enforce requires_login + allowed_domains on the submit path.
      const submitterEmail =
        request.user?.email ??
        body.email ??
        (typeof body.response_data.email === 'string' ? body.response_data.email : undefined);
      const gate = checkAccessGate(
        { requires_login: form.requires_login, allowed_domains: form.allowed_domains },
        {
          authenticated: Boolean(request.user?.id),
          email: submitterEmail,
          requestId: request.id,
        },
      );
      if (gate) {
        return reply.status(gate.status).send(gate.body);
      }

      const submission = await submissionService.createSubmission(
        form.id,
        form.organization_id,
        {
          response_data: body.response_data,
          submitted_by_user_id: request.user?.id,
          submitted_by_email: submitterEmail,
          submitted_by_ip: request.ip,
          user_agent: request.headers['user-agent'] ?? undefined,
          attachments: body.attachments,
        },
      );
      // Conditional routing: fire-and-forget processing of routing rules
      if (form.routing_config) {
        processRoutingRules(
          form.routing_config,
          body.response_data,
          form.organization_id,
          submission.id,
          fastify.log,
        ).catch((err: unknown) => {
          fastify.log.error(
            { submissionId: submission.id, err: err instanceof Error ? err.message : String(err) },
            'blank-routing: unhandled routing error',
          );
        });
      }

      // Public form submission — anonymous, no authenticated actor (defaults to system)
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1). On success we
      // flip bolt_events_emitted so the idempotency index stays accurate; on
      // failure we record the error text so operators can triage.
      Promise.all([enrichSubmission(submission.id), loadOrg(form.organization_id)])
        .then(async ([enriched, org]) => {
          await publishBoltEvent(
            'submission.created',
            'blank',
            {
              submission: enriched?.submission ?? {
                id: submission.id,
                form_id: form.id,
                submitted_at: new Date().toISOString(),
                answers: body.response_data,
              },
              form: enriched?.form ?? {
                id: form.id,
                title: form.name,
                slug: form.slug,
              },
              org,
            },
            form.organization_id,
          );
          await submissionService.markBoltEventsEmitted(submission.id);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          void submissionService.markBoltEventEmitError(submission.id, message);
        });

      return reply.status(201).send({
        data: {
          id: submission.id,
          confirmation_type: form.confirmation_type,
          confirmation_message: form.confirmation_message,
          confirmation_redirect_url: form.confirmation_redirect_url,
        },
      });
    },
  );

  // POST /forms/:slug/upload — Store one submission file in MinIO and return
  // a descriptor the client attaches to its subsequent /submit call. This runs
  // before the submission row exists, so the object is keyed by org + form +
  // uuid. The worker file-process job later validates the stored object and
  // records the canonical key on the submission's processed_files.
  fastify.post<{ Params: { slug: string } }>(
    '/forms/:slug/upload',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const form = await formService.getFormBySlug(request.params.slug, {
        userId: request.user?.id,
        userOrgId: request.user?.org_id,
      });

      if (!form.accept_responses) {
        return reply.status(400).send({
          error: {
            code: 'FORM_CLOSED',
            message: 'This form is no longer accepting responses',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Enforce the same login gate on uploads as on submit, so an
      // unauthenticated visitor cannot stash objects for a login-only form.
      if (form.requires_login && !request.user?.id) {
        return reply.status(401).send({
          error: {
            code: 'LOGIN_REQUIRED',
            message: 'You must be signed in to upload files for this form',
            details: [],
            request_id: request.id,
          },
        });
      }

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'No file provided',
            details: [],
            request_id: request.id,
          },
        });
      }

      const declaredType = file.mimetype;
      if (!isAllowedMimeType(declaredType)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File type "${declaredType}" is not allowed`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const buffer = await file.toBuffer();

      // Magic-byte verification: confirm the bytes match an allowed type.
      // text/csv and text/plain have no magic bytes, so skip detection for them.
      const declaredBase = declaredType.split(';')[0]!.trim().toLowerCase();
      if (declaredBase !== 'text/plain' && declaredBase !== 'text/csv') {
        const detected = await fileTypeFromBuffer(buffer);
        if (!detected || !isAllowedMimeType(detected.mime)) {
          return reply.status(400).send({
            error: {
              code: 'BAD_REQUEST',
              message: `File content does not match an allowed type (detected: ${detected?.mime ?? 'unknown'})`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      if (buffer.length > env.UPLOAD_MAX_FILE_SIZE) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${env.UPLOAD_MAX_FILE_SIZE} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      // field_key is passed as a multipart field alongside the file so the
      // submission can map the stored object back to its form field.
      const fieldKeyRaw = (file.fields?.field_key as { value?: unknown } | undefined)?.value;
      const fieldKey = typeof fieldKeyRaw === 'string' ? fieldKeyRaw.slice(0, 60) : undefined;

      const uuid = randomUUID();
      const key = buildBlankStorageKey(form.organization_id, form.id, uuid, file.filename);
      await uploadFile(key, buffer, declaredType);

      return reply.status(201).send({
        data: {
          field_key: fieldKey,
          filename: file.filename,
          content_type: declaredType,
          size: buffer.length,
          storage_key: key,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Minimal closed-form page
// ---------------------------------------------------------------------------

function renderClosedFormHtml(formName: string, themeColor: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(formName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; color: #374151; }
  .card { background: #fff; border-radius: 12px; padding: 48px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.1); max-width: 480px; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { color: #6b7280; margin: 0; }
  .bar { width: 48px; height: 4px; border-radius: 2px; background: ${escapeHtml(themeColor)}; margin: 0 auto 24px; }
</style>
</head>
<body>
<div class="card">
  <div class="bar"></div>
  <h1>${escapeHtml(formName)}</h1>
  <p>This form is no longer accepting responses.</p>
</div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
