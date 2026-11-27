import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconExpiryPolicies } from '../db/schema/index.js';
import { BeaconError } from './beacon.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffectivePolicy {
  min_days: number;
  max_days: number;
  default_days: number;
  grace_days: number;
}

export type PolicyScope = 'System' | 'Organization' | 'Project';

export interface PolicyInput {
  min_expiry_days: number;
  max_expiry_days: number;
  default_expiry_days: number;
  grace_period_days: number;
}

export interface PolicyValidationWarning {
  level: 'warn';
  message: string;
}

// Hard-coded fallback when no System policy exists
const FALLBACK_POLICY: EffectivePolicy = {
  min_days: 7,
  max_days: 365,
  default_days: 90,
  grace_days: 14,
};

// ---------------------------------------------------------------------------
// resolveExpiryPolicy — §3.2
// ---------------------------------------------------------------------------

/**
 * Walk the hierarchy System → Org → Project, narrowing the effective range
 * at each level.  Returns the fully resolved policy.
 */
export async function resolveExpiryPolicy(
  projectId: string | null,
  orgId: string,
  // A transaction caller passes its handle so the reads share its connection
  // instead of taking a second pool connection while holding a row lock.
  executor: Pick<typeof db, 'select'> = db,
): Promise<EffectivePolicy> {
  // --- System ---
  const [sysRow] = await executor
    .select()
    .from(beaconExpiryPolicies)
    .where(eq(beaconExpiryPolicies.scope, 'System'))
    .limit(1);

  const effective: EffectivePolicy = sysRow
    ? {
        min_days: sysRow.min_expiry_days,
        max_days: sysRow.max_expiry_days,
        default_days: sysRow.default_expiry_days,
        grace_days: sysRow.grace_period_days,
      }
    : { ...FALLBACK_POLICY };

  // --- Organization ---
  const [orgRow] = await executor
    .select()
    .from(beaconExpiryPolicies)
    .where(
      and(
        eq(beaconExpiryPolicies.scope, 'Organization'),
        eq(beaconExpiryPolicies.organization_id, orgId),
      ),
    )
    .limit(1);

  if (orgRow) {
    effective.min_days = Math.max(effective.min_days, orgRow.min_expiry_days);
    effective.max_days = Math.min(effective.max_days, orgRow.max_expiry_days);
    effective.default_days = clamp(
      orgRow.default_expiry_days,
      effective.min_days,
      effective.max_days,
    );
    effective.grace_days = orgRow.grace_period_days;
  }

  // --- Project ---
  if (projectId) {
    const [projRow] = await executor
      .select()
      .from(beaconExpiryPolicies)
      .where(
        and(
          eq(beaconExpiryPolicies.scope, 'Project'),
          eq(beaconExpiryPolicies.project_id, projectId),
        ),
      )
      .limit(1);

    if (projRow) {
      effective.min_days = Math.max(effective.min_days, projRow.min_expiry_days);
      effective.max_days = Math.min(effective.max_days, projRow.max_expiry_days);
      effective.default_days = clamp(
        projRow.default_expiry_days,
        effective.min_days,
        effective.max_days,
      );
      effective.grace_days = projRow.grace_period_days;
    }
  }

  // Sanity check
  if (effective.min_days > effective.max_days) {
    throw new BeaconError(
      'POLICY_CONFLICT',
      `Policy conflict: child min (${effective.min_days}) exceeds parent max (${effective.max_days})`,
      409,
    );
  }

  return effective;
}

// ---------------------------------------------------------------------------
// validatePolicySave — §3.3
// ---------------------------------------------------------------------------

/**
 * Validate that a new policy at the given scope respects its parent bounds.
 * Returns warnings about child policies that may need clamping.
 */
