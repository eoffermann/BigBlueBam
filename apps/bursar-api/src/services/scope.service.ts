import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { publishBoltEvent } from '@bigbluebam/shared';
import type {
  BursarApplyLibrary,
  BursarConfirmScope,
  BursarDeriveScope,
  BursarPromoteRival,
  BursarScopeNodeCreate,
  BursarScopeNodeUpdate,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  bursarExtractionRuns,
  bursarOffers,
  bursarRequests,
  bursarScopeLibrary,
  bursarScopeNodes,
  bursarVendors,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { scanForInjection } from '../lib/injection-prescan.js';
import { tallyDistinctSupporters, canAutoPromoteRival, type RivalSupporter } from '../lib/rival-support.js';
import { enqueueDerivation } from '../lib/queue.js';
import { isAdminViewer, type Viewer } from './types.js';

// Scope derivation and the confirmed tree (spec 3.2, M3). Every query carries an explicit
// organization_id predicate. Derivation is ASYNC-START: this service creates the run row + sets
// scope_status='deriving' + enqueues, and returns a run id; the engine (derivation.engine.ts)
// does the bounded, one-chunk-per-invocation work under a lease.

const DERIVABLE_FROM = new Set(['none', 'pending', 'derived']);

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 64);
}

async function loadRequest(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bursarRequests)
    .where(and(eq(bursarRequests.organization_id, orgId), eq(bursarRequests.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Request not found');
  return row;
}

async function loadNode(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bursarScopeNodes)
    .where(and(eq(bursarScopeNodes.organization_id, orgId), eq(bursarScopeNodes.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Scope node not found');
  return row;
}

/* ------------------------------------------------------------------ */
/*  Derivation kickoff (async-start)                                  */
/* ------------------------------------------------------------------ */

export async function deriveScope(viewer: Viewer, requestId: string, body: BursarDeriveScope) {
  const outcome = await runInOrgScope(viewer.org_id, async (tx) => {
    const request = await loadRequest(tx, viewer.org_id, requestId);

    if (!DERIVABLE_FROM.has(request.scope_status)) {
      if (request.scope_status === 'deriving') {
        throw new ConflictError('Scope derivation is already in progress for this request', {
          scope_status: request.scope_status,
        });
      }
      throw new ValidationFailure(
        `Scope cannot be derived from status '${request.scope_status}'`,
        'SCOPE_NOT_DERIVABLE',
      );
    }

    // Source priority: explicit inline text > Bin document (worker reads bytes) > description.
    const inlineText = body.source_text ?? (!request.bin_asset_id ? request.description ?? null : null);
    if (!inlineText && !request.bin_asset_id) {
      throw new ValidationFailure(
        'Request has no source document or text to derive a scope tree from',
        'NO_SOURCE',
      );
    }

    const sourceDocHash = inlineText ? sha(inlineText) : request.source_doc_hash;

    await tx
      .update(bursarRequests)
      .set({ scope_status: 'deriving', source_doc_hash: sourceDocHash, updated_at: new Date() })
      .where(and(eq(bursarRequests.organization_id, viewer.org_id), eq(bursarRequests.id, requestId)));

    const [run] = await tx
      .insert(bursarExtractionRuns)
      .values({
        organization_id: viewer.org_id,
        request_id: requestId,
        status: 'running',
        source_doc_hash: sourceDocHash,
      })
      .returning({ id: bursarExtractionRuns.id });

    // Stage 0 injection pre-scan (spec 5.5) is deferred to the engine boundary
    // (runInjectionPrescan), so the SAME logic covers both the inline text and the Bin-byte path
    // (the worker never needs to import bursar-api). It runs on the exact bytes the engine sees.
    return { run_id: run!.id, inline_text: inlineText };
  });

  // Enqueue AFTER the transaction commits. Best-effort: the reaper recovers a dropped enqueue.
  const enqueued = await enqueueDerivation({
    organization_id: viewer.org_id,
    request_id: requestId,
    run_id: outcome.run_id,
    source_text: outcome.inline_text ?? undefined,
  });

  return {
    data: {
      run_id: outcome.run_id,
      scope_status: 'deriving' as const,
      enqueued,
    },
  };
}

/**
 * Stage 0 injection pre-scan on the request document (spec 5.5), persisted at the engine
 * boundary so the inline-text path and the Bin-byte path share one implementation. Idempotent:
 * safe to re-run when a throttle re-enters at chunk 0. Sets bursar_requests.injection_suspected
 * + injection_signals and opens/refreshes the request_manipulation_suspected finding.
 */
export async function runInjectionPrescan(orgId: string, requestId: string, sourceText: string) {
  const scan = scanForInjection(sourceText);
  const signals = { categories: scan.categories, spans: scan.spans };
  await runInOrgScope(orgId, async (tx) => {
    await tx
      .update(bursarRequests)
      .set({ injection_suspected: scan.suspected, injection_signals: signals, updated_at: new Date() })
      .where(and(eq(bursarRequests.organization_id, orgId), eq(bursarRequests.id, requestId)));

    if (scan.suspected) {
      const dedupKey = sha(`request_manipulation_suspected|${requestId}`);
      const evidenceHash = sha(JSON.stringify(signals));
      await tx.execute(sql`
        INSERT INTO bursar_mismatches (organization_id, detector, severity, status, dedup_key, evidence_hash, request_id, cited_span, details)
        VALUES (${orgId}, 'request_manipulation_suspected', 'high', 'open', ${dedupKey}, ${evidenceHash}, ${requestId},
                ${JSON.stringify({ spans: scan.spans })}::jsonb, ${JSON.stringify(signals)}::jsonb)
        ON CONFLICT (organization_id, dedup_key) DO UPDATE SET
          status = CASE WHEN bursar_mismatches.status = 'dismissed' THEN bursar_mismatches.status ELSE 'open' END,
          evidence_hash = EXCLUDED.evidence_hash, details = EXCLUDED.details, cited_span = EXCLUDED.cited_span,
          last_seen_at = now(), updated_at = now()
      `);
    }
  });
  return { suspected: scan.suspected, signals };
}

/* ------------------------------------------------------------------ */
/*  Reads                                                             */
/* ------------------------------------------------------------------ */

export async function getScope(viewer: Viewer, requestId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const request = await loadRequest(tx, viewer.org_id, requestId);
    const nodes = await tx
      .select()
      .from(bursarScopeNodes)
      .where(
        and(
          eq(bursarScopeNodes.organization_id, viewer.org_id),
          eq(bursarScopeNodes.request_id, requestId),
          isNull(bursarScopeNodes.archived_at),
        ),
      )
      .orderBy(asc(bursarScopeNodes.ordinal), asc(bursarScopeNodes.created_at));
    const [run] = await tx
      .select()
      .from(bursarExtractionRuns)
      .where(
        and(
          eq(bursarExtractionRuns.organization_id, viewer.org_id),
          eq(bursarExtractionRuns.request_id, requestId),
        ),
      )
      .orderBy(desc(bursarExtractionRuns.started_at))
      .limit(1);
    return { data: { request, nodes, latest_run: run ?? null } };
  });
}

/* ------------------------------------------------------------------ */
/*  Node CRUD                                                         */
/* ------------------------------------------------------------------ */

export async function addNode(viewer: Viewer, requestId: string, data: BursarScopeNodeCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadRequest(tx, viewer.org_id, requestId);
    if (data.parent_id) {
      // Guard the self-FK: a parent must exist in THIS request (defense in depth over the FK).
      const [parent] = await tx
        .select({ id: bursarScopeNodes.id })
        .from(bursarScopeNodes)
        .where(
          and(
            eq(bursarScopeNodes.organization_id, viewer.org_id),
            eq(bursarScopeNodes.request_id, requestId),
            eq(bursarScopeNodes.id, data.parent_id),
          ),
        )
        .limit(1);
      if (!parent) throw new ValidationFailure('parent_id does not belong to this request', 'BAD_PARENT');
    }
    const [row] = await tx
      .insert(bursarScopeNodes)
      .values({
        organization_id: viewer.org_id,
        request_id: requestId,
        parent_id: data.parent_id ?? null,
        title: data.title,
        description: data.description ?? null,
        node_kind: data.node_kind,
        normative_strength: data.normative_strength,
        unit: data.unit ?? null,
        quantity: data.quantity === null || data.quantity === undefined ? null : String(data.quantity),
        // Precedence table: a human node is derived_from 'human' and confirmed as set.
        derived_from: 'human',
        review_status: 'confirmed',
        dedup_key: sha(`human|${nanoid()}`),
      })
      .returning();
    return { data: row };
  });
}

