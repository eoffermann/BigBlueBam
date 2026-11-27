// The public auditor room (spec 5.1 rows 101-104, 5.2; M9). No BigBlueBam account: the bearer of
// the link's token sees one room. The hardening over Bay's guest link:
//
//   - the token arrives only as the X-Bastion-Room-Token header (the SPA reads it from the URL
//     fragment, which never reaches a server log or Referer) and is looked up by SHA-256 through
//     the definer resolver bastion_resolve_room, so it works under RLS enforcement;
//   - a missing, revoked, expired or locked room, and a room whose creator no longer holds
//     bastion.auditor_room.create, are all the same 404 ("This link is no longer available.");
//   - unknown-token misses are counted per (client address, '-') in Redis: 10 in 10 minutes lock
//     that address out of unknown-token lookups for 15 minutes, so a wrong proxy hop count can
//     never lock every room at once (valid tokens are keyed by their room);
//   - an optional 6-digit passcode (argon2) whose 5th wrong answer locks the room and tells its
//     creator (auditor_room.revoked, reason "locked"); the creator can Unlock;
//   - every view writes bastion_auditor_access_log (one-way address fingerprint, short device);
//   - reads never reach outside the room's controls, period and restricted allowlist, whatever
//     ids are supplied; evidence explanations are counts-only (no cited item ever leaves).

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import argon2 from 'argon2';
import { withStorageTimeout } from '@bigbluebam/storage';
import {
  BASTION_ROOM_LOCKOUT_S,
  BASTION_ROOM_PASSCODE_MAX_FAILURES,
  BASTION_ROOM_REQUESTS_PER_HOUR,
  BASTION_ROOM_TOKEN_MISS_WINDOW_S,
  BASTION_ROOM_TOKEN_MISSES,
  type BastionAuditorViewKind,
  type BastionPublicRoomRequest,
} from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { downloadHeaders } from '../lib/download.js';
import { NotFoundError, RateLimitedError } from '../lib/errors.js';
import { frameworkTemplate, requirementsForControl } from '../library/index.js';
import { acceptedRisks, auditControls, loadAuditFramework } from './audit-view.js';
import { present, SNAPSHOT_SELECT } from './evidence.service.js';
import { roomOverview, roomStateAt, roomTokenSha256 } from './sharing.service.js';

export const ROOM_GONE = 'This link is no longer available.';

export class RoomPasscodeRequired extends Error {
  constructor(
    public readonly wrong: boolean,
    public readonly attemptsLeft: number | null,
  ) {
    super(wrong ? 'That passcode is not right.' : 'Enter the 6-digit passcode.');
    this.name = 'RoomPasscodeRequired';
  }
}

/** Small counter store (Redis in production); fails open, the age-locked room row is the floor. */
export interface RoomCounters {
  incr(key: string, ttlSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
  set(key: string, ttlSeconds: number): Promise<void>;
}

export interface RoomDeps {
  engine: EngineDeps;
  counters: RoomCounters;
  /** Does this user still hold `permission` in the org? Fail closed. */
  userCan: (userId: string, orgId: string, permission: string) => Promise<boolean>;
  ipSalt: string;
}

export interface RoomRequestContext {
  token: string | null;
  passcode: string | null;
  ip: string;
  userAgent: string | null;
}

export function ipHashOf(salt: string, ip: string): string {
  return createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

interface ResolvedRoom {
  orgId: string;
  room: Record<string, unknown>;
}

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return 0;
  }
}

