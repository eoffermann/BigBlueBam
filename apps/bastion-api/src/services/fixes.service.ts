// Gaps and fixes (spec 2.3, 2.4; 5.1 rows 51-57).
//
//   GET  /gaps                      stored gaps ranked (risk, or quick wins = risk / cost), plus the
//                                   org-level `stale` row derived at read time and "Accepted risks"
//   POST /gaps/:id/dismiss          a human adjudication, recorded
//   POST /gaps/:id/propose-fix      a draft from the closed menu, mirrored into agent_proposals
//   GET  /fix-drafts[/:id]          the review queue reads (citations pass can_access at read)
//   POST /fix-drafts/:id/decide     humans decide in Bastion (session, no impersonation, human,
//                                   control owner or control.write); closes the mirror via outbox
//   POST /fix-drafts/:id/mark-applied  records what a person did elsewhere (a Beacon draft, a Bolt rule)
//
// Drafting is deterministic at M6 (the template text below). Cited labels pass the injection
// pre-scan and are delimited as data; a suspect label is never quoted.

import {
  BASTION_FIX_PROPOSAL_TTL_DAYS,
  BASTION_STALE_GAP_KIND,
  bastionControlTaskExternalId,
  type BastionFixDecide,
  type BastionFixDraftListQuery,
  type BastionFixMarkApplied,
  type BastionGapListQuery,
} from '@bigbluebam/shared';
import { auditRaw } from '../lib/audit-raw.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { delimitAsData, scanLabel } from '../lib/injection-prescan.js';
import { boltRuleShapeFor } from '../library/fix-templates.js';
import { orgTx, type Tx } from '../engine/context.js';
import { sortGaps } from '../engine/gaps.js';
import { loadControlStates } from '../engine/numbers.js';
import { enqueueBastionEvent, enqueueOutbox } from '../engine/outbox.js';
import { enqueueProposalClose, remediationSettings } from '../engine/remediation.js';
import type { CitedRef } from '../engine/status.js';
import { anOrgAdmin, assertHumanDecider, citationVisible, type DecisionDeps, fileMirroredProposal } from './decisions.service.js';
import { cannotOpen } from '../lib/policy-access.js';
import type { Viewer } from './types.js';

const DAY_MS = 86_400_000;
const MAX_CITATIONS = 20;

export const GAP_WORDS: Record<string, string> = {
  failing: 'Not met',
  no_source: 'Nothing can show this yet',
  manual_expired: 'Uploaded evidence expired',
  not_connected: 'Source not connected',
  manual_missing: 'Evidence not uploaded yet',
  population_drift: 'Something new is not on the list',
  check_broken: "The check couldn't run",
  insufficient_data: 'Not enough activity to tell',
  population_review: 'List needs a fresh look',
  not_assessed: 'Not assessed',
  manual_expiring: 'Evidence expires soon',
  attested_only: 'Only a written statement',
  [BASTION_STALE_GAP_KIND]: "Checks haven't run recently",
};

export const TEMPLATE_WORDS: Record<string, string> = {
  confirm_check: 'Confirm how this is checked',
  evidence_request: 'Ask for evidence',
  policy_draft: 'Draft a policy',
  bolt_rule: 'Add an automation (turned off)',
  connect_source: 'Connect a source',
  config_change: 'Change a setting',
  process_change: 'Start a short procedure',
};

// ── Gaps ────────────────────────────────────────────────────────────────────────────────

