import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  blankForms,
  blankFormFields,
  blankSubmissions,
  projectMemberships,
} from '../db/schema/index.js';
import { notFound, badRequest, forbidden } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateFormInput {
  name: string;
  description?: string;
  slug: string;
  project_id?: string;
  form_type?: string;
  visibility?: string;
  expires_at?: string | Date | null;
  requires_login?: boolean;
  confirmation_type?: string;
  confirmation_message?: string;
  confirmation_redirect_url?: string;
  theme_color?: string;
  fields?: CreateFieldInput[];
}

export interface UpdateFormInput {
  name?: string;
  description?: string | null;
  slug?: string;
  project_id?: string | null;
  form_type?: string;
  visibility?: string;
  expires_at?: string | Date | null;
  requires_login?: boolean;
  accept_responses?: boolean;
  max_responses?: number | null;
  one_per_email?: boolean;
  show_progress_bar?: boolean;
  shuffle_fields?: boolean;
  confirmation_type?: string;
  confirmation_message?: string;
  confirmation_redirect_url?: string | null;
  header_image_url?: string | null;
  theme_color?: string;
  custom_css?: string | null;
  notify_on_submit?: boolean;
  notify_emails?: string[];
  notify_banter_channel_id?: string | null;
  allowed_domains?: string[] | null;
  rate_limit_per_ip?: number;
  captcha_enabled?: boolean;
}

export interface CreateFieldInput {
  field_key: string;
  label: string;
  description?: string;
  placeholder?: string;
  field_type: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  min_value?: string;
  max_value?: string;
  regex_pattern?: string;
  options?: unknown;
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string;
  scale_max_label?: string;
  allowed_file_types?: string[];
  max_file_size_mb?: number;
  conditional_on_field_id?: string;
  conditional_operator?: string;
  conditional_value?: string;
  sort_order?: number;
  page_number?: number;
  column_span?: number;
  default_value?: string;
}

export interface UpdateFieldInput {
  field_key?: string;
  label?: string;
  description?: string | null;
  placeholder?: string | null;
  field_type?: string;
  required?: boolean;
  min_length?: number | null;
  max_length?: number | null;
  options?: unknown;
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string | null;
  scale_max_label?: string | null;
  sort_order?: number;
  page_number?: number;
  column_span?: number;
  default_value?: string | null;
}

// ---------------------------------------------------------------------------
// List forms
// ---------------------------------------------------------------------------

export async function listForms(orgId: string, params: {
  status?: string;
  project_id?: string;
}) {
  const conditions = [eq(blankForms.organization_id, orgId)];

  if (params.status) {
    conditions.push(eq(blankForms.status, params.status));
  }
  if (params.project_id) {
    conditions.push(eq(blankForms.project_id, params.project_id));
  }

  const forms = await db
    .select()
    .from(blankForms)
    .where(and(...conditions))
    .orderBy(desc(blankForms.updated_at));

  // Fetch submission counts
  const formIds = forms.map((f) => f.id);
  if (formIds.length === 0) return [];

  const subCounts = await db
    .select({
      form_id: blankSubmissions.form_id,
      count: sql<number>`count(*)::int`,
    })
    .from(blankSubmissions)
    .where(inArray(blankSubmissions.form_id, formIds))
    .groupBy(blankSubmissions.form_id);

  const countMap = new Map(subCounts.map((sc) => [sc.form_id, sc.count]));

  // Fetch field counts
  const fieldCounts = await db
    .select({
      form_id: blankFormFields.form_id,
      count: sql<number>`count(*)::int`,
    })
    .from(blankFormFields)
    .where(inArray(blankFormFields.form_id, formIds))
    .groupBy(blankFormFields.form_id);

  const fieldCountMap = new Map(fieldCounts.map((fc) => [fc.form_id, fc.count]));

  return forms.map((f) => ({
    ...f,
    submission_count: countMap.get(f.id) ?? 0,
    field_count: fieldCountMap.get(f.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Get form by ID (with fields)
// ---------------------------------------------------------------------------

export async function getForm(id: string, orgId: string) {
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.id, id), eq(blankForms.organization_id, orgId)))
    .limit(1);

  if (!form) throw notFound('Form not found');

  const fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, id))
    .orderBy(asc(blankFormFields.page_number), asc(blankFormFields.sort_order));

  const [subCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blankSubmissions)
    .where(eq(blankSubmissions.form_id, id));

  return { ...form, fields, submission_count: subCount?.count ?? 0 };
}

