// The outbox (spec 2.5, 7, 8.1). Every outbound side effect is a bastion_outbox row written in
// the same transaction as the change it reports, and delivered later by the drain engine:
//
//   - only the OLDEST pending row per ordering_key is a candidate, so a row that is backing off
//     blocks the rows behind it on the same key (e.g. a seal object before its ledger.sealed);
//   - backoff 30 s doubling to 6 h, then `dead` (reported to the worker, which records a worker
//     error); a dead row stops blocking its key, so later rows proceed;
//   - delivery happens outside any transaction (no outbound HTTP while a row lock is held).

import { BASTION_EVENT_TYPES, publishBoltEventChecked, type BastionEventType } from '@bigbluebam/shared';
import type { StorageDriver } from '@bigbluebam/storage';
import { withStorageTimeout } from '@bigbluebam/storage';
import type { EngineDeps, Tx } from './context.js';

export const OUTBOX_BASE_DELAY_MS = 30_000;
export const OUTBOX_MAX_DELAY_MS = 6 * 3_600_000;
/** 30 s doubling reaches the 6 h cap on attempt 11; one more failure at the cap goes dead. */
export const OUTBOX_MAX_ATTEMPTS = 12;
const DRAIN_BUDGET_MS = 20_000;
const DRAIN_MAX_ROWS = 200;
const CLAIM_STALE_MS = 120_000;

export type OutboxKind = 'bolt_event' | 'bam_task_upsert' | 'bam_task_comment' | 'proposal_close' | 'seal_object';

