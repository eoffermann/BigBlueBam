// Sharing (spec 5.1 rows 84-93, 5.2, 7.2; M9): auditor rooms on the creator's side, the auditors'
// questions, and audit packets. The public side of a room is room.service.ts; what an auditor sees
// is built once in audit-view.ts and used by both the room and the creator's Preview.
//
// Room create, revoke and unlock are disclosure acts: their routes are session-only and refuse
// impersonation (spec 2.8, #136), so no API key or agent can open a room.

import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { withStorageTimeout } from '@bigbluebam/storage';
import type {
  BastionAccessLogQuery,
  BastionAuditorRequestListQuery,
  BastionAuditorRequestUpdate,
  BastionAuditorRoomCreate,
  BastionAuditorRoomListQuery,
  BastionExportCreate,
  BastionExportListQuery,
} from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import { auditRaw } from '../lib/audit-raw.js';
import { decodeIdCursor, encodeIdCursor, pageOf } from '../lib/cursor.js';
import { downloadHeaders, safeFilename } from '../lib/download.js';
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationFailure } from '../lib/errors.js';
import { frameworkTemplate } from '../library/index.js';
import { assertSoaCompleteForPacket, SoaIncompleteError } from '../library/soa.js';
import { runInOrgScope } from '../plugins/rls.js';
import { acceptedRisks, auditControls, loadAuditFramework, restoreNotices, sealHistory, soaFor, stateCounts } from './audit-view.js';
import { soaLinks } from './frameworks.service.js';
import type { Viewer } from './types.js';

export interface SharingDeps {
  engine: EngineDeps;
  enqueuePacket: (orgId: string, packetId: string) => Promise<boolean>;
}

const DAY_MS = 86_400_000;

/** A new room token: 32 random bytes, base64url (43 characters). Only its SHA-256 is stored. */
export function newRoomToken(): { token: string; sha256: string; hint: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, sha256: roomTokenSha256(token), hint: token.slice(0, 4) };
}

export function roomTokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type RoomState = 'active' | 'expired' | 'revoked' | 'locked';

