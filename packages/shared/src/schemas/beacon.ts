import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BeaconVisibility = z.enum(['Public', 'Organization', 'Project', 'Private']);
export const BeaconLinkType = z.enum([
  'RelatedTo',
  'Supersedes',
  'DependsOn',
  'ConflictsWith',
  'SeeAlso',
]);
export const BeaconPolicyScope = z.enum(['System', 'Organization', 'Project']);
export const BeaconSavedQueryScope = z.enum(['Private', 'Project', 'Organization']);
export const BeaconGraphScope = z.enum(['project', 'organization']);

// ── Beacon (document) schemas ──────────────────────────────────────────
export const createBeaconSchema = z.object({
  title: z.string().min(1).max(512),
  summary: z.string().max(500).nullable().optional(),
  body_markdown: z.string().min(1).max(500_000),
  body_html: z.string().nullable().optional(),
  visibility: BeaconVisibility.optional(),
  project_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateBeaconSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  summary: z.string().max(500).nullable().optional(),
  body_markdown: z.string().min(1).max(500_000).optional(),
  body_html: z.string().nullable().optional(),
  visibility: BeaconVisibility.optional(),
  metadata: z.record(z.unknown()).optional(),
  change_note: z.string().max(500).optional(),
});

export const listBeaconsQuerySchema = z.object({
  project_ids: z.string().optional(), // comma-separated UUIDs
  project_id: z.string().uuid().optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  visibility_max: z.string().optional(),
  expires_after: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

// ── Link schemas ───────────────────────────────────────────────────────
export const createBeaconLinkSchema = z.object({
  target_id: z.string().uuid(),
  link_type: BeaconLinkType,
});

// ── Tag schemas ────────────────────────────────────────────────────────
export const addBeaconTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(128)).min(1).max(20),
});

// ── Policy schemas ─────────────────────────────────────────────────────
export const setBeaconPolicySchema = z.object({
  scope: BeaconPolicyScope,
  organization_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  min_expiry_days: z.number().int().min(1),
  max_expiry_days: z.number().int().min(1),
  default_expiry_days: z.number().int().min(1),
  grace_period_days: z.number().int().min(1),
});

export const resolveBeaconPolicyQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
});

// ── Search schemas ─────────────────────────────────────────────────────
export const searchBeaconsRequestSchema = z.object({
  query: z.string().max(1000),
  filters: z
    .object({
      organization_id: z.string().uuid().optional(),
      project_ids: z.array(z.string().uuid()).optional(),
      status: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      visibility_max: BeaconVisibility.optional(),
      expires_after: z.string().optional(),
    })
    .optional(),
  options: z
    .object({
      include_graph_expansion: z.boolean().optional(),
      include_tag_expansion: z.boolean().optional(),
      include_fulltext_fallback: z.boolean().optional(),
      rerank: z.boolean().optional(),
      top_k: z.number().int().min(0).max(100).optional(),
      group_by_beacon: z.boolean().optional(),
    })
    .optional(),
});

export const suggestBeaconsQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const saveBeaconQuerySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
  query_body: z.record(z.unknown()),
  scope: BeaconSavedQueryScope.optional(),
  project_id: z.string().uuid().nullable().optional(),
});

// ── Graph schemas ──────────────────────────────────────────────────────
export const beaconGraphNeighborsQuerySchema = z.object({
  beacon_id: z.string().uuid(),
  hops: z.coerce.number().int().min(1).max(3).default(1),
  include_implicit: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  tag_affinity_threshold: z.coerce.number().int().min(1).max(5).default(2),
  'filters.status': z
    .union([z.string(), z.array(z.string())])
    .default(['Active', 'PendingReview'])
    .transform((v) => (Array.isArray(v) ? v : [v])),
});

export const beaconGraphHubsQuerySchema = z.object({
  scope: BeaconGraphScope.default('project'),
  project_id: z.string().uuid().optional(),
  top_k: z.coerce.number().int().min(1).max(50).default(20),
});

export const beaconGraphRecentQuerySchema = z.object({
  scope: BeaconGraphScope.default('project'),
  project_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});
