import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  beaconEntries,
  beaconVerifications,
  beaconAgents,
} from '../db/schema/index.js';
import type { BeaconAgentConfig } from '../db/schema/index.js';
import { BeaconError, getBeaconById } from './beacon.service.js';
import { transitionBeaconInTx } from './lifecycle.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationType = 'Manual' | 'AgentAutomatic' | 'AgentAssisted' | 'ScheduledReview';
export type VerificationOutcome = 'Confirmed' | 'Updated' | 'Challenged' | 'Retired';

export interface VerifyInput {
  type: VerificationType;
  outcome: VerificationOutcome;
  confidence?: number | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// verifyBeacon
// ---------------------------------------------------------------------------

/**
 * Record a verification event on a Beacon.
 *
 * - Inserts a row in beacon_verifications.
 * - Updates beacon_entries: last_verified_at, last_verified_by, verification_count.
 * - If outcome is Confirmed and beacon is PendingReview → transition to Active.
 * - If outcome is Challenged and beacon is Active → transition to PendingReview.
 */
export async function verifyBeacon(
  beaconId: string,
  userId: string,
  data: VerifyInput,
  orgId: string,
) {
  // One transaction on the locked row (#304): the verification row, the
  // counter bump and any status side effect commit together, the counter is
  // incremented in SQL (two concurrent verifies used to record one), and the
  // status side effect is decided on the status as of the lock, so a second
  // concurrent verify sees the first one's transition instead of racing it.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(beaconEntries)
      .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
      .limit(1)
      .for('update');
    if (!existing) {
      throw new BeaconError('NOT_FOUND', 'Beacon not found', 404);
    }

    const [verification] = await tx
      .insert(beaconVerifications)
      .values({
        beacon_id: beaconId,
        verified_by: userId,
        verification_type: data.type,
        outcome: data.outcome,
        confidence_score: data.confidence ?? null,
        notes: data.notes ?? null,
      })
      .returning();

    const now = new Date();
    const [updated] = await tx
      .update(beaconEntries)
      .set({
        last_verified_at: now,
        last_verified_by: userId,
        verification_count: sql`${beaconEntries.verification_count} + 1`,
        updated_at: now,
      })
      .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
      .returning();

    let beacon = updated ?? existing;
    if (data.outcome === 'Confirmed' && existing.status === 'PendingReview') {
      beacon = await transitionBeaconInTx(tx, beaconId, 'Active', userId, orgId);
    } else if (data.outcome === 'Challenged' && existing.status === 'Active') {
      beacon = await transitionBeaconInTx(tx, beaconId, 'PendingReview', userId, orgId);
    }

    return { verification: verification!, beacon };
  });
}

// ---------------------------------------------------------------------------
// processAgentVerification — §4.2 / §4.3
// ---------------------------------------------------------------------------

/**
 * Agent verification pipeline: route based on confidence thresholds.
 *
 *   confidence >= auto_confirm_threshold → AgentAutomatic, Confirmed
 *   confidence >= assisted_threshold     → AgentAssisted, Challenged (human review)
 *   below                                → escalate to human (no auto-action)
 */
export async function processAgentVerification(
  beaconId: string,
  agentUserId: string,
  confidence: number,
  orgId: string,
) {
  // Look up agent config
  const [agent] = await db
    .select()
    .from(beaconAgents)
    .where(eq(beaconAgents.user_id, agentUserId))
    .limit(1);

  if (!agent) {
    throw new BeaconError('NOT_FOUND', 'Agent not found', 404);
  }

  if (!agent.is_active) {
    throw new BeaconError('FORBIDDEN', 'Agent is deactivated', 403);
  }

  const config: BeaconAgentConfig = agent.agent_config ?? {};
  const autoThreshold = config.auto_confirm_threshold ?? 0.85;
  const assistedThreshold = config.assisted_threshold ?? 0.50;

  if (confidence >= autoThreshold) {
    // Auto-confirm
    return verifyBeacon(beaconId, agentUserId, {
      type: 'AgentAutomatic',
      outcome: 'Confirmed',
      confidence,
      notes: `Agent auto-confirmed with confidence ${confidence.toFixed(2)}`,
    }, orgId);
  }

  if (confidence >= assistedThreshold) {
    // Agent-assisted — flag for human review
    return verifyBeacon(beaconId, agentUserId, {
      type: 'AgentAssisted',
      outcome: 'Challenged',
      confidence,
      notes: `Agent flagged for human review with confidence ${confidence.toFixed(2)}`,
    }, orgId);
  }

  // Below assisted threshold — escalate without making a verification record
  // that would trigger a transition. Instead record an informational entry.
  const [verification] = await db
    .insert(beaconVerifications)
    .values({
      beacon_id: beaconId,
      verified_by: agentUserId,
      verification_type: 'AgentAssisted',
      outcome: 'Challenged',
      confidence_score: confidence,
      notes: `Agent confidence (${confidence.toFixed(2)}) below assisted threshold; escalated to human`,
    })
    .returning();

  const beacon = await getBeaconById(beaconId, orgId);

  return { verification: verification!, beacon, escalated: true };
}