export async function updateNode(viewer: Viewer, nodeId: string, patch: BursarScopeNodeUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadNode(tx, viewer.org_id, nodeId);
    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.node_kind !== undefined) values.node_kind = patch.node_kind;
    if (patch.normative_strength !== undefined) values.normative_strength = patch.normative_strength;
    if (patch.unit !== undefined) values.unit = patch.unit;
    if (patch.quantity !== undefined) values.quantity = patch.quantity === null ? null : String(patch.quantity);
    if (patch.review_status !== undefined) values.review_status = patch.review_status;
    const [row] = await tx
      .update(bursarScopeNodes)
      .set(values)
      .where(and(eq(bursarScopeNodes.organization_id, viewer.org_id), eq(bursarScopeNodes.id, nodeId)))
      .returning();
    return { data: row };
  });
}

/** DELETE archives (soft), never a hard delete. */
export async function archiveNode(viewer: Viewer, nodeId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadNode(tx, viewer.org_id, nodeId);
    const [row] = await tx
      .update(bursarScopeNodes)
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where(and(eq(bursarScopeNodes.organization_id, viewer.org_id), eq(bursarScopeNodes.id, nodeId)))
      .returning({ id: bursarScopeNodes.id, archived_at: bursarScopeNodes.archived_at });
    return { data: row };
  });
}

