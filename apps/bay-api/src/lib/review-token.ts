// Bay guest review link credentials (#122).
//
// A share link's bearer token is 24 random bytes as 48 hex chars. Only its SHA-256 is stored
// (bay_review_links.token_hash, migration 0340), so a database read, a backup or a query log no
// longer opens any review. The raw token is shown once, when the link is minted.
//
// Delivery keeps the token out of server logs and Referer headers: the share URL carries it in
// the fragment (/bay/r#<token>), which browsers never send, and the guest page sends it to the
// JSON API only in the REVIEW_TOKEN_HEADER header. A <video>/<img> element cannot send headers,
// so the review bundle also returns a short-lived media ticket: an HMAC over (link id, expiry)
// that only streams that link's media, expires, and is re-checked against the link (revoked or
// expired links stop serving) on every request.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/** Header the guest review page sends the token in. */
export const REVIEW_TOKEN_HEADER = 'x-bay-review-token';

/** How long a media ticket streams for. Long enough to watch a long cut without reloading. */
export const MEDIA_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{48}$/;

export function mintReviewToken(): string {
  return randomBytes(24).toString('hex');
}

/** True for a string shaped like a review token (rejects junk before any hashing or query). */
export function isWellFormedReviewToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function hashReviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time equality of two hex digests of the same length. */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function ticketSignature(payload: string): string {
  // Domain-separated from every other use of SESSION_SECRET.
  return createHmac('sha256', `bay-review-media-ticket:${env.SESSION_SECRET}`).update(payload).digest('base64url');
}

/** A media ticket for one link, valid until now + MEDIA_TICKET_TTL_MS. */
export function mintMediaTicket(linkId: string, now: number = Date.now()): string {
  const payload = `${linkId}.${now + MEDIA_TICKET_TTL_MS}`;
  return `${payload}.${ticketSignature(payload)}`;
}

/** The link id a valid, unexpired media ticket names; null otherwise. */
export function verifyMediaTicket(ticket: unknown, now: number = Date.now()): string | null {
  if (typeof ticket !== 'string' || ticket.length > 200) return null;
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [linkId, expRaw, sig] = parts as [string, string, string];
  const expected = ticketSignature(`${linkId}.${expRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return null;
  return linkId;
}