/** Pure: a room's state at `now` (revoked wins, then locked, then expired). */
export function roomStateAt(r: { revoked_at?: unknown; locked_at?: unknown; expires_at?: unknown }, now: Date): RoomState {
  if (r.revoked_at) return 'revoked';
  if (r.locked_at) return 'locked';
  if (new Date(r.expires_at as string).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

async function requireSettings(tx: Tx, orgId: string) {
  const s = (await tx`SELECT auditor_room_max_days, max_packet_bytes FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  if (!s) throw new ConflictError('Set Bastion up first: adopt a framework in Setup.', 'NOT_SET_UP');
  return { auditor_room_max_days: Number(s.auditor_room_max_days), max_packet_bytes: Number(s.max_packet_bytes) };
}

function roomOut(r: Record<string, unknown>, now: Date) {
  return {
    id: r.id,
    label: r.label,
    framework_id: r.framework_id,
    framework_name: r.framework_name ?? null,
    period_start: r.period_start ?? null,
    period_end: r.period_end ?? null,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at ?? null,
    locked_at: r.locked_at ?? null,
    state: roomStateAt(r, now),
    has_passcode: !!r.has_passcode,
    passcode_failures: Number(r.passcode_failures ?? 0),
    link_hint: r.token_hint ? `${r.token_hint}...` : null,
    control_count: Array.isArray(r.control_ids) ? r.control_ids.length : 0,
    restricted_count: Array.isArray(r.restricted_evidence_ids) ? r.restricted_evidence_ids.length : 0,
    access_count: Number(r.access_count ?? 0),
    last_accessed_at: r.last_accessed_at ?? null,
    open_requests: Number(r.open_requests ?? 0),
    created_by_name: r.created_by_name ?? null,
    created_at: r.created_at,
  };
}

const ROOM_SELECT = (tx: Tx, orgId: string) => tx`
  SELECT r.id, r.label, r.framework_id, f.name AS framework_name, r.period_start::text AS period_start,
         r.period_end::text AS period_end, r.expires_at, r.revoked_at, r.locked_at, (r.passcode_hash IS NOT NULL) AS has_passcode,
         r.passcode_failures, r.token_hint, r.control_ids, r.restricted_evidence_ids, r.access_count, r.last_accessed_at,
         r.created_at, r.created_by, u.display_name AS created_by_name,
         (SELECT count(*)::int FROM bastion_auditor_requests q WHERE q.organization_id = r.organization_id AND q.room_id = r.id AND q.status = 'open') AS open_requests
    FROM bastion_auditor_rooms r
    LEFT JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
    LEFT JOIN users u ON u.id = r.created_by
   WHERE r.organization_id = ${orgId}`;

/** GET /auditor-rooms (row 84). */
export async function listRooms(deps: SharingDeps, viewer: Viewer, q: BastionAuditorRoomListQuery) {
  const now = deps.engine.now();
  const rows = await orgTx(deps.engine.sql, viewer.org_id, (tx) => tx`${ROOM_SELECT(tx, viewer.org_id)} ORDER BY r.created_at DESC LIMIT 500`);
  const all = rows.map((r) => roomOut(r as Record<string, unknown>, now));
  return { data: q.include_closed === false ? all.filter((r) => r.state === 'active' || r.state === 'locked') : all, next_cursor: null };
}

async function loadRoom(tx: Tx, orgId: string, id: string, lock = false) {
  const r = (await tx`${ROOM_SELECT(tx, orgId)} AND r.id = ${id} ${lock ? tx`FOR UPDATE OF r` : tx``}`)[0];
  if (!r) throw new NotFoundError('We could not find that auditor room.');
  return r as Record<string, unknown>;
}

/**
 * The restricted items a room may expose: restricted, live, and linked to one of the room's
 * controls. Anything else in the request is refused by name count, never silently dropped.
 */
async function checkRestrictedAllowlist(tx: Tx, orgId: string, ids: readonly string[], controlIds: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const ok = await tx`
    SELECT DISTINCT e.id FROM bastion_manual_evidence e
      JOIN bastion_manual_evidence_links l ON l.organization_id = e.organization_id AND l.manual_evidence_id = e.id AND l.unlinked_at IS NULL
      JOIN bastion_assertions a ON a.organization_id = l.organization_id AND a.id = l.assertion_id
     WHERE e.organization_id = ${orgId} AND e.id = ANY(${[...ids]}::uuid[]) AND e.sensitivity = 'restricted'
       AND e.status IN ('active', 'superseded') AND a.control_id = ANY(${[...controlIds]}::uuid[])`;
  if (ok.length !== new Set(ids).size) {
    throw new ValidationFailure(
      `${new Set(ids).size - ok.length} of the restricted items you picked are not restricted evidence for the controls in this room.`,
      'RESTRICTED_NOT_IN_ROOM',
      [{ field: 'restricted_evidence_ids', issue: 'not_in_room' }],
    );
  }
}

/** POST /auditor-rooms (row 85): the token is returned once and never stored. */
export async function createRoom(deps: SharingDeps, viewer: Viewer, body: BastionAuditorRoomCreate, canRestricted: boolean) {
  if (body.restricted_evidence_ids.length > 0 && !canRestricted) {
    throw new ForbiddenError('Only people who may see restricted evidence can share it with an auditor.', 'RESTRICTED_NOT_ALLOWED');
  }
  const now = deps.engine.now();
  const minted = newRoomToken();
  const passcodeHash = body.passcode ? await argon2.hash(body.passcode, { type: argon2.argon2id }) : null;
  const room = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const settings = await requireSettings(tx, viewer.org_id);
    if (body.expires_in_days > settings.auditor_room_max_days) {
      throw new ValidationFailure(
        `Auditor links can last at most ${settings.auditor_room_max_days} days here (Settings).`,
        'ROOM_TOO_LONG',
        [{ field: 'expires_in_days', issue: 'too_long' }],
      );
    }
    const fw = await loadAuditFramework(tx, viewer.org_id, body.framework_id);
    if (!fw) throw new NotFoundError('We could not find that framework.');
    const applicable = (await auditControls(tx, viewer.org_id, fw.id, now)).map((c) => c.control_id);
    let controlIds = applicable;
    if (body.control_ids) {
      const known = new Set(applicable);
      const unknown = body.control_ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new ValidationFailure(`${unknown.length} of the controls you picked are not part of ${fw.name}.`, 'CONTROL_NOT_IN_FRAMEWORK', [
          { field: 'control_ids', issue: 'not_in_framework' },
        ]);
      }
      controlIds = [...new Set(body.control_ids)];
    }
    if (controlIds.length === 0) throw new ConflictError(`${fw.name} has no applicable controls to share yet.`, 'NOTHING_TO_SHARE');
    const restricted = [...new Set(body.restricted_evidence_ids)];
    await checkRestrictedAllowlist(tx, viewer.org_id, restricted, controlIds);
    const expiresAt = new Date(now.getTime() + body.expires_in_days * DAY_MS);
    const [row] = await tx`
      INSERT INTO bastion_auditor_rooms
        (organization_id, framework_id, label, token_sha256, token_hint, passcode_hash, period_start, period_end,
         control_ids, restricted_evidence_ids, expires_at, created_by, created_at)
      VALUES (${viewer.org_id}, ${fw.id}, ${body.label}, ${minted.sha256}, ${minted.hint}, ${passcodeHash},
              ${body.period_start}, ${body.period_end}, ${controlIds}::uuid[], ${restricted}::uuid[], ${expiresAt}, ${viewer.id}, ${now})
      RETURNING id`;
    const id = String(row?.id);
    await auditRaw(tx, viewer, 'auditor_room.create', { type: 'auditor_room', id }, {
      label: body.label,
      framework_id: fw.id,
      controls: controlIds.length,
      restricted: restricted.length,
      expires_at: expiresAt.toISOString(),
      passcode: !!passcodeHash,
    });
    await enqueueBastionEvent(
      'auditor_room.created',
      { room_id: id, label: body.label, framework_id: fw.id, controls: controlIds.length, restricted: restricted.length, expires_at: expiresAt.toISOString() },
      tx,
      { orgId: viewer.org_id, idempotencyKey: `auditor_room.created:${id}`, actorId: viewer.id, actorType: 'user' },
    );
    return loadRoom(tx, viewer.org_id, id);
  });
  return {
    data: {
      ...roomOut(room, now),
      token: minted.token,
      link: `/bastion/room#${minted.token}`,
      token_notice: 'Copy this link now. It is shown only once.',
    },
  };
}

/** POST /auditor-rooms/:id/revoke (row 86): the link stops working at once. */
export async function revokeRoom(deps: SharingDeps, viewer: Viewer, id: string) {
  const now = deps.engine.now();
  const room = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const r = await loadRoom(tx, viewer.org_id, id, true);
    if (r.revoked_at) return r;
    await tx`UPDATE bastion_auditor_rooms SET revoked_at = ${now} WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'auditor_room.revoke', { type: 'auditor_room', id }, { label: r.label });
    await enqueueBastionEvent('auditor_room.revoked', { room_id: id, label: r.label, reason: 'revoked' }, tx, {
      orgId: viewer.org_id,
      idempotencyKey: `auditor_room.revoked:${id}`,
      actorId: viewer.id,
      actorType: 'user',
    });
    return loadRoom(tx, viewer.org_id, id);
  });
  return { data: roomOut(room, now) };
}

/** POST /auditor-rooms/:id/unlock (row 87): after 5 wrong passcodes locked the room. */
export async function unlockRoom(deps: SharingDeps, viewer: Viewer, id: string) {
  const now = deps.engine.now();
  const room = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const r = await loadRoom(tx, viewer.org_id, id, true);
    if (r.revoked_at) throw new ConflictError('This room was revoked. Create a new one instead.', 'ROOM_REVOKED');
    if (!r.locked_at) throw new ConflictError('This room is not locked.', 'ROOM_NOT_LOCKED');
    await tx`UPDATE bastion_auditor_rooms SET locked_at = NULL, passcode_failures = 0, unlocked_by = ${viewer.id}, unlocked_at = ${now}
              WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'auditor_room.unlock', { type: 'auditor_room', id }, { locked_at: r.locked_at });
    return loadRoom(tx, viewer.org_id, id);
  });
  return { data: roomOut(room, now) };
}

