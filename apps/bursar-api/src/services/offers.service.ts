import { createHash } from 'node:crypto';
import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarOfferCreate, BursarOfferUpload, BursarUnsealOffer } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bursarOffers, bursarOfferLines, bursarRequests } from '../db/schema/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import { decodeCursor, paginate } from '../lib/pagination.js';
import { assertBinAssetReadable } from '../lib/bin-asset-access.js';
import { makeBinAssetAccessDeps } from '../lib/bin-asset-access.db.js';
import { applySeal, isSealed } from '../lib/seal.js';
import { enqueueOfferParse } from '../lib/queue.js';
import type { Viewer } from './types.js';

// Offer ingest + read surface (spec 11, M4). Every query carries an explicit organization_id
// predicate. Reads project through the shared SEAL predicate (spec 5.6) so a sealed rival bid's
// competitive content (prices, raw_text, cited spans) is withheld until unseal; the financial
// floor (spend_read_all) is applied on top at the route serializer.

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

async function loadOffer(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bursarOffers)
    .where(and(eq(bursarOffers.organization_id, orgId), eq(bursarOffers.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError('Offer not found');
  return row;
}

/** Whether a sealed offer's competitive content must be withheld from this read (spec 5.6). The
 *  seal is purely time/unseal based at M4: once sealed_until is cleared or elapsed, content is
 *  visible to everyone. */
function sealedNow(offer: { sealed_until: Date | string | null }): boolean {
  return isSealed({ sealed_until: offer.sealed_until });
}

export interface OfferListParams {
  cursor?: string;
  limit: number;
}

export async function listOffers(viewer: Viewer, requestId: string, params: OfferListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadRequest(tx, viewer.org_id, requestId);
    const cur = decodeCursor(params.cursor);
    const conds = [
      eq(bursarOffers.organization_id, viewer.org_id),
      eq(bursarOffers.request_id, requestId),
    ];
    if (cur) {
      conds.push(
        or(
          lt(bursarOffers.created_at, new Date(cur.createdAt)),
          and(eq(bursarOffers.created_at, new Date(cur.createdAt)), lt(bursarOffers.id, cur.id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(bursarOffers)
      .where(and(...conds))
      .orderBy(desc(bursarOffers.created_at), desc(bursarOffers.id))
      .limit(params.limit + 1);
    const { items, next_cursor } = paginate(rows, params.limit);
    const projected = items.map((o) => applySeal(o, sealedNow(o)));
    return { data: projected, next_cursor };
  });
}

export async function createOffer(
  viewer: Viewer,
  requestId: string,
  data: BursarOfferCreate,
  actingUserId: string,
) {
  const outcome = await runInOrgScope(viewer.org_id, async (tx) => {
    await loadRequest(tx, viewer.org_id, requestId);

    let binAssetId: string | null = null;
    let binAssetVersionId: string | null = null;
    if (data.bin_asset_id) {
      // §5.8: four-check gate, 404 on any failure, then PIN the resolved version.
      const { bin_asset_version_id } = await assertBinAssetReadable(
        makeBinAssetAccessDeps(tx),
        actingUserId,
        viewer.org_id,
        data.bin_asset_id,
      );
      binAssetId = data.bin_asset_id;
      binAssetVersionId = bin_asset_version_id;
    }

    const inlineText = data.source_text ?? null;
    if (!inlineText && !binAssetId) {
      throw new ValidationFailure('An offer needs a Bin document or inline source text', 'NO_SOURCE');
    }
    // A deterministic, non-empty source_doc_hash so the (org, request, vendor, hash) dedup means
    // "the same document from the same vendor is one offer". Inline text hashes its content; a Bin
    // document keys on the pinned version so the same pinned bytes dedup.
    const sourceDocHash = inlineText ? sha(inlineText) : sha(`bin:${binAssetVersionId}`);

    const [row] = await tx
      .insert(bursarOffers)
      .values({
        organization_id: viewer.org_id,
        request_id: requestId,
        vendor_id: data.vendor_id ?? null,
        label: data.label ?? null,
        currency: data.currency,
        bin_asset_id: binAssetId,
        bin_asset_version_id: binAssetVersionId,
        source_doc_hash: sourceDocHash,
        source_format: data.source_format ?? null,
        sealed_until: data.sealed_until ? new Date(data.sealed_until) : null,
        normalization_status: 'pending',
        created_by: viewer.id,
      })
      .returning();
    return { offer: row!, inlineText };
  });

  // Fire the deterministic parse after commit (event-triggered; worker registration is M8).
  const enqueued = await enqueueOfferParse({
    organization_id: viewer.org_id,
    offer_id: outcome.offer.id,
    source_text: outcome.inlineText ?? undefined,
  });

  await publishBoltEvent(
    'offer.received',
    'bursar',
    { 'offer.id': outcome.offer.id, 'request.id': requestId, 'org.id': viewer.org_id },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});

  return { data: applySeal(outcome.offer, sealedNow(outcome.offer)), enqueued };
}

export async function getOffer(viewer: Viewer, offerId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const offer = await loadOffer(tx, viewer.org_id, offerId);
    return { data: applySeal(offer, sealedNow(offer)) };
  });
}

export async function getOfferLines(viewer: Viewer, offerId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const offer = await loadOffer(tx, viewer.org_id, offerId);
    const lines = await tx
      .select()
      .from(bursarOfferLines)
      .where(and(eq(bursarOfferLines.organization_id, viewer.org_id), eq(bursarOfferLines.offer_id, offerId)))
      .orderBy(asc(bursarOfferLines.ordinal));
    // Lines inherit their offer's seal: while sealed, raw_text + prices are withheld.
    const sealed = sealedNow(offer);
    return { data: applySeal({ offer_id: offerId, sealed, lines }, sealed) };
  });
}

