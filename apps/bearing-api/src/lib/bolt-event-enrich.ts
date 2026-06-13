import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  organizations,
  users,
  bearingGoals,
  bearingKeyResults,
  bearingPeriods,
} from '../db/schema/index.js';
import { env } from '../env.js';

/**
 * Bolt event enrichment helpers for Bearing.
 *
 * These helpers expand raw goal/key-result IDs into the "deep" payload shape
 * expected by Bolt rules and templates — canonical names, owner/actor info,
 * org context, progress metadata, and deep-link URLs.
 *
 * All helpers are best-effort: if a lookup fails, the returned object just
 * omits the field rather than throwing — callers use these inside the
 * fire-and-forget `publishBoltEvent` path which must never break the source
 * operation.
 */

function frontendBase(): string {
  return env.PUBLIC_URL.replace(/\/$/, '');
}

export function buildGoalUrl(goalId: string): string {
  return `${frontendBase()}/bearing/goals/${goalId}`;
}

export function buildKeyResultUrl(goalId: string, keyResultId: string): string {
  return `${frontendBase()}/bearing/goals/${goalId}?kr=${keyResultId}`;
}

export interface EnrichedActor {
  id: string;
  name: string | null;
  email: string | null;
}

export interface EnrichedOrg {
  id: string;
  name: string | null;
  slug: string | null;
}

export interface EnrichedOwner {
  id: string;
  name: string | null;
  email: string | null;
}

export interface EnrichedPeriod {
  id: string;
  name: string | null;
}

/**
 * Fetch actor user record. Returns a stub with just { id } if the lookup fails.
 */
export async function loadActor(userId: string): Promise<EnrichedActor> {
  try {
    const [row] = await db
      .select({
        id: users.id,
        display_name: users.display_name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { id: userId, name: null, email: null };
    return { id: row.id, name: row.display_name, email: row.email };
  } catch {
    return { id: userId, name: null, email: null };
  }
}

export async function loadOrg(orgId: string): Promise<EnrichedOrg> {
  try {
    const [row] = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!row) return { id: orgId, name: null, slug: null };
    return { id: row.id, name: row.name, slug: row.slug };
  } catch {
    return { id: orgId, name: null, slug: null };
  }
}

export async function loadOwner(ownerId: string | null): Promise<EnrichedOwner | null> {
  if (!ownerId) return null;
  try {
    const [row] = await db
      .select({
        id: users.id,
        display_name: users.display_name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (!row) return { id: ownerId, name: null, email: null };
    return { id: row.id, name: row.display_name, email: row.email };
  } catch {
    return { id: ownerId, name: null, email: null };
  }
}

export async function loadPeriod(periodId: string): Promise<EnrichedPeriod> {
  try {
    const [row] = await db
      .select({ id: bearingPeriods.id, name: bearingPeriods.name })
      .from(bearingPeriods)
      .where(eq(bearingPeriods.id, periodId))
      .limit(1);
    if (!row) return { id: periodId, name: null };
    return { id: row.id, name: row.name };
  } catch {
    return { id: periodId, name: null };
  }
}

/**
 * Fetch the parent goal row for a key result — used when the caller only
 * has the KR in hand but needs the goal_id, title, org, owner, etc.
 */
export async function loadGoalById(goalId: string) {
  try {
    const [row] = await db
      .select()
      .from(bearingGoals)
      .where(eq(bearingGoals.id, goalId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a key result row by id. Used to capture previous values before an
 * update so producers can emit `previous_progress` and `delta` fields.
 */
export async function loadKeyResultById(keyResultId: string) {
  try {
    const [row] = await db
      .select()
      .from(bearingKeyResults)
      .where(eq(bearingKeyResults.id, keyResultId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}