export async function listGaps(d: DecisionDeps, viewer: Viewer, q: BastionGapListQuery) {
  const now = d.engine.now();
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const states = await loadControlStates(tx, viewer.org_id, now, q.framework_id);
    const inView = states.controls.map((c) => c.control_id);
    const statuses =
      q.status === 'all' ? ['open', 'proposed', 'dismissed', 'resolved'] : q.status === 'active' ? ['open', 'proposed'] : [q.status];
    const rows = await tx`
      SELECT g.id, g.control_id, g.assertion_id, g.gap_kind, g.risk_score, g.fix_template, g.fix_cost, g.status,
             g.dismissed_reason, g.computed_at, c.title AS control_title, c.control_key, c.owner_user_id, u.display_name AS owner_name,
             a.plain_statement AS assertion_statement,
             (SELECT fd.id FROM bastion_fix_drafts fd WHERE fd.organization_id = g.organization_id AND fd.gap_id = g.id
                ORDER BY fd.created_at DESC LIMIT 1) AS latest_fix_draft_id
        FROM bastion_gaps g
        JOIN bastion_controls c ON c.id = g.control_id AND c.organization_id = g.organization_id
        LEFT JOIN users u ON u.id = c.owner_user_id
        LEFT JOIN bastion_assertions a ON a.id = g.assertion_id AND a.organization_id = g.organization_id
       WHERE g.organization_id = ${viewer.org_id} AND g.status = ANY(${statuses})
         AND g.control_id = ANY(${inView}::uuid[])
         ${q.control_id ? tx`AND g.control_id = ${q.control_id}` : tx``}
         ${q.gap_kind ? tx`AND g.gap_kind = ${q.gap_kind}` : tx``}`;
    const shaped = rows.map((g) => ({
      id: g.id as string,
      control_id: g.control_id as string,
      control_title: g.control_title as string,
      owner_name: (g.owner_name as string | null) ?? null,
      assertion_id: (g.assertion_id as string | null) ?? null,
      assertion_statement: (g.assertion_statement as string | null) ?? null,
      gap_kind: g.gap_kind as string,
      gap_words: GAP_WORDS[g.gap_kind as string] ?? String(g.gap_kind),
      risk_score: Number(g.risk_score),
      fix_template: (g.fix_template as string | null) ?? null,
      fix_words: g.fix_template ? TEMPLATE_WORDS[g.fix_template as string] : null,
      fix_cost: g.fix_cost === null ? null : Number(g.fix_cost),
      status: g.status as string,
      dismissed_reason: (g.dismissed_reason as string | null) ?? null,
      latest_fix_draft_id: (g.latest_fix_draft_id as string | null) ?? null,
      computed_at: g.computed_at,
    }));
    const sorted = sortGaps(shaped, q.sort).slice(0, q.limit);

    // Org-level `stale` row, derived at read time from effectiveStatus, never stored (spec 2.3).
    const stale = states.controls.filter((c) => c.confirmed_count > 0 && c.verdict.reason === 'evaluation_stale');
    const staleRow =
      stale.length > 0
        ? {
            gap_kind: BASTION_STALE_GAP_KIND,
            gap_words: GAP_WORDS[BASTION_STALE_GAP_KIND],
            control_count: stale.length,
            message: `${stale.length} control${stale.length === 1 ? " hasn't" : "s haven't"} been checked recently, so Bastion can't vouch for ${stale.length === 1 ? 'it' : 'them'}.`,
          }
        : null;

    // "Accepted risks": active exceptions with owner and expiry (spec 2.6), never a gap.
    const accepted = await tx`
      SELECT e.id, e.control_id, c.title AS control_title, e.scope, e.reason, e.expires_at, e.small_team_self_approval,
             ou.display_name AS owner_name, du.display_name AS decided_by_name
        FROM bastion_exceptions e
        JOIN bastion_controls c ON c.id = e.control_id AND c.organization_id = e.organization_id
        LEFT JOIN users ou ON ou.id = c.owner_user_id
        LEFT JOIN users du ON du.id = e.decided_by
       WHERE e.organization_id = ${viewer.org_id} AND e.status = 'active' AND e.expires_at > ${now}
         AND e.control_id = ANY(${inView}::uuid[])
       ORDER BY e.expires_at`;
    return {
      data: sorted,
      stale: staleRow,
      accepted_risks: accepted.map((e) => ({
        id: e.id,
        control_id: e.control_id,
        control_title: e.control_title,
        scope: e.scope,
        reason: e.reason,
        expires_at: e.expires_at,
        owner_name: e.owner_name ?? null,
        approved_by_name: e.decided_by_name ?? null,
        small_team_self_approval: e.small_team_self_approval,
        approval_label: e.small_team_self_approval ? 'approved by the proposer (small team)' : null,
      })),
      sort: q.sort,
      next_cursor: null,
    };
  });
}

