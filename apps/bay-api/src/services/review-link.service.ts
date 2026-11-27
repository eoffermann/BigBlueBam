import { and, eq, asc, desc, sql } from 'drizzle-orm';
import {
  hashReviewToken,
  hashesEqual,
  isWellFormedReviewToken,
  mintMediaTicket,
  mintReviewToken,
  verifyMediaTicket,
} from '../lib/review-token.js';
import { db } from '../db/index.js';
import {
  bayReviewLinks,
  bayAssets,
  bayAssetVersions,
  bayAnnotations,
  bayReviewDecisions,
} from '../db/schema/index.js';
import { users } from '../db/schema/bbb-refs.js';
import { env } from '../env.js';
import { NotFoundError, GoneError, ForbiddenError } from './errors.js';

export interface CreateLinkInput {
  asset_id: string;
  expires_in_days?: number | null;
  allow_comments?: boolean;
}

/** The guest URL. The token rides in the fragment, which browsers never send to a server (#122). */
function shareUrl(token: string): string {
  return `${env.PUBLIC_URL.replace(/\/+$/, '')}/bay/r#${token}`;
}

type LinkRow = typeof bayReviewLinks.$inferSelect;

/** A link as the API returns it: never the token hash. */
function publicShape(link: LinkRow) {
  const { token_hash: _hash, ...rest } = link;
  return rest;
}

/** Mint a share link for a review the caller's org owns. */
export async function createReviewLink(orgId: string, userId: string, input: CreateLinkInput) {
  const asset = await db
    .select({ id: bayAssets.id })
    .from(bayAssets)
    .where(and(eq(bayAssets.id, input.asset_id), eq(bayAssets.org_id, orgId)))
    .limit(1);
  if (!asset[0]) throw new NotFoundError('Review not found');

  const token = mintReviewToken();
  const expiresAt =
    input.expires_in_days && input.expires_in_days > 0
      ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000)
      : null;

  const rows = await db
    .insert(bayReviewLinks)
    .values({
      org_id: orgId,
      asset_id: input.asset_id,
      token_hash: hashReviewToken(token),
      allow_comments: input.allow_comments ?? true,
      created_by: userId,
      expires_at: expiresAt,
    })
    .returning();
  const link = rows[0]!;
  // The only time the raw token (and so the URL) is ever returned (#122).
  return { ...publicShape(link), token, url: shareUrl(token) };
}

/** List share links for one review (org-scoped). Tokens are not stored, so no URL is returned. */
export async function listReviewLinks(orgId: string, assetId: string) {
  const rows = await db
    .select()
    .from(bayReviewLinks)
    .where(and(eq(bayReviewLinks.org_id, orgId), eq(bayReviewLinks.asset_id, assetId)))
    .orderBy(desc(bayReviewLinks.created_at));
  return rows.map(publicShape);
}

/** Revoke a share link (org-scoped). Idempotent. */
export async function revokeReviewLink(id: string, orgId: string) {
  const rows = await db
    .update(bayReviewLinks)
    .set({ revoked_at: new Date() })
    .where(and(eq(bayReviewLinks.id, id), eq(bayReviewLinks.org_id, orgId)))
    .returning();
  if (!rows[0]) throw new NotFoundError('Share link not found');
  return publicShape(rows[0]);
}

// ---------------------------------------------------------------------------
// Public (token-bearer) access — NO org scoping; the token is the credential.
// ---------------------------------------------------------------------------

/** 404 (not 410) for missing/revoked so we don't confirm a token ever existed. */
function assertActive(link: LinkRow | undefined): LinkRow {
  if (!link || link.revoked_at) throw new NotFoundError('Link not found');
  if (link.expires_at && link.expires_at.getTime() < Date.now()) {
    throw new GoneError('This share link has expired');
  }
  return link;
}

async function getActiveLink(token: string) {
  if (!isWellFormedReviewToken(token)) throw new NotFoundError('Link not found');
  const hash = hashReviewToken(token);
  const rows = await db
    .select()
    .from(bayReviewLinks)
    .where(eq(bayReviewLinks.token_hash, hash))
    .limit(1);
  const link = rows[0];
  if (link && !hashesEqual(link.token_hash, hash)) throw new NotFoundError('Link not found');
  return assertActive(link);
}

/** Assemble the read-only review bundle for a guest. Returns only safe fields
 *  (no org_id, no internal storage keys), plus a short-lived media ticket. */
