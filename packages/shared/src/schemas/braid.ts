import { z } from 'zod';

// Braid (identity-resolution / golden-record CDP) schemas.
//
// This module OWNS the Braid golden-profile, identity, candidate, decision, rule, and
// settings shapes shared between braid-api, the /braid SPA, and the braid_* MCP tools.
// See docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md sections 3, 5.

/* ------------------------------------------------------------------ */
/*  Enums                                                             */
/* ------------------------------------------------------------------ */

export const BraidProfileKind = z.enum(['person', 'company']);
export const BraidProfileStatus = z.enum(['active', 'merged_away', 'archived']);
export const BraidLinkKind = z.enum(['auto', 'human', 'seed']);
export const BraidCandidateStatus = z.enum(['pending', 'merged', 'rejected', 'superseded']);
export const BraidDecisionKind = z.enum(['auto', 'merge', 'split', 'reject']);
export const BraidSurvivorshipStrategy = z.enum([
  'most_recent',
  'source_priority',
  'longest_non_null',
  'most_frequent',
  'manual_pin',
]);

// The real, backing-row source identity types (spec 1). Blast is NOT a source type.
export const BraidSourceType = z.enum([
  'bond.contact',
  'bond.company',
  'bill.client',
  'helpdesk.user',
  'book.event_attendee',
]);
export type BraidSourceType = z.infer<typeof BraidSourceType>;

/* ------------------------------------------------------------------ */
/*  Evidence (JSONB, authoritative shapes - spec 3.3)                  */
/* ------------------------------------------------------------------ */

export const braidFeatureKind = z.enum([
  'email_exact',
  'phone_exact',
  'name_trigram',
  'embedding_cosine',
  'domain_match',
  'platform_user',
]);

export const braidDirectEvidenceSchema = z.object({
  shape: z.literal('direct'),
  features: z
    .array(
      z.object({
        kind: braidFeatureKind,
        score: z.number(),
        weight: z.number(),
        a_value_ref: z.string().optional(),
        b_value_ref: z.string().optional(),
      }),
    )
    .default([]),
  strong_signal: z.boolean(),
  weights: z.record(z.number()),
  model: z.string(),
});

export const braidBridgedEvidenceSchema = z.object({
  shape: z.literal('bridged'),
  bridge_identity_id: z.string().uuid(),
  links: z
    .array(
      z.object({
        profile: z.enum(['A', 'B']),
        bridge_identity_a_id: z.string().uuid().optional(),
        bridge_identity_b_id: z.string().uuid().optional(),
        kind: braidFeatureKind,
        score: z.number(),
        strong: z.boolean(),
      }),
    )
    .default([]),
  score: z.number(),
  strong_signal: z.boolean(),
  weights: z.record(z.number()),
  model: z.string(),
});

export const braidEvidenceSchema = z.discriminatedUnion('shape', [
  braidDirectEvidenceSchema,
  braidBridgedEvidenceSchema,
]);
export type BraidEvidence = z.infer<typeof braidEvidenceSchema>;