/** Resolve and gate one room request; throws NotFoundError(ROOM_GONE) or RoomPasscodeRequired. */
export async function resolveRoom(deps: RoomDeps, ctx: RoomRequestContext): Promise<ResolvedRoom> {
  const ipHash = ipHashOf(deps.ipSalt, ctx.ip);
  const missKey = `bastion:room:miss:${ipHash}:-`;
  const lockKey = `bastion:room:lock:${ipHash}:-`;
  const miss = async () => {
    const n = await safeCount(() => deps.counters.incr(missKey, BASTION_ROOM_TOKEN_MISS_WINDOW_S));
    if (n >= BASTION_ROOM_TOKEN_MISSES) await deps.counters.set(lockKey, BASTION_ROOM_LOCKOUT_S).catch(() => undefined);
    throw new NotFoundError(ROOM_GONE);
  };
  if (!ctx.token || !TOKEN_RE.test(ctx.token)) return miss();
  const sha = roomTokenSha256(ctx.token);
  const found = (await deps.engine.sql`SELECT id, org_id FROM bastion_resolve_room(${sha})`)[0];
  if (!found) {
    if ((await safeCount(() => deps.counters.get(lockKey))) > 0) throw new NotFoundError(ROOM_GONE);
    return miss();
  }
  const orgId = String(found.org_id);
  const roomId = String(found.id);
  const room = (await orgTx(deps.engine.sql, orgId, (tx) => tx`
    SELECT id, organization_id, framework_id, label, passcode_hash, passcode_failures, locked_at, revoked_at, expires_at,
           period_start::text AS period_start, period_end::text AS period_end, control_ids, restricted_evidence_ids, created_by
      FROM bastion_auditor_rooms WHERE organization_id = ${orgId} AND id = ${roomId}`))[0] as Record<string, unknown> | undefined;
  if (!room) throw new NotFoundError(ROOM_GONE);
  if (roomStateAt(room, deps.engine.now()) !== 'active') throw new NotFoundError(ROOM_GONE);
  // The creator must still be allowed to share (spec 5.2): a demoted or removed creator closes the room.
  if (!room.created_by || !(await deps.userCan(String(room.created_by), orgId, 'bastion.auditor_room.create').catch(() => false))) {
    throw new NotFoundError(ROOM_GONE);
  }
  if (room.passcode_hash) {
    if (!ctx.passcode) throw new RoomPasscodeRequired(false, BASTION_ROOM_PASSCODE_MAX_FAILURES - Number(room.passcode_failures ?? 0));
    await checkPasscode(deps, orgId, roomId, room, ctx.passcode);
  }
  return { orgId, room };
}

/** Redis key proving this exact passcode was verified for this room (keyed, so it reveals nothing). */
function verifiedKey(deps: RoomDeps, roomId: string, passcodeHash: string, passcode: string): string {
  const mac = createHmac('sha256', deps.ipSalt).update(`${roomId}\n${passcodeHash}\n${passcode}`, 'utf8').digest('hex');
  return `bastion:room:passcode-ok:${mac}`;
}
/** How long a verified passcode skips argon2 (the room's own lock, expiry and revocation still apply). */
const PASSCODE_VERIFIED_TTL_S = 15 * 60;

/**
 * The passcode gate (spec 5.2: 5 misses lock the room; #308, #314). Every attempt RESERVES one of
 * the room's 5 tries in a single guarded UPDATE before argon2 runs, so however many requests
 * arrive at once, at most 5 guesses can ever be in flight or spent per lockout: a burst cannot
 * test more codes than the counter allows, and a right answer that finishes after the room locked
 * is refused. A right answer gives its try back; a wrong one turns it into a miss, and the miss
 * that brings the count to 5 locks the room and tells its creator. A reservation that is never
 * settled (failed write, crash) is dropped in `finally` or expires on its own, and never counts
 * as a miss (#327).
 *
 * A passcode verified once is remembered for 15 minutes under a keyed hash of (room, passcode),
 * so the auditor's later page loads skip argon2 and never compete for tries. A hit proves the
 * guess was right, so it cannot help a guesser.
 */
async function checkPasscode(deps: RoomDeps, orgId: string, roomId: string, room: Record<string, unknown>, passcode: string): Promise<void> {
  const hash = String(room.passcode_hash);
  const okKey = verifiedKey(deps, roomId, hash, passcode);
  if ((await safeCount(() => deps.counters.get(okKey))) > 0) return;
  const reserved = await reservePasscodeTry(deps.engine, orgId, roomId);
  if (reserved.status !== 'reserved') {
    if (reserved.status === 'gone') throw new NotFoundError(ROOM_GONE);
    throw new RateLimitedError('Too many passcode tries are being checked at once. Wait a moment and try again.', 'ROOM_PASSCODE_BUSY', 5);
  }
  const tryId = reserved.id;
  // Set once the reservation has been turned into a release or a miss. Until then a throw (a failed
  // write, a crash in the response path) drops the reservation in `finally`; if even that fails,
  // or the process dies, the reservation expires on its own after PASSCODE_TRY_LEASE_MS (#327).
  let settled = false;
  try {
    let ok = false;
    try {
      ok = /^\d{6}$/.test(passcode) && (await argon2.verify(hash, passcode));
    } catch {
      ok = false;
    }
    if (ok) {
      // Give the try back, but only while the room is still open: a lock that landed during the
      // verify (other guesses used up the tries) wins.
      const released = await releasePasscodeTry(deps.engine, orgId, roomId, tryId);
      settled = true;
      if (!released) throw new NotFoundError(ROOM_GONE);
      await deps.counters.set(okKey, PASSCODE_VERIFIED_TTL_S).catch(() => undefined);
      return;
    }
    const left = await recordPasscodeMiss(deps.engine, orgId, roomId, tryId);
    settled = true;
    if (left <= 0) throw new NotFoundError(ROOM_GONE);
    throw new RoomPasscodeRequired(true, left);
  } finally {
    if (!settled) {
      await dropPasscodeTry(deps.engine, orgId, roomId, tryId).catch((err: unknown) =>
        deps.engine.log.warn({ organization_id: orgId, room_id: roomId, err: (err as Error).message }, 'bastion-room: could not drop a passcode try; it expires on its own'),
      );
    }
  }
}