const VIEW_WORDS: Record<string, string> = {
  overview: 'Opened the room',
  control: 'Looked at a control',
  evidence: 'Looked at evidence',
  download: 'Downloaded a file',
  request: 'Asked a question',
};

/** "Chrome on Windows" from a user agent; never the raw string on a default view. */
export function deviceOf(ua: string | null | undefined): string {
  const s = ua ?? '';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /Firefox\//.test(s)
      ? 'Firefox'
      : /Chrome\//.test(s)
        ? 'Chrome'
        : /Safari\//.test(s)
          ? 'Safari'
          : /curl|wget|python|node|Go-http/i.test(s)
            ? 'A script'
            : 'A browser';
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

/** GET /auditor-rooms/:id/access-log (row 88): what was opened, when, and by which visitor. */
export async function roomAccessLog(deps: SharingDeps, viewer: Viewer, id: string, q: BastionAccessLogQuery) {
  return orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const room = await loadRoom(tx, viewer.org_id, id);
    const after = q.cursor ? decodeIdCursor(q.cursor) : null;
    const rows = await tx`
      SELECT l.id, l.accessed_at, l.view_kind, l.object_ref, l.ip_hash, l.user_agent_trunc, c.title AS control_title
        FROM bastion_auditor_access_log l
        LEFT JOIN bastion_controls c ON c.organization_id = l.organization_id AND l.view_kind = 'control' AND c.id::text = l.object_ref
       WHERE l.organization_id = ${viewer.org_id} AND l.room_id = ${id}
         ${after ? tx`AND (l.accessed_at, l.id) < (SELECT p.accessed_at, p.id FROM bastion_auditor_access_log p WHERE p.id = ${after}::uuid AND p.organization_id = ${viewer.org_id})` : tx``}
       ORDER BY l.accessed_at DESC, l.id DESC LIMIT ${q.limit + 1}`;
    // Visitors are numbered by their one-way address fingerprint, oldest first across the room.
    const visitors = await tx`
      SELECT ip_hash FROM bastion_auditor_access_log WHERE organization_id = ${viewer.org_id} AND room_id = ${id} AND ip_hash IS NOT NULL
       GROUP BY ip_hash ORDER BY min(accessed_at)`;
    const number = new Map(visitors.map((v, i) => [String(v.ip_hash), i + 1]));
    const page = pageOf(rows, q.limit, (r) => encodeIdCursor(String(r.id)));
    return {
      ...page,
      room: roomOut(room, deps.engine.now()),
      data: page.data.map((r) => ({
        id: r.id,
        accessed_at: r.accessed_at,
        view_kind: r.view_kind,
        what: r.view_kind === 'control' && r.control_title ? `Looked at "${r.control_title as string}"` : (VIEW_WORDS[String(r.view_kind)] ?? 'Visited'),
        visitor: r.ip_hash ? `Visitor ${number.get(String(r.ip_hash)) ?? '?'}` : 'Visitor',
        device: deviceOf(r.user_agent_trunc as string | null),
      })),
    };
  });
}