/**
 * Ingest/reattach and (re)parse. Accepts a Bin asset reference to attach + pin (§5.8) or inline
 * source text, then enqueues the deterministic parse (spec 4.1). The multipart envelope is handled
 * at the route; the resolved fields arrive here.
 */
export async function uploadOffer(
  viewer: Viewer,
  offerId: string,
  data: BursarOfferUpload,
  actingUserId: string,
) {
  const outcome = await runInOrgScope(viewer.org_id, async (tx) => {
    const offer = await loadOffer(tx, viewer.org_id, offerId);
    const values: Record<string, unknown> = { updated_at: new Date(), normalization_status: 'pending' };
    let inlineText: string | null = null;

    if (data.bin_asset_id) {
      const { bin_asset_version_id } = await assertBinAssetReadable(
        makeBinAssetAccessDeps(tx),
        actingUserId,
        viewer.org_id,
        data.bin_asset_id,
      );
      values.bin_asset_id = data.bin_asset_id;
      values.bin_asset_version_id = bin_asset_version_id;
      values.source_doc_hash = sha(`bin:${bin_asset_version_id}`);
    } else if (data.source_text != null) {
      inlineText = data.source_text;
      values.source_doc_hash = sha(data.source_text);
    } else if (!offer.bin_asset_version_id) {
      throw new ValidationFailure('Upload needs a Bin document or inline source text', 'NO_SOURCE');
    }
    if (data.source_format !== undefined && data.source_format !== null) values.source_format = data.source_format;
    if (data.vendor_id !== undefined) values.vendor_id = data.vendor_id;

    const [row] = await tx
      .update(bursarOffers)
      .set(values)
      .where(and(eq(bursarOffers.organization_id, viewer.org_id), eq(bursarOffers.id, offerId)))
      .returning();
    return { offer: row!, inlineText };
  });

  const enqueued = await enqueueOfferParse({
    organization_id: viewer.org_id,
    offer_id: offerId,
    source_text: outcome.inlineText ?? undefined,
  });
  return { data: applySeal(outcome.offer, sealedNow(outcome.offer)), enqueued };
}

/** Re-run the deterministic parse on the current bytes/text (spec 11). Idempotent. */
export async function reparseOffer(viewer: Viewer, offerId: string) {
  const offer = await runInOrgScope(viewer.org_id, async (tx) => loadOffer(tx, viewer.org_id, offerId));
  const enqueued = await enqueueOfferParse({ organization_id: viewer.org_id, offer_id: offerId });
  return { data: { offer_id: offerId, request_id: offer.request_id, enqueued } };
}

/**
 * Unseal a sealed offer (floored, confirm-required at the route). Clears sealed_until, writes an
 * activity_log row, and publishes offer.unsealed (spec 5.6): the audit is a security requirement.
 */
export async function unsealOffer(viewer: Viewer, offerId: string, body: BursarUnsealOffer) {
  const result = await runInOrgScope(viewer.org_id, async (tx) => {
    const offer = await loadOffer(tx, viewer.org_id, offerId);
    // The unseal audit is required whether or not the seal was still active, so an unseal of an
    // already-open offer still leaves a trail (spec 5.6). It is persisted on the offer row
    // (unsealed_at / by / reason) rather than the Bam activity_log, which is project-scoped
    // (project_id NOT NULL) and cannot represent an org-only bursar event; the durable
    // offer.unsealed Bolt event below is the platform's cross-app audit fan-out (§16 / §25).
    const [row] = await tx
      .update(bursarOffers)
      .set({
        sealed_until: null,
        unsealed_at: new Date(),
        unsealed_by: viewer.id,
        unseal_reason: body.reason ?? null,
        updated_at: new Date(),
      })
      .where(and(eq(bursarOffers.organization_id, viewer.org_id), eq(bursarOffers.id, offerId)))
      .returning();
    return { offer: row!, request_id: offer.request_id };
  });

  await publishBoltEvent(
    'offer.unsealed',
    'bursar',
    { 'offer.id': offerId, 'request.id': result.request_id, 'org.id': viewer.org_id },
    viewer.org_id,
    viewer.id,
  ).catch(() => {});

  return { data: applySeal(result.offer, sealedNow(result.offer)) };
}

/** Delete an offer (spec 11). Lines, matches, coverage, and totals CASCADE from the offer. */
export async function deleteOffer(viewer: Viewer, offerId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadOffer(tx, viewer.org_id, offerId);
    await tx
      .delete(bursarOffers)
      .where(and(eq(bursarOffers.organization_id, viewer.org_id), eq(bursarOffers.id, offerId)));
    return { data: { id: offerId, deleted: true } };
  });
}
