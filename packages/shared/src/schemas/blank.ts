import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BlankFieldType = z.enum([
  'short_text',
  'long_text',
  'email',
  'phone',
  'url',
  'number',
  'single_select',
  'multi_select',
  'dropdown',
  'date',
  'time',
  'datetime',
  'file_upload',
  'image_upload',
  'rating',
  'scale',
  'nps',
  'checkbox',
  'toggle',
  'section_header',
  'paragraph',
  'hidden',
]);
export const BlankFormType = z.enum(['public', 'internal', 'embedded']);
export const BlankFormVisibility = z.enum(['public', 'org', 'project']);
export const BlankConfirmationType = z.enum(['message', 'redirect', 'page']);
export const BlankConditionalOp = z.enum([
  'equals',
  'not_equals',
  'contains',
  'gt',
  'lt',
  'is_set',
  'is_not_set',
]);

// ── Field schemas ──────────────────────────────────────────────────────
export const createBlankFieldSchema = z.object({
  field_key: z
    .string()
    .min(1)
    .max(60)
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      'field_key must be a safe identifier (letters, digits, underscores; must start with letter or underscore)',
    ),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  placeholder: z.string().max(255).optional(),
  field_type: BlankFieldType,
  required: z.boolean().optional(),
  min_length: z.number().int().positive().optional(),
  max_length: z.number().int().positive().optional(),
  options: z.unknown().optional(),
  scale_min: z.number().int().optional(),
  scale_max: z.number().int().optional(),
  scale_min_label: z.string().max(100).optional(),
  scale_max_label: z.string().max(100).optional(),
  allowed_file_types: z.array(z.string()).optional(),
  max_file_size_mb: z.number().int().positive().optional(),
  conditional_on_field_id: z.string().uuid().optional(),
  conditional_operator: BlankConditionalOp.optional(),
  conditional_value: z.string().optional(),
  sort_order: z.number().int().optional(),
  page_number: z.number().int().positive().optional(),
  column_span: z.number().int().min(1).max(2).optional(),
  default_value: z.string().optional(),
});

export const updateBlankFieldSchema = z.object({
  label: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  placeholder: z.string().max(255).nullable().optional(),
  field_type: BlankFieldType.optional(),
  required: z.boolean().optional(),
  min_length: z.number().int().positive().nullable().optional(),
  max_length: z.number().int().positive().nullable().optional(),
  options: z.unknown().optional(),
  scale_min: z.number().int().optional(),
  scale_max: z.number().int().optional(),
  scale_min_label: z.string().max(100).nullable().optional(),
  scale_max_label: z.string().max(100).nullable().optional(),
  sort_order: z.number().int().optional(),
  page_number: z.number().int().positive().optional(),
  column_span: z.number().int().min(1).max(2).optional(),
  default_value: z.string().nullable().optional(),
});

export const reorderBlankFieldsSchema = z.object({
  fields: z.array(
    z.object({
      id: z.string().uuid(),
      sort_order: z.number().int(),
    }),
  ),
});

// ── Form schemas ───────────────────────────────────────────────────────
export const blankFormFieldInputSchema = z.object({
  field_key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'field_key must be a safe identifier'),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  placeholder: z.string().max(255).optional(),
  field_type: BlankFieldType,
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

export const createBlankFormSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  project_id: z.string().uuid().optional(),
  form_type: BlankFormType.optional(),
  visibility: BlankFormVisibility.optional(),
  expires_at: z.string().datetime().nullable().optional(),
  requires_login: z.boolean().optional(),
  confirmation_type: BlankConfirmationType.optional(),
  confirmation_message: z.string().max(5000).optional(),
  confirmation_redirect_url: z.string().url().optional(),
  theme_color: z.string().max(7).optional(),
  fields: z.array(blankFormFieldInputSchema).optional(),
});

export const updateBlankFormSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  project_id: z.string().uuid().nullable().optional(),
  form_type: BlankFormType.optional(),
  visibility: BlankFormVisibility.optional(),
  expires_at: z.string().datetime().nullable().optional(),
  requires_login: z.boolean().optional(),
  accept_responses: z.boolean().optional(),
  max_responses: z.number().int().positive().nullable().optional(),
  one_per_email: z.boolean().optional(),
  show_progress_bar: z.boolean().optional(),
  shuffle_fields: z.boolean().optional(),
  confirmation_type: BlankConfirmationType.optional(),
  confirmation_message: z.string().max(5000).optional(),
  confirmation_redirect_url: z.string().url().nullable().optional(),
  header_image_url: z.string().url().nullable().optional(),
  theme_color: z.string().max(7).optional(),
});

export const listBlankFormsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  visibility: BlankFormVisibility.optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Submission schemas ─────────────────────────────────────────────────
export const submitBlankFormSchema = z.object({
  response_data: z.record(z.unknown()),
  email: z.string().email().optional(),
  captcha_token: z.string().optional(),
});

export const listBlankSubmissionsQuerySchema = z.object({
  form_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});
