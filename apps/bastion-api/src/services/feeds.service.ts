// Machine feeds (spec 3.5; 5.1 rows 42-49). An external system pushes records with a per-feed
// key; each record is frozen like any other evidence: payload hash, personal data (subject and
// attributes) in bastion_personal_data with only its HMAC on the immutable row, and a ledger entry.
// Bolt-event feeds take their records from the bastion_ingest_events inbox instead (the
// evidence-ingest engine).

import {
  type BastionFeed,
  type BastionFeedBatch,
  type BastionFeedCreate,
  type BastionFeedKey,
  type BastionFeedKeyCreate,
  type BastionFeedKeyListResponse,
  type BastionFeedListResponse,
  type BastionFeedRecordListQuery,
  type BastionFeedRecordListResponse,
  type BastionFeedRecordRow,
  type BastionFeedResponse,
  type BastionFeedUpdate,
  type BastionMintedFeedKeyResponse,
  type BastionRevokedFeedKeyResponse,
  BASTION_DAY_MS,
  BASTION_FEED_KEY_GRACE_DAYS,
  BASTION_PERSONAL_DATA_MAX_BYTES,
} from '@bigbluebam/shared';
import { randomUUID } from 'node:crypto';
import { auditRaw } from '../lib/audit-raw.js';
import { ConflictError, NotFoundError, one, RateLimitedError, ValidationFailure } from '../lib/errors.js';
import { keyUsable, mintFeedKey, parseFeedToken, quotaAfter, verifyFeedSecret } from '../lib/feed-keys.js';
import { canonicalJson, sha256Hex } from '../lib/ledger-canonical.js';
import { type EngineDeps, orgTx, sqlstateOf, type Tx, utcDate } from '../engine/context.js';
import { appendLedger, type NewEntry } from '../engine/ledger.js';
import type { SealIdentity } from '../engine/restore.js';
import { beginLedgerBatch, mapAppendError } from './ledger-batch.js';
import { intOrNull, type Served } from '../lib/served.js';
import type { Viewer } from './types.js';

const FEED_SELECT = `f.id, f.feed_key, f.label, f.feed_kind, f.source_kind, f.bolt_source, f.bolt_event_type, f.cadence_days,
  f.daily_record_quota, f.quota_day::text AS quota_day, f.records_on_quota_day, f.bytes_total, f.status, f.last_record_at,
  f.created_at, f.updated_at`;

/** One feed as the routes send it (bastionFeedSchema, #371). */
function shapeFeed(r: Record<string, unknown>, now: Date): Served<BastionFeed> {
  const today = utcDate(now);
  const usedToday = r.quota_day === today ? Number(r.records_on_quota_day) : 0;
  const lastAt = r.last_record_at ? new Date(r.last_record_at as string) : null;
  const fresh = lastAt !== null && now.getTime() - lastAt.getTime() <= Number(r.cadence_days) * BASTION_DAY_MS;
  return {
    ...(r as unknown as Served<BastionFeed>),
    bytes_total: Number(r.bytes_total),
    records_today: usedToday,
    quota_remaining_today: Math.max(0, Number(r.daily_record_quota) - usedToday),
    fresh,
    freshness: lastAt === null ? 'No records yet' : fresh ? 'Up to date' : `Nothing new in the last ${r.cadence_days} day(s)`,
  };
}

