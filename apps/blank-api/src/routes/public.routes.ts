import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as formService from '../services/form.service.js';
import * as submissionService from '../services/submission.service.js';
import { renderFormHtml } from '../lib/form-renderer.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { enrichSubmission, loadOrg } from '../lib/bolt-enrich.js';

// ---------------------------------------------------------------------------
// Public form endpoints (no auth required)
// ---------------------------------------------------------------------------

const submitSchema = z.object({
  response_data: z.record(z.unknown()),
  email: z.string().email().optional(),
  captcha_token: z.string().optional(),
});

export default async function publicRoutes(fastify: FastifyInstance) {
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

      const submission = await submissionService.createSubmission(
        form.id,
        form.organization_id,
        {
          response_data: body.response_data,
          submitted_by_email: body.email ?? (body.response_data.email as string | undefined),
          submitted_by_ip: request.ip,
          user_agent: request.headers['user-agent'] ?? undefined,
        },
      );
      // Public form submission — anonymous, no authenticated actor (defaults to system)
      // Fire-and-forget enriched Bolt event (Phase B / Tier 1)
      Promise.all([enrichSubmission(submission.id), loadOrg(form.organization_id)])
        .then(([enriched, org]) => {
          publishBoltEvent(
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
        })
        .catch(() => {});

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
