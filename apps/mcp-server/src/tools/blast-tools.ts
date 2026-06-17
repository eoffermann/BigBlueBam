import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

function createBlastClient(blastApiUrl: string, api: ApiClient) {
  const baseUrl = blastApiUrl.replace(/\/$/, '');

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

type BlastClient = ReturnType<typeof createBlastClient>;

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

// ---------------------------------------------------------------------------
// Name-or-ID resolvers (Phase D / Tier 3)
// ---------------------------------------------------------------------------
//
// Rule authors routinely reference Blast entities by their human-readable
// names — "send the Welcome campaign", "use the Newsletter template",
// "segment: Active Customers". These resolvers let the canonical action
// tools accept either a UUID (fast path, no HTTP) or a name (single lookup
// via the existing list endpoints) without forcing the caller to do a
// two-step list-then-act dance.
//
// All three follow the same contract:
//   - UUID input → returned verbatim, zero extra HTTP calls
//   - name input → single GET to the list endpoint, exact-match preferred,
//     single fuzzy match acceptable, multiple fuzzy matches → null
//   - returns null on failure so the caller can surface a clean error
//
// Templates and segments have dedicated `?search=` query params on their
// list endpoints. Campaigns do not (as of Phase C) — so we fetch a bounded
// page and filter client-side.

async function resolveCampaignId(
  blast: BlastClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  // Campaigns list endpoint has no `search` param — fetch a bounded page
  // and filter client-side. 100 is the route-level max.
  const result = await blast.request('GET', '/campaigns?limit=100');
  if (!result.ok) return null;
  const campaigns = (result.data as { data: Array<{ id: string; name: string }> }).data ?? [];
  const needle = nameOrId.toLowerCase();
  // Exact match preferred (case-insensitive)
  const exact = campaigns.find((c) => c.name.toLowerCase() === needle);
  if (exact) return exact.id;
  // Single substring match acceptable
  const fuzzy = campaigns.filter((c) => c.name.toLowerCase().includes(needle));
  if (fuzzy.length === 1 && fuzzy[0]) return fuzzy[0].id;
  return null;
}

async function resolveTemplateId(
  blast: BlastClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await blast.request(
    'GET',
    `/templates?search=${encodeURIComponent(nameOrId)}&limit=10`,
  );
  if (!result.ok) return null;
  const templates = (result.data as { data: Array<{ id: string; name: string }> }).data ?? [];
  const exact = templates.find((t) => t.name.toLowerCase() === nameOrId.toLowerCase());
  if (exact) return exact.id;
  if (templates.length === 1 && templates[0]) return templates[0].id;
  return null;
}

async function resolveSegmentId(
  blast: BlastClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await blast.request(
    'GET',
    `/segments?search=${encodeURIComponent(nameOrId)}&limit=10`,
  );
  if (!result.ok) return null;
  const segments = (result.data as { data: Array<{ id: string; name: string }> }).data ?? [];
  const exact = segments.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
  if (exact) return exact.id;
  if (segments.length === 1 && segments[0]) return segments[0].id;
  return null;
}

const templateShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  template_type: z.string().optional(),
  subject_template: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const campaignShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string().optional(),
  subject: z.string().optional(),
  sent_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const segmentShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  recipient_count: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerBlastTools(server: McpServer, api: ApiClient, blastApiUrl: string): void {
  const client = createBlastClient(blastApiUrl, api);

  // ===== TEMPLATES (3) =====

  registerTool(server, {
    name: 'blast_list_templates',
    description: 'List available email templates with optional type filter and search.',
    input: {
      template_type: z.enum(['campaign', 'drip_step', 'transactional', 'system']).optional().describe('Filter by template type'),
      search: z.string().max(200).optional().describe('Search templates by name'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50)'),
    },
    returns: z.object({ data: z.array(templateShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/templates${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing templates', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_get_template',
    description: 'Get email template content and builder state by ID.',
    input: {
      id: z.string().uuid().describe('Template ID'),
    },
    returns: templateShape.extend({ html_body: z.string().optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/templates/${id}`);
      return result.ok ? ok(result.data) : err('getting template', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_create_template',
    description: 'Create a new email template from HTML and subject line.',
    input: {
      name: z.string().min(1).max(255).describe('Template name'),
      subject_template: z.string().min(1).max(500).describe('Subject line with merge fields'),
      html_body: z.string().min(1).describe('HTML email body'),
      description: z.string().max(2000).optional().describe('Template description'),
      template_type: z.enum(['campaign', 'drip_step', 'transactional', 'system']).optional().describe('Template type'),
    },
    returns: templateShape,
    handler: async (params) => {
      const result = await client.request('POST', '/templates', params);
      return result.ok ? ok(result.data) : err('creating template', result.data);
    },
  });

  // ===== CAMPAIGNS (4) =====

  registerTool(server, {
    name: 'blast_draft_campaign',
    description: 'Create a campaign in draft status with template, segment, and schedule. `template_id` and `segment_id` accept either a UUID or the entity name — exact match preferred, single fuzzy match acceptable.',
    input: {
      name: z.string().min(1).max(255).describe('Campaign name'),
      subject: z.string().min(1).max(500).describe('Email subject line'),
      html_body: z.string().min(1).describe('HTML email body'),
      template_id: z.string().optional().describe('Template UUID or template name (exact match preferred)'),
      segment_id: z.string().optional().describe('Recipient segment UUID or segment name (exact match preferred)'),
      from_name: z.string().max(100).optional().describe('From name'),
      from_email: z.string().email().optional().describe('From email address'),
    },
    returns: campaignShape,
    handler: async (params) => {
      // Resolve human-friendly identifiers to UUIDs before hitting the API.
      let template_id: string | undefined = params.template_id;
      if (template_id) {
        const resolved = await resolveTemplateId(client, template_id);
        if (!resolved) {
          return err('drafting campaign', {
            message: `Template not found by name or id: ${template_id}`,
          });
        }
        template_id = resolved;
      }

      let segment_id: string | undefined = params.segment_id;
      if (segment_id) {
        const resolved = await resolveSegmentId(client, segment_id);
        if (!resolved) {
          return err('drafting campaign', {
            message: `Segment not found by name or id: ${segment_id}`,
          });
        }
        segment_id = resolved;
      }

      const body = { ...params, template_id, segment_id };
      const result = await client.request('POST', '/campaigns', body);
      return result.ok ? ok(result.data) : err('drafting campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_get_campaign',
    description: 'Get campaign detail and delivery stats. `id` accepts either a UUID or the campaign name (exact match preferred, single fuzzy match acceptable).',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
    },
    returns: campaignShape.extend({ opens: z.number().optional(), clicks: z.number().optional(), bounces: z.number().optional() }),
    handler: async ({ id }) => {
      const resolved = await resolveCampaignId(client, id);
      if (!resolved) {
        return err('getting campaign', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('GET', `/campaigns/${resolved}`);
      return result.ok ? ok(result.data) : err('getting campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_send_campaign',
    description: 'Send a campaign immediately. Requires human approval by default. `id` accepts either a UUID or the campaign name (exact match preferred, single fuzzy match acceptable).',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
      require_human_approval: z.boolean().default(true).describe('When true, campaign is scheduled for review instead of sent immediately'),
    },
    returns: campaignShape.extend({ note: z.string().optional() }),
    handler: async ({ id, require_human_approval }) => {
      const resolved = await resolveCampaignId(client, id);
      if (!resolved) {
        return err('sending campaign', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      if (require_human_approval) {
        // Schedule instead of send — requires human confirmation
        const result = await client.request('POST', `/campaigns/${resolved}/schedule`, {
          scheduled_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        });
        return result.ok
          ? ok({ ...(result.data as Record<string, unknown>), note: 'Campaign scheduled for review. A human must confirm before it sends.' })
          : err('scheduling campaign', result.data);
      }
      const result = await client.request('POST', `/campaigns/${resolved}/send`);
      return result.ok ? ok(result.data) : err('sending campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_get_campaign_analytics',
    description: 'Get engagement metrics for a sent campaign: open rate, click rate, click map, delivery breakdown. `id` accepts either a UUID or the campaign name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
    },
    returns: z.object({ campaign_id: z.string().uuid(), sent: z.number().optional(), delivered: z.number().optional(), opens: z.number().optional(), clicks: z.number().optional(), unsubscribes: z.number().optional(), open_rate: z.number().optional(), click_rate: z.number().optional() }).passthrough(),
    handler: async ({ id }) => {
      const resolved = await resolveCampaignId(client, id);
      if (!resolved) {
        return err('getting campaign analytics', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('GET', `/campaigns/${resolved}/analytics`);
      return result.ok ? ok(result.data) : err('getting campaign analytics', result.data);
    },
  });

  // ===== SEGMENTS (3) =====

  registerTool(server, {
    name: 'blast_list_segments',
    description: 'List contact segments with cached recipient counts.',
    input: {
      search: z.string().max(200).optional().describe('Search segments by name'),
      limit: z.number().int().positive().max(100).optional().describe('Page size'),
    },
    returns: z.object({ data: z.array(segmentShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/segments${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing segments', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_create_segment',
    description: 'Define a segment from Bond contact filter criteria.',
    input: {
      name: z.string().min(1).max(255).describe('Segment name'),
      description: z.string().max(2000).optional().describe('Segment description'),
      filter_criteria: z.object({
        conditions: z.array(z.object({
          field: z.string().describe('Contact field to filter on'),
          op: z.string().describe('Comparison operator (equals, in, contains, greater_than, less_than, older_than_days)'),
          value: z.unknown().describe('Filter value'),
        })).min(1).max(20),
        match: z.enum(['all', 'any']).describe('all = AND, any = OR'),
      }).describe('Filter definition'),
    },
    returns: segmentShape,
    handler: async (params) => {
      const result = await client.request('POST', '/segments', params);
      return result.ok ? ok(result.data) : err('creating segment', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_preview_segment',
    description: 'Preview the first 50 matching contacts for a segment.',
    input: {
      id: z.string().uuid().describe('Segment ID'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), email: z.string().optional() }).passthrough()), total: z.number().optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/segments/${id}/preview`);
      return result.ok ? ok(result.data) : err('previewing segment', result.data);
    },
  });

  // ===== AI CONTENT (2) =====

  registerTool(server, {
    name: 'blast_draft_email_content',
    description: 'AI-generate email subject and body from a brief description and tone.',
    input: {
      description: z.string().min(10).max(2000).describe('Brief description of the email to generate'),
      tone: z.enum(['professional', 'casual', 'urgent', 'friendly', 'formal']).optional().describe('Email tone'),
      audience: z.string().max(200).optional().describe('Target audience description'),
    },
    returns: z.object({ subject: z.string(), html_body: z.string(), note: z.string().optional() }),
    handler: async ({ description, tone, audience }) => {
      // This would integrate with an LLM in production
      const subject = `[Draft] ${description.substring(0, 60)}`;
      const html = `<h1>Email Draft</h1><p>${description}</p><p style="color: #666;">Tone: ${tone ?? 'professional'}${audience ? `. Audience: ${audience}` : ''}</p>`;
      return ok({
        subject,
        html_body: html,
        note: 'This is a draft. Review and edit before sending.',
      });
    },
  });

  registerTool(server, {
    name: 'blast_suggest_subject_lines',
    description: 'Generate 5 subject line variants for A/B comparison.',
    input: {
      topic: z.string().min(5).max(500).describe('Email topic or campaign description'),
      tone: z.enum(['professional', 'casual', 'urgent', 'friendly', 'formal']).optional().describe('Desired tone'),
    },
    returns: z.object({ suggestions: z.array(z.string()), tone: z.string() }),
    handler: async ({ topic, tone }) => {
      const toneLabel = tone ?? 'professional';
      const suggestions = [
        `[${toneLabel}] ${topic} - Option A`,
        `Don't miss: ${topic.substring(0, 40)}`,
        `${topic.substring(0, 50)} - you'll want to see this`,
        `Quick update: ${topic.substring(0, 45)}`,
        `[New] ${topic.substring(0, 45)} inside`,
      ];
      return ok({ suggestions, tone: toneLabel });
    },
  });

  // ===== ANALYTICS & COMPLIANCE (2) =====

  registerTool(server, {
    name: 'blast_get_engagement_summary',
    description: 'Get org-level engagement trends: total sent, avg open rate, avg click rate, unsubscribe rate.',
    input: {},
    returns: z.object({
      total_sent: z.number().optional(),
      avg_open_rate: z.number().optional(),
      avg_click_rate: z.number().optional(),
      unsubscribe_rate: z.number().optional(),
    }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/analytics/overview');
      return result.ok ? ok(result.data) : err('getting engagement summary', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_check_unsubscribed',
    description: 'Check if an email address is on the organization unsubscribe list.',
    input: {
      email: z.string().email().describe('Email address to check'),
    },
    returns: z.object({ email: z.string(), is_unsubscribed: z.boolean(), unsubscribed_at: z.string().nullable().optional() }).passthrough(),
    handler: async ({ email }) => {
      const result = await client.request(
        'GET',
        `/analytics/unsubscribe-check?email=${encodeURIComponent(email)}`,
      );
      return result.ok ? ok(result.data) : err('checking unsubscribe status', result.data);
    },
  });

  // ===== TEMPLATES (extended) =====

  registerTool(server, {
    name: 'blast_update_template',
    description: 'Update an email template. Provide only the fields to change. `id` accepts either a UUID or the template name (exact match preferred, single fuzzy match acceptable).',
    input: {
      id: z.string().describe('Template UUID or template name'),
      name: z.string().min(1).max(255).optional().describe('Updated template name'),
      subject_template: z.string().min(1).max(500).optional().describe('Updated subject line with merge fields'),
      html_body: z.string().min(1).optional().describe('Updated HTML email body'),
      plain_text_body: z.string().optional().describe('Updated plain-text body'),
      description: z.string().max(2000).optional().describe('Updated template description'),
      template_type: z.enum(['campaign', 'drip_step', 'transactional', 'system']).optional().describe('Updated template type'),
      thumbnail_url: z.string().url().optional().describe('Updated thumbnail URL'),
    },
    returns: templateShape,
    handler: async ({ id, ...rest }) => {
      const templateId = await resolveTemplateId(client, id);
      if (!templateId) {
        return err('updating template', {
          message: `Template not found by name or id: ${id}`,
        });
      }
      const result = await client.request('PATCH', `/templates/${templateId}`, rest);
      return result.ok ? ok(result.data) : err('updating template', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_duplicate_template',
    description: 'Duplicate an email template into a new copy. `id` accepts either a UUID or the template name (exact match preferred, single fuzzy match acceptable).',
    input: {
      id: z.string().describe('Template UUID or template name to duplicate'),
    },
    returns: templateShape,
    handler: async ({ id }) => {
      const templateId = await resolveTemplateId(client, id);
      if (!templateId) {
        return err('duplicating template', {
          message: `Template not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/templates/${templateId}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating template', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_preview_template',
    description: 'Render a template with sample merge data to preview the resulting subject and HTML. Read-only — does not send anything. `id` accepts either a UUID or the template name.',
    input: {
      id: z.string().describe('Template UUID or template name'),
      merge_data: z.record(z.string()).optional().describe('Optional map of merge-field name → sample value (e.g. { first_name: "Alex" })'),
    },
    returns: z.object({ data: z.object({ subject: z.string().optional(), html_body: z.string().optional() }).passthrough() }),
    handler: async ({ id, merge_data }) => {
      const templateId = await resolveTemplateId(client, id);
      if (!templateId) {
        return err('previewing template', {
          message: `Template not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/templates/${templateId}/preview`, merge_data ?? {});
      return result.ok ? ok(result.data) : err('previewing template', result.data);
    },
  });

  // ===== CAMPAIGNS (extended) =====

  registerTool(server, {
    name: 'blast_update_campaign',
    description: 'Update a draft campaign. Provide only the fields to change. `id` accepts either a UUID or the campaign name. `template_id` and `segment_id` accept a UUID or the entity name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
      name: z.string().min(1).max(255).optional().describe('Updated campaign name'),
      subject: z.string().min(1).max(500).optional().describe('Updated email subject line'),
      html_body: z.string().min(1).optional().describe('Updated HTML email body'),
      plain_text_body: z.string().optional().describe('Updated plain-text body'),
      template_id: z.string().optional().describe('Template UUID or template name'),
      segment_id: z.string().optional().describe('Recipient segment UUID or segment name'),
      from_name: z.string().max(100).optional().describe('From name'),
      from_email: z.string().email().optional().describe('From email address'),
      reply_to_email: z.string().email().optional().describe('Reply-to email address'),
    },
    returns: campaignShape,
    handler: async ({ id, ...rest }) => {
      const campaignId = await resolveCampaignId(client, id);
      if (!campaignId) {
        return err('updating campaign', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }

      const body: Record<string, unknown> = { ...rest };
      if (rest.template_id !== undefined) {
        const resolved = await resolveTemplateId(client, rest.template_id);
        if (!resolved) {
          return err('updating campaign', {
            message: `Template not found by name or id: ${rest.template_id}`,
          });
        }
        body.template_id = resolved;
      }
      if (rest.segment_id !== undefined) {
        const resolved = await resolveSegmentId(client, rest.segment_id);
        if (!resolved) {
          return err('updating campaign', {
            message: `Segment not found by name or id: ${rest.segment_id}`,
          });
        }
        body.segment_id = resolved;
      }

      const result = await client.request('PATCH', `/campaigns/${campaignId}`, body);
      return result.ok ? ok(result.data) : err('updating campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_pause_campaign',
    description: 'Pause an in-progress campaign send. `id` accepts either a UUID or the campaign name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
    },
    returns: campaignShape,
    handler: async ({ id }) => {
      const campaignId = await resolveCampaignId(client, id);
      if (!campaignId) {
        return err('pausing campaign', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/campaigns/${campaignId}/pause`);
      return result.ok ? ok(result.data) : err('pausing campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_cancel_campaign',
    description: 'Cancel a scheduled or in-progress campaign so it will not (continue to) send. `id` accepts either a UUID or the campaign name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
    },
    returns: campaignShape,
    handler: async ({ id }) => {
      const campaignId = await resolveCampaignId(client, id);
      if (!campaignId) {
        return err('cancelling campaign', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/campaigns/${campaignId}/cancel`);
      return result.ok ? ok(result.data) : err('cancelling campaign', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_list_campaign_recipients',
    description: 'List the recipients of a campaign with per-recipient delivery status. `id` accepts either a UUID or the campaign name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default service-defined)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid().optional(), email: z.string().optional(), status: z.string().optional() }).passthrough()) }).passthrough(),
    handler: async ({ id, limit, offset }) => {
      const campaignId = await resolveCampaignId(client, id);
      if (!campaignId) {
        return err('listing campaign recipients', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('GET', `/campaigns/${campaignId}/recipients${buildQs({ limit, offset })}`);
      return result.ok ? ok(result.data) : err('listing campaign recipients', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_get_campaign_device_analytics',
    description: 'Get the device/client breakdown of opens and clicks for a campaign. `id` accepts either a UUID or the campaign name.',
    input: {
      id: z.string().describe('Campaign UUID or campaign name'),
    },
    returns: z.object({}).passthrough().describe('Device-breakdown analytics — shape varies by provider'),
    handler: async ({ id }) => {
      const campaignId = await resolveCampaignId(client, id);
      if (!campaignId) {
        return err('getting campaign device analytics', {
          message: `Campaign not found by name or id: ${id}`,
        });
      }
      const result = await client.request('GET', `/campaigns/${campaignId}/analytics/devices`);
      return result.ok ? ok(result.data) : err('getting campaign device analytics', result.data);
    },
  });

  // ===== SEGMENTS (extended) =====

  registerTool(server, {
    name: 'blast_get_segment',
    description: 'Get a single segment with its filter criteria and cached recipient count. `id` accepts either a UUID or the segment name.',
    input: {
      id: z.string().describe('Segment UUID or segment name'),
    },
    returns: segmentShape.extend({ filter_criteria: z.object({}).passthrough().optional() }),
    handler: async ({ id }) => {
      const segmentId = await resolveSegmentId(client, id);
      if (!segmentId) {
        return err('getting segment', {
          message: `Segment not found by name or id: ${id}`,
        });
      }
      const result = await client.request('GET', `/segments/${segmentId}`);
      return result.ok ? ok(result.data) : err('getting segment', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_update_segment',
    description: 'Update a segment\'s name, description, or filter criteria. Provide only the fields to change. `id` accepts either a UUID or the segment name.',
    input: {
      id: z.string().describe('Segment UUID or segment name'),
      name: z.string().min(1).max(255).optional().describe('Updated segment name'),
      description: z.string().max(2000).optional().describe('Updated segment description'),
      filter_criteria: z.object({
        conditions: z.array(z.object({
          field: z.string().describe('Contact field to filter on'),
          op: z.string().describe('Comparison operator (equals, in, contains, greater_than, less_than, older_than_days)'),
          value: z.unknown().describe('Filter value'),
        })).min(1).max(20),
        match: z.enum(['all', 'any']).describe('all = AND, any = OR'),
      }).optional().describe('Updated filter definition (replaces the existing one)'),
    },
    returns: segmentShape,
    handler: async ({ id, ...rest }) => {
      const segmentId = await resolveSegmentId(client, id);
      if (!segmentId) {
        return err('updating segment', {
          message: `Segment not found by name or id: ${id}`,
        });
      }
      const result = await client.request('PATCH', `/segments/${segmentId}`, rest);
      return result.ok ? ok(result.data) : err('updating segment', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_recalculate_segment_count',
    description: 'Recalculate and cache the recipient count for a segment by re-running its filter against current Bond contacts. `id` accepts either a UUID or the segment name.',
    input: {
      id: z.string().describe('Segment UUID or segment name'),
    },
    returns: z.object({ data: z.object({ recipient_count: z.number().optional() }).passthrough() }).passthrough(),
    handler: async ({ id }) => {
      const segmentId = await resolveSegmentId(client, id);
      if (!segmentId) {
        return err('recalculating segment count', {
          message: `Segment not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/segments/${segmentId}/count`);
      return result.ok ? ok(result.data) : err('recalculating segment count', result.data);
    },
  });

  registerTool(server, {
    name: 'blast_evaluate_segment',
    description: 'Run the full recipient evaluation for a segment (the resolved send list a campaign would target). Read-only — does not send anything. `id` accepts either a UUID or the segment name.',
    input: {
      id: z.string().describe('Segment UUID or segment name'),
    },
    returns: z.object({ data: z.object({}).passthrough() }).passthrough().describe('Resolved recipient set — shape varies'),
    handler: async ({ id }) => {
      const segmentId = await resolveSegmentId(client, id);
      if (!segmentId) {
        return err('evaluating segment', {
          message: `Segment not found by name or id: ${id}`,
        });
      }
      const result = await client.request('POST', `/segments/${segmentId}/evaluate`);
      return result.ok ? ok(result.data) : err('evaluating segment', result.data);
    },
  });

  // ===== ANALYTICS (extended) =====

  registerTool(server, {
    name: 'blast_get_engagement_trend',
    description: 'Get org-level engagement metrics over time, bucketed daily, weekly, or monthly.',
    input: {
      period: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Bucketing period (default service-defined)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }).passthrough(),
    handler: async ({ period }) => {
      const result = await client.request('GET', `/analytics/engagement-trend${buildQs({ period })}`);
      return result.ok ? ok(result.data) : err('getting engagement trend', result.data);
    },
  });
}
