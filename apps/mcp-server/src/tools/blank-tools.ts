import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Helper to make requests to the blank-api service.
 */
function createBlankClient(blankApiUrl: string, api: ApiClient) {
  const baseUrl = blankApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    // Tolerate empty (204 No Content) and non-JSON bodies so DELETE/204 tools
    // report success instead of throwing "Unexpected end of JSON input".
    const __text = await res.text();
    let data: unknown = null;
    if (__text) {
      try {
        data = JSON.parse(__text);
      } catch {
        data = __text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const formShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.string().optional(),
  form_type: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const submissionShape = z.object({
  id: z.string().uuid(),
  form_id: z.string().uuid(),
  submitted_at: z.string(),
  responses: z.record(z.unknown()).optional(),
}).passthrough();

export function registerBlankTools(server: McpServer, api: ApiClient, blankApiUrl: string): void {
  const client = createBlankClient(blankApiUrl, api);

  // ===== blank_list_forms =====
  registerTool(server, {
    name: 'blank_list_forms',
    description: 'List available forms for the current organization. Supports filtering by status and project.',
    input: {
      status: z.enum(['draft', 'published', 'closed', 'archived']).optional().describe('Filter by form status'),
      project_id: z.string().uuid().optional().describe('Filter by project ID'),
    },
    returns: z.object({ data: z.array(formShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/forms${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing forms', result.data);
    },
  });

  // ===== blank_get_form =====
  registerTool(server, {
    name: 'blank_get_form',
    description: 'Get a form definition with all its fields.',
    input: {
      id: z.string().uuid().describe('Form ID'),
    },
    returns: formShape.extend({ fields: z.array(z.object({ field_key: z.string(), label: z.string(), field_type: z.string() }).passthrough()).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/forms/${id}`);
      return result.ok ? ok(result.data) : err('getting form', result.data);
    },
  });

  // ===== blank_create_form =====
  registerTool(server, {
    name: 'blank_create_form',
    description: 'Create a new form with optional inline field definitions.',
    input: {
      name: z.string().describe('Form name'),
      slug: z.string().describe('URL slug for the form'),
      description: z.string().optional().describe('Form description'),
      form_type: z.enum(['public', 'internal', 'embedded']).optional().describe('Form visibility type'),
      fields: z.array(z.object({
        field_key: z.string(),
        label: z.string(),
        field_type: z.string(),
        required: z.boolean().optional(),
        options: z.unknown().optional(),
        scale_min: z.number().optional(),
        scale_max: z.number().optional(),
        scale_min_label: z.string().optional(),
        scale_max_label: z.string().optional(),
      })).optional().describe('Fields to create with the form'),
    },
    returns: formShape,
    handler: async (params) => {
      const result = await client.request('POST', '/forms', params);
      return result.ok ? ok(result.data) : err('creating form', result.data);
    },
  });

  // ===== blank_generate_form =====
  registerTool(server, {
    name: 'blank_generate_form',
    description: 'AI generates a form from a natural-language description. Returns a form specification that can be passed to blank_create_form.',
    input: {
      description: z.string().describe('Natural-language description of the form to generate (e.g., "customer feedback survey with NPS, product rating, and open comments")'),
    },
    returns: z.object({ suggestion: formShape.extend({ fields: z.array(z.record(z.unknown())) }).partial(), instructions: z.string() }),
    handler: async ({ description }) => {
      // Parse the description and generate form fields
      const fields: Array<{ field_key: string; label: string; field_type: string; required?: boolean; options?: unknown; scale_min?: number; scale_max?: number; scale_min_label?: string; scale_max_label?: string }> = [];

      const lower = description.toLowerCase();

      // Common patterns
      if (lower.includes('name')) {
        fields.push({ field_key: 'name', label: 'Full Name', field_type: 'short_text', required: true });
      }
      if (lower.includes('email')) {
        fields.push({ field_key: 'email', label: 'Email Address', field_type: 'email', required: true });
      }
      if (lower.includes('phone')) {
        fields.push({ field_key: 'phone', label: 'Phone Number', field_type: 'phone' });
      }
      if (lower.includes('nps')) {
        fields.push({
          field_key: 'nps_score', label: 'How likely are you to recommend us?', field_type: 'nps',
          required: true, scale_min: 0, scale_max: 10,
          scale_min_label: 'Not at all likely', scale_max_label: 'Extremely likely',
        });
      }
      if (lower.includes('rating') || lower.includes('satisfaction')) {
        fields.push({
          field_key: 'rating', label: 'Overall Satisfaction', field_type: 'rating',
          required: true, scale_min: 1, scale_max: 5,
        });
      }
      if (lower.includes('feedback') || lower.includes('comment')) {
        fields.push({ field_key: 'feedback', label: 'Additional Comments', field_type: 'long_text' });
      }
      if (lower.includes('bug') || lower.includes('issue')) {
        fields.push({ field_key: 'issue_type', label: 'Issue Type', field_type: 'dropdown', options: [
          { value: 'bug', label: 'Bug' },
          { value: 'feature', label: 'Feature Request' },
          { value: 'improvement', label: 'Improvement' },
          { value: 'other', label: 'Other' },
        ]});
        fields.push({ field_key: 'description', label: 'Description', field_type: 'long_text', required: true });
      }

      if (fields.length === 0) {
        fields.push({ field_key: 'response', label: 'Your Response', field_type: 'long_text', required: true });
      }

      const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/-$/, '');

      return ok({
        suggestion: {
          name: description.slice(0, 100),
          slug,
          description: `Generated from: "${description}"`,
          form_type: 'public',
          fields,
        },
        instructions: 'Review the suggested form and call blank_create_form with the specification above (or modify it first).',
      });
    },
  });

  // ===== blank_update_form =====
  registerTool(server, {
    name: 'blank_update_form',
    description: 'Update form metadata or settings.',
    input: {
      id: z.string().uuid().describe('Form ID'),
      name: z.string().optional().describe('Updated form name'),
      description: z.string().optional().describe('Updated description'),
      form_type: z.enum(['public', 'internal', 'embedded']).optional(),
      accept_responses: z.boolean().optional(),
      theme_color: z.string().optional(),
    },
    returns: formShape,
    handler: async ({ id, ...updates }) => {
      const result = await client.request('PATCH', `/forms/${id}`, updates);
      return result.ok ? ok(result.data) : err('updating form', result.data);
    },
  });

  // ===== blank_publish_form =====
  registerTool(server, {
    name: 'blank_publish_form',
    description: 'Publish a draft form, making it available for submissions.',
    input: {
      id: z.string().uuid().describe('Form ID to publish'),
    },
    returns: formShape,
    handler: async ({ id }) => {
      const result = await client.request('POST', `/forms/${id}/publish`);
      return result.ok ? ok(result.data) : err('publishing form', result.data);
    },
  });

  // ===== blank_list_submissions =====
  registerTool(server, {
    name: 'blank_list_submissions',
    description: 'List submissions for a form. Returns paginated results.',
    input: {
      form_id: z.string().uuid().describe('Form ID'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Results per page (default 50)'),
    },
    returns: z.object({ data: z.array(submissionShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ form_id, cursor, limit }) => {
      const result = await client.request('GET', `/forms/${form_id}/submissions${buildQs({ cursor, limit })}`);
      return result.ok ? ok(result.data) : err('listing submissions', result.data);
    },
  });

  // ===== blank_get_submission =====
  registerTool(server, {
    name: 'blank_get_submission',
    description: 'Get a specific submission with all response data.',
    input: {
      id: z.string().uuid().describe('Submission ID'),
    },
    returns: submissionShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/submissions/${id}`);
      return result.ok ? ok(result.data) : err('getting submission', result.data);
    },
  });

  // ===== blank_summarize_responses =====
  registerTool(server, {
    name: 'blank_summarize_responses',
    description: 'Get analytics data for a form including response counts, field breakdowns, and trends. Useful for AI summarization of form results.',
    input: {
      form_id: z.string().uuid().describe('Form ID to analyze'),
    },
    returns: z.object({ total_submissions: z.number(), fields: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ form_id }) => {
      const result = await client.request('GET', `/forms/${form_id}/analytics`);
      return result.ok ? ok(result.data) : err('getting analytics', result.data);
    },
  });

  // ===== blank_export_submissions =====
  registerTool(server, {
    name: 'blank_export_submissions',
    description: 'Export all submissions for a form as CSV data.',
    input: {
      form_id: z.string().uuid().describe('Form ID to export'),
    },
    returns: z.object({ csv: z.string().optional(), url: z.string().optional() }).passthrough(),
    handler: async ({ form_id }) => {
      const result = await client.request('GET', `/forms/${form_id}/submissions/export`);
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data) }] };
      }
      return err('exporting submissions', result.data);
    },
  });

  // ===== blank_get_form_analytics =====
  registerTool(server, {
    name: 'blank_get_form_analytics',
    description: 'Get response aggregation data for a form, including per-field breakdowns, submission trends, and summary statistics.',
    input: {
      form_id: z.string().uuid().describe('Form ID'),
    },
    returns: z.object({ total_submissions: z.number(), fields: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ form_id }) => {
      const result = await client.request('GET', `/forms/${form_id}/analytics`);
      return result.ok ? ok(result.data) : err('getting form analytics', result.data);
    },
  });

  // ===== blank_delete_form =====
  registerTool(server, {
    name: 'blank_delete_form',
    description: 'Delete a form and all of its fields and submissions. This is destructive and cannot be undone.',
    input: {
      id: z.string().uuid().describe('Form ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/forms/${id}`);
      return result.ok ? ok(result.data) : err('deleting form', result.data);
    },
  });

  // ===== blank_close_form =====
  registerTool(server, {
    name: 'blank_close_form',
    description: 'Close a published form to new submissions. Existing submissions are retained; the form stops accepting responses.',
    input: {
      id: z.string().uuid().describe('Form ID to close'),
    },
    returns: formShape,
    handler: async ({ id }) => {
      const result = await client.request('POST', `/forms/${id}/close`);
      return result.ok ? ok(result.data) : err('closing form', result.data);
    },
  });

  // ===== blank_duplicate_form =====
  registerTool(server, {
    name: 'blank_duplicate_form',
    description: 'Clone an existing form (including its fields) into a new draft form owned by the current user.',
    input: {
      id: z.string().uuid().describe('Form ID to duplicate'),
    },
    returns: formShape,
    handler: async ({ id }) => {
      const result = await client.request('POST', `/forms/${id}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating form', result.data);
    },
  });

  // ===== blank_get_embed_code =====
  registerTool(server, {
    name: 'blank_get_embed_code',
    description: 'Get the HTML embed snippet (and public URL) for a published form, suitable for pasting into an external page.',
    input: {
      id: z.string().uuid().describe('Form ID'),
    },
    returns: z.object({ embed_code: z.string().optional(), url: z.string().optional() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/forms/${id}/embed-code`);
      return result.ok ? ok(result.data) : err('getting embed code', result.data);
    },
  });

  // ===== blank_add_field =====
  registerTool(server, {
    name: 'blank_add_field',
    description: 'Add a single field to an existing form. `field_key` must be a safe identifier (letters, digits, underscores; starting with a letter or underscore).',
    input: {
      form_id: z.string().uuid().describe('Form ID to add the field to'),
      field_key: z.string().describe('Stable identifier for the field (e.g. "email", "nps_score"); letters/digits/underscores only, must start with a letter or underscore'),
      label: z.string().describe('Human-readable field label'),
      field_type: z.enum([
        'short_text', 'long_text', 'email', 'phone', 'url', 'number',
        'single_select', 'multi_select', 'dropdown',
        'date', 'time', 'datetime',
        'file_upload', 'image_upload',
        'rating', 'scale', 'nps',
        'checkbox', 'toggle',
        'section_header', 'paragraph', 'hidden',
      ]).describe('Field input type'),
      description: z.string().optional().describe('Help text shown under the field'),
      placeholder: z.string().optional().describe('Placeholder text for the input'),
      required: z.boolean().optional().describe('Whether a response is required'),
      min_length: z.number().int().positive().optional().describe('Minimum text length'),
      max_length: z.number().int().positive().optional().describe('Maximum text length'),
      options: z.unknown().optional().describe('Choice options for select/dropdown fields (array of {value,label})'),
      scale_min: z.number().int().optional().describe('Minimum value for scale/rating/nps fields'),
      scale_max: z.number().int().optional().describe('Maximum value for scale/rating/nps fields'),
      scale_min_label: z.string().optional().describe('Label for the low end of a scale'),
      scale_max_label: z.string().optional().describe('Label for the high end of a scale'),
      conditional_on_field_id: z.string().uuid().optional().describe('Show this field only when another field meets a condition'),
      conditional_operator: z.enum(['equals', 'not_equals', 'contains', 'gt', 'lt', 'is_set', 'is_not_set']).optional().describe('Comparison operator for conditional visibility'),
      conditional_value: z.string().optional().describe('Value compared against for conditional visibility'),
      sort_order: z.number().int().optional().describe('Position of the field among siblings'),
      page_number: z.number().int().positive().optional().describe('Page (for multi-page forms)'),
      column_span: z.number().int().min(1).max(2).optional().describe('Layout column span (1 or 2)'),
      default_value: z.string().optional().describe('Pre-filled default value'),
    },
    returns: z.object({ id: z.string().uuid(), form_id: z.string().uuid(), field_key: z.string(), label: z.string(), field_type: z.string() }).passthrough(),
    handler: async ({ form_id, ...body }) => {
      const result = await client.request('POST', `/forms/${form_id}/fields`, body);
      return result.ok ? ok(result.data) : err('adding field', result.data);
    },
  });

  // ===== blank_update_field =====
  registerTool(server, {
    name: 'blank_update_field',
    description: 'Update a single form field. Provide only the fields you want to change.',
    input: {
      id: z.string().uuid().describe('Field ID to update'),
      field_key: z.string().optional().describe('Updated stable identifier (letters/digits/underscores, must start with a letter or underscore)'),
      label: z.string().optional().describe('Updated label'),
      field_type: z.enum([
        'short_text', 'long_text', 'email', 'phone', 'url', 'number',
        'single_select', 'multi_select', 'dropdown',
        'date', 'time', 'datetime',
        'file_upload', 'image_upload',
        'rating', 'scale', 'nps',
        'checkbox', 'toggle',
        'section_header', 'paragraph', 'hidden',
      ]).optional().describe('Updated field type'),
      description: z.string().nullable().optional().describe('Updated help text (null to clear)'),
      placeholder: z.string().nullable().optional().describe('Updated placeholder (null to clear)'),
      required: z.boolean().optional().describe('Whether a response is required'),
      min_length: z.number().int().positive().nullable().optional().describe('Minimum text length (null to clear)'),
      max_length: z.number().int().positive().nullable().optional().describe('Maximum text length (null to clear)'),
      options: z.unknown().optional().describe('Updated choice options for select/dropdown fields'),
      scale_min: z.number().int().optional().describe('Updated scale minimum'),
      scale_max: z.number().int().optional().describe('Updated scale maximum'),
      scale_min_label: z.string().nullable().optional().describe('Updated low-end scale label (null to clear)'),
      scale_max_label: z.string().nullable().optional().describe('Updated high-end scale label (null to clear)'),
      sort_order: z.number().int().optional().describe('Updated position among siblings'),
      page_number: z.number().int().positive().optional().describe('Updated page number'),
      column_span: z.number().int().min(1).max(2).optional().describe('Updated layout column span (1 or 2)'),
      default_value: z.string().nullable().optional().describe('Updated default value (null to clear)'),
    },
    returns: z.object({ id: z.string().uuid(), field_key: z.string(), label: z.string(), field_type: z.string() }).passthrough(),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/fields/${id}`, body);
      return result.ok ? ok(result.data) : err('updating field', result.data);
    },
  });

  // ===== blank_delete_field =====
  registerTool(server, {
    name: 'blank_delete_field',
    description: 'Delete a single field from a form. This is destructive and removes the field definition.',
    input: {
      id: z.string().uuid().describe('Field ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/fields/${id}`);
      return result.ok ? ok(result.data) : err('deleting field', result.data);
    },
  });

  // ===== blank_reorder_fields =====
  registerTool(server, {
    name: 'blank_reorder_fields',
    description: 'Bulk reorder the fields of a form by assigning each field a new sort_order.',
    input: {
      form_id: z.string().uuid().describe('Form ID whose fields to reorder'),
      fields: z.array(z.object({
        id: z.string().uuid().describe('Field ID'),
        sort_order: z.number().int().describe('New position for this field'),
      })).describe('Ordered list of {id, sort_order} for the form fields'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), sort_order: z.number().int() }).passthrough()) }).passthrough(),
    handler: async ({ form_id, fields }) => {
      const result = await client.request('POST', `/forms/${form_id}/fields/reorder`, { fields });
      return result.ok ? ok(result.data) : err('reordering fields', result.data);
    },
  });

  // ===== blank_delete_submission =====
  registerTool(server, {
    name: 'blank_delete_submission',
    description: 'Delete a single form submission. This is destructive and cannot be undone.',
    input: {
      id: z.string().uuid().describe('Submission ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/submissions/${id}`);
      return result.ok ? ok(result.data) : err('deleting submission', result.data);
    },
  });
}
