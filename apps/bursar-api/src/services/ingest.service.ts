import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { BursarInternalEvent } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { normalizePayee, resolvePayee } from '../lib/payee-normalize.js';
import { spendDedupKey } from '../lib/spend-dedup-key.js';

// Event consumption (spec 16.2, M8). The /internal/events inbox persists to bursar_ingest_events
// (idempotent) then consumes:
//   - bill:expense.created / bill:expense.approved -> a spend event (funding_source='bill.expense');
//   - braid:profile.merged -> re-point braid_profile_id on affected vendors.
// invoice.paid / payment.recorded are money-in and are never subscribed, so they never arrive; if
// one somehow did, it is persisted and ignored (no spend event), which is the correct posture.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function nested(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export interface ConsumeOutcome {
  persisted: boolean;
  consumed: 'spend_event' | 'profile_repointed' | 'ignored' | 'duplicate';
}

export async function consumeInternalEvent(evt: BursarInternalEvent, log: FastifyBaseLogger): Promise<ConsumeOutcome> {
  const idem = evt.event_id ?? createHash('sha256').update(`${evt.source}:${evt.event}:${JSON.stringify(evt.payload)}`).digest('hex').slice(0, 128);
  return runInOrgScope(evt.organization_id, async (tx) => {
    // Persist to the durable inbox, idempotent on (organization_id, source_idempotency_key).
    const inserted = pgRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO bursar_ingest_events (organization_id, source_idempotency_key, source, event_type,
               scope_fields, status, received_at)
        VALUES (${evt.organization_id}, ${idem}, ${evt.source}, ${evt.event},
               ${JSON.stringify(evt.payload)}::jsonb, 'pending', now())
        ON CONFLICT (organization_id, source_idempotency_key) DO NOTHING
        RETURNING id
      `),
    );
    if (inserted.length === 0) {
      // Already seen: idempotent no-op.
      return { persisted: false, consumed: 'duplicate' };
    }

    const key = `${evt.source}:${evt.event}`;
    let consumed: ConsumeOutcome['consumed'] = 'ignored';
    try {
      if (key === 'bill:expense.created' || key === 'bill:expense.approved') {
        consumed = (await consumeExpense(tx, evt)) ? 'spend_event' : 'ignored';
      } else if (key === 'braid:profile.merged') {
        consumed = (await consumeProfileMerged(tx, evt)) ? 'profile_repointed' : 'ignored';
      }
      await tx.execute(sql`
        UPDATE bursar_ingest_events SET status = 'processed', processed_at = now()
         WHERE organization_id = ${evt.organization_id} AND source_idempotency_key = ${idem}
      `);
    } catch (err) {
      log.warn({ err, key }, 'bursar consumeInternalEvent: consumption failed; row left pending for retry');
      // Leave status pending; a later re-delivery or reconcile can retry.
    }
    return { persisted: true, consumed };
  });
}

/** bill expense -> a spend event. amount/currency/vendor/date come from the expense payload. */
async function consumeExpense(tx: DbTx, evt: BursarInternalEvent): Promise<boolean> {
  const p = evt.payload;
  const expenseId = asString(nested(p, 'expense.id')) ?? asString(nested(p, 'expense_id'));
  const amount = asNumber(nested(p, 'expense.amount')) ?? asNumber(nested(p, 'amount'));
  const currency = (asString(nested(p, 'expense.currency')) ?? 'USD').toUpperCase();
  const payeeRaw = asString(nested(p, 'expense.vendor')) ?? asString(nested(p, 'expense.description')) ?? 'Unknown vendor';
  const occurredOn = (asString(nested(p, 'expense.expense_date')) ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (amount === null || !expenseId) return false;

  const normalized = normalizePayee(payeeRaw);
  // Resolve vendor via trigram (auto-accept only writes a vendor_id).
  const candidates = pgRows<{ id: string; display_name: string }>(
    await tx.execute(sql`SELECT id, display_name FROM bursar_vendors WHERE organization_id = ${evt.organization_id} AND status = 'active'`),
  ).map((r) => ({ vendor_id: r.id, normalized_name: normalizePayee(r.display_name) }));
  const res = resolvePayee(payeeRaw, candidates);
  const vendorId = res.disposition === 'auto_accept' ? res.vendor_id : null;

  // A bill expense is one event; external_ref = expense id makes it unique. occurrence_ordinal 0.
  const dedup = spendDedupKey({
    normalized_payee: normalized,
    occurred_on: occurredOn,
    amount_minor: amount,
    currency,
    external_ref: expenseId,
    occurrence_ordinal: 0,
  });
  const ins = pgRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO bursar_spend_events (organization_id, source_type, vendor_id, occurred_on, amount_minor,
             currency, payee_raw, normalized_payee, funding_source, external_ref, match_method,
             match_confidence, dedup_key, occurrence_ordinal)
      VALUES (${evt.organization_id}, 'bill.expense', ${vendorId}, ${occurredOn}, ${amount}, ${currency},
             ${payeeRaw}, ${normalized}, 'bill.expense', ${expenseId},
             ${vendorId ? 'auto' : null}, ${vendorId ? res.score : null}, ${dedup}, 0)
      ON CONFLICT (organization_id, dedup_key) DO NOTHING
      RETURNING id
    `),
  );
  return ins.length > 0;
}

/** braid profile.merged -> re-point vendors whose source identity moved to the survivor profile. */
async function consumeProfileMerged(tx: DbTx, evt: BursarInternalEvent): Promise<boolean> {
  const survivor = asString(nested(evt.payload, 'profile.id'));
  if (!survivor) return false;
  const affected = nested(evt.payload, 'affected_identities');
  const sourceIds: string[] = [];
  if (Array.isArray(affected)) {
    for (const item of affected) {
      const sid = asString(nested(item as Record<string, unknown>, 'source_id'));
      if (sid) sourceIds.push(sid);
    }
  }
  if (sourceIds.length === 0) return false;
  // Re-point any vendor whose bond_company_id moved under the survivor golden profile.
  const updated = pgRows<{ id: string }>(
    await tx.execute(sql`
      UPDATE bursar_vendors
         SET braid_profile_id = ${survivor}, updated_at = now()
       WHERE organization_id = ${evt.organization_id}
         AND bond_company_id = ANY(${sourceIds}::uuid[])
         AND (braid_profile_id IS DISTINCT FROM ${survivor}::uuid)
      RETURNING id
    `),
  );
  return updated.length > 0;
}
