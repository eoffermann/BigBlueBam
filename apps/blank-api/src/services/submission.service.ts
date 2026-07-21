import { eq, and, desc, sql, asc } from 'drizzle-orm';
import { neutralizeCsvValue } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { blankSubmissions, blankForms, blankFormFields } from '../db/schema/index.js';
import { notFound, badRequest, conflict } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitInput {
  response_data: Record<string, unknown>;
  submitted_by_user_id?: string;
  submitted_by_email?: string;
  submitted_by_ip?: string;
  user_agent?: string;
  attachments?: unknown[];
}

// ---------------------------------------------------------------------------
// List submissions
// ---------------------------------------------------------------------------

export async function listSubmissions(formId: string, orgId: string, params: {
  cursor?: string;
  limit?: number;
  file_processing_status?: string;
}) {
  const limit = params.limit ?? 50;

  const conditions = [
    eq(blankSubmissions.form_id, formId),
    eq(blankSubmissions.organization_id, orgId),
  ];

  if (params.cursor) {
    conditions.push(sql`${blankSubmissions.submitted_at} < (SELECT submitted_at FROM blank_submissions WHERE id = ${params.cursor})`);
  }

  if (params.file_processing_status) {
    conditions.push(eq(blankSubmissions.file_processing_status, params.file_processing_status));
  }

  const submissions = await db
    .select()
    .from(blankSubmissions)
    .where(and(...conditions))
    .orderBy(desc(blankSubmissions.submitted_at))
    .limit(limit + 1);

  const hasMore = submissions.length > limit;
  const data = hasMore ? submissions.slice(0, limit) : submissions;
  const nextCursor = hasMore ? data[data.length - 1]?.id : null;

  return { data, next_cursor: nextCursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// Get submission
// ---------------------------------------------------------------------------

export async function getSubmission(id: string, orgId: string) {
  const [submission] = await db
    .select()
    .from(blankSubmissions)
    .where(and(eq(blankSubmissions.id, id), eq(blankSubmissions.organization_id, orgId)))
    .limit(1);

  if (!submission) throw notFound('Submission not found');
  return submission;
}

// ---------------------------------------------------------------------------
// Delete submission
// ---------------------------------------------------------------------------

export async function deleteSubmission(id: string, orgId: string) {
  const [deleted] = await db
    .delete(blankSubmissions)
    .where(and(eq(blankSubmissions.id, id), eq(blankSubmissions.organization_id, orgId)))
    .returning({ id: blankSubmissions.id });

  if (!deleted) throw notFound('Submission not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Create submission (public)
// ---------------------------------------------------------------------------

export async function createSubmission(formId: string, orgId: string, input: SubmitInput) {
  // Load the form to confirm it exists
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.id, formId), eq(blankForms.organization_id, orgId)))
    .limit(1);

  if (!form) throw notFound('Form not found');

  // Enforce one_per_email: reject if a submission with this email already exists
  if (form.one_per_email && input.submitted_by_email) {
    const [existing] = await db
      .select({ id: blankSubmissions.id })
      .from(blankSubmissions)
      .where(
        and(
          eq(blankSubmissions.form_id, formId),
          eq(blankSubmissions.submitted_by_email, input.submitted_by_email),
        ),
      )
      .limit(1);

    if (existing) {
      throw conflict('You have already submitted a response to this form');
    }
  }

  // Enforce max_responses: reject if the form has reached its limit
  if (form.max_responses !== null && form.max_responses > 0) {
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(blankSubmissions)
      .where(eq(blankSubmissions.form_id, formId));

    if ((countResult?.count ?? 0) >= form.max_responses) {
      throw badRequest('This form has reached its maximum number of responses');
    }
  }

  // Load field definitions and validate response_data against them
  const fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, formId))
    .orderBy(asc(blankFormFields.sort_order));

  const errors = validateResponseData(input.response_data, fields);
  if (errors.length > 0) {
    throw badRequest(`Validation failed: ${errors.map((e) => e.message).join('; ')}`);
  }

  // Seed the file processing status column so the worker knows whether to
  // pick up this row. When the form has no file/image fields we can short
  // circuit straight to 'skipped' and save the worker a pointless wakeup.
  const hasFileField = fields.some(
    (f) => f.field_type === 'file_upload' || f.field_type === 'image_upload',
  );
  const fileProcessingStatus = hasFileField ? 'pending' : 'skipped';

  const [submission] = await db
    .insert(blankSubmissions)
    .values({
      form_id: formId,
      organization_id: orgId,
      response_data: input.response_data,
      submitted_by_user_id: input.submitted_by_user_id,
      submitted_by_email: input.submitted_by_email,
      submitted_by_ip: input.submitted_by_ip,
      user_agent: input.user_agent,
      attachments: input.attachments ?? [],
      file_processing_status: fileProcessingStatus,
    })
    .returning();

  return submission!;
}