async function loadGap(tx: Tx, orgId: string, id: string) {
  const g = (
    await tx`
      SELECT g.*, c.title AS control_title, c.owner_user_id, c.plain_summary, u.display_name AS owner_name,
             a.kind AS assertion_kind, a.probe_key, a.plain_statement, a.manual_evidence_spec, a.params
        FROM bastion_gaps g
        JOIN bastion_controls c ON c.id = g.control_id AND c.organization_id = g.organization_id
        LEFT JOIN users u ON u.id = c.owner_user_id
        LEFT JOIN bastion_assertions a ON a.id = g.assertion_id AND a.organization_id = g.organization_id
       WHERE g.organization_id = ${orgId} AND g.id = ${id}
       FOR UPDATE OF g`
  )[0];
  if (!g) throw new NotFoundError('We could not find that gap.');
  return g;
}

export async function dismissGap(d: DecisionDeps, viewer: Viewer, id: string, reason: string) {
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const g = await loadGap(tx, viewer.org_id, id);
    if (g.status === 'dismissed') throw new ConflictError('This gap was already dismissed.', 'GAP_ALREADY_DISMISSED');
    if (g.status === 'resolved') throw new ConflictError('This gap is already fixed.', 'GAP_RESOLVED');
    await tx`UPDATE bastion_gaps SET status = 'dismissed', dismissed_reason = ${reason}, dismissed_by = ${viewer.id} WHERE id = ${id}`;
    await auditRaw(tx, viewer, 'gap.dismiss', { type: 'gap', id }, { gap_kind: g.gap_kind, reason });
    return { data: { id, status: 'dismissed', dismissed_reason: reason } };
  });
}

// ── Drafting ────────────────────────────────────────────────────────────────────────────

interface Draft {
  title: string;
  body_markdown: string;
  payload: Record<string, unknown>;
  cited_refs: CitedRef[];
  dropped_citation_count: number;
  suspect_label_count: number;
}

/** Labels of population members the check found but nobody listed, scanned before quoting. */
function memberLabels(unlisted: unknown[]): { quoted: string[]; suspect: number } {
  const quoted: string[] = [];
  let suspect = 0;
  for (const m of unlisted.slice(0, 10)) {
    const label = typeof m === 'string' ? m : String((m as { label?: unknown; value?: unknown })?.label ?? (m as { value?: unknown })?.value ?? '');
    if (!label) continue;
    if (scanLabel(label).suspected) suspect += 1;
    else quoted.push(delimitAsData(label, 120));
  }
  return { quoted, suspect };
}

