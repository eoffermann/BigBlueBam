// Drift (spec 2.5; 5.1 rows 62-63). A drift row records a worsening of a control's stored status
// (or of its effective state when an accepted risk ran out) and what happened to its Bam task.

import type { BastionDriftListQuery } from '@bigbluebam/shared';
import { auditRaw } from '../lib/audit-raw.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { type EngineDeps, orgTx } from '../engine/context.js';
import { REASON_PHRASE } from '../engine/remediation.js';
import type { Viewer } from './types.js';

const STATE_WORDS: Record<string, string> = {
  pass: 'Proven',
  pass_with_exception: 'Not met, risk accepted',
  fail: 'Not met',
  unprovable: "Can't prove yet",
};

export const TASK_WORDS: Record<string, string> = {
  pending: 'Task on its way',
  created: 'Task created',
  reopened: 'Task reopened',
  updated: 'Task updated',
  no_project: 'No Compliance project set, so no task',
  proposed: 'Waiting for someone to decide on a task',
};

export async function listDrift(engine: EngineDeps, viewer: Viewer, q: BastionDriftListQuery) {
  const rows = await orgTx(engine.sql, viewer.org_id, (tx) => tx`
    SELECT d.id, d.control_id, c.title AS control_title, d.evaluation_run_id, d.exception_id, d.from_status, d.to_status, d.reason,
           d.task_status, d.bam_task_id, t.human_id AS bam_task_human_id, d.acknowledged_by, au.display_name AS acknowledged_by_name,
           d.acknowledged_at, d.detected_at
      FROM bastion_drift_events d
      JOIN bastion_controls c ON c.id = d.control_id AND c.organization_id = d.organization_id
      LEFT JOIN tasks t ON t.id = d.bam_task_id
      LEFT JOIN users au ON au.id = d.acknowledged_by
     WHERE d.organization_id = ${viewer.org_id}
       ${q.control_id ? tx`AND d.control_id = ${q.control_id}` : tx``}
       ${q.unacknowledged ? tx`AND d.acknowledged_at IS NULL` : tx``}
       ${q.before ? tx`AND d.detected_at < ${new Date(q.before)}` : tx``}
     ORDER BY d.detected_at DESC, d.id
     LIMIT ${q.limit + 1}`);
  const page = rows.slice(0, q.limit);
  return {
    data: page.map((r) => ({
      ...r,
      from_words: STATE_WORDS[r.from_status as string] ?? r.from_status,
      to_words: STATE_WORDS[r.to_status as string] ?? r.to_status,
      reason_words: REASON_PHRASE[r.reason as string] ?? r.reason,
      task_words: TASK_WORDS[r.task_status as string] ?? r.task_status,
    })),
    has_more: rows.length > q.limit,
    next_cursor: rows.length > q.limit ? (page[page.length - 1]?.detected_at ?? null) : null,
  };
}

export async function acknowledgeDrift(engine: EngineDeps, viewer: Viewer, id: string, note: string | null) {
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`SELECT id, acknowledged_at FROM bastion_drift_events WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!r) throw new NotFoundError('We could not find that change.');
    if (r.acknowledged_at) throw new ConflictError('Someone already acknowledged this.', 'DRIFT_ALREADY_ACKNOWLEDGED');
    const now = engine.now();
    await tx`UPDATE bastion_drift_events SET acknowledged_by = ${viewer.id}, acknowledged_at = ${now} WHERE id = ${id}`;
    await auditRaw(tx, viewer, 'drift.acknowledge', { type: 'drift', id }, { note });
    return { data: { id, acknowledged_by: viewer.id, acknowledged_at: now.toISOString() } };
  });
}
