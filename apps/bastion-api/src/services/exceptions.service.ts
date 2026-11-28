// Exceptions: accepted risk (spec 2.6; 5.1 rows 58-61).
//
//   POST /exceptions               propose (control owner or anyone with exception.propose, or an
//                                  agent); mirrored into agent_proposals for a human decision
//   POST /exceptions/:id/decide    a human in Bastion (session, not impersonating) holding
//                                  exception.approve, who is NOT the proposer, unless the org has
//                                  fewer than three humans ("approved by the proposer (small team)")
//   expiry (bastion-evidence-expiry) an exception whose time is up expires; when the control's
//                                  effective state worsens, a drift row (reason exception_expired)
//                                  and its outbox rows (control.drifted + task reopen) are written in
//                                  the same transaction, idempotent on the exception id (0283).
//
// Scope: an entity exception covers one cited ref for up to 365 days; an assertion-wide one covers
// only the refs failing at approval (frozen_refs) for up to 90 days. Approved exceptions are
// immutable (0276/0283 triggers) and ledgered (entry kind `exception`). Snapshots keep the raw
// outcome; effectiveStatus reads the exception at read time.

import {
  BASTION_EFFECTIVE_STATE_SEVERITY,
  BASTION_EXCEPTION_MAX_DAYS,
  endOfDayInTz,
  type BastionException,
  type BastionExceptionDecide,
  type BastionExceptionListQuery,
  type BastionExceptionListResponse,
  type BastionExceptionPropose,
  type BastionExceptionResponse,
} from '@bigbluebam/shared';
import { auditRaw } from '../lib/audit-raw.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { canonicalJson, sha256Hex } from '../lib/ledger-canonical.js';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { lockOrgGapRank, rankOrgGaps } from '../engine/gaps.js';
import { appendLedger } from '../engine/ledger.js';
import { loadControlStates, verdictOf } from '../engine/numbers.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import {
  driftTaskStatus,
  enqueueDriftTask,
  enqueueProposalClose,
  enqueueTaskComment,
  localDate,
  remediationSettings,
} from '../engine/remediation.js';
import type { CitedRef, ExceptionRow } from '../engine/status.js';
import {
  activeHumanCount,
  anOrgAdmin,
  assertHumanDecider,
  type CanAccess,
  citationVisible,
  type DecisionDeps,
  fileMirroredProposal,
  isSmallTeam,
  visibleRefs,
} from './decisions.service.js';
import { beginLedgerBatch, mapAppendError } from './ledger-batch.js';
import type { Viewer } from './types.js';

const DAY_MS = 86_400_000;
/** How long an exception proposal waits for a decision. */
const EXCEPTION_PROPOSAL_TTL_DAYS = 14;

const SELECT = `e.id, e.control_id, c.title AS control_title, c.owner_user_id, ou.display_name AS owner_name, e.assertion_id,
  a.plain_statement AS assertion_statement, e.scope, e.cited_entity_type, e.cited_entity_id, e.frozen_refs, e.reason,
  e.compensating_note, e.proposal_id, e.status, e.proposed_by, pu.display_name AS proposed_by_name, e.decided_by,
  du.display_name AS decided_by_name, e.decided_at, e.small_team_self_approval, e.expires_at, e.ledger_seq, e.created_at, e.updated_at`;
const FROM = `FROM bastion_exceptions e
  JOIN bastion_controls c ON c.id = e.control_id AND c.organization_id = e.organization_id
  LEFT JOIN users ou ON ou.id = c.owner_user_id
  LEFT JOIN users pu ON pu.id = e.proposed_by
  LEFT JOIN users du ON du.id = e.decided_by
  LEFT JOIN bastion_assertions a ON a.id = e.assertion_id AND a.organization_id = e.organization_id`;

/**
 * The response row (shared bastionExceptionSchema, #348). The cast covers what JSON does on the
 * way out: timestamp columns are Date here and ISO strings on the wire, as the schema says.
 */
