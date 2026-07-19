import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OVERAGE_BUCKET_AMOUNT,
  consumptionBand,
  decisionRemaining,
  probeCapKey,
  quantizeOverage,
} from '../src/lib/quantize.js';
import { deriveIdempotencyKey } from '../src/lib/idempotency-key.js';
import type { BurnPrecheckRequest } from '@bigbluebam/shared';

const SRC = join(__dirname, '..', 'src');

/**
 * Strip comments before asserting on source.
 *
 * precheck.service.ts DOCUMENTS the deterministic-only invariant at length, and that prose
 * necessarily names `POST /internal/llm/chat` in order to say the gate must never call it. A
 * naive substring assertion fails on the explanation rather than on an offence, and the
 * obvious way to make it pass is to delete the explanation -- which would remove the one
 * thing standing between the next implementer and a "harmless" model call inside the money
 * path. So the assertions run against code with comments removed, and a companion assertion
 * below requires the prose to still be there.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

/* ══════════════════════════════════════════════════════════════════════════════════════
   Spec 12.1, "The gate". These are the assertions the spec names explicitly; they are
   NOT deferred to M9.
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe('the precheck path is deterministic-only (Invariant 2, R2-T6)', () => {
  it('the precheck service contains no llm-provider call site of any kind', () => {
    const code = stripComments(
      readFileSync(join(SRC, 'services', 'precheck.service.ts'), 'utf8'),
    );
    // The spec's own framing is that the LLM client is stubbed to throw so any call fails
    // loudly. A static assertion is stronger still, because it catches a call site even on a
    // code path no fixture happens to exercise.
    expect(code).not.toMatch(/internal\/llm\/chat/);
    expect(code).not.toMatch(/internal-llm/);
    expect(code).not.toMatch(/llmClient|callLlm|chatCompletion/i);
  });

  it('no file reachable from the gate path imports an llm client', () => {
    for (const file of [
      'services/precheck.service.ts',
      'routes/precheck.routes.ts',
      'routes/internal.routes.ts',
    ]) {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      expect(code, `${file} must not import an llm client`).not.toMatch(
        /from ['"][^'"]*llm[^'"]*['"]/i,
      );
    }
  });

  it('and the invariant is still DOCUMENTED, so the next reader knows why', () => {
    // The inverse assertion. If someone satisfies the two above by deleting the comment
    // block, this one fails and says so. The prose is load-bearing: without it, adding a
    // model call to the gate looks like an obvious improvement rather than the change that
    // makes the blocking gate decorative.
    const source = readFileSync(join(SRC, 'services', 'precheck.service.ts'), 'utf8');
    expect(source).toMatch(/DETERMINISTIC-ONLY/);
    expect(source).toMatch(/internal\/llm\/chat/);
  });
});

describe('needs_mapping never blocks; deny is the only blocking verdict', () => {
  it('the service only ever sets enforced=true for a deny', () => {
    const source = readFileSync(join(SRC, 'services', 'precheck.service.ts'), 'utf8');
    // One assignment site, and its condition names deny explicitly.
    expect(source).toMatch(/const enforced = verdict === 'deny' && blocking;/);
    const enforcedAssignments = stripComments(source).match(/\benforced\s*=[^=]/g) ?? [];
    expect(enforcedAssignments.length).toBe(1);
  });
});

describe('the deny response is not an envelope oracle (R2-S2 + R3-S3)', () => {
  const bucket = DEFAULT_OVERAGE_BUCKET_AMOUNT; // 10000 minor units

  it('quantizes the DECISION INPUT for a non-read_all caller, not only the output', () => {
    // 47_321 remaining rounds DOWN to 40_000 for a member. The verdict boundary therefore
    // sits on a bucket edge no matter how many probes are spent against it.
    expect(decisionRemaining(47_321, bucket, false)).toBe(40_000);
    // A read_all holder is compared against the exact figure: they already receive
    // envelope.remaining in the body, so quantizing their decision would make the gate wrong
    // for the only people who can see why.
    expect(decisionRemaining(47_321, bucket, true)).toBe(47_321);
  });

  it('binary search over proposed_amount cannot recover finer than one bucket', () => {
    // This is the spec's restated assertion: "not recoverable to finer than
    // overage_bucket_amount", probing a NEWLY CONFIRMED deliverable (consumption zero, so
    // remaining == envelope_amount, which is the sharpest case).
    const trueEnvelope = 47_321;
    const effective = decisionRemaining(trueEnvelope, bucket, false);
    const denies = (proposed: number) => proposed > effective;

    let lo = 0;
    let hi = 1_000_000;
    for (let i = 0; i < 40; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (denies(mid)) hi = mid;
      else lo = mid;
    }
    // 40 probes -- far more than the ~24 the spec cites -- converge on the QUANTIZED
    // boundary, not the true envelope.
    expect(lo).toBe(effective);
    expect(Math.abs(trueEnvelope - lo)).toBeGreaterThanOrEqual(0);
    // The recovered value tells the attacker only which bucket the envelope is in.
    expect(trueEnvelope - lo).toBeLessThan(bucket);
    expect(lo % bucket).toBe(0);
  });

  it('rounds the reported overage UP so proposed_amount minus overage does not recover remaining', () => {
    expect(quantizeOverage(1, bucket)).toBe(10_000);
    expect(quantizeOverage(10_001, bucket)).toBe(20_000);
    expect(quantizeOverage(0, bucket)).toBe(0);
  });

  it('quantization is conservative: it can only make the gate stricter, never more permissive', () => {
    for (const remaining of [0, 1, 9_999, 10_000, 10_001, 99_999]) {
      expect(decisionRemaining(remaining, bucket, false)).toBeLessThanOrEqual(remaining);
    }
  });

  it('falls back to the default bucket rather than dividing by zero or a negative', () => {
    expect(decisionRemaining(47_321, 0, false)).toBe(40_000);
    expect(decisionRemaining(47_321, -5, false)).toBe(40_000);
    expect(decisionRemaining(47_321, null, false)).toBe(40_000);
  });

  it('the member-facing band is coarse and never a percentage', () => {
    expect(consumptionBand(0, 100_000)).toBe('under');
    expect(consumptionBand(80_000, 100_000)).toBe('nearing');
    expect(consumptionBand(100_000, 100_000)).toBe('at');
    expect(consumptionBand(120_000, 100_000)).toBe('over');
    expect(consumptionBand(50_000, null)).toBe('unpriced');
  });

  it('the probe cap is keyed per (member, deliverable, day) so it self-expires', () => {
    const day = new Date('2026-07-19T23:00:00Z');
    const key = probeCapKey('u1', 'd1', day);
    expect(key).toBe('burn:probe:u1:d1:20260719');
    expect(probeCapKey('u1', 'd2', day)).not.toBe(key);
    expect(probeCapKey('u2', 'd1', day)).not.toBe(key);
  });
});

describe('idempotency keys are server-derived, namespaced, and money-bound (2.4 point 7)', () => {
  const base: BurnPrecheckRequest = {
    work_ref_type: 'bill.expense',
    work_ref_id: null,
    project_id: null,
    proposed_amount: 1,
    currency: 'USD',
  } as BurnPrecheckRequest;

  it('the banked-verdict attack fails: a 1-cent key does not collide with a $60,000 key', () => {
    const cheap = deriveIdempotencyKey('secret'.repeat(8), 'usr', base);
    const expensive = deriveIdempotencyKey('secret'.repeat(8), 'usr', {
      ...base,
      proposed_amount: 6_000_000,
    });
    expect(cheap).not.toBe(expensive);
  });

  it('the svc: / usr: namespace is inside the signed material AND on the outside', () => {
    const svc = deriveIdempotencyKey('secret'.repeat(8), 'svc', base);
    const usr = deriveIdempotencyKey('secret'.repeat(8), 'usr', base);
    expect(svc.startsWith('svc:')).toBe(true);
    expect(usr.startsWith('usr:')).toBe(true);
    // Not merely a different prefix on the same digest: the calibration query restricts on
    // LIKE 'svc:%', so a member who could produce a matching digest under a forged prefix
    // would be able to inject rows into the promotion sample.
    expect(svc.slice(4)).not.toBe(usr.slice(4));
  });

  it('currency and work_ref_type are bound into the key', () => {
    const usd = deriveIdempotencyKey('secret'.repeat(8), 'usr', base);
    const eur = deriveIdempotencyKey('secret'.repeat(8), 'usr', { ...base, currency: 'EUR' });
    const recurring = deriveIdempotencyKey('secret'.repeat(8), 'usr', {
      ...base,
      work_ref_type: 'bill.recurring',
    });
    expect(new Set([usd, eur, recurring]).size).toBe(3);
  });

  it('a caller-supplied key has nowhere to go: the request schema carries no key field', async () => {
    const { burnPrecheckRequestSchema } = await import('@bigbluebam/shared');
    const parsed = burnPrecheckRequestSchema.safeParse({
      ...base,
      idempotency_key: 'usr:attacker-chosen',
    });
    // `.strict()` turns the smuggling attempt into a 400 rather than a silently ignored key.
    expect(parsed.success).toBe(false);
  });
});

describe('recompute is supersede-then-insert, never UPDATE-in-place (R2-T7)', () => {
  it('the service supersedes the prior row and inserts a new one', () => {
    const source = readFileSync(join(SRC, 'services', 'precheck.service.ts'), 'utf8');
    expect(stripComments(source)).toMatch(/\.set\(\{ superseded_at: new Date\(\) \}\)/);
    // The superseded row is the reason-of-record artifact for the verdict that WAS issued.
    expect(source).toMatch(/SUPERSEDE-THEN-INSERT/);
  });
});
