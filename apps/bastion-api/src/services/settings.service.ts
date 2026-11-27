// Settings, delivery problems and the audit log (spec 5.1 rows 96-100, 6.1 Settings; M9).
//
//   GET /settings                       the org's Bastion settings, the AI providers it may pick,
//                                       the evidence-integrity facts (key fingerprints, restores
//                                       awaiting acknowledgement) and the off-site backup status
//   PATCH /settings                     owner/admin (bastion.settings.write), audited per field
//   GET /delivery-problems              dead outbox rows, in plain words
//   POST /delivery-problems/:id/retry   operator re-drive: replayed only if no newer row of the
//                                       same kind for the same key was delivered since; otherwise
//                                       marked superseded (spec 7, outbox-drain)
//   GET /audit                          bastion_audit_log, newest first

import type { BastionAuditLogQuery, BastionDeliveryProblemListQuery, BastionSettingsUpdate } from '@bigbluebam/shared';
import { type EngineDeps, orgTx } from '../engine/context.js';
import { auditRaw } from '../lib/audit-raw.js';
import { decodeIdCursor, encodeIdCursor, pageOf } from '../lib/cursor.js';
import { ConflictError, NotFoundError, ValidationFailure } from '../lib/errors.js';
import { pdHmacKeyId, publishedSealKeys } from '../lib/keys.js';
import type { Viewer } from './types.js';

export interface SettingsFacts {
  offsite_backup_configured: boolean;
  storage_ok: boolean;
}

const SETTINGS_COLUMNS = [
  'remediation_tasks',
  'timezone',
  'evaluation_hour_local',
  'llm_provider_id',
  'stale_after_hours',
  'not_assessed_grace_days',
  'manual_expiry_warn_days',
  'questionnaire_high_floor',
  'questionnaire_medium_floor',
  'max_llm_calls_per_compile',
  'max_llm_calls_per_questionnaire',
  'max_rows_per_questionnaire',
  'auditor_room_max_days',
  'max_packet_bytes',
] as const;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "a1b2 c3d4 e5f6": a short, readable fingerprint (never the key). */
export function fingerprint(id: string): string {
  const hex = id.replace(/^[a-z]+:/, '').replace(/[^0-9a-f]/gi, '').slice(0, 12);
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

export async function getSettings(engine: EngineDeps, viewer: Viewer, facts: SettingsFacts) {
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const s = (await tx`
      SELECT s.*, p.name AS compliance_project_name
        FROM bastion_org_settings s LEFT JOIN projects p ON p.id = s.compliance_project_id
       WHERE s.organization_id = ${viewer.org_id}`)[0];
    if (!s) throw new ConflictError('Set Bastion up first: adopt a framework in Setup.', 'NOT_SET_UP');
    const providers = await tx`
      SELECT id, name, model_id, scope, is_default FROM llm_providers
       WHERE enabled AND ((scope = 'organization' AND organization_id = ${viewer.org_id}) OR (scope = 'system' AND organization_id IS NULL))
       ORDER BY (scope = 'organization') DESC, is_default DESC, name`;
    const restores = await tx`
      SELECT id, detected_at, status, lost_from_seq, lost_to_seq, bucket_epoch, provisional_epoch
        FROM bastion_ledger_restores WHERE organization_id = ${viewer.org_id} AND resolution IS NULL ORDER BY detected_at`;
    const backup = (await tx`
      SELECT completed_at, bastion_mirror_status, bastion_mirror_cursor FROM platform_backups
       WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`)[0];
    const dead = (await tx`SELECT count(*)::int AS n FROM bastion_outbox WHERE organization_id = ${viewer.org_id} AND status = 'dead'`)[0];
    const settings: Record<string, unknown> = {};
    for (const c of SETTINGS_COLUMNS) settings[c] = s[c] ?? null;
    for (const c of ['questionnaire_high_floor', 'questionnaire_medium_floor', 'max_packet_bytes'] as const) {
      if (settings[c] !== null) settings[c] = Number(settings[c]);
    }
    return {
      data: {
        settings,
        compliance_project: s.compliance_project_id ? { id: s.compliance_project_id, name: s.compliance_project_name ?? null } : null,
        ai_providers: providers.map((p) => ({ id: p.id, name: p.name, model: p.model_id, scope: p.scope, is_default: p.is_default })),
        evidence_integrity: {
          seal_keys: publishedSealKeys().map((k) => ({ fingerprint: fingerprint(k.signing_key_id), current: k.current })),
          personal_data_key: fingerprint(pdHmacKeyId()),
          restores_awaiting: restores,
        },
        offsite_backup: {
          configured: facts.offsite_backup_configured,
          last_backup_at: backup?.completed_at ?? null,
          last_mirror_status: (backup?.bastion_mirror_status as string | null) ?? null,
          current_through: backup?.bastion_mirror_cursor ?? null,
        },
        storage_ok: facts.storage_ok,
        delivery_problems: Number(dead?.n ?? 0),
        updated_at: s.updated_at,
      },
    };
  });
}

