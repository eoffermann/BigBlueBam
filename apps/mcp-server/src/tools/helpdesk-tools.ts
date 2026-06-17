import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';
import { handleScopeError } from '../middleware/scope-check.js';

const ticketShape = z.object({
  id: z.string().uuid(),
  status: z.string(),
  subject: z.string().optional(),
  client_id: z.string().uuid().nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerHelpdeskTools(server: McpServer, api: ApiClient, helpdeskApiUrl: string): void {
  /** Helper to make requests to the helpdesk-api service */
  async function helpdeskRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const url = `${helpdeskApiUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client
    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers[k] = v;
      }
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

  /**
   * Resolve a ticket identifier that may be either a UUID or a human-readable
   * ticket number (e.g. "1234" or "#1234") to a UUID. Returns `null` if the
   * input is neither a UUID nor a resolvable ticket number, so callers can
   * surface a clean "Ticket not found" error.
   */
  async function resolveTicketId(idOrNumber: string): Promise<string | null> {
    if (isUuid(idOrNumber)) return idOrNumber;
    // Strip leading '#' and validate it's a positive integer
    const stripped = idOrNumber.trim().replace(/^#/, '');
    if (!/^\d+$/.test(stripped)) return null;
    const result = await helpdeskRequest('GET', `/helpdesk/tickets/by-number/${encodeURIComponent(stripped)}`);
    if (!result.ok) return null;
    const envelope = result.data as { data?: { id?: string } | null } | null;
    return envelope?.data?.id ?? null;
  }

  registerTool(server, {
    name: 'list_tickets',
    description: 'List helpdesk tickets with optional filters',
    input: {
      status: z.enum(['open', 'in_progress', 'waiting_on_client', 'resolved', 'closed']).optional().describe('Filter by ticket status'),
      assignee_id: z.string().uuid().optional().describe('Filter by assigned agent'),
      client_id: z.string().uuid().optional().describe('Filter by client'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(ticketShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(key, String(value));
      }
      const qs = searchParams.toString();
      const result = await helpdeskRequest('GET', `/helpdesk/tickets${qs ? `?${qs}` : ''}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing tickets: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_ticket',
    description: 'Get detailed information about a helpdesk ticket including messages',
    input: {
      ticket_id: z.string().uuid().describe('The ticket ID'),
    },
    returns: ticketShape.extend({ messages: z.array(z.object({ id: z.string().uuid(), body: z.string(), is_internal: z.boolean().optional() }).passthrough()).optional() }),
    handler: async ({ ticket_id }) => {
      const result = await helpdeskRequest('GET', `/helpdesk/tickets/${ticket_id}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error getting ticket: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_get_ticket_by_number',
    description: 'Resolve a helpdesk ticket by its human-readable ticket number (e.g. 1234 or #1234). Leading "#" is stripped. Returns the full ticket record enriched with requester and task-derived assignee info, or null if not found. Use this when you only have the ticket number (as typically shown to customers or agents) and need to resolve it to the underlying UUID / full record before calling other helpdesk tools.',
    input: {
      number: z.union([z.string().min(1), z.number().int().positive()]).describe('The human-readable ticket number; may be prefixed with "#"'),
    },
    returns: z.object({ data: ticketShape.nullable() }).passthrough(),
    handler: async ({ number }) => {
      const stripped = String(number).trim().replace(/^#/, '');
      const encoded = encodeURIComponent(stripped);
      const result = await helpdeskRequest('GET', `/helpdesk/tickets/by-number/${encoded}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error resolving ticket by number: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_search_tickets',
    description: 'Fuzzy search helpdesk tickets by subject and body within the caller\'s org. Returns up to 20 matches as a compact projection ({ id, number, subject, status, priority, requester_email, requester_name, assignee_id, assignee_name }), ordered by most recently updated. Optional filters narrow by status and by the linked task\'s assignee_id. Intended as a resolver for natural-language ticket lookups where only a fragment of the subject/body is known.',
    input: {
      query: z.string().min(1).max(500).describe('Search text — matched case-insensitively against ticket subject and body'),
      status: z.enum(['open', 'in_progress', 'waiting_on_client', 'waiting_on_customer', 'resolved', 'closed']).optional().describe('Optional status filter'),
      assignee_id: z.string().uuid().optional().describe('Optional assignee filter (matches the linked task\'s assignee)'),
    },
    returns: z.object({
      data: z.array(
        ticketShape.extend({
          number: z.number().optional(),
          priority: z.string().nullable().optional(),
          requester_email: z.string().nullable().optional(),
          requester_name: z.string().nullable().optional(),
          assignee_name: z.string().nullable().optional(),
        }),
      ),
    }).passthrough(),
    handler: async ({ query, status, assignee_id }) => {
      const sp = new URLSearchParams();
      sp.set('q', query);
      if (status) sp.set('status', status);
      if (assignee_id) sp.set('assignee_id', assignee_id);

      const result = await helpdeskRequest('GET', `/helpdesk/tickets/search?${sp.toString()}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error searching tickets: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'reply_to_ticket',
    description: 'Send a message on a helpdesk ticket (public reply or internal note)',
    input: {
      ticket_id: z.string().min(1).describe('The ticket UUID, ticket number ("1234"), or prefixed ticket number ("#1234")'),
      body: z.string().min(1).describe('The message body'),
      is_internal: z.boolean().optional().default(false).describe('If true, post as an internal note (not visible to client)'),
    },
    returns: z.object({ id: z.string().uuid(), ticket_id: z.string().uuid(), body: z.string(), is_internal: z.boolean().optional() }).passthrough(),
    handler: async ({ ticket_id, body, is_internal }) => {
      const resolvedId = await resolveTicketId(ticket_id);
      if (!resolvedId) {
        return {
          content: [{ type: 'text' as const, text: `Ticket not found: "${ticket_id}". Provide a UUID or a ticket number (e.g. 1234 or #1234).` }],
          isError: true,
        };
      }

      const result = await helpdeskRequest('POST', `/helpdesk/tickets/${resolvedId}/messages`, {
        body,
        is_internal,
      });

      if (!result.ok) {
        const scopeErr = handleScopeError('reply_to_ticket', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error replying to ticket: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Message sent successfully.\n${JSON.stringify(result.data, null, 2)}` }],
      };
    },
  });

  registerTool(server, {
    name: 'update_ticket_status',
    description: 'Update the status of a helpdesk ticket',
    input: {
      ticket_id: z.string().min(1).describe('The ticket UUID, ticket number ("1234"), or prefixed ticket number ("#1234")'),
      status: z.enum(['open', 'in_progress', 'waiting_on_client', 'resolved', 'closed']).describe('The new status'),
    },
    returns: ticketShape,
    handler: async ({ ticket_id, status }) => {
      const resolvedId = await resolveTicketId(ticket_id);
      if (!resolvedId) {
        return {
          content: [{ type: 'text' as const, text: `Ticket not found: "${ticket_id}". Provide a UUID or a ticket number (e.g. 1234 or #1234).` }],
          isError: true,
        };
      }

      const result = await helpdeskRequest('PATCH', `/helpdesk/tickets/${resolvedId}`, { status });

      if (!result.ok) {
        const scopeErr = handleScopeError('update_ticket_status', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating ticket status: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Ticket status updated to "${status}".\n${JSON.stringify(result.data, null, 2)}` }],
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_get_public_settings',
    description: 'Get public helpdesk settings (no auth required). Returns email verification requirement, categories, and welcome message.',
    input: {},
    returns: z.object({}).passthrough(),
    handler: async () => {
      const result = await helpdeskRequest('GET', '/helpdesk/public-settings');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        isError: !result.ok ? true : undefined,
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_get_settings',
    description: 'Get full helpdesk configuration. Requires admin authentication — the caller\'s API key must belong to an org admin or owner.',
    input: {},
    returns: z.object({}).passthrough(),
    handler: async () => {
      const result = await helpdeskRequest('GET', '/helpdesk/settings');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        isError: !result.ok ? true : undefined,
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_update_settings',
    description: 'Update helpdesk settings. Requires admin authentication.',
    input: {
      categories: z.array(z.string()).optional().describe('Ticket categories available to customers.'),
      welcome_message: z.string().max(2000).optional().describe('Welcome message shown to customers.'),
      require_email_verification: z.boolean().optional().describe('Whether customers must verify their email.'),
      allowed_email_domains: z.array(z.string()).optional().describe('If set, only these email domains can register.'),
    },
    returns: z.object({}).passthrough(),
    handler: async (params) => {
      const body: Record<string, unknown> = {};
      if (params.categories !== undefined) body.categories = params.categories;
      if (params.welcome_message !== undefined) body.welcome_message = params.welcome_message;
      if (params.require_email_verification !== undefined) body.require_email_verification = params.require_email_verification;
      if (params.allowed_email_domains !== undefined) body.allowed_email_domains = params.allowed_email_domains;

      const result = await helpdeskRequest('PATCH', '/helpdesk/settings', body);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        isError: !result.ok ? true : undefined,
      };
    },
  });

  registerTool(server, {
    name: 'helpdesk_set_default_project',
    description:
      'Set the default project for incoming helpdesk tickets for a specific organization. Identifies the org by slug (e.g. "mage-inc") and the project by slug (e.g. "support-backlog"). Future tickets submitted at /helpdesk/<org-slug>/ (no project segment) will land in this project. Per-project portal URLs (/helpdesk/<org-slug>/<project-slug>/) override this default. Requires admin authentication.',
    input: {
      org_slug: z.string().min(1).max(100).describe('Organization slug (from organizations.slug).'),
      project_slug: z
        .string()
        .min(1)
        .max(100)
        .describe('Project slug (from projects.slug). Must belong to the named org.'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ org_slug, project_slug }) => {
      // Use the public discovery endpoint to resolve the project slug to
      // its uuid without requiring admin auth for the lookup itself. The
      // subsequent PATCH does require admin auth.
      const discovery = await helpdeskRequest(
        'GET',
        `/helpdesk/public/orgs/${encodeURIComponent(org_slug)}`,
      );
      if (!discovery.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not find organization "${org_slug}": ${JSON.stringify(discovery.data)}`,
            },
          ],
          isError: true,
        };
      }

      const payload = discovery.data as {
        data?: { projects?: Array<{ slug: string; name: string }> };
      };
      const projects = payload.data?.projects ?? [];
      const match = projects.find((p) => p.slug === project_slug);
      if (!match) {
        const available = projects.map((p) => p.slug).join(', ') || '(none)';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No project "${project_slug}" in org "${org_slug}". Available project slugs: ${available}`,
            },
          ],
          isError: true,
        };
      }

      // Resolve the project slug to a uuid via the admin-scoped helpdesk
      // projects listing, which returns { id, slug, name } for the
      // X-Org-Slug tenant. This tool inherits admin auth from the
      // caller's MCP credentials (the helpdesk PATCH route also requires
      // admin auth, so if we can PATCH we can list).
      const projectsRes = await helpdeskRequest(
        'GET',
        '/helpdesk/admin/projects',
        undefined,
        { 'X-Org-Slug': org_slug },
      );
      if (!projectsRes.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not list projects for "${org_slug}": ${JSON.stringify(projectsRes.data)}`,
            },
          ],
          isError: true,
        };
      }
      const projectList = (
        projectsRes.data as { data?: Array<{ id: string; slug: string }> }
      ).data ?? [];
      const projectHit = projectList.find((p) => p.slug === project_slug);
      const projectId = projectHit?.id ?? null;

      if (!projectId) {
        const available = projectList.map((p) => p.slug).join(', ') || '(none)';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Project "${project_slug}" not found in org "${org_slug}". Available slugs: ${available}`,
            },
          ],
          isError: true,
        };
      }

      const result = await helpdeskRequest(
        'PATCH',
        '/helpdesk/settings',
        { default_project_id: projectId },
        { 'X-Org-Slug': org_slug },
      );

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update default project: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Default project for org "${org_slug}" set to "${project_slug}" (${projectId}).\n${JSON.stringify(result.data, null, 2)}`,
          },
        ],
      };
    },
  });

  // §14 Wave 4: idempotent create-or-update of a helpdesk_user by email.
  // The route layer resolves X-Org-Slug into an org_id and scopes the
  // upsert to that tenant. Update path NEVER overwrites password_hash.
  registerTool(server, {
    name: 'helpdesk_upsert_user',
    description: 'Idempotent create-or-update of a helpdesk end-user by email. Natural key is (org_id, email); the tool resolves the org via the provided org_slug. Returns { data, created, idempotency_key }. SECURITY: the update path ignores the password field, so calling this tool on an existing email cannot change that user\'s credentials.',
    input: {
      org_slug: z.string().min(1).max(128).describe('Organization slug (sent as X-Org-Slug header)'),
      email: z.string().email().max(320).describe('Email address — idempotency key (lowercased server-side)'),
      display_name: z.string().min(1).max(100).describe('Display name'),
      password: z.string().min(12).max(256).optional().describe('Password — honored ONLY on the insert path. On update this field is silently ignored.'),
      email_verified: z.boolean().optional().describe('Whether the email address has been verified'),
      is_active: z.boolean().optional().describe('Whether the account is active'),
    },
    returns: z.object({
      data: z.object({
        id: z.string().uuid(),
        email: z.string(),
        org_id: z.string().uuid().nullable(),
        display_name: z.string(),
        email_verified: z.boolean(),
        is_active: z.boolean(),
        created_at: z.string(),
        updated_at: z.string(),
      }).passthrough(),
      created: z.boolean(),
      idempotency_key: z.string(),
    }),
    handler: async ({ org_slug, ...body }) => {
      const result = await helpdeskRequest(
        'POST',
        '/v1/helpdesk-users/upsert',
        body,
        { 'X-Org-Slug': org_slug },
      );
      if (!result.ok) {
        const scopeErr = handleScopeError('helpdesk_upsert_user', 'admin', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error upserting helpdesk user: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