/** GET /feeds (row 42). */
export async function listFeeds(engine: EngineDeps, viewer: Viewer): Promise<Served<BastionFeedListResponse>> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT ${FEED_SELECT},
              (SELECT count(*)::int FROM bastion_feed_keys k WHERE k.organization_id = f.organization_id AND k.feed_id = f.id AND k.status = 'active') AS active_keys,
              (SELECT count(*)::int FROM bastion_feed_records r WHERE r.organization_id = f.organization_id AND r.feed_id = f.id) AS record_count
         FROM bastion_evidence_feeds f WHERE f.organization_id = $1 ORDER BY f.created_at`,
      [viewer.org_id],
    )) as unknown as Array<Record<string, unknown>>;
    return { data: rows.map((r) => shapeFeed(r, now)), next_cursor: null };
  });
}

async function loadFeed(tx: Tx, orgId: string, id: string) {
  const r = (await tx.unsafe(`SELECT ${FEED_SELECT} FROM bastion_evidence_feeds f WHERE f.organization_id = $1 AND f.id = $2`, [orgId, id]))[0];
  if (!r) throw new NotFoundError('We could not find that feed.');
  return r as Record<string, unknown>;
}

/** POST /feeds (row 43). */
export async function createFeed(engine: EngineDeps, viewer: Viewer, body: BastionFeedCreate): Promise<Served<BastionFeedResponse>> {
  const now = engine.now();
  try {
    return await orgTx(engine.sql, viewer.org_id, async (tx) => {
      const rows = await tx`
        INSERT INTO bastion_evidence_feeds (organization_id, feed_key, label, feed_kind, source_kind, bolt_source, bolt_event_type,
                                            cadence_days, daily_record_quota)
        VALUES (${viewer.org_id}, ${body.feed_key}, ${body.label}, ${body.feed_kind ?? null}, ${body.source_kind},
                ${body.source_kind === 'bolt_event' ? (body.bolt_source ?? null) : null},
                ${body.source_kind === 'bolt_event' ? (body.bolt_event_type ?? null) : null},
                ${body.cadence_days}, ${body.daily_record_quota})
        RETURNING id`;
      const id = String(one(rows, 'feed').id);
      await auditRaw(tx, viewer, 'feed.create', { type: 'feed', id }, { feed_key: body.feed_key, source_kind: body.source_kind });
      return { data: shapeFeed(await loadFeed(tx, viewer.org_id, id), now) };
    });
  } catch (err) {
    if (sqlstateOf(err) === '23505') throw new ConflictError('A feed with that key already exists. Pick another key.', 'FEED_KEY_TAKEN');
    throw err;
  }
}

/** PATCH /feeds/:id (row 44). */
export async function updateFeed(engine: EngineDeps, viewer: Viewer, id: string, body: BastionFeedUpdate): Promise<Served<BastionFeedResponse>> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    await loadFeed(tx, viewer.org_id, id);
    await tx`
      UPDATE bastion_evidence_feeds
         SET label = COALESCE(${body.label ?? null}, label),
             cadence_days = COALESCE(${body.cadence_days ?? null}::int, cadence_days),
             daily_record_quota = COALESCE(${body.daily_record_quota ?? null}::int, daily_record_quota),
             status = COALESCE(${body.status ?? null}, status)
       WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'feed.update', { type: 'feed', id }, { fields: Object.keys(body) });
    return { data: shapeFeed(await loadFeed(tx, viewer.org_id, id), now) };
  });
}

const KEY_SELECT = 'id, feed_id, key_id, fingerprint, last4, label, status, grace_expires_at, predecessor_id, created_by, created_at, last_used_at, revoked_at';

/** GET /feeds/:id/keys (row 45). Never returns secrets or their HMACs. */
export async function listFeedKeys(engine: EngineDeps, viewer: Viewer, feedId: string): Promise<Served<BastionFeedKeyListResponse>> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    await loadFeed(tx, viewer.org_id, feedId);
    const rows = (await tx.unsafe(
      `SELECT ${KEY_SELECT} FROM bastion_feed_keys WHERE organization_id = $1 AND feed_id = $2 ORDER BY created_at DESC`,
      [viewer.org_id, feedId],
    )) as unknown as Array<Record<string, unknown>>;
    return {
      data: rows.map((k) => ({
        ...(k as unknown as Served<BastionFeedKey>),
        usable: keyUsable(
          { status: String(k.status), grace_expires_at: k.grace_expires_at ? new Date(k.grace_expires_at as string) : null, revoked_at: k.revoked_at ? new Date(k.revoked_at as string) : null },
          now,
        ),
      })),
    };
  });
}

/**
 * POST /feeds/:id/keys (row 46). Shown once: the response carries the token and nothing stores
 * it. Rotation: the feed's current active keys move to `grace` for seven days.
 */