export async function updateSettings(engine: EngineDeps, viewer: Viewer, body: BastionSettingsUpdate, facts: SettingsFacts) {
  if (body.timezone !== undefined && !validTimeZone(body.timezone)) {
    throw new ValidationFailure('That is not a timezone we know. Use a name like Europe/London or America/New_York.', 'BAD_TIMEZONE', [
      { field: 'timezone', issue: 'unknown' },
    ]);
  }
  await orgTx(engine.sql, viewer.org_id, async (tx) => {
    const cur = (await tx`SELECT * FROM bastion_org_settings WHERE organization_id = ${viewer.org_id} FOR UPDATE`)[0];
    if (!cur) throw new ConflictError('Set Bastion up first: adopt a framework in Setup.', 'NOT_SET_UP');
    const next = { ...cur, ...body } as Record<string, unknown>;
    if (Number(next.questionnaire_medium_floor) >= Number(next.questionnaire_high_floor)) {
      throw new ValidationFailure('The "Check this" floor must be below the "Sure" floor.', 'FLOORS_OUT_OF_ORDER', [
        { field: 'questionnaire_medium_floor', issue: 'not_below_high' },
      ]);
    }
    if (body.llm_provider_id) {
      const ok = (await tx`
        SELECT 1 FROM llm_providers WHERE id = ${body.llm_provider_id} AND enabled
           AND ((scope = 'organization' AND organization_id = ${viewer.org_id}) OR (scope = 'system' AND organization_id IS NULL))`)[0];
      if (!ok) throw new NotFoundError('We could not find that AI provider.');
    }
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(body)) {
      const before = cur[k] === null || cur[k] === undefined ? null : typeof v === 'number' ? Number(cur[k]) : cur[k];
      if (before !== v) changed[k] = { from: before, to: v };
    }
    if (Object.keys(changed).length === 0) return;
    // One UPDATE per field keeps every value a bound parameter (no dynamic SQL from the body).
    for (const k of Object.keys(changed) as Array<(typeof SETTINGS_COLUMNS)[number]>) {
      if (!SETTINGS_COLUMNS.includes(k)) continue;
      await tx`UPDATE bastion_org_settings SET ${tx(k)} = ${(body as Record<string, unknown>)[k] as never}, updated_by = ${viewer.id}, updated_at = now()
                WHERE organization_id = ${viewer.org_id}`;
    }
    await auditRaw(tx, viewer, 'settings.update', { type: 'settings', id: null }, { changed });
  });
  return getSettings(engine, viewer, facts);
}

const KIND_WORDS: Record<string, string> = {
  bolt_event: 'An event for Bolt automations',
  bam_task_upsert: 'A task in the Compliance project',
  bam_task_comment: 'A comment on a Compliance task',
  proposal_close: 'Closing a decided proposal',
  seal_object: 'A daily seal copy in evidence storage',
};