/**
 * How long a reserved passcode try counts as in flight (#327). argon2 takes well under a second,
 * so a reservation this old belongs to a request that died; it no longer holds a slot.
 */
export const PASSCODE_TRY_LEASE_MS = 60_000;

/** Live (unexpired) reservations in `passcode_inflight`, as a SQL count. */
const liveTries = (tx: Tx, nowMs: number) =>
  tx`(SELECT count(*) FROM jsonb_each_text(passcode_inflight) AS t(k, v) WHERE t.v::bigint > ${nowMs})`;
/** `passcode_inflight` with expired reservations pruned. */
const prunedTries = (tx: Tx, nowMs: number) =>
  tx`(SELECT coalesce(jsonb_object_agg(t.k, t.v::bigint), '{}'::jsonb) FROM jsonb_each_text(passcode_inflight) AS t(k, v) WHERE t.v::bigint > ${nowMs})`;

export type PasscodeReservation = { status: 'reserved'; id: string } | { status: 'gone' | 'busy' };

/**
 * Take one of the room's tries before verifying: a reservation in `passcode_inflight` that expires
 * after PASSCODE_TRY_LEASE_MS, granted only while misses plus live reservations stay under 5 (#327).
 * `gone` = locked, revoked or missing (the usual 404); `busy` = open, but every remaining try is
 * already being checked by another request.
 */
export async function reservePasscodeTry(engine: EngineDeps, orgId: string, roomId: string): Promise<PasscodeReservation> {
  const id = randomUUID();
  const nowMs = engine.now().getTime();
  return orgTx(engine.sql, orgId, async (tx) => {
    const [r] = await tx`
      UPDATE bastion_auditor_rooms
         SET passcode_inflight = ${prunedTries(tx, nowMs)} || jsonb_build_object(${id}::text, ${nowMs + PASSCODE_TRY_LEASE_MS}::bigint)
       WHERE organization_id = ${orgId} AND id = ${roomId} AND locked_at IS NULL AND revoked_at IS NULL
         AND passcode_failures + ${liveTries(tx, nowMs)} < ${BASTION_ROOM_PASSCODE_MAX_FAILURES}
      RETURNING id`;
    if (r) return { status: 'reserved' as const, id };
    const [cur] = await tx`SELECT locked_at, revoked_at FROM bastion_auditor_rooms WHERE organization_id = ${orgId} AND id = ${roomId}`;
    if (!cur || cur.locked_at || cur.revoked_at) return { status: 'gone' as const };
    // Every try is spent or in flight but none has locked the room yet: the in-flight guesses decide.
    return { status: 'busy' as const };
  });
}

