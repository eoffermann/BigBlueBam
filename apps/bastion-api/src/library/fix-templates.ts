// The closed fix menu (spec 2.3, 2.4). Deterministic: the gap decides the template, a fixed
// table decides the failing template per probe, and a Bolt rule is one of a few closed shapes
// keyed by (gap_kind, probe_key). Nothing here is chosen by a language model; when the LLM
// tailoring lands (M7) it may only reword the name and description of a drafted rule and the
// plain request text, never the template, the trigger or the actions.

import {
  BASTION_BOLT_RULE_ALLOWED_ACTIONS,
  type BastionFixTemplate,
  type BastionGapKind,
  type BastionProbeKey,
} from '@bigbluebam/shared';

/** What fixes a FAILING probe check (spec 2.3 "by probe"). */
export const FAILING_TEMPLATE_BY_PROBE: Record<BastionProbeKey, BastionFixTemplate> = {
  'keys.max_age': 'config_change',
  'keys.unused_active': 'config_change',
  'access.departed_still_holding': 'config_change',
  'access.dormant_accounts': 'config_change',
  'access.privileged_roster': 'config_change',
  'auth.failed_login_spikes': 'process_change',
  'agents.policy_coverage': 'config_change',
  'agents.human_approval': 'process_change',
  'change.merge_reviewed': 'bolt_rule',
  'change.merge_traceable': 'bolt_rule',
  'ops.backup_fresh': 'config_change',
  'ops.restore_tested': 'process_change',
  'logging.retention_floor': 'config_change',
  'logging.audit_trail_alive': 'config_change',
  'automation.failure_rate': 'bolt_rule',
  // M7 (spec 3.6): the people who have not acknowledged include anyone who cannot open the
  // article; the fix is a setting (share it with everyone in Beacon) plus a nudge for the rest.
  'policy.attested': 'config_change',
  'policy.current': 'policy_draft',
  'platform.superuser_access': 'process_change',
  'vendors.critical_have_award': 'process_change',
  'feed.fresh': 'connect_source',
};

/** The default template per stored gap kind; `failing` depends on the check (see above). */
export const TEMPLATE_BY_GAP_KIND: Record<Exclude<BastionGapKind, 'failing'>, BastionFixTemplate | null> = {
  no_source: 'evidence_request',
  manual_expired: 'evidence_request',
  not_connected: 'connect_source',
  manual_missing: 'evidence_request',
  population_drift: 'config_change',
  check_broken: null,
  insufficient_data: null,
  population_review: 'confirm_check',
  not_assessed: 'confirm_check',
  manual_expiring: 'evidence_request',
  attested_only: 'evidence_request',
};

export function failingTemplate(kind: 'probe' | 'manual' | 'feed', probeKey: string | null): BastionFixTemplate {
  if (kind === 'manual') return 'evidence_request';
  if (kind === 'feed') return 'process_change';
  return FAILING_TEMPLATE_BY_PROBE[probeKey as BastionProbeKey] ?? 'process_change';
}

// ── Bolt rule shapes (spec 2.4) ─────────────────────────────────────────────────────────

export interface BoltRuleAction {
  sort_order: number;
  mcp_tool: string;
  parameters: Record<string, unknown>;
}

/** The body the approver's session posts to bolt-api, always created turned off. */
export interface BoltRuleShape {
  name: string;
  description: string;
  enabled: false;
  trigger_source: 'bastion';
  trigger_event: 'control.drifted';
  trigger_filter: Record<string, unknown>;
  conditions: never[];
  actions: BoltRuleAction[];
}

export interface ShapeContext {
  control_id: string;
  control_title: string;
  compliance_project_id: string | null;
}

type ShapeBuilder = (ctx: ShapeContext) => BoltRuleShape;

const remediationTask = (ctx: ShapeContext, title: string): BoltRuleAction => ({
  sort_order: 0,
  mcp_tool: 'create_task',
  parameters: { project_id: ctx.compliance_project_id, title, priority: 'high' },
});

/**
 * The closed shapes. Each fires on Bastion's own control.drifted for one control, so the rule
 * reacts the moment the nightly check sees the problem again, and its only action is a task in
 * the Compliance project. Keyed `<gap_kind>:<probe_key>`.
 */
export const BOLT_RULE_SHAPES: Record<string, ShapeBuilder> = {
  'failing:change.merge_reviewed': (ctx) => ({
    name: 'Flag code changes merged without a second review',
    description: 'When Bastion sees a change merged without a second person reviewing it, file a task in the Compliance project.',
    enabled: false,
    trigger_source: 'bastion',
    trigger_event: 'control.drifted',
    trigger_filter: { control_id: ctx.control_id },
    conditions: [],
    actions: [remediationTask(ctx, 'Review the code change that was merged without a second reviewer')],
  }),
  'failing:change.merge_traceable': (ctx) => ({
    name: 'Flag code changes not linked to planned work',
    description: 'When Bastion sees a merged change with no linked task, file a task in the Compliance project.',
    enabled: false,
    trigger_source: 'bastion',
    trigger_event: 'control.drifted',
    trigger_filter: { control_id: ctx.control_id },
    conditions: [],
    actions: [remediationTask(ctx, 'Link the merged code change to the work it belongs to')],
  }),
  'failing:automation.failure_rate': (ctx) => ({
    name: 'Follow up on failing automations',
    description: 'When Bastion sees too many automation runs failing, file a task in the Compliance project.',
    enabled: false,
    trigger_source: 'bastion',
    trigger_event: 'control.drifted',
    trigger_filter: { control_id: ctx.control_id },
    conditions: [],
    actions: [remediationTask(ctx, 'Look at the automations that keep failing')],
  }),
};

export class BoltRuleShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoltRuleShapeError';
  }
}

const ALLOWED = new Set<string>(BASTION_BOLT_RULE_ALLOWED_ACTIONS);

/**
 * Refuse any rule whose actions leave the allowlist: only create_task (in the Compliance project)
 * and banter_post_message. send_webhook and every send_email* action are rejected by name too,
 * so the refusal reads plainly even if the allowlist ever grows.
 */
export function assertBoltRuleShapeAllowed(shape: { actions: Array<{ mcp_tool: string; parameters?: Record<string, unknown> }> }, complianceProjectId: string | null): void {
  if (!Array.isArray(shape.actions) || shape.actions.length === 0) throw new BoltRuleShapeError('A drafted rule needs at least one action.');
  for (const a of shape.actions) {
    if (a.mcp_tool === 'send_webhook' || a.mcp_tool.startsWith('send_email')) {
      throw new BoltRuleShapeError(`A drafted rule may not use ${a.mcp_tool}: Bastion never drafts anything that sends outside the suite.`);
    }
    if (!ALLOWED.has(a.mcp_tool)) throw new BoltRuleShapeError(`A drafted rule may not use ${a.mcp_tool}.`);
    if (a.mcp_tool === 'create_task' && (a.parameters?.project_id ?? null) !== complianceProjectId) {
      throw new BoltRuleShapeError('A drafted rule may only create tasks in the Compliance project.');
    }
  }
}

/** The shape for a gap, or null when no shape is defined (the draft falls back to process_change). */
export function boltRuleShapeFor(gapKind: string, probeKey: string | null, ctx: ShapeContext): BoltRuleShape | null {
  const build = BOLT_RULE_SHAPES[`${gapKind}:${probeKey ?? ''}`];
  if (!build) return null;
  const shape = build(ctx);
  assertBoltRuleShapeAllowed(shape, ctx.compliance_project_id);
  return shape;
}