/** GET /delivery-problems (row 98). */
export async function listDeliveryProblems(engine: EngineDeps, viewer: Viewer, q: BastionDeliveryProblemListQuery) {
  const rows = await orgTx(engine.sql, viewer.org_id, (tx) => tx`
    SELECT id, kind, ordering_key, payload, attempts, redrive_count, last_error, created_at
      FROM bastion_outbox WHERE organization_id = ${viewer.org_id} AND status = 'dead'
     ORDER BY created_at DESC LIMIT ${q.limit}`);
  return {
    data: rows.map((r) => {
      const payload = (r.payload ?? {}) as { event_type?: string };
      return {
        id: r.id,
        what: KIND_WORDS[String(r.kind)] ?? 'An update to another app',
        event: r.kind === 'bolt_event' ? (payload.event_type ?? null) : null,
        attempts: Number(r.attempts),
        retried_before: Number(r.redrive_count),
        last_error: r.last_error ? String(r.last_error).slice(0, 300) : null,
        created_at: r.created_at,
      };
    }),
    next_cursor: null,
  };
}

/** POST /delivery-problems/:id/retry (row 99). */
export async function retryDelivery(engine: EngineDeps, viewer: Viewer, id: string) {
  const out = await orgTx(engine.sql, viewer.org_id, async (tx) => {
    const row = (await tx`SELECT id, kind, ordering_key, status, created_at FROM bastion_outbox
                          WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!row) throw new NotFoundError('We could not find that delivery problem.');
    if (row.status !== 'dead') throw new ConflictError('This was already delivered or is being retried.', 'NOT_DEAD');
    const newer = (await tx`
      SELECT 1 FROM bastion_outbox
       WHERE organization_id = ${viewer.org_id} AND kind = ${row.kind} AND ordering_key = ${row.ordering_key}
         AND status = 'delivered' AND created_at > ${row.created_at} LIMIT 1`)[0];
    if (newer) {
      await tx`UPDATE bastion_outbox SET status = 'superseded' WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
      await auditRaw(tx, viewer, 'delivery.retry', { type: 'outbox', id }, { result: 'superseded' });
      return { result: 'superseded' as const, message: 'A newer update of the same kind was already delivered, so this one is no longer needed.' };
    }
    await tx`UPDATE bastion_outbox
                SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, claimed_by = NULL, heartbeat_at = NULL,
                    redrive_count = redrive_count + 1
              WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'delivery.retry', { type: 'outbox', id }, { result: 'retrying' });
    return { result: 'retrying' as const, message: 'Bastion will try this delivery again within a minute.' };
  });
  return { data: { id, ...out } };
}

/** GET /audit (row 100). */
export async function listAudit(engine: EngineDeps, viewer: Viewer, q: BastionAuditLogQuery) {
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const after = q.cursor ? decodeIdCursor(q.cursor) : null;
    const rows = await tx`
      SELECT a.id, a.created_at, a.action, a.subject_type, a.subject_id, a.actor_id, a.actor_kind, a.impersonator_id, a.details,
             u.display_name AS actor_name, i.display_name AS impersonator_name
        FROM bastion_audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
        LEFT JOIN users i ON i.id = a.impersonator_id
       WHERE a.organization_id = ${viewer.org_id}
         ${q.action ? tx`AND a.action = ${q.action}` : tx``}
         ${q.subject_type ? tx`AND a.subject_type = ${q.subject_type}` : tx``}
         ${after ? tx`AND (a.created_at, a.id) < (SELECT p.created_at, p.id FROM bastion_audit_log p WHERE p.id = ${after}::uuid AND p.organization_id = ${viewer.org_id})` : tx``}
       ORDER BY a.created_at DESC, a.id DESC LIMIT ${q.limit + 1}`;
    return pageOf(rows, q.limit, (r) => encodeIdCursor(String(r.id)));
  });
}
