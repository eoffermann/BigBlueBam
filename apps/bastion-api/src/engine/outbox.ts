// The outbox (spec 2.5, 7, 8.1). Every outbound side effect is a bastion_outbox row written in
// the same transaction as the change it reports, and delivered later by the drain engine:
//
//   - only the OLDEST pending row per ordering_key is a candidate, so a row that is backing off
//     blocks the rows behind it on the same key (e.g. a seal object before its ledger.sealed);
//   - backoff 30 s doubling to 6 h, then `dead` (reported to the worker, which records a worker
//     error); a dead row stops blocking its key, so later rows proceed;
//   - a permanent refusal (a 4xx other than 408/429) goes `dead` on that attempt with the reason
//     in last_error, instead of holding its key for ~14.5 h of backoff (issue #203);
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

/**
 * `permanent` marks a failure no retry can fix (issue #203): the row goes dead on that attempt,
 * with the reason in last_error, so it never holds its ordering key through the 30 s to 6 h
 * ladder. `status` is the HTTP status when there was one.
 */
export type DeliveryResult = { ok: true } | { ok: false; error: string; permanent?: boolean; status?: number | null };

/**
 * A 4xx is the receiver refusing THIS request (bad payload, unknown source or event, too large):
 * resending it unchanged gets the same answer. 408 and 429 are the exceptions, they ask for a
 * retry. 5xx, timeouts and network errors (no status) stay on the backoff ladder.
 */
export function isPermanentHttpFailure(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface Deliverer {
  deliver(row: OutboxRow): Promise<DeliveryResult>;
}

/** Where the Bam internal routes live (spec 8.4) and the secret that opens them. */
export interface BamTarget {
  apiUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The api's refusal codes that mean "the Compliance project cannot take tasks" (#229): deleted,
 * or no open phase. The drift row records project_unavailable instead of staying pending, and
 * redriveProjectDeliveries (remediation.ts) re-sends these rows once the project is fixed.
 */
export const PROJECT_UNAVAILABLE_CODES = ['PROJECT_NOT_FOUND', 'CONFIGURATION_ERROR'] as const;

function errorCodeOf(text: string): string | null {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

const BAM_PATHS: Record<'bam_task_upsert' | 'bam_task_comment', string> = {
  bam_task_upsert: '/internal/bastion/tasks/upsert',
  bam_task_comment: '/internal/bastion/tasks/comment',
};

/**
 * Deliver a Bam row (task upsert, comment by external_id, proposal close) to the api-owned route.
 * After a successful upsert the drift row records the task and what happened to it.
 */
export async function deliverToBam(sql: EngineDeps['sql'], bam: BamTarget | undefined, row: OutboxRow): Promise<DeliveryResult> {
  if (!bam) return { ok: false, error: 'the Bam API is not configured for Bastion' };
  const p = row.payload;
  const path =
    row.kind === 'proposal_close'
      ? `/internal/bastion/proposals/${String(p.proposal_id)}/close`
      : BAM_PATHS[row.kind as 'bam_task_upsert' | 'bam_task_comment'];
  let res: Response;
  try {
    res = await (bam.fetchImpl ?? fetch)(`${bam.apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Secret': bam.secret },
      body: JSON.stringify(p.request ?? {}),
      signal: AbortSignal.timeout(bam.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const code = errorCodeOf(text);
    if (row.kind === 'bam_task_upsert' && typeof p.drift_id === 'string' && code && (PROJECT_UNAVAILABLE_CODES as readonly string[]).includes(code)) {
      await sql`UPDATE bastion_drift_events SET task_status = 'project_unavailable'
                 WHERE organization_id = ${row.organization_id} AND id = ${p.drift_id} AND task_status = 'pending'`;
    }
    return { ok: false, error: `Bam API ${res.status}: ${text.slice(0, 300)}`, status: res.status, permanent: isPermanentHttpFailure(res.status) };
  }
  if (row.kind === 'bam_task_upsert' && typeof p.drift_id === 'string') {
    let data: { task_id?: string; outcome?: string } = {};
    try {
      data = (JSON.parse(text) as { data?: typeof data }).data ?? {};
    } catch {
      data = {};
    }
    if (data.task_id && data.outcome) {
      await sql`UPDATE bastion_drift_events SET bam_task_id = ${data.task_id}, task_status = ${data.outcome}
                 WHERE organization_id = ${row.organization_id} AND id = ${p.drift_id}`;
    }
  }
  return { ok: true };
}

/** The production deliverer: Bolt events, seal objects to the bucket, Bam rows to the api. */
export function defaultDeliverer(deps: { sql: EngineDeps['sql']; storage: StorageDriver | null; putTimeoutMs: number; bam?: BamTarget }): Deliverer {
  return {
    async deliver(row) {
      const p = row.payload;
      if (row.kind === 'bam_task_upsert' || row.kind === 'bam_task_comment' || row.kind === 'proposal_close') {
        return deliverToBam(deps.sql, deps.bam, row);
      }
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
        if (!res.ok) {
          return { ok: false, error: res.error ?? 'bolt-api ingest failed', status: res.status, permanent: isPermanentHttpFailure(res.status) };
        }
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
      return { ok: false, error: `no deliverer for outbox kind ${row.kind}`, permanent: true };
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
      const delay = result.permanent ? null : nextBackoffMs(attempts);
      if (delay === null) {
        const reason = result.permanent
          ? `permanent failure${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error}`
          : `gave up after ${attempts} attempts: ${result.error}`;
        await deps.sql`UPDATE bastion_outbox SET status = 'dead', attempts = ${attempts}, claimed_by = NULL,
                         last_error = ${reason.slice(0, 2000)} WHERE id = ${head.id}`;
        summary.dead += 1;
        summary.dead_ids.push(head.id);
        deps.log.error(
          { outbox_id: head.id, kind: head.kind, ordering_key: head.ordering_key, status: result.status ?? null, permanent: !!result.permanent, error: result.error },
          result.permanent
            ? `bastion-outbox: the receiver refused this row (HTTP ${result.status}); dead at once so its key is not blocked`
            : 'bastion-outbox: delivery gave up; row is dead',
        );
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