function shape(r: Record<string, unknown>, now: Date): BastionException {
  const expires = new Date(r.expires_at as string);
  return {
    ...(r as unknown as BastionException),
    // bigint arrives from Postgres as a string; the response carries a number.
    ledger_seq: r.ledger_seq === null || r.ledger_seq === undefined ? null : Number(r.ledger_seq),
    days_left: Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / DAY_MS)),
    approval_label: r.small_team_self_approval ? 'approved by the proposer (small team)' : null,
    state_words: r.status === 'active' ? 'Not met, risk accepted' : null,
  };
}

/**
 * The exception as this reader may see it (spec 2.4: citations pass can_access at read, #414).
 * The one cited item of an entity exception, and each frozen ref of an assertion-wide one, is
 * shown only when it passes for the reader (and the asker, when an agent reads for a person);
 * the rest are counted in hidden_citation_count and named nowhere.
 */
async function shapeForReader(canAccess: CanAccess, viewer: Viewer, r: Record<string, unknown>, now: Date): Promise<BastionException> {
  const base = shape(r, now);
  let hidden = 0;
  let citedType = base.cited_entity_type;
  let citedId = base.cited_entity_id;
  if (citedType && citedId && !(await citationVisible(canAccess, viewer, { entity_type: citedType, entity_id: citedId }))) {
    citedType = null;
    citedId = null;
    hidden += 1;
  }
  const frozenAll = (base.frozen_refs as CitedRef[] | null) ?? null;
  const frozen = frozenAll === null ? null : await visibleRefs(canAccess, viewer, frozenAll);
  if (frozenAll && frozen) hidden += frozenAll.length - frozen.length;
  return { ...base, cited_entity_type: citedType, cited_entity_id: citedId, frozen_refs: frozen, hidden_citation_count: hidden };
}

export async function listExceptions(
  engine: EngineDeps,
  viewer: Viewer,
  q: BastionExceptionListQuery,
  canAccess: CanAccess,
): Promise<BastionExceptionListResponse> {
  const now = engine.now();
  const rows = await orgTx(engine.sql, viewer.org_id, (tx) => tx.unsafe(
    `SELECT ${SELECT} ${FROM}
      WHERE e.organization_id = $1 AND ($2::text IS NULL OR e.status = $2) AND ($3::uuid IS NULL OR e.control_id = $3)
      ORDER BY e.created_at DESC LIMIT $4`,
    [viewer.org_id, q.status ?? null, q.control_id ?? null, q.limit],
  ));
  const data: BastionException[] = [];
  for (const r of rows) data.push(await shapeForReader(canAccess, viewer, r as Record<string, unknown>, now));
  return { data, next_cursor: null };
}

export async function getException(engine: EngineDeps, viewer: Viewer, id: string, canAccess: CanAccess): Promise<BastionExceptionResponse> {
  const r = (await orgTx(engine.sql, viewer.org_id, (tx) => tx.unsafe(`SELECT ${SELECT} ${FROM} WHERE e.organization_id = $1 AND e.id = $2`, [viewer.org_id, id])))[0];
  if (!r) throw new NotFoundError('We could not find that exception.');
  return { data: await shapeForReader(canAccess, viewer, r as Record<string, unknown>, engine.now()) };
}