/** Restricted items a room exposes, by title (the Preview lists them). */
async function restrictedTitles(tx: Tx, orgId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await tx`SELECT id, title FROM bastion_manual_evidence WHERE organization_id = ${orgId} AND id = ANY(${[...ids]}::uuid[]) ORDER BY title`;
  return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
}

/**
 * The overview an auditor sees for a room. Shared by the public room and the creator's Preview,
 * so both always show the same thing.
 */
export async function roomOverview(engine: EngineDeps, orgId: string, room: Record<string, unknown>) {
  const now = engine.now();
  const controlIds = (room.control_ids as string[] | null) ?? [];
  const built = await orgTx(engine.sql, orgId, async (tx) => {
    const org = (await tx`SELECT name FROM organizations WHERE id = ${orgId}`)[0];
    const fw = room.framework_id ? await loadAuditFramework(tx, orgId, String(room.framework_id)) : null;
    const controls = fw ? await auditControls(tx, orgId, fw.id, now, controlIds) : [];
    return {
      org_name: String(org?.name ?? ''),
      fw,
      controls,
      risks: await acceptedRisks(tx, orgId, controlIds),
      seals: await sealHistory(tx, orgId),
      restricted: await restrictedTitles(tx, orgId, (room.restricted_evidence_ids as string[] | null) ?? []),
    };
  });
  const soa = built.fw ? await soaFor(orgId, built.fw) : null;
  return {
    room: {
      label: room.label,
      organization_name: built.org_name,
      framework_name: built.fw?.name ?? null,
      is_iso: built.fw?.is_iso ?? false,
      period_start: room.period_start ?? null,
      period_end: room.period_end ?? null,
      expires_at: room.expires_at,
    },
    numbers: stateCounts(built.controls),
    controls: built.controls.map((c) => ({ ...c, id: c.control_id })),
    accepted_risks: built.risks,
    restricted_items: built.restricted,
    statement_of_applicability: soa?.rows ?? null,
    seals: built.seals.seals,
    public_keys: built.seals.public_keys,
    notices: await restoreNotices(engine, orgId),
    not_an_audit: 'Bastion shows the evidence your organization collected. It is not an auditor and does not certify anything.',
  };
}

