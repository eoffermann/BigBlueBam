import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as settingsService from '../services/settings.service.js';

const updateSettingsSchema = z.object({
  company_name: z.string().max(255).optional(),
  company_email: z.string().email().max(255).optional(),
  company_phone: z.string().max(50).optional(),
  company_address: z.string().max(2000).optional(),
  company_logo_url: z.string().url().optional(),
  company_tax_id: z.string().max(50).optional(),
  default_currency: z.string().length(3).optional(),
  default_tax_rate: z.number().min(0).max(100).optional(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_payment_instructions: z.string().max(2000).optional(),
  default_footer_text: z.string().max(2000).optional(),
  default_terms_text: z.string().max(5000).optional(),
  invoice_prefix: z.string().min(1).max(20).optional(),
});

export default async function settingsRoutes(fastify: FastifyInstance) {
  // GET /settings
  fastify.get(
    '/settings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const settings = await settingsService.getSettings(request.user!.org_id);
      return reply.send({ data: settings });
    },
  );

  // PUT /settings
  fastify.put(
    '/settings',
    { preHandler: [requireAuth, fastify.requireCan('bill.setting.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateSettingsSchema.parse(request.body);
      const settings = await settingsService.updateSettings(request.user!.org_id, body);
      return reply.send({ data: settings });
    },
  );
}