/** POST /exceptions (row 60). */
export async function proposeException(d: DecisionDeps, viewer: Viewer, body: BastionExceptionPropose): Promise<BastionExceptionResponse> {
  const now = d.engine.now();
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const c = (await tx`SELECT id FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${body.control_id}`)[0];
    if (!c) throw new NotFoundError('We could not find that control.');
    if (body.scope === 'entity') {
      // The item must be one this control's checks actually cite (latest evidence), so an
      // exception can only cover something Bastion found.
      const cited = await tx`
        SELECT 1 FROM bastion_assertions a
          JOIN LATERAL (SELECT cited_refs FROM bastion_evidence_snapshots s
                         WHERE s.organization_id = a.organization_id AND s.assertion_id = a.id
                         ORDER BY s.created_at DESC LIMIT 1) s ON true
         WHERE a.organization_id = ${viewer.org_id} AND a.control_id = ${body.control_id} AND a.review_status = 'confirmed'
           AND s.cited_refs @> ${tx.json([{ entity_type: body.cited_entity_type, entity_id: body.cited_entity_id }] as never)}
         LIMIT 1`;
      if (cited.length === 0) {
        throw new ValidationFailure("That item is not one this control's checks found.", 'NOT_A_CITED_ITEM', [{ field: 'cited_entity_id', issue: 'not_cited' }]);
      }
    }
  });
  if (body.scope === 'entity' && body.cited_entity_type && body.cited_entity_id) {
    // The cited item passes the visibility preflight for the person asking (spec 2.4, 2.8).
    if (!(await citationVisible(d.canAccess, viewer, { entity_type: body.cited_entity_type, entity_id: body.cited_entity_id }))) {
      throw new ValidationFailure('You cannot see the item this exception would cover.', 'CITATION_NOT_VISIBLE', [{ field: 'cited_entity_id', issue: 'not_visible' }]);
    }
  }
  const id = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const c = (await tx`SELECT id, owner_user_id FROM bastion_controls WHERE organization_id = ${viewer.org_id} AND id = ${body.control_id}`)[0];
    if (!c) throw new NotFoundError('We could not find that control.');
    if (body.assertion_id) {
      const a = (await tx`SELECT id FROM bastion_assertions WHERE organization_id = ${viewer.org_id} AND id = ${body.assertion_id}
                           AND control_id = ${body.control_id} AND review_status = 'confirmed'`)[0];
      if (!a) throw new ValidationFailure('That check is not a confirmed check on this control.', 'NOT_A_CONTROL_CHECK', [{ field: 'assertion_id', issue: 'not_on_control' }]);
    }
    const s = await remediationSettings(tx, viewer.org_id);
    const expiresAt = endOfDayInTz(body.expires_on, s.timezone);
    if (expiresAt.getTime() <= now.getTime()) {
      throw new ValidationFailure('Pick an end date that has not passed.', 'ALREADY_EXPIRED', [{ field: 'expires_on', issue: 'in_past' }]);
    }
    const cap = BASTION_EXCEPTION_MAX_DAYS[body.scope];
    if (expiresAt.getTime() > now.getTime() + cap * DAY_MS) {
      throw new ValidationFailure(
        body.scope === 'entity'
          ? 'An exception for one item can last at most 365 days.'
          : 'An exception for a whole check can last at most 90 days.',
        'EXPIRY_TOO_LONG',
        [{ field: 'expires_on', issue: `max_${cap}_days` }],
      );
    }
    const ins = await tx`
      INSERT INTO bastion_exceptions (organization_id, control_id, assertion_id, scope, cited_entity_type, cited_entity_id,
                                      reason, compensating_note, status, proposed_by, expires_at, created_at)
      VALUES (${viewer.org_id}, ${body.control_id}, ${body.assertion_id ?? null}, ${body.scope}, ${body.cited_entity_type ?? null},
              ${body.cited_entity_id ?? null}, ${body.reason}, ${body.compensating_note ?? null}, 'proposed', ${viewer.id}, ${expiresAt}, ${now})
      RETURNING id`;
    const exId = String(ins[0]?.id ?? '');
    if (!exId) throw new Error('bastion_exceptions insert returned no row');
    // The approver differs from the proposer where possible: the control owner, else an admin.
    const owner = (c.owner_user_id as string | null) ?? null;
    const approver = owner && owner !== viewer.id ? owner : ((await anOrgAdmin(tx, viewer.org_id, viewer.id)) ?? owner);
    const proposalId = await fileMirroredProposal(tx, viewer, {
      action: 'bastion.exception.accept',
      subject_type: 'bastion.exception',
      subject_id: exId,
      approver_id: approver,
      payload: { exception_id: exId, control_id: body.control_id, scope: body.scope, review_path: '/bastion/review' },
      expires_at: new Date(Math.min(now.getTime() + EXCEPTION_PROPOSAL_TTL_DAYS * DAY_MS, expiresAt.getTime())),
    });
    await tx`UPDATE bastion_exceptions SET proposal_id = ${proposalId} WHERE id = ${exId}`;
    const kind = String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
    await enqueueBastionEvent(
      'exception.proposed',
      { exception_id: exId, control_id: body.control_id, scope: body.scope, expires_at: expiresAt.toISOString(), proposal_id: proposalId },
      tx,
      { orgId: viewer.org_id, idempotencyKey: `exception.proposed:${exId}`, actorId: viewer.id, actorType: kind === 'human' ? 'user' : 'agent' },
    );
    await auditRaw(tx, viewer, 'exception.propose', { type: 'exception', id: exId }, { control_id: body.control_id, scope: body.scope, proposal_id: proposalId });
    return exId;
  });
  return getException(d.engine, viewer, id, d.canAccess);
}