async function draftFor(d: DecisionDeps, tx: Tx, viewer: Viewer, g: Record<string, unknown>): Promise<Draft> {
  const template = String(g.fix_template);
  const control = String(g.control_title);
  const owner = (g.owner_name as string | null) ?? 'the control owner';
  // bastionManualEvidenceSpecSchema: title (what is needed), description, kind, cadence_days.
  const rawSpec = (g.manual_evidence_spec as { title?: string; description?: string } | null) ?? null;
  const spec = rawSpec ? { what: rawSpec.title, example: rawSpec.description } : null;
  const statement = (g.plain_statement as string | null) ?? null;
  const latest = g.assertion_id
    ? (await tx`SELECT cited_refs, population_unlisted, summary FROM bastion_evidence_snapshots
                 WHERE organization_id = ${viewer.org_id} AND assertion_id = ${g.assertion_id as string}
                 ORDER BY created_at DESC LIMIT 1`)[0]
    : undefined;

  // Citations pass can_access at write for the person asking (spec 2.4); a refusal drops it.
  const refs = ((latest?.cited_refs as CitedRef[] | null) ?? []).slice(0, MAX_CITATIONS);
  const cited: CitedRef[] = [];
  let dropped = 0;
  for (const r of refs) {
    if (await citationVisible(d, viewer, r, (g.owner_user_id as string | null) ?? null)) cited.push(r);
    else dropped += 1;
  }

  const base = { title: '', body_markdown: '', payload: {} as Record<string, unknown>, cited_refs: cited, dropped_citation_count: dropped, suspect_label_count: 0 };
  switch (template) {
    case 'confirm_check':
      return {
        ...base,
        title: `Confirm how Bastion checks "${control}"`,
        body_markdown:
          g.gap_kind === 'population_review'
            ? `The list of things Bastion checks for "${control}" was confirmed more than six months ago. Open the review queue and confirm it is still the complete list.`
            : `Nobody has confirmed how Bastion should check "${control}" yet. Open the review queue and confirm or reject the proposed checks.`,
        payload: { review_path: '/bastion/review' },
      };
    case 'evidence_request': {
      const what = spec?.what ?? 'a report from the system that knows';
      const example = spec?.example ? `\n\nFor example: ${spec.example}` : '';
      return {
        ...base,
        title: `Please upload: ${what}`.slice(0, 512),
        body_markdown: `Hi ${owner}, Bastion needs ${what} to show that "${control}" is met.${example}\n\nUpload it in Bastion (Evidence locker, Add evidence). Someone else will review it before it counts.`,
        payload: { request_to_user_id: (g.owner_user_id as string | null) ?? null, what, example: spec?.example ?? null },
      };
    }
    case 'config_change': {
      if (g.gap_kind === 'population_drift') {
        const unlisted = (latest?.population_unlisted as unknown[] | null) ?? [];
        const { quoted, suspect } = memberLabels(unlisted);
        const names = quoted.length > 0 ? quoted.join(', ') : `${unlisted.length} item${unlisted.length === 1 ? '' : 's'}`;
        const one = unlisted.length === 1;
        const suspectNote =
          suspect > 0 ? ` (${suspect} name${suspect === 1 ? ' looked' : 's looked'} like instructions, so ${suspect === 1 ? 'it is' : 'they are'} not quoted.)` : '';
        return {
          ...base,
          suspect_label_count: suspect,
          title: `Add ${quoted.length === 1 ? quoted[0] : names} to what Bastion checks for "${control}"`.slice(0, 512),
          body_markdown: `Bastion found ${unlisted.length} item${one ? '' : 's'} that ${one ? 'is' : 'are'} connected but not on the list it checks for "${control}": ${names}.${suspectNote}\n\nApproving files an updated list for one-click confirmation in the review queue.`,
          payload: { add_members: unlisted.slice(0, 200), assertion_id: g.assertion_id },
        };
      }
      if (g.probe_key === 'policy.attested' && g.assertion_id) {
        // Spec 3.6 (M7): people who cannot open the article cannot acknowledge it. can_access per
        // person still due; those refused are the cited "N people can't open this policy".
        const pin = (await tx`
          SELECT p.id, p.beacon_entry_id FROM bastion_assertions a
            JOIN bastion_policies p ON p.organization_id = a.organization_id AND p.id::text = a.params->>'policy_id'
           WHERE a.organization_id = ${viewer.org_id} AND a.id = ${g.assertion_id as string}`)[0];
        const due = ((latest?.cited_refs as CitedRef[] | null) ?? []).filter((r) => r.entity_type === 'user').map((r) => r.entity_id);
        const blocked = pin ? await cannotOpen(d.canAccess, String(pin.beacon_entry_id), due) : [];
        const blockedSet = new Set(blocked);
        const rest = due.length - blocked.length;
        const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        return {
          ...base,
          cited_refs: cited.filter((r) => blockedSet.has(r.entity_id)).concat(cited.filter((r) => !blockedSet.has(r.entity_id))),
          title: (blocked.length > 0
            ? `${plural(blocked.length, "person can't", "people can't")} open the policy for "${control}"`
            : `${plural(rest, 'person has', 'people have')} not acknowledged the policy for "${control}"`
          ).slice(0, 512),
          body_markdown: [
            blocked.length > 0
              ? `${plural(blocked.length, "person can't", "people can't")} open this policy in Beacon, so they cannot read or acknowledge it. In Beacon, share the article with everyone in the organization (visibility: Organization).`
              : null,
            rest > 0 ? `${plural(rest, 'other person has', 'other people have')} not acknowledged the current version yet. On the Policies page, use "Ask people to read it".` : null,
            'The next check after they acknowledge it proves it.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          payload: { probe_key: 'policy.attested', policy_id: pin ? String(pin.id) : null, cannot_open_count: blocked.length, not_acknowledged_count: due.length },
        };
      }
      return {
        ...base,
        title: `Change a setting so "${control}" is met`.slice(0, 512),
        body_markdown: `${statement ? `What Bastion checks: ${statement}\n\n` : ''}Make the change in the app that owns it. The next nightly check proves it; nothing else is needed.`,
        payload: { probe_key: g.probe_key ?? null },
      };
    }
    case 'connect_source':
      return {
        ...base,
        title: `Connect the source Bastion needs for "${control}"`.slice(0, 512),
        body_markdown: `${statement ? `What Bastion checks: ${statement}\n\n` : ''}This could be checked automatically once the source is connected. After connecting, the next nightly check proves it.`,
        payload: { probe_key: g.probe_key ?? null },
      };
    case 'bolt_rule': {
      const s = await remediationSettings(tx, viewer.org_id);
      const shape = boltRuleShapeFor(String(g.gap_kind), (g.probe_key as string | null) ?? null, {
        control_id: String(g.control_id),
        control_title: control,
        compliance_project_id: s.compliance_project_id,
      });
      if (shape) {
        return {
          ...base,
          title: shape.name,
          body_markdown: `${shape.description}\n\nApproving lets you create this automation in Bolt, turned off, so you can look at it before switching it on.`,
          payload: { bolt_rule: shape },
        };
      }
      return processChange(base, control, statement);
    }
    case 'policy_draft':
      return {
        ...base,
        title: `Draft a policy for "${control}"`.slice(0, 512),
        body_markdown: `# ${control}\n\n## Purpose\n\n${(g.plain_summary as string | null) ?? 'Why this matters to us.'}\n\n## What we do\n\n- Who is responsible: ${owner}\n- How often we check: every quarter\n\n## Evidence\n\nBastion checks this every night and keeps the record.`,
        payload: { beacon_draft: true },
      };
    default:
      return processChange(base, control, statement);
  }
}

function processChange(base: Draft, control: string, statement: string | null): Draft {
  return {
    ...base,
    title: `Start a short procedure for "${control}"`.slice(0, 512),
    body_markdown: `${statement ? `What needs to be true: ${statement}\n\n` : ''}1. Agree who does it and how often.\n2. Each time, record what was done.\n3. Upload that record to Bastion so it counts as evidence.`,
    payload: {
      manual_evidence_spec: {
        title: `A record that the "${control}" procedure was followed`.slice(0, 256),
        description: 'Who did it, when, and what they found.',
        kind: 'file',
        cadence_days: 90,
      },
    },
  };
}

export async function proposeFix(d: DecisionDeps, viewer: Viewer, gapId: string, note: string | null) {
  const now = d.engine.now();
  const draftId = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const g = await loadGap(tx, viewer.org_id, gapId);
    if (g.status !== 'open') {
      throw new ConflictError(
        g.status === 'proposed' ? 'A fix for this gap is already waiting for a decision.' : 'Only an open gap can get a fix.',
        g.status === 'proposed' ? 'FIX_ALREADY_PROPOSED' : 'GAP_NOT_OPEN',
      );
    }
    if (!g.fix_template) throw new ConflictError('There is nothing Bastion can draft for this gap; it needs whoever runs the installation.', 'NO_FIX_FOR_GAP');
    const draft = await draftFor(d, tx, viewer, g);
    const kind = String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
    const ins = await tx`
      INSERT INTO bastion_fix_drafts (organization_id, gap_id, template, title, body_markdown, payload, cited_refs,
                                      dropped_citation_count, status, created_by, created_by_kind)
      VALUES (${viewer.org_id}, ${gapId}, ${g.fix_template as string}, ${draft.title}, ${draft.body_markdown},
              ${tx.json({ ...draft.payload, note, suspect_label_count: draft.suspect_label_count } as never)},
              ${tx.json(draft.cited_refs as never)}, ${draft.dropped_citation_count}, 'proposed', ${viewer.id}, ${kind})
      RETURNING id`;
    const id = String(ins[0]?.id ?? '');
    if (!id) throw new Error('bastion_fix_drafts insert returned no row');
    const approver = (g.owner_user_id as string | null) ?? (await anOrgAdmin(tx, viewer.org_id));
    const proposalId = await fileMirroredProposal(tx, viewer, {
      action: `bastion.fix.${String(g.fix_template)}`,
      subject_type: 'bastion.fix_draft',
      subject_id: id,
      approver_id: approver,
      // Content-free: the draft lives in Bastion and is read in its review queue.
      payload: { fix_draft_id: id, gap_kind: g.gap_kind, control_id: g.control_id, review_path: '/bastion/review' },
      expires_at: new Date(now.getTime() + BASTION_FIX_PROPOSAL_TTL_DAYS * DAY_MS),
    });
    await tx`UPDATE bastion_fix_drafts SET proposal_id = ${proposalId} WHERE id = ${id}`;
    await tx`UPDATE bastion_gaps SET status = 'proposed' WHERE id = ${gapId}`;
    await enqueueBastionEvent(
      'gap.fix_proposed',
      { gap_id: gapId, fix_draft_id: id, control_id: g.control_id, template: g.fix_template, proposal_id: proposalId },
      tx,
      { orgId: viewer.org_id, idempotencyKey: `gap.fix_proposed:${id}`, actorId: viewer.id, actorType: kind === 'human' ? 'user' : 'agent' },
    );
    await auditRaw(tx, viewer, 'fix.propose', { type: 'fix_draft', id }, { gap_id: gapId, template: g.fix_template, proposal_id: proposalId });
    return id;
  });
  return getFixDraft(d, viewer, draftId);
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────