export async function createFeedKey(
  engine: EngineDeps,
  viewer: Viewer,
  feedId: string,
  body: BastionFeedKeyCreate,
  pepperHex: string,
): Promise<Served<BastionMintedFeedKeyResponse>> {
  const now = engine.now();
  const minted = mintFeedKey(pepperHex);
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const feed = await loadFeed(tx, viewer.org_id, feedId);
    if (feed.source_kind !== 'api_push') {
      throw new ConflictError('This feed takes its records from Bolt events, so it does not use keys.', 'FEED_NOT_PUSH');
    }
    const graceUntil = new Date(now.getTime() + BASTION_FEED_KEY_GRACE_DAYS * BASTION_DAY_MS);
    const previous = await tx`
      UPDATE bastion_feed_keys SET status = 'grace', grace_expires_at = ${graceUntil}
       WHERE organization_id = ${viewer.org_id} AND feed_id = ${feedId} AND status = 'active'
      RETURNING id`;
    const rows = await tx`
      INSERT INTO bastion_feed_keys (organization_id, feed_id, key_id, secret_hmac, fingerprint, last4, label, status, predecessor_id, created_by)
      VALUES (${viewer.org_id}, ${feedId}, ${minted.key_id}, ${minted.secret_hmac}, ${minted.fingerprint}, ${minted.last4},
              ${body.label ?? null}, 'active', ${(previous[0]?.id as string | undefined) ?? null}, ${viewer.id})
      RETURNING id, created_at`;
    const created = one(rows, 'feed key');
    await auditRaw(tx, viewer, 'feed.key.create', { type: 'feed_key', id: String(created.id) }, { feed_id: feedId, rotated: previous.length });
    return {
      data: {
        id: String(created.id),
        feed_id: feedId,
        key_id: minted.key_id,
        fingerprint: minted.fingerprint,
        last4: minted.last4,
        label: body.label ?? null,
        status: 'active' as const,
        created_at: created.created_at as Date,
        /** Shown once. Bastion keeps only an HMAC of the secret part. */
        token: minted.token,
        rotated_keys: previous.length,
        grace_expires_at: previous.length > 0 ? graceUntil.toISOString() : null,
        push_path: `/bastion/api/v1/feeds/${feed.feed_key as string}/records`,
      },
    };
  });
}

/** POST /feed-keys/:id/revoke (row 47). Immediate; no grace. */
export async function revokeFeedKey(engine: EngineDeps, viewer: Viewer, keyRowId: string): Promise<BastionRevokedFeedKeyResponse> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const rows = await tx`
      UPDATE bastion_feed_keys SET status = 'revoked', revoked_at = ${now}
       WHERE organization_id = ${viewer.org_id} AND id = ${keyRowId} AND status <> 'revoked'
      RETURNING id, feed_id`;
    if (!rows[0]) {
      const exists = await tx`SELECT 1 FROM bastion_feed_keys WHERE organization_id = ${viewer.org_id} AND id = ${keyRowId}`;
      if (exists.length === 0) throw new NotFoundError('We could not find that key.');
      throw new ConflictError('This key was already revoked.', 'ALREADY_REVOKED');
    }
    await auditRaw(tx, viewer, 'feed.key.revoke', { type: 'feed_key', id: keyRowId }, { feed_id: rows[0].feed_id });
    return { data: { id: keyRowId, status: 'revoked' as const, revoked_at: now.toISOString() } };
  });
}

/** GET /feeds/:id/records (row 49). Subjects are personal data: shown unless redacted. */
export async function listFeedRecords(
  engine: EngineDeps,
  viewer: Viewer,
  feedId: string,
  q: BastionFeedRecordListQuery,
): Promise<Served<BastionFeedRecordListResponse>> {
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    await loadFeed(tx, viewer.org_id, feedId);
    const rows = (await tx.unsafe(
      `SELECT r.id, r.idempotency_key, r.occurred_at, r.received_at, r.payload_sha256, r.ledger_seq,
              pd.id AS personal_data_id, pd.redacted_at,
              CASE WHEN pd.redacted_at IS NULL THEN pd.data->>'subject' END AS subject
         FROM bastion_feed_records r
         LEFT JOIN bastion_personal_data pd ON pd.organization_id = r.organization_id AND pd.holder_kind = 'feed_record' AND pd.holder_id = r.id
        WHERE r.organization_id = $1 AND r.feed_id = $2 AND ($3::timestamptz IS NULL OR r.occurred_at < $3)
        ORDER BY r.occurred_at DESC, r.id LIMIT $4`,
      [viewer.org_id, feedId, q.before ?? null, q.limit + 1],
    )) as unknown as Array<Record<string, unknown>>;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      // ledger_seq is bigint and arrives from postgres as a string; the response carries a number (#371).
      data: page.map((r) => ({ ...(r as unknown as Served<BastionFeedRecordRow>), ledger_seq: intOrNull(r.ledger_seq) })),
      next_cursor: rows.length > q.limit && last ? new Date(last.occurred_at as string).toISOString() : null,
      has_more: rows.length > q.limit,
    };
  });
}

