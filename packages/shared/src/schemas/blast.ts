import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BlastTemplateType = z.enum([
  'campaign',
  'drip_step',
  'transactional',
  'system',
]);
export const BlastAnalyticsTrendPeriod = z.enum(['daily', 'weekly', 'monthly']);
export const BlastBounceType = z.enum(['hard', 'soft', 'complaint']);
export const BlastSegmentMatch = z.enum(['all', 'any']);

// ── Campaign schemas ───────────────────────────────────────────────────
export const createBlastCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  template_id: z.string().uuid().optional(),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  plain_text_body: z.string().optional(),
  segment_id: z.string().uuid().optional(),
  from_name: z
    .string()
    .max(100)
    .regex(/^[^\r\n]*$/, 'from_name must not contain line breaks')
    .optional(),
  from_email: z.string().email().max(255).optional(),
  reply_to_email: z.string().email().max(255).optional(),
});

export const updateBlastCampaignSchema = createBlastCampaignSchema.partial();

export const scheduleBlastCampaignSchema = z.object({
  scheduled_at: z.string().datetime(),
});

export const listBlastCampaignsQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

export const listBlastRecipientsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Template schemas ───────────────────────────────────────────────────
export const createBlastTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  subject_template: z.string().min(1).max(500),
  html_body: z.string().min(1),
  json_design: z.unknown().optional(),
  plain_text_body: z.string().optional(),
  template_type: BlastTemplateType.optional(),
  thumbnail_url: z.string().url().optional(),
});

export const updateBlastTemplateSchema = createBlastTemplateSchema.partial();

export const listBlastTemplatesQuerySchema = z.object({
  template_type: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// ── Segment schemas ────────────────────────────────────────────────────
export const blastSegmentConditionSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.unknown(),
});

export const createBlastSegmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  filter_criteria: z.object({
    conditions: z.array(blastSegmentConditionSchema).min(1).max(20),
    match: BlastSegmentMatch,
  }),
});

export const updateBlastSegmentSchema = createBlastSegmentSchema.partial();

export const listBlastSegmentsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// ── Sender domain schemas ──────────────────────────────────────────────
export const addBlastSenderDomainSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(255)
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
      'Invalid domain format',
    ),
});

// ── Analytics schemas ──────────────────────────────────────────────────
export const blastAnalyticsTrendQuerySchema = z.object({
  period: BlastAnalyticsTrendPeriod.optional(),
});

export const blastUnsubCheckQuerySchema = z.object({
  email: z.string().email(),
});

// ── Webhook schemas ────────────────────────────────────────────────────
export const blastBounceWebhookSchema = z.object({
  message_id: z.string().optional(),
  email: z.string().email().optional(),
  bounce_type: BlastBounceType,
  reason: z.string().optional(),
});

export const blastComplaintWebhookSchema = z.object({
  message_id: z.string().optional(),
  email: z.string().email().optional(),
});
