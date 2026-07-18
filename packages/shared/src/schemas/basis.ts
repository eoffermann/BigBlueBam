import { z } from 'zod';

// Basis (governed metric layer) schemas.
//
// This module OWNS the Basis metric-definition shape. It is deliberately not the
// Bench widget schema (benchQueryConfigSchema), which cannot express the additive
// decomposition Basis needs (no per-measure aggregation). The definition is
// convertible to Bench's executor QueryConfig; the authoritative anti-drift guard
// is round-trip preview validation against bench-api (spec sections 1, 3.1).

/* ------------------------------------------------------------------ */
/*  Metric definition                                                 */
/* ------------------------------------------------------------------ */

export const BasisMeasureAgg = z.enum(['sum', 'count', 'avg', 'min', 'max']);
export const BasisUnit = z.enum(['currency', 'count', 'percent', 'ratio', 'duration_ms']);
export const BasisFavorableDirection = z.enum(['up', 'down', 'neutral']);
export const BasisCertification = z.enum(['draft', 'certified', 'deprecated']);
export const BasisResolveStatus = z.enum(['ok', 'resolve_failed']);

// A single filter clause over a source field. Kept intentionally permissive at
// the schema layer (values are opaque); bench-api validates fields/ops against
// the data-source registry at preview time.
export const basisFilterSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.string().min(1).max(20),
  value: z.unknown(),
});

// The Basis definition. `default_dimensions` are candidate decomposition
// dimensions (spec 2.2 effective-dimension precedence uses [0] as the metric tier).
export const basisDefinitionSchema = z.object({
  source_product: z.string().min(1).max(40), // e.g. 'bill', 'bond', 'bam'
  source_entity: z.string().min(1).max(80), // data-source registry entity id
  measure: z.object({
    field: z.string().min(1).max(80),
    agg: BasisMeasureAgg,
  }),
  filters: z.array(basisFilterSchema).max(50).optional(),
  default_dimensions: z.array(z.string().min(1).max(80)).max(20).default([]),
  time_column: z.string().min(1).max(80),
});

// Descriptive lineage. NOT executed (spec 2.2 / 3.1); `joins` is metadata only.
export const basisLineageSchema = z.object({
  apps: z.array(z.string().min(1).max(40)).default([]),
  base_table: z.string().max(120).optional(),
  joins: z.array(z.string().max(200)).optional(),
});

/* ------------------------------------------------------------------ */
/*  Metric CRUD                                                        */
/* ------------------------------------------------------------------ */

export const basisTargetSchema = z.object({
  value: z.number(),
  comparison: z.enum(['gte', 'lte', 'gt', 'lt']),
});

export const createBasisMetricSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/, 'slug must be snake_case starting with a letter'),
  name: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  unit: BasisUnit,
  favorable_direction: BasisFavorableDirection.default('up'),
  owner_id: z.string().uuid().optional(),
  related_apps: z.array(z.string().min(1).max(40)).max(30).optional(),
  target: basisTargetSchema.optional(),
  definition: basisDefinitionSchema,
  lineage: basisLineageSchema.optional(),
  change_note: z.string().max(2000).optional(),
});

// Metadata-only patch (never the definition; that is a new version).
export const updateBasisMetricSchema = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(4000),
    unit: BasisUnit,
    favorable_direction: BasisFavorableDirection,
    owner_id: z.string().uuid().nullable(),
    related_apps: z.array(z.string().min(1).max(40)).max(30),
    target: basisTargetSchema.nullable(),
  })
  .partial();

export const createBasisVersionSchema = z.object({
  definition: basisDefinitionSchema,
  lineage: basisLineageSchema.optional(),
  change_note: z.string().max(2000).optional(),
});

/* ------------------------------------------------------------------ */
/*  Explain / value                                                   */
/* ------------------------------------------------------------------ */

export const basisPeriodSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// POST /explain body. `dimension` is optional; the server resolves the
// effective dimension (request > default_dimensions[0] > org settings) BEFORE
// hashing the cache key (spec 2.2).
export const basisExplainRequestSchema = z.object({
  period_a: basisPeriodSchema,
  period_b: basisPeriodSchema,
  dimension: z.string().min(1).max(80).optional(),
  asker_user_id: z.string().uuid().optional(),
});

// A single driver row. Class A carries a label; Class B is opaque until
// per-user read-time resolution, and denied rows collapse into "Other".
export const basisDriverSchema = z.object({
  dimension_value: z.string(),
  label: z.string().nullable().optional(),
  contribution_abs: z.number(),
  contribution_pct: z.number(),
  is_other: z.boolean().optional(), // the aggregated "Other (N hidden)" bucket
  hidden_count: z.number().int().nonnegative().optional(),
});