// ---------------------------------------------------------------------------
// Bolt event idempotency helpers
// ---------------------------------------------------------------------------

/**
 * Mark a submission as having successfully emitted its Bolt event(s). Called
 * by the public submit route after the fire-and-forget publish resolves. The
 * column is indexed (WHERE bolt_events_emitted = false) so a future worker
 * backfill can cheaply find rows whose emission failed.
 */
export async function markBoltEventsEmitted(submissionId: string): Promise<void> {
  try {
    await db
      .update(blankSubmissions)
      .set({ bolt_events_emitted: true, bolt_event_emit_error: null })
      .where(eq(blankSubmissions.id, submissionId));
  } catch {
    // Idempotency-marker update must never break the submit path.
  }
}

/**
 * Record that a Bolt event emission attempt failed for a submission. The
 * error text is stored verbatim for operator debugging; the worker retry
 * loop keys off bolt_events_emitted = false, not the error text.
 */
export async function markBoltEventEmitError(
  submissionId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await db
      .update(blankSubmissions)
      .set({ bolt_events_emitted: false, bolt_event_emit_error: errorMessage })
      .where(eq(blankSubmissions.id, submissionId));
  } catch {
    // Swallow — this is itself a best-effort bookkeeping update.
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^https?:\/\/.+/;
const PHONE_REGEX = /^[+]?[\d\s().-]{7,20}$/;

// Non-input field types that don't require validation
const NON_INPUT_TYPES = ['section_header', 'paragraph', 'hidden', 'page_break'];

function validateResponseData(
  data: Record<string, unknown>,
  fields: Array<{
    field_key: string;
    field_type: string;
    required: boolean;
    label: string;
    min_length: number | null;
    max_length: number | null;
    min_value: string | null;
    max_value: string | null;
    regex_pattern: string | null;
    options: unknown;
    scale_min: number | null;
    scale_max: number | null;
  }>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of fields) {
    if (NON_INPUT_TYPES.includes(field.field_type)) continue;

    const value = data[field.field_key];
    const isEmpty = value === undefined || value === null || value === '';

    // Required check
    if (field.required && isEmpty) {
      errors.push({ field: field.field_key, message: `${field.label} is required` });
      continue;
    }

    // Skip further validation if value is empty and not required
    if (isEmpty) continue;

    // Type-specific validation
    switch (field.field_type) {
      case 'email':
        if (typeof value !== 'string' || !EMAIL_REGEX.test(value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be a valid email address` });
        }
        break;

      case 'url':
        if (typeof value !== 'string' || !URL_REGEX.test(value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be a valid URL` });
        }
        break;

      case 'phone':
        if (typeof value !== 'string' || !PHONE_REGEX.test(value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be a valid phone number` });
        }
        break;

      case 'number':
      case 'rating':
      case 'scale':
      case 'nps': {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push({ field: field.field_key, message: `${field.label} must be a number` });
          break;
        }
        if (field.min_value !== null && num < Number(field.min_value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be at least ${field.min_value}` });
        }
        if (field.max_value !== null && num > Number(field.max_value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be at most ${field.max_value}` });
        }
        if ((field.field_type === 'scale' || field.field_type === 'rating') && field.scale_min !== null && num < field.scale_min) {
          errors.push({ field: field.field_key, message: `${field.label} must be at least ${field.scale_min}` });
        }
        if ((field.field_type === 'scale' || field.field_type === 'rating') && field.scale_max !== null && num > field.scale_max) {
          errors.push({ field: field.field_key, message: `${field.label} must be at most ${field.scale_max}` });
        }
        break;
      }

      case 'single_select':
      case 'dropdown': {
        if (field.options && Array.isArray(field.options)) {
          const validValues = (field.options as Array<{ value: string }>).map((o) => o.value ?? o);
          if (!validValues.includes(value as string)) {
            errors.push({ field: field.field_key, message: `${field.label} contains an invalid option` });
          }
        }
        break;
      }

      case 'multi_select':
      case 'checkbox_group': {
        if (!Array.isArray(value)) {
          errors.push({ field: field.field_key, message: `${field.label} must be an array` });
          break;
        }
        if (field.options && Array.isArray(field.options)) {
          const validValues = (field.options as Array<{ value: string }>).map((o) => o.value ?? o);
          for (const v of value) {
            if (!validValues.includes(v as string)) {
              errors.push({ field: field.field_key, message: `${field.label} contains an invalid option: ${v}` });
              break;
            }
          }
        }
        break;
      }

      case 'short_text':
      case 'long_text':
      case 'textarea': {
        if (typeof value !== 'string') {
          errors.push({ field: field.field_key, message: `${field.label} must be a string` });
          break;
        }
        if (field.min_length !== null && value.length < field.min_length) {
          errors.push({ field: field.field_key, message: `${field.label} must be at least ${field.min_length} characters` });
        }
        if (field.max_length !== null && value.length > field.max_length) {
          errors.push({ field: field.field_key, message: `${field.label} must be at most ${field.max_length} characters` });
        }
        break;
      }

      case 'date': {
        if (typeof value !== 'string' || isNaN(Date.parse(value))) {
          errors.push({ field: field.field_key, message: `${field.label} must be a valid date` });
        }
        break;
      }

      case 'checkbox': {
        if (typeof value !== 'boolean') {
          errors.push({ field: field.field_key, message: `${field.label} must be true or false` });
        }
        break;
      }
    }

    // Regex pattern validation (applies to any field type that has one)
    if (field.regex_pattern && typeof value === 'string') {
      try {
        const regex = new RegExp(field.regex_pattern);
        if (!regex.test(value)) {
          errors.push({ field: field.field_key, message: `${field.label} does not match the required format` });
        }
      } catch {
        // Invalid regex in field definition — skip pattern check
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Export submissions as CSV
// ---------------------------------------------------------------------------

export async function exportSubmissions(formId: string, orgId: string) {
  // Get form with fields
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.id, formId), eq(blankForms.organization_id, orgId)))
    .limit(1);

  if (!form) throw notFound('Form not found');

  const fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, formId))
    .orderBy(asc(blankFormFields.sort_order));

  const submissions = await db
    .select()
    .from(blankSubmissions)
    .where(eq(blankSubmissions.form_id, formId))
    .orderBy(desc(blankSubmissions.submitted_at));

  // Build CSV
  const fieldKeys = fields
    .filter((f) => !['section_header', 'paragraph'].includes(f.field_type))
    .map((f) => f.field_key);

  const headers = ['Submission ID', 'Submitted At', 'Email', ...fieldKeys.map((k) => {
    const field = fields.find((f) => f.field_key === k);
    return field?.label ?? k;
  })];

  const rows = submissions.map((sub) => {
    const data = sub.response_data as Record<string, unknown>;
    return [
      sub.id,
      sub.submitted_at?.toISOString() ?? '',
      sub.submitted_by_email ?? '',
      ...fieldKeys.map((k) => {
        const val = data[k];
        if (val === null || val === undefined) return '';
        if (Array.isArray(val)) return val.join('; ');
        return String(val);
      }),
    ];
  });

  // neutralizeCsvValue guards against spreadsheet formula injection (a form answer like
  // `=cmd|'/c calc'!A1` executing when a CFO opens the export) before the always-quote wrap.
  const csvLines = [
    headers.map((h) => `"${neutralizeCsvValue(h).replace(/"/g, '""')}"`).join(','),
    ...rows.map((row) =>
      row.map((cell) => `"${neutralizeCsvValue(cell).replace(/"/g, '""')}"`).join(','),
    ),
  ];

  return csvLines.join('\n');
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export async function getFormAnalytics(formId: string, orgId: string) {
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.id, formId), eq(blankForms.organization_id, orgId)))
    .limit(1);

  if (!form) throw notFound('Form not found');

  const fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, formId))
    .orderBy(asc(blankFormFields.sort_order));

  // Total submissions
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blankSubmissions)
    .where(eq(blankSubmissions.form_id, formId));

  const totalSubmissions = totalResult?.count ?? 0;

  // Submissions over time (last 30 days, grouped by day)
  const dailyCounts = await db.execute(sql`
    SELECT DATE_TRUNC('day', submitted_at)::date AS day, COUNT(*)::int AS count
    FROM blank_submissions
    WHERE form_id = ${formId}
      AND submitted_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE_TRUNC('day', submitted_at)
    ORDER BY day
  `);

  // Per-field analytics
  const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const fieldAnalytics: Record<string, unknown> = {};

  for (const field of fields) {
    if (['section_header', 'paragraph', 'hidden'].includes(field.field_type)) continue;

    // Defense-in-depth: skip fields with unsafe keys to prevent SQL injection via sql.raw()
    if (!SAFE_IDENTIFIER.test(field.field_key)) continue;

    if (['single_select', 'multi_select', 'dropdown'].includes(field.field_type)) {
      // Count per option
      const optionCounts = await db.execute(sql`
        SELECT value, COUNT(*)::int AS count
        FROM blank_submissions,
             LATERAL (SELECT jsonb_array_elements_text(
               CASE jsonb_typeof(response_data->${sql.raw(`'${field.field_key}'`)})
                 WHEN 'array' THEN response_data->${sql.raw(`'${field.field_key}'`)}
                 ELSE jsonb_build_array(response_data->>${sql.raw(`'${field.field_key}'`)})
               END
             ) AS value) AS expanded
        WHERE form_id = ${formId}
          AND response_data ? ${field.field_key}
        GROUP BY value
        ORDER BY count DESC
      `);
      fieldAnalytics[field.field_key] = { type: 'option_counts', data: optionCounts };
    } else if (['rating', 'scale', 'nps', 'number'].includes(field.field_type)) {
      // Average and distribution
      const stats = await db.execute(sql`
        SELECT
          AVG((response_data->>${sql.raw(`'${field.field_key}'`)})::numeric) AS average,
          MIN((response_data->>${sql.raw(`'${field.field_key}'`)})::numeric) AS min_val,
          MAX((response_data->>${sql.raw(`'${field.field_key}'`)})::numeric) AS max_val,
          COUNT(*)::int AS response_count
        FROM blank_submissions
        WHERE form_id = ${formId}
          AND response_data ? ${field.field_key}
          AND response_data->>${sql.raw(`'${field.field_key}'`)} ~ '^-?[0-9]+(\\.[0-9]+)?$'
      `);
      fieldAnalytics[field.field_key] = { type: 'numeric_stats', data: stats[0] ?? {} };
    } else {
      // Text: just count responses
      const [count] = await db.execute(sql`
        SELECT COUNT(*)::int AS response_count
        FROM blank_submissions
        WHERE form_id = ${formId}
          AND response_data ? ${field.field_key}
          AND response_data->>${sql.raw(`'${field.field_key}'`)} != ''
      `);
      fieldAnalytics[field.field_key] = { type: 'text_count', data: count ?? {} };
    }
  }

  return {
    form_id: formId,
    total_submissions: totalSubmissions,
    daily_trend: dailyCounts,
    field_analytics: fieldAnalytics,
  };
}