const DRAFT_SELECT = `d.id, d.gap_id, d.template, d.title, d.body_markdown, d.payload, d.cited_refs, d.dropped_citation_count,
  d.proposal_id, d.status, d.decided_by, du.display_name AS decided_by_name, d.decided_at, d.applied_entity_type,
  d.applied_entity_id, d.created_by, cu.display_name AS created_by_name, d.created_by_kind, d.created_at, d.updated_at,
  g.gap_kind, g.control_id, c.title AS control_title, c.owner_user_id, ou.display_name AS owner_name, p.expires_at AS proposal_expires_at`;
const DRAFT_FROM = `FROM bastion_fix_drafts d
  LEFT JOIN bastion_gaps g ON g.id = d.gap_id AND g.organization_id = d.organization_id
  LEFT JOIN bastion_controls c ON c.id = g.control_id AND c.organization_id = d.organization_id
  LEFT JOIN users ou ON ou.id = c.owner_user_id
  LEFT JOIN users du ON du.id = d.decided_by
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN agent_proposals p ON p.id = d.proposal_id`;

async function shapeDraft(d: DecisionDeps, viewer: Viewer, r: Record<string, unknown>) {
  // Citations pass can_access again at read, for whoever is reading (spec 2.4).
  const refs = (r.cited_refs as CitedRef[] | null) ?? [];
  const visible: CitedRef[] = [];
  for (const ref of refs) if (await citationVisible(d, viewer, ref, (r.owner_user_id as string | null) ?? null)) visible.push(ref);
  return {
    ...r,
    cited_refs: visible,
    hidden_citation_count: refs.length - visible.length + Number(r.dropped_citation_count ?? 0),
    gap_words: r.gap_kind ? (GAP_WORDS[r.gap_kind as string] ?? null) : null,
    template_words: TEMPLATE_WORDS[r.template as string] ?? String(r.template),
  };
}