/** The content an approved exception commits to in the ledger (names are personal data). */
export function exceptionContentHash(e: {
  id: string;
  control_id: string;
  assertion_id: string | null;
  scope: string;
  cited_entity_type: string | null;
  cited_entity_id: string | null;
  frozen_refs: CitedRef[] | null;
  reason: string;
  compensating_note: string | null;
  expires_at: Date;
}): string {
  return sha256Hex(
    canonicalJson({
      id: e.id,
      control_id: e.control_id,
      assertion_id: e.assertion_id,
      scope: e.scope,
      cited_entity_type: e.cited_entity_type,
      cited_entity_id: e.cited_entity_id,
      frozen_refs: e.frozen_refs,
      reason: e.reason,
      compensating_note: e.compensating_note,
      expires_at: e.expires_at.toISOString(),
    }),
  );
}

/** POST /exceptions/:id/decide (row 61). */
export async function decideException(d: DecisionDeps, viewer: Viewer, id: string, body: BastionExceptionDecide, opts: { smallTeamThreshold?: number } = {}) {
  const engine = d.engine;
  const now = engine.now();
  const approve = body.decision === 'approve';
  const highest = approve ? await beginLedgerBatch(engine, viewer.org_id) : null;
  try {
    await orgTx(engine.sql, viewer.org_id, async (tx) => {
      // An approval re-ranks the org's gaps (below). Take the gap-rank lock FIRST, before the row
      // lock and the ledger, so the lock order is the same as every other re-rank (#230).
      if (approve) await lockOrgGapRank(tx, viewer.org_id);
      const e = (await tx`SELECT * FROM bastion_exceptions WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
      if (!e) throw new NotFoundError('We could not find that exception.');
      await assertHumanDecider(tx, viewer);
      if (e.status !== 'proposed') throw new ConflictError(`This exception was already ${String(e.status)}.`, 'EXCEPTION_ALREADY_DECIDED');
      const expiresAt = new Date(e.expires_at as string);
      if (expiresAt.getTime() <= now.getTime()) throw new ConflictError('This exception ran out before anyone decided it.', 'EXCEPTION_EXPIRED');

      let selfApproval = false;
      if (approve && e.proposed_by === viewer.id) {
        const humans = await activeHumanCount(tx, viewer.org_id);
        if (!isSmallTeam(humans, opts.smallTeamThreshold)) {
          throw new ForbiddenError('Someone other than the person who proposed this exception has to approve it.', 'SECOND_PERSON_REQUIRED');
        }
        selfApproval = true;
      }

      if (!approve) {
        await tx`UPDATE bastion_exceptions SET status = 'rejected', decided_by = ${viewer.id}, decided_at = ${now} WHERE id = ${id} AND status = 'proposed'`;
      } else {
        // Assertion-wide: freeze the refs failing right now; a new failure later is not covered.
        let frozen: CitedRef[] | null = null;
        if (e.scope === 'assertion') {
          const snap = (await tx`SELECT outcome, cited_refs FROM bastion_evidence_snapshots
                                  WHERE organization_id = ${viewer.org_id} AND assertion_id = ${e.assertion_id as string}
                                  ORDER BY created_at DESC LIMIT 1`)[0];
          frozen = snap?.outcome === 'fail' ? ((snap.cited_refs as CitedRef[] | null) ?? []) : [];
        }
        const names = (await tx`SELECT
            (SELECT display_name FROM users WHERE id = ${e.proposed_by as string}) AS proposed_by_name,
            (SELECT display_name FROM users WHERE id = ${viewer.id}) AS decided_by_name`)[0];
        const pd = { proposed_by_name: names?.proposed_by_name ?? null, decided_by_name: names?.decided_by_name ?? null };
        const pdHmac = engine.pdHmac(pd);
        const contentSha = exceptionContentHash({
          id,
          control_id: String(e.control_id),
          assertion_id: (e.assertion_id as string | null) ?? null,
          scope: String(e.scope),
          cited_entity_type: (e.cited_entity_type as string | null) ?? null,
          cited_entity_id: (e.cited_entity_id as string | null) ?? null,
          frozen_refs: frozen,
          reason: String(e.reason),
          compensating_note: (e.compensating_note as string | null) ?? null,
          expires_at: expiresAt,
        });
        const [entry] = await appendLedger(
          tx,
          viewer.org_id,
          [{ kind: 'exception', id, content_sha256: contentSha, personal_data_hmac: pdHmac, pd_hmac_key_id: engine.pdKeyId }],
          { highest, now },
        );
        // proposed -> active in ONE update: every frozen column is written before the row freezes.
        const upd = await tx`
          UPDATE bastion_exceptions
             SET status = 'active', decided_by = ${viewer.id}, decided_at = ${now}, small_team_self_approval = ${selfApproval},
                 frozen_refs = ${frozen === null ? null : tx.json(frozen as never)}, personal_data_hmac = ${pdHmac},
                 pd_hmac_key_id = ${engine.pdKeyId}, ledger_seq = ${entry?.seq ?? null}
           WHERE id = ${id} AND status = 'proposed'
          RETURNING id`;
        if (upd.length === 0) throw new ConflictError('This exception was decided by someone else first.', 'EXCEPTION_ALREADY_DECIDED');
        await tx`
          INSERT INTO bastion_personal_data (organization_id, holder_kind, holder_id, data, data_hmac, pd_hmac_key_id)
          VALUES (${viewer.org_id}, 'exception', ${id}, ${tx.json(pd as never)}, ${pdHmac}, ${engine.pdKeyId})
          ON CONFLICT (organization_id, holder_kind, holder_id) DO NOTHING`;
        await tx`UPDATE bastion_controls SET active_exception_count = active_exception_count + 1
                  WHERE organization_id = ${viewer.org_id} AND id = ${e.control_id as string}`;
        const s = await remediationSettings(tx, viewer.org_id);
        await enqueueBastionEvent(
          'exception.approved',
          { exception_id: id, control_id: e.control_id, scope: e.scope, expires_at: expiresAt.toISOString(), small_team_self_approval: selfApproval },
          tx,
          { orgId: viewer.org_id, idempotencyKey: `exception.approved:${id}`, orderingKey: `control:${String(e.control_id)}`, actorId: viewer.id, actorType: 'user' },
        );
        await enqueueTaskComment(tx, viewer.org_id, s, {
          control_id: String(e.control_id),
          body: `Risk accepted until ${localDate(expiresAt, s.timezone)}: ${String(e.reason)}`.slice(0, 4000),
          idempotency_key: `exception:${id}:approved:bam_task_comment`,
        });
        // The covered failure stops being a gap right away (it moves to "Accepted risks").
        await rankOrgGaps(tx, viewer.org_id, now);
      }
      if (e.proposal_id) {
        await enqueueProposalClose(tx, viewer.org_id, {
          proposal_id: String(e.proposal_id),
          decision: approve ? 'approved' : 'rejected',
          decided_by: viewer.id,
          reason: body.reason ?? null,
          ordering_key: `exception:${id}`,
        });
      }
      await auditRaw(tx, viewer, approve ? 'exception.approve' : 'exception.reject', { type: 'exception', id }, {
        reason: body.reason ?? null,
        small_team_self_approval: selfApproval,
      });
    });
  } catch (err) {
    throw mapAppendError(err);
  }
  return getException(engine, viewer, id, d.canAccess);
}

// ── Expiry (inside bastion-evidence-expiry, spec 2.6) ───────────────────────────────────

export interface ExceptionExpiryResult {
  expired: number;
  drifted: number;
}

/**
 * Expire every active exception whose time is up in one org, inside the caller's transaction.
 * For each: compare-and-set the status, then compare the control's effective state with and
 * without it; when it worsens, insert the exception-expiry drift row ON CONFLICT DO NOTHING and,
 * only when that inserted a row, write control.drifted and the task upsert ("Accepted risk
 * expired on {date}"). exception.expired is published either way.
 */
export async function expireExceptions(tx: Tx, orgId: string, now: Date): Promise<ExceptionExpiryResult> {
  // The expiry re-ranks the gaps at the end: take that lock before any write (#230).
  await lockOrgGapRank(tx, orgId);
  const due = await tx`SELECT id, control_id, expires_at FROM bastion_exceptions
                        WHERE organization_id = ${orgId} AND status = 'active' AND expires_at <= ${now} ORDER BY expires_at`;
  if (due.length === 0) return { expired: 0, drifted: 0 };
  const states = await loadControlStates(tx, orgId, now);
  const s = await remediationSettings(tx, orgId);
  const out: ExceptionExpiryResult = { expired: 0, drifted: 0 };
  let live: ExceptionRow[] = [...states.exceptions];
  for (const ex of due) {
    const exId = String(ex.id);
    const controlId = String(ex.control_id);
    const cas = await tx`UPDATE bastion_exceptions SET status = 'expired' WHERE id = ${exId} AND status = 'active' RETURNING id`;
    if (cas.length === 0) continue;
    out.expired += 1;
    await tx`UPDATE bastion_controls SET active_exception_count = greatest(active_exception_count - 1, 0)
              WHERE organization_id = ${orgId} AND id = ${controlId}`;
    const expiresAt = new Date(ex.expires_at as string);
    await enqueueBastionEvent('exception.expired', { exception_id: exId, control_id: controlId, expired_at: expiresAt.toISOString() }, tx, {
      orgId,
      idempotencyKey: `exception.expired:${exId}`,
      orderingKey: `control:${controlId}`,
    });

    const control = states.controls.find((c) => c.control_id === controlId);
    if (!control) {
      live = live.filter((e) => e.id !== exId);
      continue;
    }
    // Before: as if the exception were still in force. After: without it.
    const stillCovering = live.map((e) => (e.id === exId ? { ...e, expires_at: new Date(now.getTime() + DAY_MS) } : e));
    const before = verdictOf(control, stillCovering, states.stale_after_hours, now);
    live = live.filter((e) => e.id !== exId);
    const after = verdictOf(control, live, states.stale_after_hours, now);
    if (!before.state || !after.state) continue;
    if (BASTION_EFFECTIVE_STATE_SEVERITY[after.state] <= BASTION_EFFECTIVE_STATE_SEVERITY[before.state]) continue;

    const taskStatus = driftTaskStatus(s);
    const ins = await tx`
      INSERT INTO bastion_drift_events (organization_id, control_id, evaluation_run_id, from_status, to_status, reason, task_status, detected_at, exception_id)
      VALUES (${orgId}, ${controlId}, NULL, ${before.state}, ${after.state}, 'exception_expired', ${taskStatus}, ${now}, ${exId})
      ON CONFLICT (organization_id, exception_id, control_id) WHERE exception_id IS NOT NULL DO NOTHING
      RETURNING id`;
    const driftId = ins[0]?.id as string | undefined;
    if (!driftId) continue;
    out.drifted += 1;
    await enqueueBastionEvent(
      'control.drifted',
      { control_id: controlId, drift_id: driftId, from_status: before.state, to_status: after.state, reason: 'exception_expired', exception_id: exId },
      tx,
      { orgId, idempotencyKey: `drift:exception:${exId}:control.drifted`, orderingKey: `control:${controlId}` },
    );
    if (taskStatus === 'pending') {
      await enqueueDriftTask(tx, orgId, s, {
        control_id: controlId,
        drift_id: driftId,
        now,
        reopen_comment: `Accepted risk expired on ${localDate(expiresAt, s.timezone)}.`,
        idempotency_base: `drift:exception:${exId}`,
      });
    }
  }
  await rankOrgGaps(tx, orgId, now);
  return out;
}
