// Shared Braid engine constants for the worker.

// The Braid System service-account user (seeded in migration 0230). Used as decided_by
// on auto-merges and actor_id on the review-band agent_proposals insert (spec 4.6).
// Mirrors apps/braid-api/src/services/types.ts::BRAID_SYSTEM_USER_ID.
export const BRAID_SYSTEM_USER_ID = '00000000-0000-0000-0000-0000000000b1';

// Default autonomy thresholds when an org has no braid_org_settings row (spec 2.2).
export const DEFAULT_AUTO_MERGE_THRESHOLD = 0.92;
export const DEFAULT_REVIEW_THRESHOLD = 0.6;
export const DEFAULT_REQUIRE_STRONG_SIGNAL = true;

// No-op band cooldown before a sub-review pair is rescored (spec 4.2 / D-r2-5).
export const NOOP_RESURFACE_COOLDOWN_DAYS = 30;

// Review-band proposal lifetime (spec 2.2 / D3-3): agent_proposals.expires_at = now()+7d.
export const PROPOSAL_EXPIRY_DAYS = 7;