export async function validatePolicySave(
  newPolicy: PolicyInput,
  scope: PolicyScope,
  orgId?: string,
  _projectId?: string,
): Promise<PolicyValidationWarning[]> {
  const warnings: PolicyValidationWarning[] = [];

  // Internal consistency
  if (newPolicy.min_expiry_days > newPolicy.default_expiry_days) {
    throw new BeaconError(
      'VALIDATION_ERROR',
      'min_expiry_days must be <= default_expiry_days',
      400,
    );
  }
  if (newPolicy.default_expiry_days > newPolicy.max_expiry_days) {
    throw new BeaconError(
      'VALIDATION_ERROR',
      'default_expiry_days must be <= max_expiry_days',
      400,
    );
  }
  if (newPolicy.min_expiry_days < 1) {
    throw new BeaconError(
      'VALIDATION_ERROR',
      'min_expiry_days must be > 0',
      400,
    );
  }

  // Load parent policy to validate against
  let parent: EffectivePolicy | null = null;

  if (scope === 'Organization') {
    // Parent is System
    const [sysRow] = await db
      .select()
      .from(beaconExpiryPolicies)
      .where(eq(beaconExpiryPolicies.scope, 'System'))
      .limit(1);
    if (sysRow) {
      parent = {
        min_days: sysRow.min_expiry_days,
        max_days: sysRow.max_expiry_days,
        default_days: sysRow.default_expiry_days,
        grace_days: sysRow.grace_period_days,
      };
    }
  } else if (scope === 'Project' && orgId) {
    // Parent is Org (or System if no org policy)
    parent = await resolveExpiryPolicy(null, orgId);
  }

  if (parent) {
    if (newPolicy.min_expiry_days < parent.min_days) {
      throw new BeaconError(
        'VALIDATION_ERROR',
        `Minimum (${newPolicy.min_expiry_days}) is below parent minimum (${parent.min_days})`,
        400,
      );
    }
    if (newPolicy.max_expiry_days > parent.max_days) {
      throw new BeaconError(
        'VALIDATION_ERROR',
        `Maximum (${newPolicy.max_expiry_days}) exceeds parent maximum (${parent.max_days})`,
        400,
      );
    }
  }

  // Check child policies for clamping warnings
  if (scope === 'System') {
    const children = await db
      .select()
      .from(beaconExpiryPolicies)
      .where(eq(beaconExpiryPolicies.scope, 'Organization'));
    for (const child of children) {
      if (
        child.min_expiry_days < newPolicy.min_expiry_days ||
        child.max_expiry_days > newPolicy.max_expiry_days
      ) {
        warnings.push({
          level: 'warn',
          message: `Org policy (org ${child.organization_id}) is out of range and will be auto-clamped`,
        });
      }
    }
  } else if (scope === 'Organization' && orgId) {
    const children = await db
      .select()
      .from(beaconExpiryPolicies)
      .where(eq(beaconExpiryPolicies.scope, 'Project'));
    for (const child of children) {
      if (
        child.min_expiry_days < newPolicy.min_expiry_days ||
        child.max_expiry_days > newPolicy.max_expiry_days
      ) {
        warnings.push({
          level: 'warn',
          message: `Project policy (project ${child.project_id}) is out of range and will be auto-clamped`,
        });
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// getPolicy
// ---------------------------------------------------------------------------

export async function getPolicy(
  scope: PolicyScope,
  orgId?: string,
  projectId?: string,
) {
  const conditions = [eq(beaconExpiryPolicies.scope, scope)];

  if (scope === 'Organization' && orgId) {
    conditions.push(eq(beaconExpiryPolicies.organization_id, orgId));
  }
  if (scope === 'Project' && projectId) {
    conditions.push(eq(beaconExpiryPolicies.project_id, projectId));
  }

  const [row] = await db
    .select()
    .from(beaconExpiryPolicies)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// setPolicy
// ---------------------------------------------------------------------------

export async function setPolicy(
  scope: PolicyScope,
  orgId: string | undefined,
  projectId: string | undefined,
  data: PolicyInput,
  userId: string,
) {
  const warnings = await validatePolicySave(data, scope, orgId, projectId);

  const existing = await getPolicy(scope, orgId, projectId);

  let row;
  if (existing) {
    [row] = await db
      .update(beaconExpiryPolicies)
      .set({
        min_expiry_days: data.min_expiry_days,
        max_expiry_days: data.max_expiry_days,
        default_expiry_days: data.default_expiry_days,
        grace_period_days: data.grace_period_days,
        set_by: userId,
        updated_at: new Date(),
      })
      .where(eq(beaconExpiryPolicies.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(beaconExpiryPolicies)
      .values({
        scope,
        organization_id: orgId ?? null,
        project_id: projectId ?? null,
        min_expiry_days: data.min_expiry_days,
        max_expiry_days: data.max_expiry_days,
        default_expiry_days: data.default_expiry_days,
        grace_period_days: data.grace_period_days,
        set_by: userId,
      })
      .returning();
  }

  return { policy: row!, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