// ---------------------------------------------------------------------------
// Get form by slug (enforces visibility + expiration)
// ---------------------------------------------------------------------------

export interface GetFormBySlugContext {
  userId?: string;
  userOrgId?: string;
}

export async function getFormBySlug(slug: string, ctx?: GetFormBySlugContext) {
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.slug, slug), eq(blankForms.status, 'published')))
    .limit(1);

  if (!form) throw notFound('Form not found');

  // Enforce expiration window — treat an expired form as missing so we
  // don't leak its existence to unauthenticated visitors.
  if (form.expires_at && new Date(form.expires_at) <= new Date()) {
    throw notFound('Form not found');
  }

  // Enforce visibility
  const visibility = (form as { visibility?: string }).visibility ?? 'public';
  if (visibility === 'org') {
    if (!ctx?.userOrgId || ctx.userOrgId !== form.organization_id) {
      throw forbidden('This form is only available to organization members');
    }
  } else if (visibility === 'project') {
    if (!ctx?.userId || !ctx?.userOrgId) {
      throw forbidden('This form is only available to project members');
    }
    if (!form.project_id) {
      // Misconfigured — fail closed.
      throw forbidden('This form is only available to project members');
    }
    // Same-org check first (cheap), then project membership.
    if (ctx.userOrgId !== form.organization_id) {
      throw forbidden('This form is only available to project members');
    }
    const [membership] = await db
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.project_id, form.project_id),
          eq(projectMemberships.user_id, ctx.userId),
        ),
      )
      .limit(1);
    if (!membership) {
      throw forbidden('This form is only available to project members');
    }
  }

  let fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, form.id))
    .orderBy(asc(blankFormFields.page_number), asc(blankFormFields.sort_order));

  // Apply shuffle_fields if enabled: randomize within each page, keeping non-input fields in place
  if (form.shuffle_fields) {
    const NON_SHUFFLABLE = ['section_header', 'paragraph', 'hidden'];
    const pages = new Map<number, typeof fields>();
    for (const f of fields) {
      const page = f.page_number ?? 0;
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page)!.push(f);
    }

    const shuffled: typeof fields = [];
    for (const [, pageFields] of [...pages.entries()].sort(([a], [b]) => a - b)) {
      // Separate fixed-position fields from shufflable ones
      const moveable = pageFields.filter((f) => !NON_SHUFFLABLE.includes(f.field_type));
      // Fisher-Yates shuffle
      for (let i = moveable.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [moveable[i], moveable[j]] = [moveable[j]!, moveable[i]!];
      }
      // Merge back: fixed items go at their original positions
      const merged: typeof fields = [];
      let moveIdx = 0;
      for (const f of pageFields) {
        if (NON_SHUFFLABLE.includes(f.field_type)) {
          merged.push(f);
        } else {
          merged.push(moveable[moveIdx]!);
          moveIdx++;
        }
      }
      shuffled.push(...merged);
    }
    fields = shuffled;
  }

  return { ...form, fields };
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

export async function createForm(input: CreateFormInput, orgId: string, userId: string) {
  const [form] = await db
    .insert(blankForms)
    .values({
      organization_id: orgId,
      name: input.name,
      description: input.description,
      slug: input.slug,
      project_id: input.project_id,
      form_type: input.form_type ?? 'public',
      visibility: input.visibility ?? 'public',
      expires_at:
        typeof input.expires_at === 'string'
          ? new Date(input.expires_at)
          : (input.expires_at ?? undefined),
      requires_login: input.requires_login ?? false,
      confirmation_type: input.confirmation_type ?? 'message',
      confirmation_message: input.confirmation_message ?? 'Thank you for your submission!',
      confirmation_redirect_url: input.confirmation_redirect_url,
      theme_color: input.theme_color ?? '#3b82f6',
      created_by: userId,
    })
    .returning();

  // Create fields if provided
  if (input.fields && input.fields.length > 0) {
    for (let i = 0; i < input.fields.length; i++) {
      const field = input.fields[i]!;
      await db.insert(blankFormFields).values({
        form_id: form!.id,
        field_key: field.field_key,
        label: field.label,
        description: field.description,
        placeholder: field.placeholder,
        field_type: field.field_type,
        required: field.required ?? false,
        min_length: field.min_length,
        max_length: field.max_length,
        options: field.options,
        scale_min: field.scale_min,
        scale_max: field.scale_max,
        scale_min_label: field.scale_min_label,
        scale_max_label: field.scale_max_label,
        sort_order: field.sort_order ?? i,
        page_number: field.page_number ?? 1,
        column_span: field.column_span ?? 1,
        default_value: field.default_value,
      });
    }
  }

  return getForm(form!.id, orgId);
}