/** GET /auditor-rooms/:id/preview: exactly what the auditor sees, without logging a visit. */
export async function previewRoom(deps: SharingDeps, viewer: Viewer, id: string) {
  const room = await orgTx(deps.engine.sql, viewer.org_id, (tx) => loadRoom(tx, viewer.org_id, id));
  return { data: { ...(await roomOverview(deps.engine, viewer.org_id, room)), state: roomStateAt(room, deps.engine.now()) } };
}

// ── Auditor questions ────────────────────────────────────────────────────────────────────

/** GET /auditor-requests (row 89). */
export async function listRequests(deps: SharingDeps, viewer: Viewer, q: BastionAuditorRequestListQuery) {
  const rows = await orgTx(deps.engine.sql, viewer.org_id, (tx) => tx`
    SELECT q.id, q.room_id, r.label AS room_label, q.control_id, c.title AS control_title, q.requester_name, q.body, q.status,
           q.answer_note, u.display_name AS answered_by_name, q.created_at, q.updated_at
      FROM bastion_auditor_requests q
      JOIN bastion_auditor_rooms r ON r.id = q.room_id AND r.organization_id = q.organization_id
      LEFT JOIN bastion_controls c ON c.id = q.control_id AND c.organization_id = q.organization_id
      LEFT JOIN users u ON u.id = q.answered_by
     WHERE q.organization_id = ${viewer.org_id}
       ${q.room_id ? tx`AND q.room_id = ${q.room_id}` : tx``}
       ${q.status ? tx`AND q.status = ${q.status}` : tx``}
     ORDER BY (q.status = 'open') DESC, q.created_at DESC LIMIT 500`);
  return { data: rows, next_cursor: null };
}