export async function listFixDrafts(d: DecisionDeps, viewer: Viewer, q: BastionFixDraftListQuery) {
  const rows = await orgTx(d.engine.sql, viewer.org_id, (tx) => tx.unsafe(
    `SELECT ${DRAFT_SELECT} ${DRAFT_FROM}
      WHERE d.organization_id = $1 AND ($2::text IS NULL OR d.status = $2) AND ($3::uuid IS NULL OR d.gap_id = $3)
        AND ($4::uuid IS NULL OR g.control_id = $4)
      ORDER BY d.created_at DESC LIMIT $5`,
    [viewer.org_id, q.status ?? null, q.gap_id ?? null, q.control_id ?? null, q.limit],
  ));
  const data = [];
  for (const r of rows) data.push(await shapeDraft(d, viewer, r as Record<string, unknown>));
  return { data, next_cursor: null };
}

export async function getFixDraft(d: DecisionDeps, viewer: Viewer, id: string) {
  const r = (await orgTx(d.engine.sql, viewer.org_id, (tx) => tx.unsafe(`SELECT ${DRAFT_SELECT} ${DRAFT_FROM} WHERE d.organization_id = $1 AND d.id = $2`, [viewer.org_id, id])))[0];
  if (!r) throw new NotFoundError('We could not find that fix.');
  return { data: await shapeDraft(d, viewer, r as Record<string, unknown>) };
}

// ── Deciding ────────────────────────────────────────────────────────────────────────────

/**
 * Approve or reject a drafted fix (row 56). Only a human, signed in, not impersonating, who owns
 * the control or holds bastion.control.write. Approval files what the template promises; either
 * way the mirrored proposal is closed through the api (outbox) with this person as the decider.
 */
