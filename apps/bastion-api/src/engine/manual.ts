// The manual-assertion decision (spec 3.3), pure so its decision table is unit-tested:
//
//   pass        at least one ACTIVE linked item is current (valid_until in the future), covers the
//               window (what it describes ended no more than cadence_days before as_of), and is
//               ACCEPTED by a reviewer other than the uploader. Under three humans in the org a
//               self-review is allowed and labelled (small_team_self_review).
//   fail        any active linked item was reviewed `shows_exception`.
//   unprovable  manual_evidence_expired when accepted evidence exists but none is current;
//               manual_evidence_missing otherwise (nothing uploaded, pending review, pending scan,
//               blocked, or it no longer covers the window).

import { BASTION_DAY_MS } from '@bigbluebam/shared';

export interface ManualItemForDecision {
  id: string;
  kind: 'file' | 'attestation_statement';
  status: string;
  valid_until: Date | null;
  produced_on: string | null;
  period_end: string | null;
  uploaded_by: string;
  review_verdict: 'pending' | 'accepted' | 'shows_exception';
  reviewed_by: string | null;
  small_team_self_review: boolean;
}

export interface ManualDecision {
  outcome: 'pass' | 'fail' | 'unprovable';
  unprovable_reason: 'manual_evidence_expired' | 'manual_evidence_missing' | null;
  /** The active items considered (cited in the snapshot as manual_evidence_ids). */
  item_ids: string[];
  /** The items that made it pass. */
  passing_ids: string[];
  /** True when every passing item is a self-attested statement (the "Self-attested" label). */
  self_attested_only: boolean;
  /** True when a passing item was accepted by its own uploader under the small-team rule. */
  small_team_self_review: boolean;
  /** Earliest valid_until among the passing items (drives "expires in N days"). */
  expires_at: Date | null;
}

const DAY_MS = BASTION_DAY_MS;

/** A valid review: by someone other than the uploader, or a labelled small-team self-review. */
export function reviewCounts(item: Pick<ManualItemForDecision, 'uploaded_by' | 'reviewed_by' | 'small_team_self_review'>): boolean {
  if (!item.reviewed_by) return false;
  return item.reviewed_by !== item.uploaded_by || item.small_team_self_review;
}

/** Does the item describe a recent enough period? Uses period_end, else produced_on. */
export function coversWindow(item: Pick<ManualItemForDecision, 'period_end' | 'produced_on'>, asOf: Date, cadenceDays: number): boolean {
  const end = item.period_end ?? item.produced_on;
  if (!end) return true;
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  return endMs >= asOf.getTime() - cadenceDays * DAY_MS;
}

export function isCurrent(item: Pick<ManualItemForDecision, 'valid_until'>, asOf: Date): boolean {
  return item.valid_until === null || item.valid_until.getTime() > asOf.getTime();
}

export function decideManual(items: ManualItemForDecision[], asOf: Date, cadenceDays: number): ManualDecision {
  const active = items.filter((i) => i.status === 'active');
  const base = {
    item_ids: active.map((i) => i.id),
    passing_ids: [] as string[],
    self_attested_only: false,
    small_team_self_review: false,
    expires_at: null as Date | null,
  };
  if (active.some((i) => i.review_verdict === 'shows_exception')) {
    return { ...base, outcome: 'fail', unprovable_reason: null };
  }
  const accepted = active.filter((i) => i.review_verdict === 'accepted' && reviewCounts(i));
  const passing = accepted.filter((i) => isCurrent(i, asOf) && coversWindow(i, asOf, cadenceDays));
  if (passing.length > 0) {
    const expiries = passing.map((i) => i.valid_until).filter((d): d is Date => d !== null);
    return {
      ...base,
      outcome: 'pass',
      unprovable_reason: null,
      passing_ids: passing.map((i) => i.id),
      self_attested_only: passing.every((i) => i.kind === 'attestation_statement'),
      small_team_self_review: passing.some((i) => i.reviewed_by === i.uploaded_by),
      // The latest expiry among passing items: the control stays proven until the last one lapses.
      expires_at: expiries.length === passing.length && expiries.length > 0 ? new Date(Math.max(...expiries.map((d) => d.getTime()))) : null,
    };
  }
  if (accepted.some((i) => !isCurrent(i, asOf))) {
    return { ...base, outcome: 'unprovable', unprovable_reason: 'manual_evidence_expired' };
  }
  return { ...base, outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing' };
}

/**
 * Whole days left before `until` (an end-of-day instant): 0 on the last day, negative once past.
 * Evidence valid through the end of the day 12 calendar days from now reads "expires in 12 days".
 */
export function daysLeft(until: Date, now: Date): number {
  return Math.floor((until.getTime() - now.getTime()) / DAY_MS);
}