/** PATCH /auditor-requests/:id (row 90). */
export async function updateRequest(deps: SharingDeps, viewer: Viewer, id: string, body: BastionAuditorRequestUpdate) {
  const row = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const cur = (await tx`SELECT id, status FROM bastion_auditor_requests WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!cur) throw new NotFoundError('We could not find that question.');
    if (cur.status === 'closed') throw new ConflictError('This question is already closed.', 'REQUEST_CLOSED');
    const [updated] = await tx`
      UPDATE bastion_auditor_requests
         SET status = ${body.status},
             answer_note = coalesce(${body.answer_note ?? null}, answer_note),
             answered_by = CASE WHEN ${body.status} = 'answered' THEN ${viewer.id}::uuid ELSE answered_by END
       WHERE organization_id = ${viewer.org_id} AND id = ${id}
      RETURNING id, room_id, control_id, requester_name, body, status, answer_note, answered_by, created_at, updated_at`;
    await auditRaw(tx, viewer, `auditor_request.${body.status}`, { type: 'auditor_request', id }, {});
    return updated;
  });
  return { data: row };
}

// ── Audit packets ────────────────────────────────────────────────────────────────────────

/**
 * One build attempt's zip (#312). Every claim gets its own key, so a failing or stalled attempt
 * can only ever delete its own bytes, never the zip a later attempt finished; the packet row
 * records the key of the attempt that succeeded.
 */
export function packetObjectKey(orgId: string, packetId: string, attempt: string): string {
  return `packets/${orgId}/${packetId}/${attempt}.zip`;
}

const STAGE_WORDS: Record<string, string> = {
  collecting: 'Collecting controls',
  checking_commitments: 'Checking recorded names',
  writing_evidence: 'Writing evidence',
  rendering_summary: 'Rendering summary',
  zipping: 'Zipping',
  uploading: 'Uploading',
};

/** The progress line the Sharing page shows ("Writing evidence 120 of 412"). */
export function stageWords(stage: string | null, progress: number, total: number | null): string | null {
  if (!stage) return null;
  const base = STAGE_WORDS[stage] ?? stage;
  if (stage === 'writing_evidence' && total) return `${base} ${progress} of ${total}`;
  return base;
}

/** POST /exports (row 91): queue one packet; the worker builds it (spec 7.2). */
export async function createExport(deps: SharingDeps, viewer: Viewer, body: BastionExportCreate, canRestricted: boolean) {
  if (body.include_restricted && !canRestricted) {
    throw new ForbiddenError('Only people who may see restricted evidence can put it in a packet.', 'RESTRICTED_NOT_ALLOWED');
  }
  if (!deps.engine.storage) throw new UnavailableError("Evidence storage isn't set up on this installation, so a packet can't be built.", 'STORAGE_NOT_SET_UP');
  const fw = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    await requireSettings(tx, viewer.org_id);
    const f = await loadAuditFramework(tx, viewer.org_id, body.framework_id);
    if (!f) throw new NotFoundError('We could not find that framework.');
    return f;
  });
  // An ISO packet needs a finished Statement of Applicability (spec 2.1).
  const template = frameworkTemplate(fw.template_key);
  if (template?.is_iso) {
    const links = await runInOrgScope(viewer.org_id, (tx) => soaLinks(tx, viewer.org_id, fw.id));
    try {
      assertSoaCompleteForPacket(template, links);
    } catch (err) {
      if (err instanceof SoaIncompleteError) throw new ConflictError(err.message, 'SOA_INCOMPLETE');
      throw err;
    }
  }
  const row = await orgTx(deps.engine.sql, viewer.org_id, async (tx) => {
    const [r] = await tx`
      INSERT INTO bastion_export_packets (organization_id, framework_id, period_start, period_end, include_restricted, status, requested_by)
      VALUES (${viewer.org_id}, ${fw.id}, ${body.period_start}, ${body.period_end}, ${body.include_restricted}, 'queued', ${viewer.id})
      RETURNING id, status, created_at`;
    await auditRaw(tx, viewer, 'export.create', { type: 'export_packet', id: String(r?.id) }, {
      framework_id: fw.id,
      period_start: body.period_start,
      period_end: body.period_end,
      include_restricted: body.include_restricted,
    });
    return r as Record<string, unknown>;
  });
  const queued = await deps.enqueuePacket(viewer.org_id, String(row.id));
  return {
    data: {
      id: row.id,
      framework_id: fw.id,
      framework_name: fw.name,
      period_start: body.period_start,
      period_end: body.period_end,
      include_restricted: body.include_restricted,
      status: 'queued',
      stage_words: 'Waiting to start',
      queued_for_worker: queued,
      created_at: row.created_at,
    },
  };
}

/** GET /exports (row 92). */
export async function listExports(deps: SharingDeps, viewer: Viewer, q: BastionExportListQuery) {
  const rows = await orgTx(deps.engine.sql, viewer.org_id, (tx) => tx`
    SELECT p.id, p.framework_id, f.name AS framework_name, p.period_start::text AS period_start, p.period_end::text AS period_end,
           p.include_restricted, p.status, p.stage, p.stage_progress, p.size_bytes, p.error, p.created_at, p.updated_at,
           u.display_name AS requested_by_name
      FROM bastion_export_packets p
      LEFT JOIN bastion_frameworks f ON f.id = p.framework_id AND f.organization_id = p.organization_id
      LEFT JOIN users u ON u.id = p.requested_by
     WHERE p.organization_id = ${viewer.org_id} ${q.status ? tx`AND p.status = ${q.status}` : tx``}
     ORDER BY p.created_at DESC LIMIT ${q.limit}`);
  return {
    data: rows.map((r) => ({
      ...r,
      stage_words:
        r.status === 'queued'
          ? 'Waiting to start'
          : r.status === 'running'
            ? stageWords(r.stage as string | null, Number(r.stage_progress ?? 0), null)
            : r.status === 'succeeded'
              ? 'Ready to download'
              : r.status === 'failed'
                ? 'Could not be built'
                : 'No longer available',
    })),
    next_cursor: null,
  };
}

/** GET /exports/:id/download (row 93): the zip, streamed from the Bastion bucket. */
export async function openExportDownload(deps: SharingDeps, viewer: Viewer, id: string, canRestricted: boolean) {
  const engine = deps.engine;
  const row = await orgTx(engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`
      SELECT p.status, p.object_key, p.size_bytes, p.include_restricted, p.period_start::text AS period_start, p.period_end::text AS period_end,
             f.name AS framework_name
        FROM bastion_export_packets p LEFT JOIN bastion_frameworks f ON f.id = p.framework_id AND f.organization_id = p.organization_id
       WHERE p.organization_id = ${viewer.org_id} AND p.id = ${id}`)[0];
    if (!r || (r.include_restricted && !canRestricted)) throw new NotFoundError('We could not find that packet.');
    if (r.status !== 'succeeded' || !r.object_key) throw new ConflictError('This packet is not ready to download.', 'PACKET_NOT_READY');
    await auditRaw(tx, viewer, 'export.download', { type: 'export_packet', id });
    return r;
  });
  if (!engine.storage) throw new UnavailableError("Evidence storage isn't set up on this installation.", 'STORAGE_NOT_SET_UP');
  let obj: Awaited<ReturnType<typeof engine.storage.getStream>>;
  try {
    obj = await withStorageTimeout('get', engine.storage.getStream(String(row.object_key)), engine.putTimeoutMs);
  } catch {
    throw new NotFoundError('The packet file is missing. Build it again.');
  }
  const name = safeFilename(`audit-packet ${String(row.framework_name ?? 'framework')} ${String(row.period_start)} to ${String(row.period_end)}.zip`, 'audit-packet.zip');
  return { stream: obj.stream, headers: downloadHeaders({ contentType: 'application/zip', filename: name, size: Number(row.size_bytes ?? obj.size) }) };
}
