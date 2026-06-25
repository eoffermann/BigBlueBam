import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Bay MCP tools. Bay is BigBlueBam's media review & approval product, and its
 * defining feature is that AI agents review like humans: an agent ingests a
 * version, posts frame/region/timecode/viewpoint-anchored annotations, and sets
 * a per-reviewer decision through the SAME tools, identity, and audit trail as a
 * human reviewer. Canonical bytes live in Bin; Bay owns the review layer.
 *
 * Mirrors the bin/board/blueprint pattern: a fetch wrapper forwarding the
 * caller's bearer token to bay-api, then per-tool registerTool calls.
 */
function createBayClient(bayApiUrl: string, api: ApiClient) {
  const baseUrl = bayApiUrl.replace(/\/$/, '');
  async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    const token = (api as unknown as { token?: string }).token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
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
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const DECISIONS = ['approved', 'rejected', 'changes_requested', 'pending'] as const;

export function registerBayTools(server: McpServer, api: ApiClient, bayApiUrl: string): void {
  const client = createBayClient(bayApiUrl, api);

  registerTool(server, {
    name: 'bay_review_resolve',
    description:
      'Open (find-or-create) the Bay review for a Bin media asset. Given the Bin asset id (and optionally its content_type/name/current bin_version_id), returns the Bay review asset — creating it + an initial version on first call, idempotent thereafter. This is how a media file in Bin is opened for review in Bay.',
    input: {
      bin_asset_id: z.string().uuid().describe('The Bin asset holding the media bytes'),
      bin_version_id: z.string().uuid().nullable().optional(),
      name: z.string().optional(),
      media_kind: z.enum(['image', 'video', 'audio', 'model']).optional(),
      content_type: z.string().optional().describe('Used to infer media_kind when not given'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async (params) => {
      const r = await client.request('POST', '/review/resolve', params);
      return r.ok ? ok(r.data) : err('resolving bay review', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_asset_list',
    description:
      'List Bay review assets (the durable things under review: a shot, cut, track, or model), optionally filtered by project or including archived. Returns metadata; use bay_version_list for the version stack.',
    input: {
      project_id: z.string().uuid().optional(),
      include_archived: z.boolean().optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async (params) => {
      const r = await client.request('GET', `/assets${buildQs(params)}`);
      return r.ok ? ok(r.data) : err('listing bay assets', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_asset_get',
    description: "Get a Bay asset's metadata (media_kind, current version, project).",
    input: { id: z.string().uuid() },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const r = await client.request('GET', `/assets/${id}`);
      return r.ok ? ok(r.data) : err('getting bay asset', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_asset_create',
    description:
      'Create a Bay review asset. media_kind is one of image/video/audio/model. The canonical bytes live in Bin; attach them via bay_version_create with bin_asset_id.',
    input: {
      name: z.string().min(1).max(512),
      media_kind: z.enum(['image', 'video', 'audio', 'model']),
      project_id: z.string().uuid().nullable().optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async (params) => {
      const r = await client.request('POST', '/assets', params);
      return r.ok ? ok(r.data) : err('creating bay asset', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_asset_archive',
    description: 'Archive (soft-delete) a Bay asset. Review history is preserved.',
    input: { id: z.string().uuid() },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const r = await client.request('POST', `/assets/${id}/archive`);
      return r.ok ? ok(r.data) : err('archiving bay asset', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_version_list',
    description: 'List the immutable version stack of a Bay asset, newest first.',
    input: { asset_id: z.string().uuid() },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ asset_id }) => {
      const r = await client.request('GET', `/assets/${asset_id}/versions`);
      return r.ok ? ok(r.data) : err('listing bay versions', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_version_get',
    description: 'Get a single Bay version (media metadata + Bin byte references).',
    input: { id: z.string().uuid() },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const r = await client.request('GET', `/versions/${id}`);
      return r.ok ? ok(r.data) : err('getting bay version', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_version_create',
    description:
      'Add a new immutable version to a Bay asset. Reference the canonical bytes already stored in Bin via bin_asset_id / bin_version_id, and pass media_meta (duration_sec, width, height, codec, …).',
    input: {
      asset_id: z.string().uuid(),
      bin_asset_id: z.string().uuid().nullable().optional(),
      bin_version_id: z.string().uuid().nullable().optional(),
      media_meta: z.record(z.unknown()).optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ asset_id, ...body }) => {
      const r = await client.request('POST', `/assets/${asset_id}/versions`, body);
      return r.ok ? ok(r.data) : err('creating bay version', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_annotation_list',
    description: 'List annotations on a Bay version (optionally include resolved).',
    input: { version_id: z.string().uuid(), include_resolved: z.boolean().optional() },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ version_id, include_resolved }) => {
      const r = await client.request(
        'GET',
        `/versions/${version_id}/annotations${include_resolved ? '?include_resolved=true' : ''}`,
      );
      return r.ok ? ok(r.data) : err('listing bay annotations', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_annotation_create',
    description:
      'Post a coordinate-anchored annotation on a Bay version. The anchor is structured + queryable: video → {type:"frame",frame} or {type:"timerange",start,end}; image → {type:"region",x,y,w,h}; 3D → {type:"viewpoint",camera}. This is how an agent posts automated-QC findings next to human notes.',
    input: {
      version_id: z.string().uuid(),
      anchor: z.record(z.unknown()).describe('e.g. {type:"region",x:0.4,y:0.2,w:0.2,h:0.1}'),
      body: z.string().min(1).max(10000),
      thread_parent_id: z.string().uuid().nullable().optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ version_id, ...body }) => {
      const r = await client.request('POST', `/versions/${version_id}/annotations`, body);
      return r.ok ? ok(r.data) : err('creating bay annotation', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_annotation_resolve',
    description: 'Mark a Bay annotation resolved (or reopen with resolved:false).',
    input: { id: z.string().uuid(), resolved: z.boolean().optional() },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, resolved }) => {
      const r = await client.request('POST', `/annotations/${id}/resolve`, { resolved: resolved ?? true });
      return r.ok ? ok(r.data) : err('resolving bay annotation', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_decision_list',
    description: 'List the per-reviewer decisions on a Bay version (the approval rollup input).',
    input: { version_id: z.string().uuid() },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ version_id }) => {
      const r = await client.request('GET', `/versions/${version_id}/decisions`);
      return r.ok ? ok(r.data) : err('listing bay decisions', r.data);
    },
  });

  registerTool(server, {
    name: 'bay_decision_set',
    description:
      "Set (upsert) the caller's review decision on a Bay version — one decision per reviewer per version. decision is approved/rejected/changes_requested/pending. An agent setting a decision is a first-class reviewer; an agent-proposed FINAL approval that a different human must ratify should instead route through proposal_create.",
    input: {
      version_id: z.string().uuid(),
      decision: z.enum(DECISIONS),
      comment: z.string().max(10000).nullable().optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ version_id, ...body }) => {
      const r = await client.request('PUT', `/versions/${version_id}/decision`, body);
      return r.ok ? ok(r.data) : err('setting bay decision', r.data);
    },
  });
}