/* ------------------------------------------------------------------ */
/*  Apply library                                                    */
/* ------------------------------------------------------------------ */

export async function applyLibrary(viewer: Viewer, requestId: string, body: BursarApplyLibrary) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadRequest(tx, viewer.org_id, requestId);
    // Library rows are readable when global OR owned by this org. (Writes to the library filter
    // is_global=false; this is a READ of the library into the tree, so globals are admissible.)
    const entries = await tx
      .select()
      .from(bursarScopeLibrary)
      .where(
        and(
          inArray(bursarScopeLibrary.id, body.library_ids),
          or(eq(bursarScopeLibrary.is_global, true), eq(bursarScopeLibrary.organization_id, viewer.org_id)),
        ),
      );
    if (entries.length === 0) throw new ValidationFailure('No visible library entries matched', 'NO_LIBRARY');

    let inserted = 0;
    for (const e of entries) {
      const dedupKey = sha(`library|${e.id}`);
      const res = await tx.execute(sql`
        INSERT INTO bursar_scope_nodes (
          organization_id, request_id, title, description, node_kind, normative_strength,
          unit, quantity, derived_from, review_status, dedup_key
        ) VALUES (
          ${viewer.org_id}, ${requestId}, ${e.title}, ${e.description}, ${e.node_kind},
          'should_have', ${e.unit}, ${e.default_quantity}, 'library', 'pending_review', ${dedupKey}
        )
        ON CONFLICT (organization_id, request_id, dedup_key) DO NOTHING
        RETURNING id
      `);
      const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as unknown[];
      inserted += rows.length;
    }
    return { data: { applied: inserted, requested: body.library_ids.length } };
  });
}

/* ------------------------------------------------------------------ */
/*  Confirm                                                           */
/* ------------------------------------------------------------------ */