export interface OutboxInsert {
  orgId: string;
  kind: OutboxKind;
  orderingKey: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/**
 * Insert one outbox row; a repeated idempotency key is a no-op. Returns true when inserted.
 *
 * created_at is clock_timestamp(), not the column default now(): now() is the transaction's start
 * time, so rows enqueued in one transaction (a seal object then its ledger.sealed event) tied and
 * the drainer's (created_at, id) order fell to a random uuid. Found by the M4 live rehearsal.
 */
export async function enqueueOutbox(tx: Tx, row: OutboxInsert): Promise<boolean> {
  const inserted = await tx`
    INSERT INTO bastion_outbox (organization_id, kind, ordering_key, idempotency_key, payload, created_at)
    VALUES (${row.orgId}, ${row.kind}, ${row.orderingKey}, ${row.idempotencyKey}, ${tx.json(row.payload as never)}, clock_timestamp())
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id`;
  return inserted.length > 0;
}

const KNOWN_EVENTS = new Set<string>(BASTION_EVENT_TYPES);

export interface BastionEventOptions {
  orgId: string;
  idempotencyKey: string;
  /** Defaults to `org:<org>`. Drift and recovery use `control:<id>`; seals use `seal:<org>`. */
  orderingKey?: string;
  actorId?: string;
  actorType?: 'user' | 'agent' | 'system';
}

/**
 * Enqueue a Bastion Bolt event (spec 8.1). The first argument is always a string literal:
 * scripts/check-bolt-catalog.mjs reads it as a `bastion` publisher and fails CI when the name is
 * not in the Bolt catalog. Payloads are refs and scalars only.
 */
export async function enqueueBastionEvent(
  eventType: BastionEventType,
  payload: Record<string, unknown>,
  tx: Tx,
  opts: BastionEventOptions,
): Promise<boolean> {
  if (!KNOWN_EVENTS.has(eventType)) throw new Error(`unknown Bastion event ${eventType}`);
  return enqueueOutbox(tx, {
    orgId: opts.orgId,
    kind: 'bolt_event',
    orderingKey: opts.orderingKey ?? `org:${opts.orgId}`,
    idempotencyKey: `event:${opts.idempotencyKey}`,
    payload: {
      event_type: eventType,
      payload: { ...payload, org_id: opts.orgId },
      actor_id: opts.actorId ?? null,
      actor_type: opts.actorType ?? (opts.actorId ? 'user' : 'system'),
    },
  });
}

/** Backoff after `attempts` failures, or null when the row should go dead. Pure; tested. */
export function nextBackoffMs(attempts: number): number | null {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return null;
  return Math.min(OUTBOX_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_DELAY_MS);
}

export interface OutboxRow {
  id: string;
  organization_id: string;
  kind: OutboxKind;
  ordering_key: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
}

export type DeliveryResult = { ok: true } | { ok: false; error: string };

export interface Deliverer {
  deliver(row: OutboxRow): Promise<DeliveryResult>;
}

/** The production deliverer: Bolt events via publishBoltEventChecked, seal objects to the bucket. */
export function defaultDeliverer(deps: { sql: EngineDeps['sql']; storage: StorageDriver | null; putTimeoutMs: number }): Deliverer {
  return {
    async deliver(row) {
      const p = row.payload;
      if (row.kind === 'bolt_event') {
        const eventPayload: Record<string, unknown> = { ...((p.payload as Record<string, unknown>) ?? {}), _event_id: row.idempotency_key };
        const res = await publishBoltEventChecked(
          String(p.event_type),
          'bastion',
          eventPayload,
          row.organization_id,
          typeof p.actor_id === 'string' ? p.actor_id : undefined,
          (p.actor_type as 'user' | 'agent' | 'system' | undefined) ?? 'system',
        );
        if (!res.ok) return { ok: false, error: res.error ?? 'bolt-api ingest failed' };
        if (p.event_type === 'ledger.sealed' && typeof eventPayload.seal_date === 'string') {
          await deps.sql`UPDATE bastion_ledger_seals SET published_at = now()
                          WHERE organization_id = ${row.organization_id} AND seal_date = ${eventPayload.seal_date}::date
                            AND published_at IS NULL`;
        }
        return { ok: true };
      }
      if (row.kind === 'seal_object') {
        if (!deps.storage) return { ok: false, error: 'evidence storage is not set up' };
        const key = String(p.object_key);
        const body = Buffer.from(JSON.stringify(p.seal));
        try {
          await withStorageTimeout('put', deps.storage.put(key, body, { contentType: 'application/json', size: body.length }), deps.putTimeoutMs);
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
        await deps.sql`UPDATE bastion_ledger_seals SET object_written_at = now()
                        WHERE organization_id = ${row.organization_id} AND seal_date = ${String(p.seal_date)}::date
                          AND object_written_at IS NULL`;
        return { ok: true };
      }
      // bam_task_upsert, bam_task_comment and proposal_close are delivered to the internal Bam
      // routes that land at M6; nothing writes them before then.
      return { ok: false, error: `no deliverer for outbox kind ${row.kind} yet` };
    },
  };
}

export interface DrainSummary {
  candidates: number;
  delivered: number;
  failed: number;
  dead: number;
  dead_ids: string[];
  elapsed_ms: number;
}

/**
 * Deliver due rows: the oldest pending row of each ordering_key, if its next_attempt_at has
 * passed. Repeats until nothing is due, the row cap or the time budget is reached.
 */
export async function drainOutbox(deps: EngineDeps, deliverer: Deliverer, opts: { orgId?: string; claimant: string }): Promise<DrainSummary> {
  const started = Date.now();
  const summary: DrainSummary = { candidates: 0, delivered: 0, failed: 0, dead: 0, dead_ids: [], elapsed_ms: 0 };
  const attempted = new Set<string>();
  while (Date.now() - started < DRAIN_BUDGET_MS && summary.candidates < DRAIN_MAX_ROWS) {
    const now = deps.now();
    const heads = (await deps.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (ordering_key) id, organization_id, kind, ordering_key, idempotency_key, payload,
               attempts, next_attempt_at, created_at
          FROM bastion_outbox
         WHERE status = 'pending' ${opts.orgId ? deps.sql`AND organization_id = ${opts.orgId}` : deps.sql``}
         ORDER BY ordering_key, created_at, id
      ) h
      WHERE h.next_attempt_at IS NULL OR h.next_attempt_at <= ${now}
      ORDER BY h.created_at
      LIMIT 50`) as unknown as OutboxRow[];
    const due = heads.filter((h) => !attempted.has(h.id));
    if (due.length === 0) break;
    for (const head of due) {
      if (Date.now() - started >= DRAIN_BUDGET_MS) break;
      attempted.add(head.id);
      const claimed = await deps.sql`
        UPDATE bastion_outbox SET claimed_by = ${opts.claimant}, heartbeat_at = now()
         WHERE id = ${head.id} AND status = 'pending'
           AND (claimed_by IS NULL OR heartbeat_at < now() - make_interval(secs => ${CLAIM_STALE_MS / 1000}))
        RETURNING id`;
      if (claimed.length === 0) continue;
      summary.candidates += 1;
      let result: DeliveryResult;
      try {
        result = await deliverer.deliver(head);
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
      if (result.ok) {
        await deps.sql`UPDATE bastion_outbox SET status = 'delivered', delivered_at = now(), claimed_by = NULL,
                         last_error = NULL WHERE id = ${head.id}`;
        summary.delivered += 1;
        continue;
      }
      const attempts = head.attempts + 1;
      const delay = nextBackoffMs(attempts);
      if (delay === null) {
        await deps.sql`UPDATE bastion_outbox SET status = 'dead', attempts = ${attempts}, claimed_by = NULL,
                         last_error = ${result.error.slice(0, 2000)} WHERE id = ${head.id}`;
        summary.dead += 1;
        summary.dead_ids.push(head.id);
        deps.log.error({ outbox_id: head.id, kind: head.kind, ordering_key: head.ordering_key, error: result.error }, 'bastion-outbox: delivery gave up; row is dead');
      } else {
        await deps.sql`UPDATE bastion_outbox SET attempts = ${attempts}, claimed_by = NULL,
                         next_attempt_at = ${new Date(now.getTime() + delay)}, last_error = ${result.error.slice(0, 2000)}
                         WHERE id = ${head.id}`;
        summary.failed += 1;
      }
    }
  }
  summary.elapsed_ms = Date.now() - started;
  return summary;
}
