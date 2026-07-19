import { createHmac } from 'node:crypto';
import type { BurnPrecheckRequest } from '@bigbluebam/shared';

/**
 * The precheck idempotency key. Spec 2.4 point 7.
 *
 * SERVER-DERIVED, always. A caller-supplied key is rejected structurally: the
 * `burnPrecheckRequestSchema` is `.strict()` and carries no key field at all, so an attempt
 * to smuggle one is a 400 rather than a silently honoured override.
 *
 * HMAC over the namespace, work ref, amount, currency, and an attempt nonce, so:
 *   - two callers cannot collide into each other's verdicts;
 *   - a caller cannot forge a key that maps onto a verdict issued for DIFFERENT MONEY --
 *     this is the banked-verdict attack, where an `allow` stored for a 1-cent charge is
 *     replayed for a $60,000 one. Amount and currency are inside the signed material, so
 *     the collision is impossible by construction rather than caught by a later check;
 *   - the `svc:` / `usr:` prefix is inside the signed material AND on the outside, so the
 *     calibration query's `LIKE 'svc:%'` restriction cannot be spoofed by a member trying to
 *     inject rows into the gate-promotion sample.
 *
 * Lives in lib/ rather than in the precheck service because it is a pure function: keeping
 * it here means the test suite can exercise it without importing the service, which pulls in
 * db/index.ts and therefore the whole env schema.
 */
export function deriveIdempotencyKey(
  secret: string,
  namespace: 'svc' | 'usr',
  req: BurnPrecheckRequest,
): string {
  const material = [
    namespace,
    req.work_ref_type,
    req.work_ref_id ?? '',
    String(req.proposed_amount),
    req.currency,
    req.attempt_nonce ?? '',
  ].join('|');
  const digest = createHmac('sha256', secret).update(material).digest('hex').slice(0, 48);
  return `${namespace}:${digest}`;
}