export async function decideFix(d: DecisionDeps, viewer: Viewer, id: string, body: BastionFixDecide, canControlWrite: boolean) {
  const now = d.engine.now();
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const r = (
      await tx`
        SELECT d.*, g.gap_kind, g.control_id, g.assertion_id, c.owner_user_id, c.title AS control_title
          FROM bastion_fix_drafts d
          LEFT JOIN bastion_gaps g ON g.id = d.gap_id AND g.organization_id = d.organization_id
          LEFT JOIN bastion_controls c ON c.id = g.control_id AND c.organization_id = d.organization_id
         WHERE d.organization_id = ${viewer.org_id} AND d.id = ${id}
         FOR UPDATE OF d`
    )[0];
    if (!r) throw new NotFoundError('We could not find that fix.');
    await assertHumanDecider(tx, viewer);
    if (r.owner_user_id !== viewer.id && !canControlWrite) {
      throw new ForbiddenError('Only the control owner, or someone who can change controls, can decide this fix.', 'NOT_CONTROL_OWNER');
    }
    if (r.status !== 'proposed') throw new ConflictError(`This fix was already ${String(r.status).replace('_', ' ')}.`, 'FIX_ALREADY_DECIDED');
    if (r.proposal_id) {
      const p = (await tx`SELECT status, expires_at FROM agent_proposals WHERE id = ${r.proposal_id as string}`)[0];
      if (p && (p.status === 'expired' || new Date(p.expires_at as string) <= now)) {
        await tx`UPDATE bastion_fix_drafts SET status = 'expired' WHERE id = ${id}`;
        if (r.gap_id) await tx`UPDATE bastion_gaps SET status = 'open' WHERE id = ${r.gap_id as string} AND status = 'proposed'`;
        throw new ConflictError('This fix expired before anyone decided it. Draft it again if it is still needed.', 'FIX_EXPIRED');
      }
    }
    const approve = body.decision === 'approve';
    await tx`UPDATE bastion_fix_drafts SET status = ${approve ? 'approved' : 'rejected'}, decided_by = ${viewer.id}, decided_at = ${now} WHERE id = ${id}`;
    if (!approve && r.gap_id) await tx`UPDATE bastion_gaps SET status = 'open' WHERE id = ${r.gap_id as string} AND status = 'proposed'`;

    const effects: string[] = [];
    if (approve) effects.push(...(await applyApproval(tx, viewer, r as Record<string, unknown>)));
    if (r.proposal_id) {
      await enqueueProposalClose(tx, viewer.org_id, {
        proposal_id: String(r.proposal_id),
        decision: approve ? 'approved' : 'rejected',
        decided_by: viewer.id,
        reason: body.reason ?? null,
        ordering_key: `fix:${id}`,
      });
    }
    await auditRaw(tx, viewer, approve ? 'fix.approve' : 'fix.reject', { type: 'fix_draft', id }, {
      reason: body.reason ?? null,
      effects,
      decided_as: r.owner_user_id === viewer.id ? 'control_owner' : 'control_write',
    });
  });
  return getFixDraft(d, viewer, id);
}