// ---------------------------------------------------------------------------
// Update form
// ---------------------------------------------------------------------------

export async function updateForm(
  id: string,
  orgId: string,
  input: UpdateFormInput,
) {
  const updateData: Record<string, unknown> = { updated_at: new Date() };

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    // Coerce ISO strings to Date for timestamp columns
    if (key === 'expires_at' && typeof value === 'string') {
      updateData[key] = new Date(value);
    } else {
      updateData[key] = value;
    }
  }

  const [updated] = await db
    .update(blankForms)
    .set(updateData)
    .where(and(eq(blankForms.id, id), eq(blankForms.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Form not found');
  return getForm(id, orgId);
}

// ---------------------------------------------------------------------------
// Delete form
// ---------------------------------------------------------------------------

export async function deleteForm(id: string, orgId: string) {
  const [deleted] = await db
    .delete(blankForms)
    .where(and(eq(blankForms.id, id), eq(blankForms.organization_id, orgId)))
    .returning({ id: blankForms.id });

  if (!deleted) throw notFound('Form not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Publish form
// ---------------------------------------------------------------------------

export async function publishForm(id: string, orgId: string) {
  const [form] = await db
    .select()
    .from(blankForms)
    .where(and(eq(blankForms.id, id), eq(blankForms.organization_id, orgId)))
    .limit(1);

  if (!form) throw notFound('Form not found');
  if (form.status === 'published') throw badRequest('Form is already published');

  const fields = await db
    .select()
    .from(blankFormFields)
    .where(eq(blankFormFields.form_id, id));

  if (fields.length === 0) throw badRequest('Cannot publish a form with no fields');

  await db
    .update(blankForms)
    .set({ status: 'published', published_at: new Date(), updated_at: new Date() })
    .where(eq(blankForms.id, id));

  return getForm(id, orgId);
}

// ---------------------------------------------------------------------------
// Close form
// ---------------------------------------------------------------------------

export async function closeForm(id: string, orgId: string) {
  const [updated] = await db
    .update(blankForms)
    .set({ status: 'closed', closed_at: new Date(), accept_responses: false, updated_at: new Date() })
    .where(and(eq(blankForms.id, id), eq(blankForms.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Form not found');
  return getForm(id, orgId);
}

// ---------------------------------------------------------------------------
// Duplicate form
// ---------------------------------------------------------------------------

export async function duplicateForm(id: string, orgId: string, userId: string) {
  const source = await getForm(id, orgId);

  const [form] = await db
    .insert(blankForms)
    .values({
      organization_id: orgId,
      name: `${source.name} (Copy)`,
      description: source.description,
      slug: `${source.slug}-copy-${Date.now().toString(36)}`,
      project_id: source.project_id,
      form_type: source.form_type,
      requires_login: source.requires_login,
      confirmation_type: source.confirmation_type,
      confirmation_message: source.confirmation_message,
      confirmation_redirect_url: source.confirmation_redirect_url,
      theme_color: source.theme_color,
      show_progress_bar: source.show_progress_bar,
      status: 'draft',
      created_by: userId,
    })
    .returning();

  // Duplicate fields
  for (const field of source.fields) {
    await db.insert(blankFormFields).values({
      form_id: form!.id,
      field_key: field.field_key,
      label: field.label,
      description: field.description,
      placeholder: field.placeholder,
      field_type: field.field_type,
      required: field.required,
      min_length: field.min_length,
      max_length: field.max_length,
      options: field.options,
      scale_min: field.scale_min,
      scale_max: field.scale_max,
      scale_min_label: field.scale_min_label,
      scale_max_label: field.scale_max_label,
      sort_order: field.sort_order,
      page_number: field.page_number,
      column_span: field.column_span,
      default_value: field.default_value,
    });
  }

  return getForm(form!.id, orgId);
}

// ---------------------------------------------------------------------------
// Get embed code
// ---------------------------------------------------------------------------

export async function getEmbedCode(id: string, orgId: string, publicUrl: string) {
  const form = await getForm(id, orgId);
  const url = `${publicUrl}/forms/${form.slug}`;
  const html = `<iframe src="${url}" width="100%" height="600" frameborder="0" style="border: none; max-width: 640px;"></iframe>`;
  return { url, embed_html: html };
}
