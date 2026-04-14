import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BondLifecycleStage = z.enum([
  'subscriber',
  'lead',
  'marketing_qualified',
  'sales_qualified',
  'opportunity',
  'customer',
  'evangelist',
  'other',
]);

export const BondCompanySize = z.enum([
  '1-10',
  '11-50',
  '51-200',
  '201-1000',
  '1001-5000',
  '5000+',
]);

export const BondActivityType = z.enum([
  'note',
  'email_sent',
  'email_received',
  'call',
  'meeting',
  'task',
  'stage_change',
  'deal_created',
  'deal_won',
  'deal_lost',
  'contact_created',
  'form_submission',
  'campaign_sent',
  'campaign_opened',
  'campaign_clicked',
  'custom',
]);

export const BondCustomFieldEntityType = z.enum(['contact', 'company', 'deal']);
export const BondCustomFieldType = z.enum([
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'boolean',
]);
export const BondStageType = z.enum(['active', 'won', 'lost']);
export const BondScoringConditionOperator = z.enum([
  'equals',
  'not_equals',
  'contains',
  'gt',
  'lt',
  'gte',
  'lte',
  'exists',
  'not_exists',
]);

// ── Contact schemas ────────────────────────────────────────────────────
export const createBondContactSchema = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(150).optional(),
  avatar_url: z.string().url().optional(),
  lifecycle_stage: BondLifecycleStage.optional(),
  lead_source: z.string().max(60).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  owner_id: z.string().uuid().optional(),
});

export const updateBondContactSchema = createBondContactSchema.partial();

export const mergeBondContactSchema = z.object({
  source_id: z.string().uuid(),
});

export const importBondContactsSchema = z.object({
  contacts: z.array(createBondContactSchema).min(1).max(5000),
});

export const listBondContactsQuerySchema = z.object({
  lifecycle_stage: z.string().optional(),
  lead_source: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  lead_score_min: z.coerce.number().int().optional(),
  lead_score_max: z.coerce.number().int().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

export const searchBondContactsQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── Company schemas ────────────────────────────────────────────────────
export const createBondCompanySchema = z.object({
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  industry: z.string().max(100).optional(),
  size_bucket: BondCompanySize.optional(),
  annual_revenue: z.number().int().optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().optional(),
  logo_url: z.string().url().optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  owner_id: z.string().uuid().optional(),
});

export const updateBondCompanySchema = createBondCompanySchema.partial();

export const listBondCompaniesQuerySchema = z.object({
  industry: z.string().optional(),
  size_bucket: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

export const searchBondCompaniesQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── Deal schemas ───────────────────────────────────────────────────────
export const createBondDealSchema = z.object({
  name: z.string().min(1).max(255),
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  description: z.string().max(5000).optional(),
  value: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  expected_close_date: z.string().optional(),
  probability_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const updateBondDealSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  value: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  expected_close_date: z.string().optional(),
  probability_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().nullable().optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

export const moveBondDealStageSchema = z.object({
  stage_id: z.string().uuid(),
});

export const closeBondDealWonSchema = z.object({
  close_reason: z.string().max(2000).optional(),
});

export const closeBondDealLostSchema = z.object({
  close_reason: z.string().max(2000).optional(),
  lost_to_competitor: z.string().max(255).optional(),
});

export const addBondDealContactSchema = z.object({
  contact_id: z.string().uuid(),
  role: z.string().max(60).optional(),
});

export const listBondDealsQuerySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  value_min: z.coerce.number().int().optional(),
  value_max: z.coerce.number().int().optional(),
  expected_close_after: z.string().optional(),
  expected_close_before: z.string().optional(),
  stale: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// ── Pipeline schemas ───────────────────────────────────────────────────
export const createBondStageSchema = z.object({
  name: z.string().min(1).max(100),
  sort_order: z.number().int().optional(),
  stage_type: BondStageType.optional(),
  probability_pct: z.number().int().min(0).max(100).optional(),
  rotting_days: z.number().int().positive().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const updateBondStageSchema = createBondStageSchema.partial();

export const createBondPipelineSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  stages: z.array(createBondStageSchema).optional(),
});

export const updateBondPipelineSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().optional(),
  currency: z.string().length(3).optional(),
});

export const reorderBondStagesSchema = z.object({
  stage_ids: z.array(z.string().uuid()).min(1),
});

// ── Activity schemas ───────────────────────────────────────────────────
export const createBondActivitySchema = z.object({
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  activity_type: BondActivityType,
  subject: z.string().max(255).optional(),
  body: z.string().max(10000).optional(),
  metadata: z.record(z.unknown()).optional(),
  performed_at: z.string().datetime().optional(),
});

export const updateBondActivitySchema = z.object({
  subject: z.string().max(255).optional(),
  body: z.string().max(10000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const listBondActivitiesQuerySchema = z.object({
  contact_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  activity_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// ── Custom field schemas ───────────────────────────────────────────────
export const bondCustomFieldOptionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
});

export const createBondCustomFieldSchema = z.object({
  entity_type: BondCustomFieldEntityType,
  field_key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, {
      message:
        'Field key must be lowercase alphanumeric with underscores, starting with a letter',
    }),
  label: z.string().min(1).max(100),
  field_type: BondCustomFieldType,
  options: z.array(bondCustomFieldOptionSchema).optional(),
  required: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
});

export const updateBondCustomFieldSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  field_type: BondCustomFieldType.optional(),
  options: z.array(bondCustomFieldOptionSchema).optional(),
  required: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
});

export const listBondCustomFieldsQuerySchema = z.object({
  entity_type: BondCustomFieldEntityType.optional(),
});

// ── Scoring schemas ────────────────────────────────────────────────────
export const createBondScoringRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  condition_field: z.string().min(1).max(100),
  condition_operator: BondScoringConditionOperator,
  condition_value: z.string().max(500),
  score_delta: z.number().int().min(-100).max(100),
  enabled: z.boolean().optional(),
});

export const updateBondScoringRuleSchema = createBondScoringRuleSchema.partial();

export const scoreBondContactSchema = z.object({
  contact_id: z.string().uuid(),
});

// ── Analytics query schemas ────────────────────────────────────────────
export const bondPipelineAnalyticsQuerySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
});

export const bondConversionAnalyticsQuerySchema = z.object({
  pipeline_id: z.string().uuid(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

export const bondVelocityAnalyticsQuerySchema = z.object({
  pipeline_id: z.string().uuid(),
});

export const bondWinLossAnalyticsQuerySchema = z.object({
  pipeline_id: z.string().uuid().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