/** What approval does, per template (spec 2.4). Returns plain effect labels for the audit row. */
async function applyApproval(tx: Tx, viewer: Viewer, r: Record<string, unknown>): Promise<string[]> {
  const payload = (r.payload as Record<string, unknown>) ?? {};
  const controlId = r.control_id as string | null;
  switch (r.template) {
    case 'evidence_request': {
      // A Bam task to the owner, on the control's one task (comment when it already exists).
      const s = await remediationSettings(tx, viewer.org_id);
      if (!s.compliance_project_id || !controlId) return ['no_compliance_project'];
      await enqueueOutbox(tx, {
        orgId: viewer.org_id,
        kind: 'bam_task_upsert',
        orderingKey: `control:${controlId}`,
        idempotencyKey: `fix:${String(r.id)}:bam_task_upsert`,
        payload: {
          request: {
            org_id: viewer.org_id,
            project_id: s.compliance_project_id,
            control_id: controlId,
            external_id: bastionControlTaskExternalId(controlId),
            title: `Fix: ${String(r.control_title)}`.slice(0, 500),
            description: String(r.body_markdown ?? ''),
            assignee_id: (payload.request_to_user_id as string | null) ?? (r.owner_user_id as string | null) ?? null,
            comment: `Evidence requested: ${String(r.title)}`.slice(0, 4000),
            idempotency_key: `fix:${String(r.id)}:bam_task_upsert`,
          },
        },
      });
      return ['bam_task_requested'];
    }
    case 'process_change': {
      if (!controlId) return [];
      const spec = (payload.manual_evidence_spec as Record<string, unknown> | undefined) ?? { title: String(r.title).slice(0, 256), description: '', kind: 'file', cadence_days: 90 };
      const kind = String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
      await tx`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, manual_evidence_spec, plain_statement, proposed_by, review_status, created_by)
        VALUES (${viewer.org_id}, ${controlId}, 'manual', ${tx.json(spec as never)}, ${'A record shows the procedure for this control was followed.'},
                ${kind === 'human' ? 'human' : 'agent'}, 'proposed', ${viewer.id})`;
      return ['manual_check_proposed'];
    }
    case 'config_change': {
      if (r.gap_kind !== 'population_drift' || !r.assertion_id) return [];
      // File a superseding assertion with the found members added, for one-click confirmation.
      const a = (await tx`SELECT * FROM bastion_assertions WHERE organization_id = ${viewer.org_id} AND id = ${r.assertion_id as string}`)[0];
      if (!a) return [];
      // The confirmation stamp never carries over to a revised list (M3 decision).
      const { population_confirmed_at: _at, population_confirmed_by: _by, ...kept } = (a.params as Record<string, unknown>) ?? {};
      const params: Record<string, unknown> = { ...kept };
      const add = ((payload.add_members as unknown[]) ?? []).map((m) => (typeof m === 'string' ? m : String((m as { value?: unknown })?.value ?? ''))).filter(Boolean);
      const current = Array.isArray(params.expected_population) ? (params.expected_population as string[]) : [];
      params.expected_population = [...new Set([...current, ...add])];
      const kind = String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
      await tx`
        INSERT INTO bastion_assertions (organization_id, control_id, kind, probe_key, probe_version, params, predicate, plain_statement,
                                        proposed_by, review_status, supersedes_id, created_by)
        VALUES (${viewer.org_id}, ${a.control_id as string}, ${a.kind as string}, ${a.probe_key as string | null}, ${a.probe_version as number | null},
                ${tx.json(params as never)}, ${tx.json((a.predicate ?? {}) as never)}, ${a.plain_statement as string},
                ${kind === 'human' ? 'human' : 'agent'}, 'proposed', ${a.id as string}, ${viewer.id})`;
      return ['superseding_check_proposed'];
    }
    default:
      // confirm_check, connect_source, other config changes: a person does it; the next check proves it.
      // bolt_rule and policy_draft: created by the approver's session in Bolt or Beacon, then mark-applied.
      return [];
  }
}

export async function markFixApplied(d: DecisionDeps, viewer: Viewer, id: string, body: BastionFixMarkApplied) {
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const r = (await tx`SELECT id, status, template FROM bastion_fix_drafts WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!r) throw new NotFoundError('We could not find that fix.');
    if (r.status !== 'approved') throw new ConflictError('Only an approved fix can be marked as done.', 'FIX_NOT_APPROVED');
    if (body.applied_entity_type && body.applied_entity_id) {
      if (!(await d.canAccess(viewer.id, body.applied_entity_type, body.applied_entity_id).catch(() => false))) {
        throw new NotFoundError('We could not find what you made, or you cannot see it.');
      }
    }
    await tx`
      UPDATE bastion_fix_drafts SET status = 'applied', applied_entity_type = ${body.applied_entity_type ?? null},
             applied_entity_id = ${body.applied_entity_id ?? null}
       WHERE id = ${id}`;
    if (body.applied_entity_type && body.applied_entity_id) {
      // spec 8.3: bastion.fix_draft -> the applied beacon.entry or bolt.rule.
      await tx`
        INSERT INTO entity_links (org_id, src_type, src_id, dst_type, dst_id, link_kind, created_by)
        VALUES (${viewer.org_id}, 'bastion.fix_draft', ${id}, ${body.applied_entity_type}, ${body.applied_entity_id}, 'derived_from', ${viewer.id})
        ON CONFLICT DO NOTHING`;
    }
    await auditRaw(tx, viewer, 'fix.mark_applied', { type: 'fix_draft', id }, {
      applied_entity_type: body.applied_entity_type ?? null,
      applied_entity_id: body.applied_entity_id ?? null,
      note: body.note ?? null,
    });
  });
  return getFixDraft(d, viewer, id);
}