/** A right answer returns its reserved try. False when the room locked in the meantime. */
async function releasePasscodeTry(engine: EngineDeps, orgId: string, roomId: string, tryId: string): Promise<boolean> {
  return orgTx(engine.sql, orgId, async (tx) => {
    const rows = await tx`
      UPDATE bastion_auditor_rooms SET passcode_inflight = passcode_inflight - ${tryId}::text
       WHERE organization_id = ${orgId} AND id = ${roomId} AND locked_at IS NULL AND revoked_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  });
}

/** Best effort on a failed request: the reservation stops holding a slot (it is not a miss). */
async function dropPasscodeTry(engine: EngineDeps, orgId: string, roomId: string, tryId: string): Promise<void> {
  await orgTx(engine.sql, orgId, async (tx) => {
    await tx`UPDATE bastion_auditor_rooms SET passcode_inflight = passcode_inflight - ${tryId}::text
              WHERE organization_id = ${orgId} AND id = ${roomId}`;
  });
}

/**
 * One wrong passcode: its reservation becomes a miss. When the misses reach 5 the room locks and
 * its creator is told (spec 5.2). Returns tries left.
 */
export async function recordPasscodeMiss(engine: EngineDeps, orgId: string, roomId: string, tryId: string): Promise<number> {
  return orgTx(engine.sql, orgId, async (tx) => {
    const now = engine.now();
    await tx`
      UPDATE bastion_auditor_rooms SET passcode_failures = passcode_failures + 1, passcode_inflight = passcode_inflight - ${tryId}::text
       WHERE organization_id = ${orgId} AND id = ${roomId} AND locked_at IS NULL`;
    const [locked] = await tx`
      UPDATE bastion_auditor_rooms SET locked_at = ${now}
       WHERE organization_id = ${orgId} AND id = ${roomId} AND locked_at IS NULL
         AND passcode_failures >= ${BASTION_ROOM_PASSCODE_MAX_FAILURES}
      RETURNING passcode_failures`;
    if (locked) {
      await enqueueBastionEvent('auditor_room.revoked', { room_id: roomId, reason: 'locked' }, tx, {
        orgId,
        idempotencyKey: `auditor_room.locked:${roomId}:${now.toISOString()}`,
      });
      return 0;
    }
    const [cur] = await tx`SELECT passcode_failures, locked_at FROM bastion_auditor_rooms WHERE organization_id = ${orgId} AND id = ${roomId}`;
    if (!cur || cur.locked_at) return 0;
    return Math.max(0, BASTION_ROOM_PASSCODE_MAX_FAILURES - Number(cur.passcode_failures ?? 0));
  });
}

/** Every view is logged and counted (spec 5.2). */
export async function logRoomAccess(deps: RoomDeps, r: ResolvedRoom, ctx: RoomRequestContext, kind: BastionAuditorViewKind, objectRef: string | null): Promise<void> {
  const now = deps.engine.now();
  await orgTx(deps.engine.sql, r.orgId, async (tx) => {
    await tx`
      INSERT INTO bastion_auditor_access_log (organization_id, room_id, accessed_at, view_kind, object_ref, ip_hash, user_agent_trunc)
      VALUES (${r.orgId}, ${String(r.room.id)}, ${now}, ${kind}, ${objectRef}, ${ipHashOf(deps.ipSalt, ctx.ip)}, ${(ctx.userAgent ?? '').slice(0, 256) || null})`;
    await tx`UPDATE bastion_auditor_rooms SET access_count = access_count + 1, last_accessed_at = ${now}
              WHERE organization_id = ${r.orgId} AND id = ${String(r.room.id)}`;
  });
}

/** GET /public/room (row 101). */
export async function publicRoomOverview(deps: RoomDeps, ctx: RoomRequestContext) {
  const r = await resolveRoom(deps, ctx);
  await logRoomAccess(deps, r, ctx, 'overview', null);
  return { data: await roomOverview(deps.engine, r.orgId, r.room) };
}

const roomControls = (room: Record<string, unknown>) => new Set(((room.control_ids as string[] | null) ?? []).map(String));

/** Period bounds as SQL fragments (an open bound is no bound). */
function inPeriod(tx: Tx, column: string, room: Record<string, unknown>) {
  return tx`${room.period_start ? tx`AND ${tx(column)}::date >= ${String(room.period_start)}::date` : tx``}
            ${room.period_end ? tx`AND ${tx(column)}::date <= ${String(room.period_end)}::date` : tx``}`;
}

/** Manual evidence the room may show: linked to a room control, live, standard or allowlisted, in the period. */
async function roomFiles(tx: Tx, orgId: string, room: Record<string, unknown>, onlyControl: string | null, onlyId: string | null) {
  const controls = onlyControl ? [onlyControl] : [...roomControls(room)];
  const allow = ((room.restricted_evidence_ids as string[] | null) ?? []).map(String);
  return tx`
    SELECT DISTINCT e.id, e.kind, e.title, e.description, e.source_system, e.produced_on::text AS produced_on,
           e.period_start::text AS period_start, e.period_end::text AS period_end, e.valid_until, e.sensitivity, e.status,
           e.content_sha256, e.content_type, e.size_bytes, e.scan_label,
           bool_or(l.review_verdict = 'accepted') OVER (PARTITION BY e.id) AS accepted
      FROM bastion_manual_evidence e
      JOIN bastion_manual_evidence_links l ON l.organization_id = e.organization_id AND l.manual_evidence_id = e.id AND l.unlinked_at IS NULL
      JOIN bastion_assertions a ON a.organization_id = l.organization_id AND a.id = l.assertion_id
     WHERE e.organization_id = ${orgId} AND a.control_id = ANY(${controls}::uuid[])
       AND e.status IN ('active', 'superseded') AND e.redacted_at IS NULL
       AND (e.sensitivity = 'standard' OR e.id = ANY(${allow}::uuid[]))
       ${onlyId ? tx`AND e.id = ${onlyId}` : tx``}
       ${room.period_end ? tx`AND coalesce(e.produced_on, e.created_at::date) <= ${String(room.period_end)}::date` : tx``}
       ${room.period_start ? tx`AND (e.valid_until IS NULL OR e.valid_until::date >= ${String(room.period_start)}::date)` : tx``}
     ORDER BY e.title`;
}

function fileOut(f: Record<string, unknown>) {
  return {
    id: f.id,
    kind: f.kind === 'attestation_statement' ? 'statement' : 'file',
    title: f.title,
    description: f.description ?? null,
    source_system: f.source_system ?? null,
    produced_on: f.produced_on ?? null,
    period_start: f.period_start ?? null,
    period_end: f.period_end ?? null,
    valid_until: f.valid_until ?? null,
    restricted: f.sensitivity === 'restricted',
    review: f.accepted ? 'Accepted by a reviewer' : 'Not reviewed yet',
    scan: f.scan_label === 'not_scanned' ? 'Not virus-scanned (scanning is off on this installation)' : null,
    superseded: f.status === 'superseded',
  };
}

const OUTCOME_WORDS: Record<string, string> = { pass: 'Passed', fail: 'Failed', unprovable: "Couldn't prove" };

/** GET /public/room/controls/:id (row 102). */
export async function publicRoomControl(deps: RoomDeps, ctx: RoomRequestContext, controlId: string) {
  const r = await resolveRoom(deps, ctx);
  if (!roomControls(r.room).has(controlId) || !r.room.framework_id) throw new NotFoundError('That control is not part of this room.');
  const now = deps.engine.now();
  const out = await orgTx(deps.engine.sql, r.orgId, async (tx) => {
    const fw = await loadAuditFramework(tx, r.orgId, String(r.room.framework_id));
    if (!fw) throw new NotFoundError('That control is not part of this room.');
    const [control] = await auditControls(tx, r.orgId, fw.id, now, [controlId]);
    if (!control) throw new NotFoundError('That control is not part of this room.');
    const template = frameworkTemplate(fw.template_key);
    const titles = new Map((template ? requirementsForControl(template, control.control_key) : []).map((q) => [q.ref_code, q.title]));
    const snaps = await tx.unsafe(
      `SELECT ${SNAPSHOT_SELECT}, a.plain_statement FROM bastion_evidence_snapshots s
         JOIN bastion_assertions a ON a.id = s.assertion_id AND a.organization_id = s.organization_id
        WHERE s.organization_id = $1 AND s.control_id = $2
          AND ($3::date IS NULL OR s.created_at::date >= $3::date) AND ($4::date IS NULL OR s.created_at::date <= $4::date)
        ORDER BY s.created_at DESC LIMIT 50`,
      [r.orgId, controlId, (r.room.period_start as string | null) ?? null, (r.room.period_end as string | null) ?? null],
    );
    const files = await roomFiles(tx, r.orgId, r.room, controlId, null);
    return {
      control: { ...control, id: control.control_id },
      requirements: control.requirement_codes.map((code) => ({ ref_code: code, title: titles.get(code) ?? null })),
      evidence: snaps.map((s) => {
        const shown = present(s as Record<string, unknown>, false);
        return {
          id: s.id,
          recorded_at: s.created_at,
          what: (s.plain_statement as string | null) ?? null,
          outcome: s.outcome,
          outcome_words: OUTCOME_WORDS[String(s.outcome)] ?? String(s.outcome),
          explanation: shown.explanation,
        };
      }),
      files: files.map((f) => fileOut(f as Record<string, unknown>)),
      accepted_risks: await acceptedRisks(tx, r.orgId, [controlId]),
    };
  });
  await logRoomAccess(deps, r, ctx, 'control', controlId);
  return { data: out };
}

interface EvidenceHit {
  kind: 'check' | 'file' | 'statement';
  title: string;
  object_key: string | null;
  redacted: boolean;
  content_type: string | null;
  size: number | null;
  /** SHA-256 of the stored record (checks): the auditor can match it against a packet or seal. */
  fingerprint: string | null;
  body: Record<string, unknown>;
}

async function findRoomEvidence(deps: RoomDeps, r: ResolvedRoom, id: string): Promise<EvidenceHit> {
  return orgTx(deps.engine.sql, r.orgId, async (tx) => {
    const controls = [...roomControls(r.room)];
    const snap = (await tx`
      SELECT s.id, s.control_id, s.outcome, s.created_at, s.content_sha256, s.summary, s.probe_key, s.probe_version,
             s.cited_refs, s.overflow_count, s.population_checked, s.population_unlisted,
             c.title AS control_title, a.plain_statement, o.object_key, o.bytes_redacted_at, o.size_bytes
        FROM bastion_evidence_snapshots s
        JOIN bastion_controls c ON c.id = s.control_id AND c.organization_id = s.organization_id
        JOIN bastion_assertions a ON a.id = s.assertion_id AND a.organization_id = s.organization_id
        LEFT JOIN bastion_evidence_objects o ON o.organization_id = s.organization_id AND o.content_sha256 = s.content_sha256
       WHERE s.organization_id = ${r.orgId} AND s.id = ${id} AND s.control_id = ANY(${controls}::uuid[])
         ${inPeriod(tx, 's.created_at', r.room)}`)[0];
    if (snap) {
      const shown = present(snap as Record<string, unknown>, false);
      return {
        kind: 'check' as const,
        title: `${String(snap.control_title)} check, ${new Date(snap.created_at as string).toISOString().slice(0, 10)}`,
        object_key: (snap.object_key as string | null) ?? null,
        redacted: !!snap.bytes_redacted_at,
        content_type: 'application/json',
        size: snap.size_bytes == null ? null : Number(snap.size_bytes),
        fingerprint: (snap.content_sha256 as string | null) ?? null,
        body: {
          id: snap.id,
          kind: 'check',
          control_title: snap.control_title,
          what: snap.plain_statement ?? null,
          recorded_at: snap.created_at,
          outcome: snap.outcome,
          outcome_words: OUTCOME_WORDS[String(snap.outcome)] ?? String(snap.outcome),
          explanation: shown.explanation,
        },
      };
    }
    const file = (await roomFiles(tx, r.orgId, r.room, null, id))[0];
    if (!file) throw new NotFoundError('That evidence is not part of this room.');
    const obj = file.content_sha256
      ? (await tx`SELECT object_key, bytes_redacted_at, size_bytes FROM bastion_evidence_objects
                   WHERE organization_id = ${r.orgId} AND content_sha256 = ${String(file.content_sha256)}`)[0]
      : undefined;
    const out = fileOut(file as Record<string, unknown>);
    return {
      kind: out.kind as 'file' | 'statement',
      title: String(file.title),
      object_key: (obj?.object_key as string | null) ?? null,
      redacted: !!obj?.bytes_redacted_at,
      content_type: (file.content_type as string | null) ?? null,
      size: obj?.size_bytes == null ? null : Number(obj.size_bytes),
      fingerprint: null,
      body: out,
    };
  });
}

/** GET /public/room/evidence/:id (row 103), and its `?download=1` byte stream. */
export async function publicRoomEvidence(deps: RoomDeps, ctx: RoomRequestContext, id: string) {
  const r = await resolveRoom(deps, ctx);
  const hit = await findRoomEvidence(deps, r, id);
  let file: 'available' | 'missing' | 'redacted' | 'none' = hit.object_key ? 'available' : 'none';
  if (hit.redacted) file = 'redacted';
  else if (hit.object_key && deps.engine.storage) {
    const st = await withStorageTimeout('stat', deps.engine.storage.stat(hit.object_key), deps.engine.putTimeoutMs).catch(() => null);
    if (!st) {
      file = 'missing';
      deps.engine.log.error({ organization_id: r.orgId, evidence_id: id }, 'bastion-room: evidence file missing from the bucket');
    }
  }
  await logRoomAccess(deps, r, ctx, 'evidence', id);
  return {
    data: {
      ...hit.body,
      file,
      file_words: file === 'missing' ? 'Evidence file missing' : file === 'redacted' ? 'This file was redacted' : null,
    },
  };
}

/**
 * What a room download of a check carries (#307): the same counts-only view the room's JSON shows,
 * plus the stored record's fingerprint. The stored evidence document itself (population names,
 * repository lists, cited entity ids, probe params) never leaves through the room; it goes only
 * into an audit packet the organization builds and sends on purpose.
 */
export function roomCheckDocument(hit: Pick<EvidenceHit, 'body' | 'fingerprint'>): Buffer {
  const doc = {
    ...hit.body,
    fingerprint_sha256: hit.fingerprint,
    note: 'Counts only. This is the summary an auditor room shows; the full evidence record stays with the organization and is identified by fingerprint_sha256.',
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export async function publicRoomDownload(deps: RoomDeps, ctx: RoomRequestContext, id: string) {
  const r = await resolveRoom(deps, ctx);
  const hit = await findRoomEvidence(deps, r, id);
  if (hit.redacted) throw new NotFoundError('This file was redacted.');
  if (hit.kind === 'check') {
    // Never the stored object: it is the detail view, and the room is counts-only (spec 3.1, 5.2).
    const body = roomCheckDocument(hit);
    await logRoomAccess(deps, r, ctx, 'download', id);
    return {
      stream: Readable.from([body]),
      headers: downloadHeaders({ contentType: 'application/json', filename: `${hit.title}.json`, size: body.length }),
    };
  }
  if (!hit.object_key || !deps.engine.storage) throw new NotFoundError('There is no file to download for this evidence.');
  let obj: Awaited<ReturnType<NonNullable<EngineDeps['storage']>['getStream']>>;
  try {
    obj = await withStorageTimeout('get', deps.engine.storage.getStream(hit.object_key), deps.engine.putTimeoutMs);
  } catch {
    throw new NotFoundError('Evidence file missing.');
  }
  await logRoomAccess(deps, r, ctx, 'download', id);
  const ext = hit.kind === 'statement' ? '.txt' : '';
  return { stream: obj.stream, headers: downloadHeaders({ contentType: hit.content_type, filename: `${hit.title}${ext}`, size: hit.size ?? obj.size }) };
}

/** POST /public/room/requests (row 104): at most 20 an hour per room. */
export async function publicRoomRequest(deps: RoomDeps, ctx: RoomRequestContext, body: BastionPublicRoomRequest) {
  const r = await resolveRoom(deps, ctx);
  if (body.control_id && !roomControls(r.room).has(body.control_id)) throw new NotFoundError('That control is not part of this room.');
  const now = deps.engine.now();
  const row = await orgTx(deps.engine.sql, r.orgId, async (tx) => {
    // Serialize per room so the hourly cap holds under concurrent posts.
    await tx`SELECT 1 FROM bastion_auditor_rooms WHERE organization_id = ${r.orgId} AND id = ${String(r.room.id)} FOR UPDATE`;
    const recent = (await tx`SELECT count(*)::int AS n FROM bastion_auditor_requests
                              WHERE organization_id = ${r.orgId} AND room_id = ${String(r.room.id)} AND created_at > ${new Date(now.getTime() - 3_600_000)}`)[0];
    if (Number(recent?.n ?? 0) >= BASTION_ROOM_REQUESTS_PER_HOUR) {
      throw new RateLimitedError('This room has sent the most questions allowed in an hour. Try again later.', 'ROOM_REQUESTS_LIMIT', 3600);
    }
    const [q] = await tx`
      INSERT INTO bastion_auditor_requests (organization_id, room_id, control_id, requester_name, body, created_at)
      VALUES (${r.orgId}, ${String(r.room.id)}, ${body.control_id ?? null}, ${body.requester_name}, ${body.body}, ${now})
      RETURNING id, status, created_at`;
    return q;
  });
  await logRoomAccess(deps, r, ctx, 'request', String(row?.id));
  return { data: { id: row?.id, status: row?.status, created_at: row?.created_at, message: 'Your question was sent. The team will answer it in Bastion.' } };
}
