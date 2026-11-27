import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconEntries } from '../db/schema/index.js';
import { BeaconError } from './beacon.service.js';
import { resolveExpiryPolicy } from './policy.service.js';

/** A transaction handle from db.transaction. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Status type
// ---------------------------------------------------------------------------

export type BeaconStatus =
  | 'Draft'
  | 'Active'
  | 'PendingReview'
  | 'Expired'
  | 'Archived'
  | 'Retired';

// ---------------------------------------------------------------------------
// Transition map — §2.1.2
// ---------------------------------------------------------------------------

/**
 * Valid transitions per the lifecycle diagram.
 *
 *   Draft         → Active
 *   Active        → PendingReview, Retired
 *   PendingReview → Active, Archived, Retired
 *   Archived      → Active, Retired
 *   Retired       → (terminal — no outbound transitions)
 */
export const TRANSITIONS: Record<BeaconStatus, BeaconStatus[]> = {
  Draft: ['Active', 'Retired'],
  Active: ['PendingReview', 'Retired'],
  PendingReview: ['Active', 'Archived', 'Retired'],
  Archived: ['Active', 'Retired'],
  Expired: ['PendingReview', 'Retired'],
  Retired: [],
};

// ---------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------

/**
 * Throws HTTP 409 if the transition is not in the allowed map.
 */
export function assertTransition(from: BeaconStatus, to: BeaconStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new BeaconError(
      'INVALID_TRANSITION',
      `Cannot transition from '${from}' to '${to}'`,
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// transitionBeacon
// ---------------------------------------------------------------------------

export interface TransitionOpts {
  /** Override the expiry days instead of using resolved policy */
  expiryDays?: number;
  /** Reason for the transition (stored as metadata / audit context) */
  reason?: string;
}

/**
 * Validate and execute a lifecycle transition on a Beacon.
 *
 * Side-effects per transition:
 *   Draft → Active        : set expires_at from resolved policy
 *   Active → PendingReview: no expiry change (challenge or sweep trigger)
 *   PendingReview → Active: reset expires_at, increment verification_count
 *   PendingReview → Archived: no expiry change
 *   Archived → Active     : reset expires_at, set last_verified_at
 *   Any → Retired         : set retired_at
 */
export async function transitionBeacon(
  beaconId: string,
  targetStatus: BeaconStatus,
  userId: string,
  opts?: TransitionOpts,
  orgId?: string,
) {
  if (!orgId) {
    // Should not happen in properly updated callers; throw to surface the
    // missing orgId during development.
    throw new BeaconError('BAD_REQUEST', 'orgId is required for transitionBeacon', 400);
  }
  return db.transaction((tx) => transitionBeaconInTx(tx, beaconId, targetStatus, userId, orgId, opts));
}

/**
 * The transition itself, inside the caller's transaction (#304). The row is
 * read FOR UPDATE, so `from` is the status as of the lock and a concurrent
 * transition waits instead of both passing assertTransition on a stale read.
 * The UPDATE is still predicated on id, org and `status = from`, and
 * verification_count is bumped in SQL, so the write can never land on a row
 * whose state moved under it; if it would, 409 rather than a silent overwrite.
 */
export async function transitionBeaconInTx(
  tx: Tx,
  beaconId: string,
  targetStatus: BeaconStatus,
  userId: string,
  orgId: string,
  opts?: TransitionOpts,
) {
  const [existing] = await tx
    .select()
    .from(beaconEntries)
    .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
    .limit(1)
    .for('update');
  if (!existing) {
    throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);
  }

  const from = existing.status as BeaconStatus;
  assertTransition(from, targetStatus);

  const now = new Date();
  const updateValues: Record<string, unknown> = {
    status: targetStatus,
    updated_at: now,
  };

  // Side-effects by transition
  if (from === 'Draft' && targetStatus === 'Active') {
    const policy = await resolveExpiryPolicy(
      existing.project_id,
      existing.organization_id,
      tx,
    );
    const days = opts?.expiryDays ?? policy.default_days;
    updateValues.expires_at = new Date(now.getTime() + days * 86_400_000);
  }

  if (
    (from === 'PendingReview' && targetStatus === 'Active') ||
    (from === 'Archived' && targetStatus === 'Active')
  ) {
    const policy = await resolveExpiryPolicy(
      existing.project_id,
      existing.organization_id,
      tx,
    );
    const days = opts?.expiryDays ?? policy.default_days;
    updateValues.expires_at = new Date(now.getTime() + days * 86_400_000);
    updateValues.last_verified_at = now;
    updateValues.last_verified_by = userId;
    if (from === 'PendingReview') {
      updateValues.verification_count = sql`${beaconEntries.verification_count} + 1`;
    }
  }

  if (targetStatus === 'Retired') {
    updateValues.retired_at = now;
  }

  const [beacon] = await tx
    .update(beaconEntries)
    .set(updateValues)
    .where(
      and(
        eq(beaconEntries.id, beaconId),
        eq(beaconEntries.organization_id, orgId),
        eq(beaconEntries.status, from),
      ),
    )
    .returning();
  if (!beacon) {
    throw new BeaconError(
      'CONFLICT',
      'The beacon changed status while this transition was running; reload and try again',
      409,
    );
  }

  return beacon;
}