export async function confirmScope(viewer: Viewer, requestId: string, body: BursarConfirmScope) {
  const result = await runInOrgScope(viewer.org_id, async (tx) => {
    const request = await loadRequest(tx, viewer.org_id, requestId);

    // 409 while deriving.
    if (request.scope_status === 'deriving') {
      throw new ConflictError('Scope derivation is in progress; cannot confirm yet', {
        scope_status: request.scope_status,
      });
    }
    if (request.scope_status !== 'derived') {
      throw new ValidationFailure(
        `Scope must be 'derived' before it can be confirmed (currently '${request.scope_status}')`,
        'NOT_DERIVED',
      );
    }

    // Blocked while injection_suspected, until the flagged spans are cleared (spec 5.5).
    let injectionSuspected = request.injection_suspected;
    if (injectionSuspected) {
      if (body.clear_injection && isAdminViewer(viewer)) {
        injectionSuspected = false;
        // Resolve the open finding.
        await tx.execute(sql`
          UPDATE bursar_mismatches SET status = 'resolved', resolved_by = ${viewer.id}, resolved_at = now(), updated_at = now()
           WHERE organization_id = ${viewer.org_id} AND request_id = ${requestId} AND detector = 'request_manipulation_suspected' AND status = 'open'
        `);
      } else {
        throw new ConflictError(
          'Scope confirm is blocked: request manipulation suspected. Clear the flagged spans first (admins may pass clear_injection).',
          { injection_suspected: true, injection_signals: request.injection_signals },
        );
      }
    }

    const [row] = await tx
      .update(bursarRequests)
      .set({
        scope_status: 'confirmed',
        injection_suspected: injectionSuspected,
        scope_confirmed_at: new Date(),
        scope_confirmed_by: viewer.id,
        updated_at: new Date(),
      })
      .where(and(eq(bursarRequests.organization_id, viewer.org_id), eq(bursarRequests.id, requestId)))
      .returning();
    return row!;
  });

  // A confirmed tree publishes a Bolt event; an unconfirmed tree publishes none (spec 3.2).
  await publishBoltEvent(
    'scope.confirmed',
    'bursar',
    { 'request.id': requestId, 'org.id': viewer.org_id },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});

  return { data: result };
}

/* ------------------------------------------------------------------ */
/*  Promote a rival proposal                                          */
/* ------------------------------------------------------------------ */

export async function promoteRival(viewer: Viewer, nodeId: string, _body: BursarPromoteRival) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const node = await loadNode(tx, viewer.org_id, nodeId);
    if (node.archived_at) throw new NotFoundError('Scope node not found');
    if (node.derived_from !== 'rival_offer') {
      throw new ValidationFailure('Only rival-derived proposals can be promoted', 'NOT_RIVAL');
    }
    if (node.review_status !== 'pending_review') {
      throw new ValidationFailure('Proposal is not pending review', 'NOT_PENDING');
    }

    const offerIds = (node.contributing_offer_ids ?? []) as string[];
    let supporters: RivalSupporter[] = [];
    if (offerIds.length > 0) {
      const rows = await tx
        .select({
          offer_id: bursarOffers.id,
          bond_company_id: bursarVendors.bond_company_id,
          injection_suspected: bursarOffers.injection_suspected,
          blanket_suspected: bursarOffers.blanket_suspected,
        })
        .from(bursarOffers)
        .leftJoin(bursarVendors, eq(bursarVendors.id, bursarOffers.vendor_id))
        .where(
          and(
            eq(bursarOffers.organization_id, viewer.org_id),
            inArray(bursarOffers.id, offerIds),
          ),
        );
      supporters = rows.map((r) => ({
        offer_id: r.offer_id,
        // braid_profile_id resolution is layered in when rival nodes materialize (M5); the
        // bond_company_id fallback is the identity used here, never vendor_id.
        braid_profile_id: null,
        bond_company_id: r.bond_company_id ?? null,
        injection_suspected: r.injection_suspected,
        blanket_suspected: r.blanket_suspected,
      }));
    }

    const tally = tallyDistinctSupporters(supporters);
    if (!canAutoPromoteRival(tally)) {
      throw new ValidationFailure(
        `Promotion needs at least 2 distinct real-world supporters; found ${tally.distinct} distinct` +
          (tally.undecided ? `, ${tally.undecided} unresolved (need a human decision)` : '') +
          (tally.excluded ? `, ${tally.excluded} excluded as suspected` : ''),
        'INSUFFICIENT_SUPPORT',
      );
    }

    const [row] = await tx
      .update(bursarScopeNodes)
      .set({ review_status: 'confirmed', updated_at: new Date() })
      .where(and(eq(bursarScopeNodes.organization_id, viewer.org_id), eq(bursarScopeNodes.id, nodeId)))
      .returning();

    // Echo contributing_offer_ids so the audit records what the promoter was shown (spec 4.5).
    return {
      data: row,
      contributing_offer_ids: offerIds,
      distinct_supporters: tally.distinct,
      supporter_keys: tally.keys,
    };
  });
}