// Per-field provenance in braid_profiles.attributes (internal cache; re-assembled per viewer).
export const braidAttributeProvenanceSchema = z.object({
  value: z.unknown(),
  source_identity_id: z.string().uuid().optional(),
  source_app: z.string().optional(),
  rule: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/*  Profile (read shapes; scalars re-assembled per viewer)            */
/* ------------------------------------------------------------------ */

export const braidProfileSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  kind: BraidProfileKind,
  display_name: z.string().nullable(),
  primary_email: z.string().nullable(),
  primary_phone: z.string().nullable(),
  // email_suppressed is admin-only on read; nullable when withheld.
  email_suppressed: z.boolean().nullable(),
  company_profile_id: z.string().uuid().nullable(),
  attributes: z.record(braidAttributeProvenanceSchema).default({}),
  identity_count: z.number().int(),
  confidence: z.number().nullable(),
  status: BraidProfileStatus,
  merged_into_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BraidProfile = z.infer<typeof braidProfileSchema>;

export const braidIdentitySchema = z.object({
  id: z.string().uuid(),
  profile_id: z.string().uuid(),
  source_type: BraidSourceType,
  source_id: z.string().uuid(),
  match_keys: z.record(z.unknown()).default({}),
  link_confidence: z.number().nullable(),
  link_kind: BraidLinkKind,
  linked_at: z.string(),
});
export type BraidIdentity = z.infer<typeof braidIdentitySchema>;

/* ------------------------------------------------------------------ */
/*  Resolve (the flagship)                                             */
/* ------------------------------------------------------------------ */

export const braidResolveInputSchema = z.object({
  source_type: BraidSourceType,
  source_id: z.string().uuid(),
  // The human the agent acts for; required for input-record preflight (spec 5.1).
  asker_user_id: z.string().uuid().optional(),
});
export type BraidResolveInput = z.infer<typeof braidResolveInputSchema>;

export const braidResolveResultSchema = z.object({
  profile_id: z.string().uuid(),
  kind: BraidProfileKind,
  // Suppressed (null) for non-admin askers (spec 2.5 point 1).
  identity_count: z.number().int().nullable(),
  created: z.boolean(), // true if a singleton seed was minted on this call
});
export type BraidResolveResult = z.infer<typeof braidResolveResultSchema>;

/* ------------------------------------------------------------------ */
/*  Candidate (review queue)                                          */
/* ------------------------------------------------------------------ */

export const braidCandidateSchema = z.object({
  id: z.string().uuid(),
  profile_a_id: z.string().uuid(),
  profile_b_id: z.string().uuid(),
  score: z.number(),
  evidence: braidEvidenceSchema,
  rationale: z.string().nullable(),
  status: BraidCandidateStatus,
  proposal_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type BraidCandidate = z.infer<typeof braidCandidateSchema>;

export const braidProposeMergeSchema = z.object({
  profile_a_id: z.string().uuid(),
  profile_b_id: z.string().uuid(),
  reason: z.string().max(2000).optional(),
  asker_user_id: z.string().uuid().optional(),
});

export const braidRejectCandidateSchema = z.object({
  reason: z.string().max(2000).optional(),
});

/* ------------------------------------------------------------------ */
/*  Merge / split (truth-flips)                                        */
/* ------------------------------------------------------------------ */

export const braidMergeProfilesSchema = z.object({
  profile_a_id: z.string().uuid(),
  profile_b_id: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

export const braidSplitProfileSchema = z
  .object({
    merge_decision_id: z.string().uuid().optional(),
    identity_ids: z.array(z.string().uuid()).min(1).optional(),
    reason: z.string().max(2000).optional(),
  })
  .refine((v) => !!v.merge_decision_id !== (!!v.identity_ids && v.identity_ids.length > 0), {
    message: 'Provide exactly one of merge_decision_id (unmerge) or identity_ids (fresh split)',
  });

/* ------------------------------------------------------------------ */
/*  Survivorship rules                                                */
/* ------------------------------------------------------------------ */

export const braidSurvivorshipRuleSchema = z.object({
  kind: BraidProfileKind,
  field: z.string().min(1).max(64),
  strategy: BraidSurvivorshipStrategy,
  source_priority: z.array(BraidSourceType).max(10).default([]),
  pinned_value: z.unknown().optional(),
});
export type BraidSurvivorshipRule = z.infer<typeof braidSurvivorshipRuleSchema>;

export const braidSetSurvivorshipRuleSchema = z.object({
  strategy: BraidSurvivorshipStrategy,
  source_priority: z.array(BraidSourceType).max(10).default([]),
  pinned_value: z.unknown().optional(),
});

/* ------------------------------------------------------------------ */
/*  Org settings                                                       */
/* ------------------------------------------------------------------ */

export const braidSettingsSchema = z.object({
  auto_merge_threshold: z.number().min(0).max(1),
  review_threshold: z.number().min(0).max(1),
  require_strong_signal_for_auto: z.boolean(),
  enabled_source_types: z.array(BraidSourceType).default([]),
  rescan_max_age_days: z.number().int().positive().nullable(),
  last_rescan_at: z.string().nullable(),
});
export type BraidSettings = z.infer<typeof braidSettingsSchema>;

export const braidUpdateSettingsSchema = z
  .object({
    auto_merge_threshold: z.number().min(0).max(1).optional(),
    review_threshold: z.number().min(0).max(1).optional(),
    require_strong_signal_for_auto: z.boolean().optional(),
    enabled_source_types: z.array(BraidSourceType).optional(),
    rescan_max_age_days: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

/* ------------------------------------------------------------------ */
/*  Pagination / list envelopes                                       */
/* ------------------------------------------------------------------ */

export const braidListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
});