export async function getPublicReviewByToken(token: string) {
  const link = await getActiveLink(token);

  // Bump view stats; never block the read on it.
  void db
    .update(bayReviewLinks)
    .set({ view_count: sql`${bayReviewLinks.view_count} + 1`, last_viewed_at: new Date() })
    .where(eq(bayReviewLinks.id, link.id))
    .catch(() => undefined);

  const assetRows = await db
    .select({
      id: bayAssets.id,
      name: bayAssets.name,
      media_kind: bayAssets.media_kind,
      current_version_id: bayAssets.current_version_id,
    })
    .from(bayAssets)
    .where(eq(bayAssets.id, link.asset_id))
    .limit(1);
  const asset = assetRows[0];
  if (!asset) throw new NotFoundError('Review not found');

  let version: { id: string; version_number: number; bin_asset_id: string | null; media_meta: unknown } | null =
    null;
  let annotations: unknown[] = [];
  let decisions: unknown[] = [];

  if (asset.current_version_id) {
    const vRows = await db
      .select({
        id: bayAssetVersions.id,
        version_number: bayAssetVersions.version_number,
        bin_asset_id: bayAssetVersions.bin_asset_id,
        media_meta: bayAssetVersions.media_meta,
      })
      .from(bayAssetVersions)
      .where(eq(bayAssetVersions.id, asset.current_version_id))
      .limit(1);
    version = vRows[0] ?? null;

    if (version) {
      annotations = await db
        .select({
          id: bayAnnotations.id,
          author_name: sql<string | null>`COALESCE(${users.display_name}, ${bayAnnotations.guest_name})`,
          is_guest: sql<boolean>`${bayAnnotations.author_id} IS NULL`,
          anchor: bayAnnotations.anchor,
          body: bayAnnotations.body,
          resolved: bayAnnotations.resolved,
          created_at: bayAnnotations.created_at,
        })
        .from(bayAnnotations)
        .leftJoin(users, eq(users.id, bayAnnotations.author_id))
        .where(eq(bayAnnotations.version_id, version.id))
        .orderBy(asc(bayAnnotations.created_at));

      decisions = await db
        .select({
          decision: bayReviewDecisions.decision,
          comment: bayReviewDecisions.comment,
          reviewer_name: users.display_name,
          created_at: bayReviewDecisions.created_at,
        })
        .from(bayReviewDecisions)
        .leftJoin(users, eq(users.id, bayReviewDecisions.reviewer_id))
        .where(eq(bayReviewDecisions.version_id, version.id))
        .orderBy(asc(bayReviewDecisions.created_at));
    }
  }

  return {
    name: asset.name,
    media_kind: asset.media_kind,
    allow_comments: link.allow_comments,
    version,
    annotations,
    decisions,
    media_ticket: mintMediaTicket(link.id),
  };
}

/**
 * Resolve the bin_asset_id behind a media ticket's review (for the media
 * stream), with the org that minted the link. The guest request has no
 * identity, so the link's org is what scopes the bin_assets read in
 * lib/bin-media.ts: a link only ever serves its own org's bytes. The link is
 * re-checked on every request, so revoking or expiring it stops the stream.
 */
export async function resolveTicketBinAsset(
  ticket: unknown,
): Promise<{ binAssetId: string; orgId: string } | null> {
  const linkId = verifyMediaTicket(ticket);
  if (!linkId) throw new NotFoundError('Link not found');
  const linkRows = await db.select().from(bayReviewLinks).where(eq(bayReviewLinks.id, linkId)).limit(1);
  const link = assertActive(linkRows[0]);
  const rows = await db
    .select({ bin_asset_id: bayAssetVersions.bin_asset_id })
    .from(bayAssets)
    .leftJoin(bayAssetVersions, eq(bayAssetVersions.id, bayAssets.current_version_id))
    .where(and(eq(bayAssets.id, link.asset_id), eq(bayAssets.org_id, link.org_id)))
    .limit(1);
  const binAssetId = rows[0]?.bin_asset_id;
  return binAssetId ? { binAssetId, orgId: link.org_id } : null;
}

export interface GuestCommentInput {
  body: string;
  guest_name: string;
  anchor?: Record<string, unknown>;
}

/** Add a guest comment if the link allows it. */
export async function addGuestComment(token: string, input: GuestCommentInput) {
  const link = await getActiveLink(token);
  if (!link.allow_comments) throw new ForbiddenError('Comments are disabled for this link');

  const assetRows = await db
    .select({ current_version_id: bayAssets.current_version_id })
    .from(bayAssets)
    .where(eq(bayAssets.id, link.asset_id))
    .limit(1);
  const versionId = assetRows[0]?.current_version_id;
  if (!versionId) throw new NotFoundError('This review has no version to comment on');

  const rows = await db
    .insert(bayAnnotations)
    .values({
      version_id: versionId,
      author_id: null,
      guest_name: input.guest_name.slice(0, 120),
      anchor: input.anchor ?? {},
      body: input.body,
    })
    .returning();
  const a = rows[0]!;
  return {
    id: a.id,
    version_id: versionId,
    author_name: input.guest_name.slice(0, 120),
    is_guest: true,
    anchor: a.anchor,
    body: a.body,
    resolved: a.resolved,
    created_at: a.created_at,
  };
}