// A possibly-related-activity item (spec 2.1/2.3): a per-viewer, access-scoped
// cross-app event that may correlate with a metric move. Ranked below drivers and
// never a causal claim.
export const basisCorrelationItemSchema = z.object({
  source_app: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  action: z.string(),
  actor_id: z.string().nullable(),
  created_at: z.string(),
});

export const basisExplanationSchema = z.object({
  metric_id: z.string().uuid(),
  version_id: z.string().uuid(),
  cache_key: z.string(),
  dimension: z.string().nullable(),
  dimension_class: z.enum(['A', 'B']).nullable(),
  delta_abs: z.number().nullable(),
  delta_pct: z.number().nullable(),
  drivers: z.array(basisDriverSchema),
  narrative: z.string().nullable(),
  correlation: z.array(basisCorrelationItemSchema).default([]),
  computed_at: z.string().datetime().optional(),
});

/* ------------------------------------------------------------------ */
/*  Persisted response shapes (single source of truth for the SPA)    */
/* ------------------------------------------------------------------ */

// A persisted metric row as basis-api serializes it (JSON: timestamps are ISO
// strings, jsonb columns are typed). This is THE shape the SPA imports instead
// of re-declaring its own interface (spec section 4).
export const basisMetricSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  unit: BasisUnit,
  favorable_direction: BasisFavorableDirection,
  owner_id: z.string().uuid().nullable(),
  certification: BasisCertification,
  current_version_id: z.string().uuid().nullable(),
  related_apps: z.array(z.string()),
  target: basisTargetSchema.nullable(),
  resolve_status: BasisResolveStatus,
  resolve_failed_at: z.string().nullable(),
  last_breach_at: z.string().nullable(),
  last_breach_direction: z.string().nullable(),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// A persisted immutable definition version row.
export const basisMetricVersionSchema = z.object({
  id: z.string().uuid(),
  metric_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  version_number: z.number().int(),
  definition: basisDefinitionSchema,
  lineage: basisLineageSchema,
  change_note: z.string().nullable(),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
});

// GET /metrics/:id and the create/version write paths return this envelope.
export const basisMetricWithVersionSchema = z.object({
  metric: basisMetricSchema,
  currentVersion: basisMetricVersionSchema.nullable(),
});

// GET /metrics/:id/value response.
export const basisValueSchema = z.object({
  value: z.number().nullable(),
  unit: BasisUnit,
});

/* ------------------------------------------------------------------ */
/*  Org settings                                                      */
/* ------------------------------------------------------------------ */

// GET /settings response (resolved effective settings; never null - the service
// returns defaults for an org with no row).
export const basisOrgSettingsSchema = z.object({
  snapshot_max_age_days: z.number().int().nullable(),
  explanation_cache_ttl_seconds: z.number().int(),
  default_dimension: z.string().nullable(),
});


export const updateBasisOrgSettingsSchema = z
  .object({
    snapshot_max_age_days: z.number().int().min(1).max(3650).nullable(), // null = unbounded
    explanation_cache_ttl_seconds: z.number().int().min(60).max(2_592_000),
    default_dimension: z.string().min(1).max(80).nullable(),
  })
  .partial();

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type BasisDefinition = z.infer<typeof basisDefinitionSchema>;
export type BasisLineage = z.infer<typeof basisLineageSchema>;
export type CreateBasisMetricInput = z.infer<typeof createBasisMetricSchema>;
export type UpdateBasisMetricInput = z.infer<typeof updateBasisMetricSchema>;
export type CreateBasisVersionInput = z.infer<typeof createBasisVersionSchema>;
export type BasisExplainRequest = z.infer<typeof basisExplainRequestSchema>;
export type BasisDriver = z.infer<typeof basisDriverSchema>;
export type BasisExplanation = z.infer<typeof basisExplanationSchema>;
export type BasisCorrelationItem = z.infer<typeof basisCorrelationItemSchema>;
export type UpdateBasisOrgSettingsInput = z.infer<typeof updateBasisOrgSettingsSchema>;
export type BasisMetric = z.infer<typeof basisMetricSchema>;
export type BasisMetricVersion = z.infer<typeof basisMetricVersionSchema>;
export type BasisMetricWithVersion = z.infer<typeof basisMetricWithVersionSchema>;
export type BasisValue = z.infer<typeof basisValueSchema>;
export type BasisOrgSettings = z.infer<typeof basisOrgSettingsSchema>;