// ── Ingest ──────────────────────────────────────────────────────────────────────────────

export interface IngestResult {
  accepted: number;
  duplicates: number;
  quota_remaining: number;
}

interface RecordIn {
  idempotency_key: string;
  occurred_at: string;
  subject?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Write a batch for one feed inside one org transaction, under the feed row lock: repeated
 * idempotency keys are no-ops, only NEW records count against the daily quota (429 when the batch
 * would exceed it, nothing written), and every new record gets a ledger entry.
 */
async function writeRecords(
  engine: EngineDeps,
  tx: Tx,
  orgId: string,
  feedId: string,
  feedKeyRowId: string | null,
  records: RecordIn[],
  bytes: number,
  highest: SealIdentity | null,
): Promise<IngestResult> {
  const now = engine.now();
  const today = utcDate(now);
  const feed = (await tx`
    SELECT id, quota_day::text AS quota_day, records_on_quota_day, daily_record_quota
      FROM bastion_evidence_feeds WHERE organization_id = ${orgId} AND id = ${feedId} FOR UPDATE`)[0];
  if (!feed) throw new NotFoundError('Unknown feed.');
  const keys = [...new Set(records.map((r) => r.idempotency_key))];
  const existing = new Set(
    (await tx`SELECT idempotency_key FROM bastion_feed_records
               WHERE organization_id = ${orgId} AND feed_id = ${feedId} AND idempotency_key = ANY(${keys})`).map((r) => String(r.idempotency_key)),
  );
  const seen = new Set<string>();
  const fresh = records.filter((r) => {
    if (existing.has(r.idempotency_key) || seen.has(r.idempotency_key)) return false;
    seen.add(r.idempotency_key);
    return true;
  });
  const quota = quotaAfter(
    { quota_day: (feed.quota_day as string | null) ?? null, records_on_quota_day: Number(feed.records_on_quota_day), daily_record_quota: Number(feed.daily_record_quota) },
    today,
    fresh.length,
  );
  if (!quota.allowed) {
    throw new RateLimitedError(
      `This feed's daily limit of ${feed.daily_record_quota} records is used up (${quota.remaining} left today, UTC). Nothing from this batch was saved.`,
      'FEED_QUOTA_EXCEEDED',
      secondsToUtcMidnight(now),
    );
  }
  if (fresh.length > 0) {
    const prepared = fresh.map((r) => {
      const id = randomUUID();
      const pd = r.subject !== undefined || r.attributes !== undefined ? { subject: r.subject ?? null, attributes: r.attributes ?? {} } : null;
      if (pd && Buffer.byteLength(JSON.stringify(pd)) > BASTION_PERSONAL_DATA_MAX_BYTES) {
        throw new ValidationFailure(`The subject and attributes of record "${r.idempotency_key}" are larger than 16 KB.`, 'RECORD_TOO_LARGE', [
          { field: 'records', issue: 'personal_data_too_large' },
        ]);
      }
      return {
        id,
        r,
        pd,
        pdHmac: pd ? engine.pdHmac(pd) : null,
        payloadSha: sha256Hex(canonicalJson({ idempotency_key: r.idempotency_key, occurred_at: r.occurred_at, subject: r.subject ?? null, attributes: r.attributes ?? {} })),
      };
    });
    const entries: NewEntry[] = prepared.map((p) => ({
      kind: 'feed_record',
      id: p.id,
      content_sha256: p.payloadSha,
      personal_data_hmac: p.pdHmac,
      pd_hmac_key_id: p.pdHmac ? engine.pdKeyId : null,
    }));
    const appended = await appendLedger(tx, orgId, entries, { highest, now });
    for (const [i, p] of prepared.entries()) {
      await tx`
        INSERT INTO bastion_feed_records (id, organization_id, feed_id, feed_key_id, idempotency_key, occurred_at, payload_sha256,
                                          personal_data_hmac, pd_hmac_key_id, ledger_seq, received_at)
        VALUES (${p.id}, ${orgId}, ${feedId}, ${feedKeyRowId}, ${p.r.idempotency_key}, ${p.r.occurred_at}::timestamptz, ${p.payloadSha},
                ${p.pdHmac}, ${p.pdHmac ? engine.pdKeyId : null}, ${appended[i]?.seq ?? null}, ${now})`;
      if (p.pd) {
        await tx`
          INSERT INTO bastion_personal_data (organization_id, holder_kind, holder_id, data, data_hmac, pd_hmac_key_id)
          VALUES (${orgId}, 'feed_record', ${p.id}, ${tx.json(p.pd as never)}, ${p.pdHmac}, ${engine.pdKeyId})`;
      }
    }
  }
  await tx`
    UPDATE bastion_evidence_feeds
       SET quota_day = ${today}::date, records_on_quota_day = ${quota.used}, bytes_total = bytes_total + ${bytes},
           last_record_at = CASE WHEN ${fresh.length} > 0 THEN ${now}::timestamptz ELSE last_record_at END
     WHERE organization_id = ${orgId} AND id = ${feedId}`;
  if (feedKeyRowId) await tx`UPDATE bastion_feed_keys SET last_used_at = ${now} WHERE organization_id = ${orgId} AND id = ${feedKeyRowId}`;
  return { accepted: fresh.length, duplicates: records.length - fresh.length, quota_remaining: quota.remaining };
}

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Pre-org key lookup through the definer resolver, so it works under BBB_RLS_ENFORCE=1. */
export async function resolveFeedKey(engine: EngineDeps, keyId: string): Promise<{ id: string; org_id: string } | null> {
  const rows = await engine.sql`SELECT id, org_id FROM bastion_resolve_feed_key(${keyId})`;
  return rows[0] ? { id: String(rows[0].id), org_id: String(rows[0].org_id) } : null;
}

export class FeedAuthError extends Error {
  constructor() {
    super('This feed key is not valid for this feed.');
    this.name = 'FeedAuthError';
  }
}

/**
 * POST /feeds/:feed_key/records (row 48). The key decides the org; the path's feed_key must be the
 * key's own feed. Every failure to authenticate is the same 401, so a key id is not confirmable.
 * The per-key rate limit runs in the route (Redis); the byte cap is the route's bodyLimit.
 */
export async function authenticateFeedPush(
  engine: EngineDeps,
  pathFeedKey: string,
  authorization: string | undefined,
  pepperHex: string,
): Promise<{ orgId: string; feedId: string; keyRowId: string }> {
  const parsed = parseFeedToken(authorization);
  if (!parsed) throw new FeedAuthError();
  const resolved = await resolveFeedKey(engine, parsed.key_id);
  if (!resolved) throw new FeedAuthError();
  const now = engine.now();
  return orgTx(engine.sql, resolved.org_id, async (tx) => {
    const k = (await tx`
      SELECT k.id, k.secret_hmac, k.status, k.grace_expires_at, k.revoked_at, f.id AS feed_id, f.feed_key, f.status AS feed_status, f.source_kind
        FROM bastion_feed_keys k
        JOIN bastion_evidence_feeds f ON f.id = k.feed_id AND f.organization_id = k.organization_id
       WHERE k.organization_id = ${resolved.org_id} AND k.id = ${resolved.id}`)[0];
    if (!k) throw new FeedAuthError();
    const usable = keyUsable(
      { status: String(k.status), grace_expires_at: k.grace_expires_at ? new Date(k.grace_expires_at as string) : null, revoked_at: k.revoked_at ? new Date(k.revoked_at as string) : null },
      now,
    );
    if (!usable || !verifyFeedSecret(pepperHex, parsed.secret, String(k.secret_hmac)) || k.feed_key !== pathFeedKey) throw new FeedAuthError();
    if (k.feed_status !== 'active' || k.source_kind !== 'api_push') {
      throw new ConflictError('This feed is paused or retired, so it is not accepting records.', 'FEED_NOT_ACTIVE');
    }
    return { orgId: resolved.org_id, feedId: String(k.feed_id), keyRowId: String(k.id) };
  });
}

export async function ingestFeedBatch(
  engine: EngineDeps,
  auth: { orgId: string; feedId: string; keyRowId: string },
  batch: BastionFeedBatch,
  bytes: number,
): Promise<{ data: IngestResult }> {
  const highest = await beginLedgerBatch(engine, auth.orgId);
  try {
    const data = await orgTx(engine.sql, auth.orgId, (tx) => writeRecords(engine, tx, auth.orgId, auth.feedId, auth.keyRowId, batch.records, bytes, highest));
    return { data };
  } catch (err) {
    throw mapAppendError(err);
  }
}

// ── Bolt-event feeds (the evidence-ingest engine) ─────────────────────────────────────────

/** The most inbox events one Bolt-event feed turns into records per engine call. */
export const BOLT_FEED_BATCH = 200;

/**
 * Turn pending inbox events that match an active Bolt-event feed into feed records. Events that
 * match no feed are left for the consumers that own them (M6 proposal reconcile). Per org, one
 * transaction per batch of up to 200 events.
 *
 * The engine is its own pusher, so it never sends a batch larger than the feed's remaining daily
 * quota (#218): it takes at most `remaining` events (the oldest first) and leaves the rest for
 * the next UTC day, instead of retrying one all-or-nothing batch that can never fit until the
 * events are pruned unrecorded. A feed with no quota left is skipped with a warning.
 */
export async function ingestBoltEventFeeds(engine: EngineDeps, orgId: string): Promise<{ recorded: number; duplicates: number; quota_blocked: number }> {
  const feeds = await orgTx(engine.sql, orgId, (tx) => tx`
    SELECT id, label, bolt_source, bolt_event_type, quota_day::text AS quota_day, records_on_quota_day, daily_record_quota
      FROM bastion_evidence_feeds
     WHERE organization_id = ${orgId} AND source_kind = 'bolt_event' AND status = 'active'`);
  let recorded = 0;
  let duplicates = 0;
  let quotaBlocked = 0;
  const today = utcDate(engine.now());
  for (const f of feeds) {
    const remaining = quotaAfter(
      { quota_day: (f.quota_day as string | null) ?? null, records_on_quota_day: Number(f.records_on_quota_day), daily_record_quota: Number(f.daily_record_quota) },
      today,
      0,
    ).remaining;
    const take = Math.min(BOLT_FEED_BATCH, remaining);
    if (take <= 0) {
      const waiting = await orgTx(engine.sql, orgId, (tx) => tx`
        SELECT count(*)::int AS n FROM bastion_ingest_events
         WHERE organization_id = ${orgId} AND status = 'pending' AND source = ${f.bolt_source as string} AND event_type = ${f.bolt_event_type as string}`);
      const n = Number(waiting[0]?.n ?? 0);
      if (n > 0) {
        quotaBlocked += n;
        engine.log.warn(
          { organization_id: orgId, feed_id: f.id, waiting: n },
          `bastion-evidence-ingest: feed "${String(f.label)}" has used its daily limit; ${n} event(s) wait for the next UTC day`,
        );
      }
      continue;
    }
    const events = await orgTx(engine.sql, orgId, (tx) => tx`
      SELECT id, source_idempotency_key, payload, created_at FROM bastion_ingest_events
       WHERE organization_id = ${orgId} AND status = 'pending' AND source = ${f.bolt_source as string} AND event_type = ${f.bolt_event_type as string}
       ORDER BY created_at LIMIT ${take}`);
    if (events.length === 0) continue;
    const highest = await beginLedgerBatch(engine, orgId);
    const records: RecordIn[] = events.map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const occurred = typeof p.occurred_at === 'string' && !Number.isNaN(Date.parse(p.occurred_at)) ? p.occurred_at : new Date(e.created_at as string).toISOString();
      return { idempotency_key: String(e.source_idempotency_key), occurred_at: occurred };
    });
    try {
      const res = await orgTx(engine.sql, orgId, async (tx) => {
        const r = await writeRecords(engine, tx, orgId, String(f.id), null, records, 0, highest);
        await tx`UPDATE bastion_ingest_events SET status = 'done', attempts = attempts + 1
                  WHERE organization_id = ${orgId} AND id = ANY(${events.map((e) => String(e.id))}::uuid[])`;
        return r;
      });
      recorded += res.accepted;
      duplicates += res.duplicates;
    } catch (err) {
      if (err instanceof RateLimitedError) {
        quotaBlocked += events.length;
        continue;
      }
      throw mapAppendError(err);
    }
  }
  return { recorded, duplicates, quota_blocked: quotaBlocked };
}
