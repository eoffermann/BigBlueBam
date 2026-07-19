// The envelope oracle defense. Spec 2.4 point 3 (round-2 R2-S2 + round-3 R3-S3).
//
// ── WHY QUANTIZING THE OUTPUT IS NOT ENOUGH ───────────────────────────────────────────
//
// The caller supplies `proposed_amount`, and the verdict flips exactly at
//
//     proposed_amount > envelope_remaining
//
// so the VERDICT ITSELF is a one-bit comparator the caller fully controls. Binary search
// over proposed_amount recovers `envelope_remaining` to the cent in roughly 24 probes NO
// MATTER how coarsely the returned overage is bucketed. On a freshly confirmed deliverable
// consumption is zero, so `remaining == envelope_amount`; summing across a chain's
// deliverables then recovers `contract_value` exactly. Round 1's justification ("discloses
// nothing the caller could not compute") was false, and an implementer meeting a "no
// absolute recovery" test honestly would have had to weaken the test instead of the
// response. That is why this file exists and why the test asserts recovery is "not finer
// than overage_bucket_amount" rather than "not within 5 percent".
//
// ── THE FIX: QUANTIZE THE DECISION INPUT ──────────────────────────────────────────────
//
// For a caller WITHOUT burn.financials.read_all the comparison runs against
//
//     effective_remaining = floor(envelope_remaining / bucket) * bucket
//
// so the boundary the caller can probe sits on a bucket edge. However many probes are
// spent, the recovered value is one bucket-quantized figure: the comparator leaks at most
// log2(range/bucket) bits total rather than per-probe refinement to the cent.
//
// A read_all holder is compared against the exact figure, because they are already entitled
// to `envelope.remaining` in the response body; quantizing their decision would make the
// gate wrong for the very people who can see why.
//
// The second half of the defense is the per-(member, deliverable) daily probe cap, since a
// real charge is prechecked once or twice and never 24 times. See probeCapKey below.

/** The default bucket, in minor units. 10000 == $100.00. Overridable per org. */
export const DEFAULT_OVERAGE_BUCKET_AMOUNT = 10_000;

function safeBucket(bucket: number | null | undefined): number {
  const b = Math.trunc(Number(bucket ?? DEFAULT_OVERAGE_BUCKET_AMOUNT));
  return Number.isFinite(b) && b > 0 ? b : DEFAULT_OVERAGE_BUCKET_AMOUNT;
}

/**
 * The remaining figure the DENY DECISION is evaluated against.
 *
 * read_all  -> the exact figure.
 * otherwise -> rounded DOWN to the bucket, so the probe boundary is bucket-aligned.
 *
 * Rounding down (never up) also keeps the quantization conservative: the gate can only be
 * stricter than the truth for a member, never more permissive, so quantization cannot let a
 * charge through that the exact arithmetic would have denied.
 */
export function decisionRemaining(
  envelopeRemaining: number,
  bucketAmount: number | null | undefined,
  canReadAll: boolean,
): number {
  if (canReadAll) return envelopeRemaining;
  const bucket = safeBucket(bucketAmount);
  if (envelopeRemaining <= 0) return 0;
  return Math.floor(envelopeRemaining / bucket) * bucket;
}

/**
 * The overage a non-read_all caller is told about: rounded UP to the bucket, so it is an
 * "at least" figure (spec 5.7 names the wire field `overage_at_least` for exactly this
 * reason) and `proposed_amount - overage` no longer recovers remaining.
 */
export function quantizeOverage(
  overage: number,
  bucketAmount: number | null | undefined,
): number {
  const bucket = safeBucket(bucketAmount);
  if (overage <= 0) return 0;
  return Math.ceil(overage / bucket) * bucket;
}

/**
 * The coarse consumption band a member receives in place of a percentage.
 *
 * Deliberately five wide buckets and not a percentage: a percentage plus a known
 * proposed_amount is another comparator, and the whole point of this file is to stop
 * handing the caller a dial they can turn.
 */
export type BurnConsumptionBand = 'unpriced' | 'under' | 'nearing' | 'at' | 'over';

export function consumptionBand(
  consumed: number,
  envelope: number | null | undefined,
): BurnConsumptionBand {
  if (envelope === null || envelope === undefined || envelope <= 0) return 'unpriced';
  const ratio = consumed / envelope;
  if (ratio < 0.75) return 'under';
  if (ratio < 0.95) return 'nearing';
  if (ratio <= 1) return 'at';
  return 'over';
}

/**
 * The Redis key for the per-(member, deliverable) daily probe cap
 * (`usr_precheck_per_deliverable_cap`, default 5).
 *
 * Keyed per DAY so the counter self-expires and one abusive afternoon does not permanently
 * lock a person out of a deliverable they legitimately charge against. Exceeding it raises a
 * `precheck_probing` variance and writes an audit row rather than silently 429ing into the
 * void: the point is that the attempt is VISIBLE, not merely blocked.
 */
export function probeCapKey(userId: string, deliverableId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `burn:probe:${userId}:${deliverableId}:${day}`;
}

/** The per-org daily `usr:` precheck ceiling key (spec 2.4 point 10). */
export function orgDailyPrecheckKey(orgId: string, userId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `burn:usr_precheck:${orgId}:${userId}:${day}`;
}

/** Counters live one day plus slack, so a clock skew cannot resurrect yesterday's count. */
export const PROBE_COUNTER_TTL_SECONDS = 60 * 60 * 26;
