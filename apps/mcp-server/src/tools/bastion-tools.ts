import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BastionControlLifecycle,
  BastionSetupState,
  bastionAssertionProposeSchema,
  bastionAssertionReviseSchema,
  bastionEvaluationListQuerySchema,
  bastionRunEvaluationSchema,
} from '@bigbluebam/shared';
// M6 decision tools (registerBastionDecisionTools at the very end).
// Every M6 tool input is taken from the shared schema of its route (#231): the tool advertises
// exactly what the route enforces, and a bound changed in shared changes both.
import {
  bastionDriftAcknowledgeSchema,
  bastionDriftListQuerySchema,
  bastionExceptionListQuerySchema,
  bastionExceptionProposeSchema,
  bastionFixDraftListQuerySchema,
  bastionFixMarkAppliedSchema,
  bastionGapDismissSchema,
  bastionGapListQuerySchema,
  bastionProposeFixSchema,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';
import { createBastionClient, type BastionClient, type BastionFetch } from '../clients/bastion-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
// #196 parity tools (registerBastionAdminTools at the bottom of this file).
import { createHash, randomBytes } from 'node:crypto';
// M5 evidence, feeds and coverage tools (registerBastionEvidenceTools at the very bottom).
import {
  bastionFeedCreateSchema,
  bastionFeedRecordListQuerySchema,
  bastionFeedUpdateSchema,
  bastionManualEvidenceListQuerySchema,
} from '@bigbluebam/shared';
// M8 questionnaire tools (registerBastionQuestionnaireTools at the very end).
import {
  BastionAnswerKind,
  BastionConfidenceBand,
  BastionQuestionnaireStatus,
  bastionAnswerLibraryUpdateSchema,
  bastionDraftAnswerSchema,
  bastionQuestionnaireColumnMapSchema,
  bastionQuestionnaireCreateSchema,
  bastionQuestionnaireItemReviewSchema,
  bastionQuestionnaireUpdateSchema,
} from '@bigbluebam/shared';
// M7 policy tools (registerBastionPolicyTools at the very end).
import { bastionPolicyAudienceSchema, bastionPolicyCreateFields, bastionPolicyCreateSchema, bastionPolicyUpdateSchema } from '@bigbluebam/shared';
// M9 sharing, settings and audit tools (registerBastionSharingTools at the very end).
import {
  BastionExportStatus,
  bastionAuditorRequestUpdateSchema,
  bastionExportCreateSchema,
  bastionSettingsUpdateFields,
  bastionSettingsUpdateSchema,
} from '@bigbluebam/shared';
import {
  BastionAuditorRequestStatus,
  bastionAdoptFrameworkSchema,
  bastionBulkApplicabilitySchema,
  bastionCompanyProfileSchema,
  bastionControlCreateSchema,
  bastionControlUpdateSchema,
  bastionFrameworkUpdateSchema,
  bastionRequirementApplicabilitySchema,
  bastionSetupComplianceProjectSchema,
} from '@bigbluebam/shared';

/**
 * Bastion MCP tool handlers (spec 5.4), registered by server.ts.
 *
 * Built from M2 to M10 under src/tools-pending/bastion.ts, outside the counted tool surface, and
 * moved here and registered in the M11 merge unit, so scripts/check-tool-return-coverage.mjs and
 * the docs catalog (scripts/docs/lib/tool-source.mjs) count them from M11 on. Each milestone added
 * the handlers for the routes it shipped, typed off the shared Zod in @bigbluebam/shared, with tests.
 *
 * M3 (this file's first content): frameworks, controls, assertions, probes and setup status.
 * M4: run an evaluation, evaluation runs, evidence, verification, seals and restores. Resolving
 * a ledger restore (POST /ledger/restores/:id/acknowledge) has no tool: it is an owner's
 * integrity act behind a session (spec 2.8).
 * M5: manual evidence (list, link, unlink, withdraw with a confirm token, scan check again), feeds
 * (list, records; create and edit in the admin block) and the Readiness summary and Evidence map
 * (registerBastionEvidenceTools at the bottom).
 *
 * Agent policy: every tool goes through registerTool, so the section 15 kill switch and the
 * `bastion.*` allowlist apply; bastion_* tools fail closed until an operator allowlists them.
 *
 * Build rule (orchestrator decision on issue #196, recorded in the WIP decisions): an agent can do
 * everything a human can, under the same permissions and audit. The setup and admin writes
 * (adopt, edit and archive a framework, create and edit controls, applicability decisions, the
 * company profile, the Compliance project) and the floored room reads therefore have tools, in
 * registerBastionAdminTools below. Every path that changes what Bastion reports as compliant
 * (archive, not applicable, dismiss a gap, unlink evidence, retire a policy) is two-step through a
 * confirm token (BASTION_CONFIRM_ACTIONS, #415).
 *
 * Deliberately NO tool: confirming or rejecting a check, and every later vouching route (attest,
 * decide, evidence review, room create/revoke/unlock, ...). Category "auth: session required
 * (spec 2.8, #136)": bastion-api requires a cookie session and refuses impersonation there, so an
 * API key can never satisfy a vouching act. Also none for the Statement of Applicability CSV
 * (binary download).
 */

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

export const BASTION_PENDING_TOOL_NAMES = [
  'bastion_list_frameworks',
  'bastion_not_applicable_suggestions',
  'bastion_compile_framework',
  'bastion_list_controls',
  'bastion_control_status',
  'bastion_propose_assertion',
  'bastion_list_probes',
  'bastion_get_setup_status',
  'bastion_run_evaluation',
  'bastion_list_evaluations',
  'bastion_evidence_for',
  'bastion_get_evidence',
  'bastion_verify_evidence',
  'bastion_list_seals',
  'bastion_list_restores',
] as const;

export function registerBastionTools(
  server: McpServer,
  api: ApiClient,
  bastionApiUrl: string,
  fetchImpl?: BastionFetch,
  confirmTokenStore?: ConfirmTokenStore,
): void {
  const client = createBastionClient(bastionApiUrl, api, fetchImpl);
  registerBastionAdminTools(server, client, confirmTokenStore);
  // The truth-flip paths in these blocks are confirm-gated too (BASTION_CONFIRM_ACTIONS, #415).
  registerBastionEvidenceTools(server, client, confirmTokenStore);
  registerBastionDecisionTools(server, client, confirmTokenStore);
  registerBastionPolicyTools(server, client, confirmTokenStore);
  registerBastionQuestionnaireTools(server, client);
  registerBastionSharingTools(server, client);

  // ── 1. bastion_list_frameworks (rows 1, 2, 4, 7) ───────────────────────────
  registerTool(server, {
    name: 'bastion_list_frameworks',
    description:
      'Compliance frameworks (SOC 2, ISO 27001). Without framework_id: the adopted frameworks with their setup counts and Statement of Applicability progress, plus the built-in templates and whether each is adopted (GET /frameworks, GET /library/templates). With framework_id: that framework (GET /frameworks/:id), and with include_requirements=true every requirement with its reference code, our plain summary, the linked controls and the applicability decision (GET /frameworks/:id/requirements). Read-only.',
    input: {
      framework_id: z.string().uuid().optional(),
      include_requirements: z.boolean().optional(),
      include_archived: z.boolean().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, include_requirements, include_archived }) => {
      if (framework_id) {
        const f = await client.getFramework(framework_id);
        if (!f.ok) return err('reading framework', f.data);
        if (!include_requirements) return ok(f.data);
        const reqs = await client.listRequirements(framework_id);
        if (!reqs.ok) return err('reading requirements', reqs.data);
        return ok({ framework: f.data.data, requirements: reqs.data });
      }
      const [list, templates] = await Promise.all([client.listFrameworks(include_archived), client.listTemplates()]);
      if (!list.ok) return err('listing frameworks', list.data);
      if (!templates.ok) return err('listing framework templates', templates.data);
      return ok({
        frameworks: list.data.data,
        templates: templates.data.data,
      });
    },
  });

  // ── 1b. bastion_not_applicable_suggestions (#238) ──────────────────────────
  registerTool(server, {
    name: 'bastion_not_applicable_suggestions',
    description:
      'The AI compile\'s "this requirement may not apply" suggestions for a framework (GET /frameworks/:id/not-applicable-suggestions): each undecided requirement the compiler thinks may not apply, with the controls that said so and their reasons. A suggestion is not a decision: the control still gets the library\'s checks until a person decides the requirement in Setup (or through POST /frameworks/:id/applicability). Decided requirements are not listed. Read-only; needs bastion.framework.read.',
    input: { framework_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id }) => {
      const r = await client.listNotApplicableSuggestions(framework_id);
      return r.ok ? ok(r.data) : err('listing not-applicable suggestions', r.data);
    },
  });

  // ── 2. bastion_compile_framework (rows 9, 10) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_compile_framework',
    description:
      'Propose checks for a framework\'s controls (POST /frameworks/:id/compile, 202 with the run). With an AI provider the run comes back `queued` and the worker tailors each control from the closed probe menu (the AI never writes queries; anything invalid is dropped with a reason, and a control the AI cannot help with gets the library suggestions); poll with action="list_runs" until it is succeeded. Without a provider, or with use_ai=false, the library suggestions are proposed and the run is already finished. Or list its past runs with action="list_runs" (GET /frameworks/:id/compile-runs, newest first; pass next_cursor back as cursor while has_more is true). The compile only PROPOSES: every check lands as proposed and a person must confirm it in Bastion (including "This is the complete list" for any list of systems). Re-running proposes nothing a control already has. A run already going returns 409 COMPILE_RUNNING.',
    input: {
      framework_id: z.string().uuid(),
      action: z.enum(['start', 'list_runs']).optional().describe('Default "start".'),
      use_ai: z
        .boolean()
        .optional()
        .describe('start: false proposes the library suggestions verbatim, finished at once. Default true: with an AI provider the run is queued and tailored on the worker (poll list_runs).'),
      cursor: z.string().max(200).optional().describe('list_runs: next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(200).optional().describe('list_runs: page size (default 50).'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, action, cursor, limit, use_ai }) => {
      if (action === 'list_runs') {
        const r =
          cursor || limit
            ? await client.listCompileRunsPage(framework_id, { cursor, limit })
            : await client.listCompileRuns(framework_id);
        return r.ok ? ok(r.data) : err('listing compile runs', r.data);
      }
      const r = use_ai === undefined ? await client.compileFramework(framework_id) : await client.compileFrameworkWith(framework_id, { use_ai });
      return r.ok ? ok(r.data) : err('starting compile', r.data);
    },
  });

  // ── 3. bastion_list_controls (row 11) ──────────────────────────────────────
  registerTool(server, {
    name: 'bastion_list_controls',
    description:
      'The organization\'s controls in one framework view (or all adopted frameworks), each with its requirement reference codes, its setup state (set_up, not_set_up, not_applicable) and assertion counts, plus the view\'s counts including "Not set up yet" (GET /controls). Filter by setup state, lifecycle (active or retired) or a text query. Read-only.',
    input: {
      framework_id: z.string().uuid().optional(),
      setup: BastionSetupState.optional(),
      lifecycle: BastionControlLifecycle.optional(),
      q: z.string().max(200).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const r = await client.listControls(args);
      return r.ok ? ok(r.data) : err('listing controls', r.data);
    },
  });

  // ── 4. bastion_control_status (rows 13, 16) ────────────────────────────────
  registerTool(server, {
    name: 'bastion_control_status',
    description:
      'One control: its stored status and reason, setup state, derived applicability, every framework requirement it satisfies, and its checks (assertions) with their review state and, for population checks, the listed systems and whether a person confirmed the list (GET /controls/:id). With checks_only, just the checks, newest first (GET /controls/:id/assertions). Read-only.',
    input: {
      control_id: z.string().uuid(),
      checks_only: z.boolean().optional().describe('Return only the control\'s checks (GET /controls/:id/assertions).'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ control_id, checks_only }) => {
      if (checks_only) {
        const r = await client.listControlAssertions(control_id);
        return r.ok ? ok(r.data) : err('reading checks', r.data);
      }
      const r = await client.getControl(control_id);
      return r.ok ? ok(r.data) : err('reading control', r.data);
    },
  });

  // ── 5. bastion_propose_assertion (rows 17, 20) ─────────────────────────────
  registerTool(server, {
    name: 'bastion_propose_assertion',
    description:
      'Propose a new check for a control (control_id + proposal: POST /controls/:id/assertions) or a revision of an existing one (revise_assertion_id + revision: POST /assertions/:id/revise, which files a superseding proposed check). A check has at most one revision waiting for review: revising a check that already has one is refused (409 REVISION_PENDING); revise the waiting revision instead (it replaces it) or wait until it is confirmed or rejected.Probe checks use the closed probe menu (see bastion_list_probes); parameters outside the probe\'s range are refused. Everything lands as proposed; only a signed-in person can confirm it in Bastion. Give exactly one of control_id or revise_assertion_id.',
    input: {
      control_id: z.string().uuid().optional(),
      proposal: bastionAssertionProposeSchema.optional(),
      revise_assertion_id: z.string().uuid().optional(),
      revision: bastionAssertionReviseSchema.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ control_id, proposal, revise_assertion_id, revision }) => {
      if (control_id && proposal && !revise_assertion_id && !revision) {
        const r = await client.proposeAssertion(control_id, proposal);
        return r.ok ? ok(r.data) : err('proposing check', r.data);
      }
      if (revise_assertion_id && revision && !control_id && !proposal) {
        const r = await client.reviseAssertion(revise_assertion_id, revision);
        return r.ok ? ok(r.data) : err('revising check', r.data);
      }
      return err('proposing check', {
        code: 'VALIDATION_ERROR',
        message: 'Give either control_id with proposal, or revise_assertion_id with revision.',
      });
    },
  });

  // ── 6. bastion_list_probes (row 21) ────────────────────────────────────────
  registerTool(server, {
    name: 'bastion_list_probes',
    description:
      'The closed menu of automatic checks Bastion can run against suite data (GET /probes): key, version, a plain title and description, whether it checks a confirmed list of systems (population_kind), and whether it is provided by the hosting platform. Read-only.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.listProbes();
      return r.ok ? ok(r.data) : err('listing probes', r.data);
    },
  });

  // ── 7. bastion_get_setup_status (GET /setup; M3 parity reconciliation) ──────
  registerTool(server, {
    name: 'bastion_get_setup_status',
    description:
      'Where Bastion setup stands (GET /setup): adopted frameworks and their latest compile run, the company profile, the Compliance project, the proposed checks waiting for a person (with any lists of systems awaiting "This is the complete list"), ISO applicability progress, and which required steps are done. Read-only; the setup steps themselves are done by a person in Bastion.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.getSetup();
      return r.ok ? ok(r.data) : err('reading setup status', r.data);
    },
  });

  // ── 8. bastion_run_evaluation (row 22) ─────────────────────────────────────
  registerTool(server, {
    name: 'bastion_run_evaluation',
    description:
      'Check the controls now instead of waiting for the nightly run (POST /evaluations, 202 with the queued run). Without control_id every in-scope control is checked; with control_id only that one. Runs are recorded as started by an agent when the caller is one. Poll bastion_list_evaluations with run_id for progress. If an evaluation of the same scope is already going this returns 409 EVALUATION_RUNNING; it finishes on its own. Checks only read suite data; nothing is changed.',
    input: bastionRunEvaluationSchema.shape,
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const r = await client.runEvaluation(args);
      return r.ok ? ok(r.data) : err('starting evaluation', r.data);
    },
  });

  // ── 9. bastion_list_evaluations (rows 23, 24) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_list_evaluations',
    description:
      'Evaluation runs, newest first (GET /evaluations, optional status filter and limit; pass next_cursor back as cursor while has_more is true), or one run with run_id (GET /evaluations/:id): trigger (nightly, manual, agent), scope, status (queued, running, succeeded, partial with a reason such as restore_pending, failed), and the counts checked so far. Read-only.',
    input: {
      run_id: z.string().uuid().optional(),
      status: bastionEvaluationListQuerySchema.shape.status,
      cursor: z.string().max(200).optional().describe('next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ run_id, status, cursor, limit }) => {
      const r = run_id ? await client.getEvaluation(run_id) : await client.listEvaluations({ status, cursor, limit });
      return r.ok ? ok(r.data) : err(run_id ? 'reading evaluation' : 'listing evaluations', r.data);
    },
  });

  // ── 10. bastion_evidence_for (row 25) ──────────────────────────────────────
  registerTool(server, {
    name: 'bastion_evidence_for',
    description:
      'The evidence recorded for one control, newest first (GET /controls/:id/evidence): each snapshot\'s outcome (pass, fail, unprovable with a reason), the check that produced it, its window, counts, its hash and ledger position, and a plain explanation. Names and cited records are shown only to owners, admins and the control\'s owner; everyone else gets counts. Every evaluation run stores one snapshot per check, so the full list repeats each check once per run; latest=true returns only the newest snapshot of each confirmed check (one page, what Control detail shows). Optional assertion_id narrows to one check (its history). Pass next_cursor back as cursor while has_more is true. asker_user_id is required: the person you are answering must hold bastion.evidence.read too, detail is shown only when both of you may see it, and each cited record (cited_refs, cited_items, cited_labels) and repository name appears only when both of you can open it; the rest are counted in hidden_citation_count. Read-only.',
    input: {
      asker_user_id: askerUserId,
      control_id: z.string().uuid(),
      assertion_id: z.string().uuid().optional(),
      latest: z.boolean().optional().describe('Only the newest snapshot of each confirmed check.'),
      cursor: z.string().max(200).optional().describe('next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ control_id, assertion_id, latest, cursor, limit, asker_user_id }) => {
      const r = await client.listControlEvidence(control_id, { assertion_id, latest, cursor, limit, asker_user_id });
      return r.ok ? ok(r.data) : err('listing evidence', r.data);
    },
  });

  // ── 11. bastion_get_evidence (row 26) ──────────────────────────────────────
  registerTool(server, {
    name: 'bastion_get_evidence',
    description:
      'One evidence snapshot by id (GET /evidence/:id), with the same counts-only rule as bastion_evidence_for. asker_user_id is required: detail and each cited record are shown only when both you and the person you are answering may see them (the rest are counted in hidden_citation_count). Read-only.',
    input: { asker_user_id: askerUserId, evidence_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ evidence_id, asker_user_id }) => {
      const r = await client.getEvidence(evidence_id, { asker_user_id });
      return r.ok ? ok(r.data) : err('reading evidence', r.data);
    },
  });

  // ── 12. bastion_verify_evidence (row 27) ───────────────────────────────────
  registerTool(server, {
    name: 'bastion_verify_evidence',
    description:
      'Verify one evidence snapshot (GET /evidence/:id/verify): re-hashes its ledger entry and stored file, checks the personal-data commitment, and walks the chain to the next signed daily seal. result is intact, hash_mismatch, object_missing ("Evidence file missing"), redacted, pd_mismatch or key_changed; recent evidence reads "Not sealed yet" until the nightly seal. Read-only.',
    input: { evidence_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ evidence_id }) => {
      const r = await client.verifyEvidence(evidence_id);
      return r.ok ? ok(r.data) : err('verifying evidence', r.data);
    },
  });

  // ── 13. bastion_list_seals (row 29; M3 parity reconciliation) ──────────────
  registerTool(server, {
    name: 'bastion_list_seals',
    description:
      'The signed daily seals of the evidence ledger (GET /ledger/seals): seal date, epoch, head position and hash, Ed25519 signature, signing key id, and when the seal object reached storage and was published; plus every signing key (current and retired) with its public key so anyone can check old seals. Newest first; pass next_cursor back as cursor while has_more is true. Read-only.',
    input: {
      cursor: z.string().max(200).optional().describe('next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(400).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ cursor, limit }) => {
      const r = await client.listSeals({ cursor, limit });
      return r.ok ? ok(r.data) : err('listing seals', r.data);
    },
  });

  // ── 14. bastion_list_restores (row 30; M3 parity reconciliation) ───────────
  registerTool(server, {
    name: 'bastion_list_restores',
    description:
      'Gaps in the evidence ledger found after a database restore (GET /ledger/restores): each lost range as "History lost by restore, epoch E seq X-Y" or "Unexplained gap, epoch E seq X-Y", whether recording is paused until an owner resolves it, and the ranges recorded in storage that the database no longer holds. Read-only; resolving a gap is a signed-in owner\'s act in Bastion and has no tool. Newest first; pass next_cursor back as cursor while has_more is true (the storage-only ranges come with the first page).',
    input: {
      cursor: z.string().max(200).optional().describe('next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ cursor, limit }) => {
      const r = await client.listRestores({ cursor, limit });
      return r.ok ? ok(r.data) : err('listing restores', r.data);
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * #196 parity: setup and admin writes, and the floored auditor-room reads.
 *
 * Orchestrator decision (issue #196): "an agent can do everything a human can" stands. These
 * routes accept an API key under the same requireCan the wizard's buttons hit, so each gets a
 * tool. Kept in one block, after the milestone handlers above, so milestone appends merge cleanly.
 * Archive is destructive (it retires controls no other framework needs) and goes through a
 * two-step confirm token, as the other confirm-gated tools in apps/mcp-server do.
 * ════════════════════════════════════════════════════════════════════════════ */

export const BASTION_ADMIN_TOOL_NAMES = [
  'bastion_adopt_framework',
  'bastion_update_framework',
  'bastion_archive_framework',
  'bastion_upsert_control',
  'bastion_decide_applicability',
  'bastion_save_company_profile',
  'bastion_set_compliance_project',
  'bastion_list_auditor_rooms',
  'bastion_list_auditor_requests',
  // M5 feed configuration (spec rows 43, 44).
  'bastion_create_feed',
  'bastion_update_feed',
] as const;

/** Confirm-token TTL: the 5 min human-approver window, as Bursar's confirm-gated tools use. */
export const BASTION_CONFIRM_TTL_MS = 300_000;
export const BASTION_ARCHIVE_FRAMEWORK_ACTION = 'bastion_archive_framework';

/**
 * Every Bastion tool path that changes what Bastion reports as compliant (a "truth flip", #415),
 * each behind the same two-step confirm token. The ONE list: the gate, the descriptions and the
 * tests all read it.
 *
 *   archive_framework  retires every control only that framework needs
 *   not_applicable     takes a requirement out of scope (bastion_decide_applicability)
 *   dismiss_gap        removes a gap from the ranked list for good
 *   unlink_evidence    takes reviewed proof off a check, which is then re-evaluated
 *   retire_policy      stops tracking who has read a policy (bastion_update_policy, status retired)
 *
 * The other paths of those tools ("applicable", policy edits other than retiring) stay one call.
 */
export const BASTION_CONFIRM_ACTIONS = {
  archive_framework: BASTION_ARCHIVE_FRAMEWORK_ACTION,
  not_applicable: 'bastion_decide_applicability:not_applicable',
  dismiss_gap: 'bastion_dismiss_gap',
  unlink_evidence: 'bastion_unlink_manual_evidence',
  retire_policy: 'bastion_update_policy:retire',
} as const;

/** Stable JSON (sorted keys) so the same request always digests the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The resource a token is bound to: the record's id, plus (#415) a digest of exactly what the call
 * will do, so a token staged for one change cannot carry out a different one on the same record.
 */
export function bastionConfirmResource(id: string, payload?: unknown): string {
  if (payload === undefined) return id;
  return `${id}#${createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 32)}`;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

/**
 * The two-step confirm for a truth-flip path (bastion_archive_framework's flow, #415). Without
 * confirm_token: stage a token bound to (action, resource) and call nothing. With it: the token
 * must match both, is consumed, and only then does `run` call bastion-api. No token store: fail
 * closed.
 */
async function confirmGate(
  store: ConfirmTokenStore | undefined,
  gate: { tool: string; action: string; resource: string; label: string; what: string; noun: string; consequence: string },
  confirmToken: string | undefined,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!store) {
    return err(gate.label, {
      code: 'CONFIRMATION_UNAVAILABLE',
      message: `${gate.what} needs a confirmation step, which is not available on this server.`,
    });
  }
  if (!confirmToken) {
    const token = randomBytes(16).toString('hex');
    await store.set(token, { action: gate.action, resource_id: gate.resource, ttlMs: BASTION_CONFIRM_TTL_MS });
    return ok({
      status: 'pending_confirmation',
      message: `${gate.consequence} Re-call ${gate.tool} with the same arguments and this confirm_token to proceed. Token expires in ${Math.floor(
        BASTION_CONFIRM_TTL_MS / 1000,
      )} seconds.`,
      action: gate.action,
      resource_id: gate.resource,
      confirm_token: token,
    });
  }
  const pending = await store.get(confirmToken);
  if (!pending || pending.action !== gate.action || pending.resource_id !== gate.resource) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid or expired confirm_token for this ${gate.noun}. Re-call ${gate.tool} without a token to stage a new one.`,
        },
      ],
      isError: true as const,
    };
  }
  await store.delete(confirmToken);
  return run();
}

const confirmTokenInput = z.string().optional().describe('Token from the staging call. Required to carry out this change.');

export function registerBastionAdminTools(
  server: McpServer,
  client: BastionClient,
  confirmTokenStore: ConfirmTokenStore | undefined,
): void {
  // ── A1. bastion_adopt_framework (spec row 3) ───────────────────────────────
  registerTool(server, {
    name: 'bastion_adopt_framework',
    description:
      'Adopt a built-in framework (SOC 2 or ISO 27001) for the organization (POST /frameworks), optionally with an audit target date and period. Creates the framework\'s controls, reusing any control another adopted framework already has, and links them to its requirements. Next step: bastion_compile_framework to propose checks. Needs bastion.framework.write; 409 if the framework is already adopted.',
    input: bastionAdoptFrameworkSchema.shape,
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const r = await client.adoptFramework(args);
      return r.ok ? ok(r.data) : err('adopting framework', r.data);
    },
  });

  // ── A2. bastion_update_framework (spec row 5) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_update_framework',
    description:
      'Rename a framework or change its audit target date or audit period (PATCH /frameworks/:id). Give only the fields to change. Needs bastion.framework.write.',
    input: {
      framework_id: z.string().uuid(),
      changes: bastionFrameworkUpdateSchema,
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, changes }) => {
      const r = await client.updateFramework(framework_id, changes);
      return r.ok ? ok(r.data) : err('updating framework', r.data);
    },
  });

  // ── A3. bastion_archive_framework (spec row 6; CONFIRM two-step) ───────────
  registerTool(server, {
    name: 'bastion_archive_framework',
    description:
      'Archive a framework (POST /frameworks/:id/archive). DESTRUCTIVE: controls that serve only this framework are retired with it. Two-step confirm: call once WITHOUT confirm_token to stage a token, then again WITH the returned confirm_token (same framework_id) within 5 minutes to archive. Needs bastion.framework.write.',
    input: {
      framework_id: z.string().uuid(),
      confirm_token: z.string().optional().describe('Token from the staging call. Required to archive.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, confirm_token }) =>
      confirmGate(
        confirmTokenStore,
        {
          tool: 'bastion_archive_framework',
          action: BASTION_CONFIRM_ACTIONS.archive_framework,
          resource: bastionConfirmResource(framework_id),
          label: 'archiving framework',
          what: 'Archiving',
          noun: 'archive',
          consequence: 'Archiving retires every control that only this framework needs.',
        },
        confirm_token,
        async () => {
          const r = await client.archiveFramework(framework_id);
          return r.ok ? ok(r.data) : err('archiving framework', r.data);
        },
      ),
  });

  // ── A4. bastion_upsert_control (spec rows 12, 14) ──────────────────────────
  registerTool(server, {
    name: 'bastion_upsert_control',
    description:
      'Create a custom control (create: POST /controls; its key becomes custom:<slug>, optionally linked to framework requirements) or edit an existing control\'s title, summary, category, owner or risk weight (control_id + changes: PATCH /controls/:id). Give exactly one of create, or control_id with changes. Needs bastion.control.write.',
    input: {
      create: bastionControlCreateSchema.optional(),
      control_id: z.string().uuid().optional(),
      changes: bastionControlUpdateSchema.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ create, control_id, changes }) => {
      if (create && !control_id && !changes) {
        const r = await client.createControl(create);
        return r.ok ? ok(r.data) : err('creating control', r.data);
      }
      if (control_id && changes && !create) {
        const r = await client.updateControl(control_id, changes);
        return r.ok ? ok(r.data) : err('updating control', r.data);
      }
      return err('saving control', {
        code: 'VALIDATION_ERROR',
        message: 'Give either create, or control_id with changes.',
      });
    },
  });

  // ── A5. bastion_decide_applicability (spec row 15 + the bulk setup route) ───
  registerTool(server, {
    name: 'bastion_decide_applicability',
    description:
      'Record Statement of Applicability decisions. framework_id + decisions: decide several requirements by reference code at once, every control link of each code (POST /frameworks/:id/applicability). requirement_link_id + decision: decide one control-requirement link (PATCH /control-requirements/:id). "not_applicable" needs a plain reason. The decision is audited with who made it. "not_applicable" takes the requirement out of scope, so it stops counting against readiness: any call that marks something not applicable is two-step (call once WITHOUT confirm_token to stage a token, then again with the same arguments and the returned confirm_token within 5 minutes). "applicable" decisions run in one call. Needs bastion.control.write.',
    input: {
      framework_id: z.string().uuid().optional(),
      decisions: bastionBulkApplicabilitySchema.shape.decisions.optional(),
      requirement_link_id: z.string().uuid().optional(),
      decision: bastionRequirementApplicabilitySchema.optional(),
      confirm_token: confirmTokenInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, decisions, requirement_link_id, decision, confirm_token }) => {
      // A not-applicable decision is a truth flip (#415): staged and confirmed, bound to exactly
      // these decisions on this framework or link.
      const gated = (id: string, payload: unknown, run: () => Promise<ToolResult>) =>
        confirmGate(
          confirmTokenStore,
          {
            tool: 'bastion_decide_applicability',
            action: BASTION_CONFIRM_ACTIONS.not_applicable,
            resource: bastionConfirmResource(id, payload),
            label: 'deciding applicability',
            what: 'Marking a requirement not applicable',
            noun: 'not-applicable decision',
            consequence: 'Marking a requirement not applicable takes it out of scope: it stops counting against readiness.',
          },
          confirm_token,
          run,
        );
      if (framework_id && decisions && !requirement_link_id && !decision) {
        const run = async () => {
          const r = await client.decideApplicability(framework_id, { decisions });
          return r.ok ? ok(r.data) : err('deciding applicability', r.data);
        };
        return decisions.some((d) => d.applicability === 'not_applicable') ? gated(framework_id, { decisions }, run) : run();
      }
      if (requirement_link_id && decision && !framework_id && !decisions) {
        const run = async () => {
          const r = await client.updateRequirementLink(requirement_link_id, decision);
          return r.ok ? ok(r.data) : err('deciding applicability', r.data);
        };
        return decision.applicability === 'not_applicable' ? gated(requirement_link_id, decision, run) : run();
      }
      return err('deciding applicability', {
        code: 'VALIDATION_ERROR',
        message: 'Give either framework_id with decisions, or requirement_link_id with decision.',
      });
    },
  });

  // ── A6. bastion_save_company_profile (PATCH /setup/profile) ────────────────
  registerTool(server, {
    name: 'bastion_save_company_profile',
    description:
      'Save answers to the ten setup questions about the company (PATCH /setup/profile): size, where people work, own premises, builds software, uses GitHub, keeps customer personal data, takes card payments, runs in the cloud, has contractors, issues laptops. Answers given are merged into the saved profile. Needs bastion.framework.write.',
    input: { profile: bastionCompanyProfileSchema },
    returns: z.record(z.unknown()),
    handler: async ({ profile }) => {
      const r = await client.saveCompanyProfile(profile);
      return r.ok ? ok(r.data) : err('saving company profile', r.data);
    },
  });

  // ── A7. bastion_set_compliance_project (POST /setup/compliance-project) ────
  registerTool(server, {
    name: 'bastion_set_compliance_project',
    description:
      'Record the Bam project Bastion files its remediation tasks in (POST /setup/compliance-project). The caller must be a member of that project (SuperUsers excepted); otherwise 404, the same as an unknown project. To create a new "Compliance" project first, use Bam\'s create_project, then pass its id here. Needs bastion.framework.write.',
    input: bastionSetupComplianceProjectSchema.shape,
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const r = await client.setComplianceProject(args);
      return r.ok ? ok(r.data) : err('recording Compliance project', r.data);
    },
  });

  // ── A8. bastion_list_auditor_rooms (spec rows 84, 88) ──────────────────────
  registerTool(server, {
    name: 'bastion_list_auditor_rooms',
    description:
      'Auditor rooms (read-only). Without room_id: every room with its scope, expiry and state (GET /auditor-rooms). With room_id: that room\'s access log, who opened what and when (GET /auditor-rooms/:id/access-log). Floored: needs bastion.auditor_room.read. Creating, revoking or unlocking a room is a disclosure act with no tool (a signed-in person does it in Bastion).',
    input: { room_id: z.string().uuid().optional() },
    returns: z.record(z.unknown()),
    handler: async ({ room_id }) => {
      if (room_id) {
        const r = await client.getAuditorRoomAccessLog(room_id);
        return r.ok ? ok(r.data) : err('reading auditor room access log', r.data);
      }
      const r = await client.listAuditorRooms();
      return r.ok ? ok(r.data) : err('listing auditor rooms', r.data);
    },
  });

  // ── A9. bastion_list_auditor_requests (spec row 89) ────────────────────────
  registerTool(server, {
    name: 'bastion_list_auditor_requests',
    description:
      'Requests auditors raised in auditor rooms (GET /auditor-requests), optionally for one room or one status (open, answered, closed). Read-only; floored: needs bastion.auditor_room.read.',
    input: {
      room_id: z.string().uuid().optional(),
      status: BastionAuditorRequestStatus.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const r = await client.listAuditorRequests(args);
      return r.ok ? ok(r.data) : err('listing auditor requests', r.data);
    },
  });

  // ── A10. bastion_create_feed (spec row 43, M5) ─────────────────────────────
  registerTool(server, {
    name: 'bastion_create_feed',
    description:
      'Set up a machine feed (POST /feeds): an API-push feed that an outside system sends records to with its own per-feed key, or a Bolt-event feed (source_kind "bolt_event" with bolt_source and bolt_event_type) that records matching suite events. Records are frozen as evidence. Minting the push key is a credential act a person does in Bastion (no tool). Needs bastion.feed.manage; 409 FEED_KEY_TAKEN if the key is in use.',
    input: { feed: bastionFeedCreateSchema },
    returns: z.record(z.unknown()),
    handler: async ({ feed }) => {
      const r = await client.createFeed(feed);
      return r.ok ? ok(r.data) : err('creating feed', r.data);
    },
  });

  // ── A11. bastion_update_feed (spec row 44, M5) ─────────────────────────────
  registerTool(server, {
    name: 'bastion_update_feed',
    description:
      'Change a feed\'s label, how often it should send records (cadence_days), its daily record limit, or its status (active, paused, retired) (PATCH /feeds/:id). Give only the fields to change. Needs bastion.feed.manage.',
    input: {
      feed_id: z.string().uuid(),
      changes: bastionFeedUpdateSchema,
    },
    returns: z.record(z.unknown()),
    handler: async ({ feed_id, changes }) => {
      const r = await client.updateFeed(feed_id, changes);
      return r.ok ? ok(r.data) : err('updating feed', r.data);
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * M5: manual evidence, machine feeds, Readiness and the Evidence map (spec 3.3-3.5, 5.1).
 *
 * No tool (sanctioned skips, recorded in docs/reference/mcp-endpoint-mapping.md):
 *   - uploading or superseding evidence (rows 32, 40), reviewing a link (38) and redacting personal
 *     data (41): "auth: session required (spec 2.8, #136)"; a person vouches for these;
 *   - downloading the file (35): multipart/binary;
 *   - listing, minting and revoking feed keys (45-47): auth/credentials;
 *   - the machine push itself (48): public-inbound, authenticated by its own per-feed key;
 *   - withdrawing evidence (39): a destructive human act, "auth: session required (spec 2.8,
 *     #136)"; the route requires a session and refuses impersonation (#217).
 *
 * Detail-bearing reads (the locker, feed records, readiness and the map) REQUIRE asker_user_id
 * (#217, spec 5.4): bastion-api answers with the intersection of the bearer's and the asker's
 * permissions, including bastion.evidence.read_restricted and bastion.feed.read, so an agent
 * posting into a shared surface never shows a person more than they may see. Narrows, never widens.
 * ════════════════════════════════════════════════════════════════════════════ */

export const BASTION_EVIDENCE_TOOL_NAMES = [
  'bastion_list_manual_evidence',
  'bastion_link_manual_evidence',
  'bastion_unlink_manual_evidence',
  'bastion_check_evidence_scan_again',
  'bastion_list_feeds',
  'bastion_list_feed_records',
  'bastion_coverage_summary',
] as const;

const askerUserId = z
  .string()
  .uuid()
  .describe('The person this answer is for (required). Results are narrowed to what both you and they may see.');

export function registerBastionEvidenceTools(server: McpServer, client: BastionClient, confirmTokenStore?: ConfirmTokenStore): void {
  // ── E1. bastion_list_manual_evidence (rows 33, 34) ─────────────────────────
  registerTool(server, {
    name: 'bastion_list_manual_evidence',
    description:
      'Uploaded evidence and written statements (the Evidence locker). Without manual_evidence_id: a list, newest first, filtered by status (pending_scan, active, superseded, withdrawn, blocked), kind (file or attestation_statement), a check (assertion_id), a control (control_id), or stuck=true for uploads waiting more than a day for a virus scan, plus counts (GET /manual-evidence). With manual_evidence_id: one item with its linked checks and their review state (GET /manual-evidence/:id). Each item shows its owner, who uploaded it, its period, when it expires (days_left), and whether it was virus-scanned. Restricted items are masked, or not found, unless both the caller and the asker may read restricted evidence. Read-only.',
    input: {
      asker_user_id: askerUserId,
      manual_evidence_id: z.string().uuid().optional(),
      // Filters of the route itself (#215): the tool and GET /manual-evidence validate alike.
      ...bastionManualEvidenceListQuerySchema.shape,
      limit: bastionManualEvidenceListQuerySchema.shape.limit.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ manual_evidence_id, asker_user_id, ...q }) => {
      const r = manual_evidence_id
        ? await client.getManualEvidence(manual_evidence_id, { asker_user_id })
        : await client.listManualEvidence({ ...q, asker_user_id });
      return r.ok ? ok(r.data) : err(manual_evidence_id ? 'reading evidence' : 'listing evidence', r.data);
    },
  });

  // ── E2. bastion_link_manual_evidence (row 36) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_link_manual_evidence',
    description:
      'Link uploaded evidence to a manual check it proves (POST /manual-evidence/:id/links). The link counts only after a second person reviews it in Bastion (there is no tool for the review). Re-linking an unlinked check starts a fresh review. Needs bastion.evidence.link.',
    input: {
      manual_evidence_id: z.string().uuid(),
      assertion_id: z.string().uuid(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ manual_evidence_id, assertion_id }) => {
      const r = await client.linkManualEvidence(manual_evidence_id, { assertion_id });
      return r.ok ? ok(r.data) : err('linking evidence', r.data);
    },
  });

  // ── E3. bastion_unlink_manual_evidence (row 37) ────────────────────────────
  registerTool(server, {
    name: 'bastion_unlink_manual_evidence',
    description:
      'Remove the link between uploaded evidence and a check (DELETE /manual-evidence/:id/links/:assertion_id). If the link had been reviewed, the control is checked again so its status reflects the change. That takes proof away from the check, so this is two-step: call once WITHOUT confirm_token to stage a token, then again with the same manual_evidence_id, assertion_id and the returned confirm_token within 5 minutes. Needs bastion.evidence.link.',
    input: {
      manual_evidence_id: z.string().uuid(),
      assertion_id: z.string().uuid(),
      confirm_token: confirmTokenInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ manual_evidence_id, assertion_id, confirm_token }) =>
      // Taking reviewed proof off a check is a truth flip (#415).
      confirmGate(
        confirmTokenStore,
        {
          tool: 'bastion_unlink_manual_evidence',
          action: BASTION_CONFIRM_ACTIONS.unlink_evidence,
          resource: bastionConfirmResource(`${manual_evidence_id}/${assertion_id}`),
          label: 'unlinking evidence',
          what: 'Unlinking evidence',
          noun: 'unlink',
          consequence: 'Unlinking takes this evidence off the check; if the link was reviewed, the control is checked again without it.',
        },
        confirm_token,
        async () => {
          const r = await client.unlinkManualEvidence(manual_evidence_id, assertion_id);
          return r.ok ? ok(r.data) : err('unlinking evidence', r.data);
        },
      ),
  });

  // (Row 39, withdraw: no tool. A destructive human act, spec 2.8, #217.)

  // ── E5. bastion_check_evidence_scan_again (POST /manual-evidence/:id/check-again) ─
  registerTool(server, {
    name: 'bastion_check_evidence_scan_again',
    description:
      'For an upload still waiting on its virus scan, check Bin again right now instead of waiting for the next automatic retry (POST /manual-evidence/:id/check-again; the review queue\'s "Check again"). If the scan finished clean (or scanning is off) the file is copied into Bastion\'s evidence store; an infected or failed scan blocks it. check_result is copied, copy_started (a large file is still being saved), still_pending, blocked or skipped. 409 NOT_PENDING_SCAN when the item is not waiting. Needs bastion.evidence.upload.',
    input: { manual_evidence_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ manual_evidence_id }) => {
      const r = await client.checkEvidenceScanAgain(manual_evidence_id);
      return r.ok ? ok(r.data) : err('checking the scan again', r.data);
    },
  });

  // ── E6. bastion_list_feeds (row 42) ────────────────────────────────────────
  registerTool(server, {
    name: 'bastion_list_feeds',
    description:
      'Machine feeds (GET /feeds): each feed\'s key, label, kind (API push or Bolt event), expected cadence, whether it is up to date, records today against its daily limit, active key count and total records. Never returns key secrets. Read-only; needs bastion.feed.read.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.listFeeds();
      return r.ok ? ok(r.data) : err('listing feeds', r.data);
    },
  });

  // ── E7. bastion_list_feed_records (row 49) ─────────────────────────────────
  registerTool(server, {
    name: 'bastion_list_feed_records',
    description:
      'Records one feed received, newest first (GET /feeds/:id/records): idempotency key, when it happened and was received, its payload hash and ledger position, and its subject unless redacted. Page with before = next_cursor while has_more is true. Read-only; both the caller and the asker need bastion.feed.read.',
    input: {
      asker_user_id: askerUserId,
      feed_id: z.string().uuid(),
      // Paging of the route itself (#215).
      limit: bastionFeedRecordListQuerySchema.shape.limit.optional(),
      before: bastionFeedRecordListQuerySchema.shape.before,
    },
    returns: z.record(z.unknown()),
    handler: async ({ feed_id, limit, before, asker_user_id }) => {
      const r = await client.listFeedRecords(feed_id, { limit, before, asker_user_id });
      return r.ok ? ok(r.data) : err('listing feed records', r.data);
    },
  });

  // ── E8. bastion_coverage_summary (rows 50, 94) ─────────────────────────────
  registerTool(server, {
    name: 'bastion_coverage_summary',
    description:
      'Readiness in one framework view (or all adopted frameworks). mode "summary" (default, GET /summary): the four numbers kept separate (Proven by the suite, Proven by evidence you provided, Not met with its "risk accepted" sub-count, Can\'t prove yet) plus "Not set up yet" and the denominator sentence ("41 of 64 controls checked; 23 not set up yet"), days to the nearest audit, banners, the top open gaps and evidence expiring soon. mode "map" (GET /coverage): every control with where its proof comes from (suite checks, feeds, uploaded files, self-attested statements), its state in plain words and when uploaded proof expires. Not-applicable controls are listed separately. Read-only; both the caller and the asker need bastion.control.read.',
    input: {
      asker_user_id: askerUserId,
      mode: z.enum(['summary', 'map']).optional().describe('Default "summary".'),
      framework_id: z.string().uuid().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ mode, framework_id, asker_user_id }) => {
      const r =
        mode === 'map' ? await client.getCoverage({ framework_id, asker_user_id }) : await client.getSummary({ framework_id, asker_user_id });
      return r.ok ? ok(r.data) : err(mode === 'map' ? 'reading the evidence map' : 'reading readiness', r.data);
    },
  });
}

/* ════════════════════════════════════════════════════════════════════════════
 * M6: gaps, fixes, exceptions, drift (spec 5.1 rows 51-63, 5.4 tools 8, 9, 14, 23, 24, plus
 * the #196 parity tools for dismiss, mark-applied and drift acknowledgement).
 *
 * No tool for either decide route (rows 56 and 61): "auth: session required (spec 2.8, #136)".
 * An agent proposes a fix or an exception; a person decides it inside Bastion.
 * ════════════════════════════════════════════════════════════════════════════ */

export const BASTION_DECISION_TOOL_NAMES = [
  'bastion_coverage_gaps',
  'bastion_propose_fix',
  'bastion_dismiss_gap',
  'bastion_list_fix_drafts',
  'bastion_mark_fix_applied',
  'bastion_list_exceptions',
  'bastion_propose_exception',
  'bastion_list_drift',
  'bastion_acknowledge_drift',
] as const;

export function registerBastionDecisionTools(server: McpServer, client: BastionClient, confirmTokenStore?: ConfirmTokenStore): void {
  // ── D1. bastion_coverage_gaps (row 51) ─────────────────────────────────────
  registerTool(server, {
    name: 'bastion_coverage_gaps',
    description:
      'What to fix first (GET /gaps): stored gaps ranked by risk (control weight x severity x how close the audit is), or sort "quick_wins" for risk per unit of effort. Each gap names its control, owner, kind in plain words (Not met, Evidence not uploaded yet, Something new is not on the list, ...), its fix template and cost, and any drafted fix. Also returns the org-level "checks are stale" row (never stored per control) and "Accepted risks" (active exceptions with owner and expiry). status defaults to "active" (open plus waiting on a decided fix). Read-only.',
    input: { ...bastionGapListQuerySchema.shape },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.listGaps(q);
      return r.ok ? ok(r.data) : err('listing gaps', r.data);
    },
  });

  // ── D2. bastion_propose_fix (row 52) ───────────────────────────────────────
  registerTool(server, {
    name: 'bastion_propose_fix',
    description:
      'Draft the fix for one open gap (POST /gaps/:id/propose-fix). The template comes from the gap (nobody picks it): confirm a check, ask the owner for evidence, change a setting, connect a source, add a Bolt automation (created turned off, only create_task in the Compliance project or a Banter post), draft a policy, or start a short procedure. The draft is filed as a platform proposal that a PERSON decides inside Bastion (the generic proposal decide answers DECIDE_IN_APP); there is no tool to decide it. Cited items you cannot see are dropped. 409 FIX_ALREADY_PROPOSED, GAP_NOT_OPEN or NO_FIX_FOR_GAP. Needs bastion.fix.draft.',
    input: {
      gap_id: z.string().uuid(),
      note: bastionProposeFixSchema.shape.note,
    },
    returns: z.record(z.unknown()),
    handler: async ({ gap_id, note }) => {
      const r = await client.proposeFix(gap_id, { note: note ?? null });
      return r.ok ? ok(r.data) : err('drafting the fix', r.data);
    },
  });

  // ── D3. bastion_dismiss_gap (row 53) ───────────────────────────────────────
  registerTool(server, {
    name: 'bastion_dismiss_gap',
    description:
      'Dismiss a gap with a reason (POST /gaps/:id/dismiss), for example when it does not apply to how the company works. Recorded in the Bastion audit log with who dismissed it; a dismissed gap stays dismissed when gaps are re-ranked. That takes it off the list for good, so this is two-step: call once WITHOUT confirm_token to stage a token, then again with the same gap_id, the same reason and the returned confirm_token within 5 minutes. Needs bastion.gap.dismiss (owners and admins).',
    input: {
      gap_id: z.string().uuid(),
      reason: bastionGapDismissSchema.shape.reason,
      confirm_token: confirmTokenInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ gap_id, reason, confirm_token }) =>
      // Dismissing removes a gap from what Bastion reports for good: a truth flip (#415).
      confirmGate(
        confirmTokenStore,
        {
          tool: 'bastion_dismiss_gap',
          action: BASTION_CONFIRM_ACTIONS.dismiss_gap,
          resource: bastionConfirmResource(gap_id, { reason }),
          label: 'dismissing the gap',
          what: 'Dismissing a gap',
          noun: 'dismissal',
          consequence: 'Dismissing takes this gap off the list, and it stays dismissed when gaps are re-ranked.',
        },
        confirm_token,
        async () => {
          const r = await client.dismissGap(gap_id, { reason });
          return r.ok ? ok(r.data) : err('dismissing the gap', r.data);
        },
      ),
  });

  // ── D4. bastion_list_fix_drafts (rows 54, 55) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_list_fix_drafts',
    description:
      'Drafted fixes (the review queue). Without fix_draft_id: newest first, filtered by status (proposed, approved, rejected, expired, applied, decision_rejected), gap or control (GET /fix-drafts). With fix_draft_id: one draft (GET /fix-drafts/:id). Each draft has its title, plain body, template, control, who drafted it, the mirrored proposal and its expiry, and the cited items both you and the person you are answering (asker_user_id, required) may see (others are counted in hidden_citation_count, not shown). decision_rejected means the proposal was decided outside Bastion and that decision was ignored. Read-only; both the caller and the asker need bastion.fix.read.',
    input: {
      asker_user_id: askerUserId,
      fix_draft_id: z.string().uuid().optional(),
      ...bastionFixDraftListQuerySchema.shape,
    },
    returns: z.record(z.unknown()),
    handler: async ({ fix_draft_id, asker_user_id, ...q }) => {
      const r = fix_draft_id ? await client.getFixDraft(fix_draft_id, { asker_user_id }) : await client.listFixDrafts({ ...q, asker_user_id });
      return r.ok ? ok(r.data) : err(fix_draft_id ? 'reading the fix' : 'listing fixes', r.data);
    },
  });

  // ── D5. bastion_mark_fix_applied (row 57) ──────────────────────────────────
  registerTool(server, {
    name: 'bastion_mark_fix_applied',
    description:
      'Record that an approved fix was carried out elsewhere (POST /fix-drafts/:id/mark-applied), optionally naming what was made: the Beacon policy draft (beacon.entry) or the Bolt automation (bolt.rule), by applied_entity_id, or for a Beacon article by applied_entity_slug (the last part of its /beacon/<slug> link). The named item must be visible to the caller; a link from the fix to it is recorded. 409 FIX_NOT_APPROVED unless a person approved the fix first. Needs bastion.fix.mark_applied.',
    input: {
      fix_draft_id: z.string().uuid(),
      ...bastionFixMarkAppliedSchema.innerType().shape,
    },
    returns: z.record(z.unknown()),
    handler: async ({ fix_draft_id, applied_entity_type, applied_entity_id, applied_entity_slug, note }) => {
      const r = await client.markFixApplied(fix_draft_id, {
        applied_entity_type: applied_entity_type ?? null,
        applied_entity_id: applied_entity_id ?? null,
        ...(applied_entity_slug ? { applied_entity_slug } : {}),
        note: note ?? null,
      });
      return r.ok ? ok(r.data) : err('marking the fix done', r.data);
    },
  });

  // ── D6. bastion_list_exceptions (rows 58, 59) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_list_exceptions',
    description:
      'Accepted risks (exceptions). Without exception_id: newest first, filtered by status (proposed, active, expired, rejected) or control (GET /exceptions). With exception_id: one exception (GET /exceptions/:id). Each shows the control and its owner, scope (one item for up to 365 days, or a whole check for up to 90 days covering only the items failing when it was approved), reason, compensating note, who proposed and who approved it ("approved by the proposer (small team)" when a team of fewer than three self-approved), expiry and days left. An active exception makes the control read "Not met, risk accepted"; it still counts under Not met, never as proof. asker_user_id is required: the covered item (cited_entity_type, cited_entity_id) and each frozen ref are shown only when both you and the person you are answering can open them; the rest are counted in hidden_citation_count. Read-only; both the caller and the asker need bastion.exception.read.',
    input: {
      asker_user_id: askerUserId,
      exception_id: z.string().uuid().optional(),
      ...bastionExceptionListQuerySchema.shape,
    },
    returns: z.record(z.unknown()),
    handler: async ({ exception_id, asker_user_id, ...q }) => {
      const r = exception_id ? await client.getException(exception_id, { asker_user_id }) : await client.listExceptions({ ...q, asker_user_id });
      return r.ok ? ok(r.data) : err(exception_id ? 'reading the exception' : 'listing exceptions', r.data);
    },
  });

  // ── D7. bastion_propose_exception (row 60) ─────────────────────────────────
  registerTool(server, {
    name: 'bastion_propose_exception',
    description:
      'Propose accepting a risk on a control (POST /exceptions). scope "entity" covers one cited item (cited_entity_type + cited_entity_id, for example the long-lived "Radio Relay" key) for up to 365 days; scope "assertion" covers one whole check (assertion_id) for up to 90 days and, once approved, only the items failing at that moment. expires_on is a date in the organization\'s time zone. A PERSON other than the proposer decides it inside Bastion (fewer than three people: the proposer may, labelled); there is no tool to decide it. 400 EXPIRY_TOO_LONG, CITATION_NOT_VISIBLE, NOT_A_CONTROL_CHECK. Needs bastion.exception.propose.',
    // The object inside the shared refine; the handler re-parses with the full schema for the
    // cross-field rule (an assertion-wide exception needs its check).
    input: { ...bastionExceptionProposeSchema.innerType().innerType().shape },
    returns: z.record(z.unknown()),
    handler: async (input) => {
      const parsed = bastionExceptionProposeSchema.safeParse(input);
      if (!parsed.success) return err('proposing the exception', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.proposeException(parsed.data);
      return r.ok ? ok(r.data) : err('proposing the exception', r.data);
    },
  });

  // ── D8. bastion_list_drift (row 62) ────────────────────────────────────────
  registerTool(server, {
    name: 'bastion_list_drift',
    description:
      'Controls that got worse (GET /drift), newest first: from and to state in plain words, why (the check failed, the accepted risk ran out, evidence expired, ...), what happened to the control\'s Bam task (created, reopened, no Compliance project), and whether someone acknowledged it. Filter by control or unacknowledged=true; page with before = next_cursor. Read-only; needs bastion.drift.read.',
    input: { ...bastionDriftListQuerySchema.shape },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.listDrift(q);
      return r.ok ? ok(r.data) : err('listing drift', r.data);
    },
  });

  // ── D9. bastion_acknowledge_drift (row 63) ─────────────────────────────────
  registerTool(server, {
    name: 'bastion_acknowledge_drift',
    description:
      'Acknowledge that a control got worse (POST /drift/:id/acknowledge), with an optional note. It does not change the control or its task; it records who has seen it. 409 DRIFT_ALREADY_ACKNOWLEDGED. Needs bastion.drift.acknowledge.',
    input: {
      drift_id: z.string().uuid(),
      note: bastionDriftAcknowledgeSchema.shape.note,
    },
    returns: z.record(z.unknown()),
    handler: async ({ drift_id, note }) => {
      const r = await client.acknowledgeDrift(drift_id, { note: note ?? null });
      return r.ok ? ok(r.data) : err('acknowledging the change', r.data);
    },
  });
}

/* ------------------------------------------------------------------ */
/*  M7: policies and attestation (spec 3.6; 5.1 rows 64-71)           */
/* ------------------------------------------------------------------ */

/**
 * Deliberately NO tool for row 70 (POST /policies/:id/attest, "I have read and understood
 * this"): category "auth: session required (spec 2.8, #136)". Only the person, signed in and not
 * impersonated, acknowledges a policy; an agent never can.
 */
export const BASTION_POLICY_TOOL_NAMES = [
  'bastion_attestation_status',
  'bastion_get_policy_body',
  'bastion_my_attestations',
  'bastion_create_policy',
  'bastion_update_policy',
  'bastion_request_attestations',
] as const;

export function registerBastionPolicyTools(server: McpServer, client: BastionClient, confirmTokenStore?: ConfirmTokenStore): void {
  // ── P1. bastion_attestation_status (rows 64, 68) ───────────────────────────
  registerTool(server, {
    name: 'bastion_attestation_status',
    description:
      'Policy acknowledgements. Without policy_id: every linked policy (GET /policies) with its Beacon article, audience, how often it must be re-read, owner, whether it is still shared with everyone, Beacon\'s expiry, and "X of Y have read the current version". With policy_id: who has read the current version and when, who has not, and who cannot even open the article in Beacon ("N people can\'t open this policy", from can_access per person) (GET /policies/:id/attestations). Read-only; needs bastion.policy.read or bastion.attestation.read.',
    input: {
      policy_id: z.string().uuid().optional(),
      status: z.enum(['active', 'retired', 'all']).optional().describe('List mode: default "active".'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ policy_id, status }) => {
      const r = policy_id ? await client.listPolicyAttestations(policy_id) : await client.listPolicies({ status });
      return r.ok ? ok(r.data) : err(policy_id ? 'reading who has read the policy' : 'listing policies', r.data);
    },
  });

  // ── P2. bastion_get_policy_body (row 67) ───────────────────────────────────
  registerTool(server, {
    name: 'bastion_get_policy_body',
    description:
      'The exact text of a policy\'s current version as Bastion serves it for acknowledgement (GET /policies/:id/body): title, Beacon version, the frozen body in Markdown, its SHA-256, Beacon\'s expiry, and whether the caller is asked to read it and is due. Refused with POLICY_NOT_SHARED when the article is no longer shared with everyone, and POLICY_NOT_READABLE when the caller cannot open it in Beacon. Reading it never acknowledges it: only the person can, signed in to Bastion. Read-only; needs bastion.attestation.read.',
    input: { policy_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ policy_id }) => {
      const r = await client.getPolicyBody(policy_id);
      return r.ok ? ok(r.data) : err('reading the policy', r.data);
    },
  });

  // ── P3. bastion_my_attestations (row 69) ───────────────────────────────────
  registerTool(server, {
    name: 'bastion_my_attestations',
    description:
      'The caller\'s own policies to read (GET /me/attestations): each policy they are asked to read, whether they are due ("Please read and acknowledge", "A new version or a new year: please read it again", "Read and acknowledged"), the version they last acknowledged and when it is next due. Read-only; needs bastion.attestation.read.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.myAttestations();
      return r.ok ? ok(r.data) : err('listing your policies', r.data);
    },
  });

  // ── P4. bastion_create_policy (row 65) ─────────────────────────────────────
  registerTool(server, {
    name: 'bastion_create_policy',
    description:
      'Link a Beacon article as a policy people must read and acknowledge (POST /policies). Name the article by beacon_entry_id, or by beacon_slug (the last part of its Beacon link, /beacon/<slug>). The article must be shared with everyone (Beacon visibility Organization or Public; else 409 POLICY_NOT_SHARED). audience is everyone (default) or a list of members; cadence_days is how often it must be re-read (default 365). With control_id, Bastion proposes that control\'s two policy checks (read and acknowledged; kept current) pinned to this policy, for a person to confirm. Without control_id, Bastion does the same for the one control whose policy checks are not yet pinned to an active policy (if there is exactly one). If the policy links but those checks cannot be pinned, the response still succeeds with pin_problem set and proposed_assertion_ids empty: the policy exists, so do not link it again. 409 POLICY_ALREADY_LINKED. Needs bastion.policy.write (owners and admins).',
    // Fields of the route itself (#239: beacon_entry_id, or the beacon_slug from an article link);
    // the handler re-parses with the full schema for "exactly one of the two".
    input: { ...bastionPolicyCreateFields.shape },
    returns: z.record(z.unknown()),
    handler: async (input) => {
      const parsed = bastionPolicyCreateSchema.safeParse(input);
      if (!parsed.success) return err('linking the policy', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.createPolicy(parsed.data);
      return r.ok ? ok(r.data) : err('linking the policy', r.data);
    },
  });

  // ── P5. bastion_update_policy (row 66) ─────────────────────────────────────
  registerTool(server, {
    name: 'bastion_update_policy',
    description:
      'Change a policy\'s audience, re-read cadence or owner, or retire it (status "retired") (PATCH /policies/:id). Retiring keeps every acknowledgement already recorded (they are immutable) but stops tracking who has read the policy, so a call with status "retired" is two-step: call once WITHOUT confirm_token to stage a token, then again with the same arguments and the returned confirm_token within 5 minutes. Other edits run in one call. Needs bastion.policy.write (owners and admins).',
    input: {
      policy_id: z.string().uuid(),
      audience: bastionPolicyAudienceSchema.optional(),
      cadence_days: z.number().int().min(1).max(1095).optional(),
      owner_user_id: z.string().uuid().nullable().optional(),
      status: z.enum(['active', 'retired']).optional(),
      confirm_token: confirmTokenInput,
    },
    returns: z.record(z.unknown()),
    handler: async ({ policy_id, confirm_token, ...rest }) => {
      const parsed = bastionPolicyUpdateSchema.safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
      if (!parsed.success) return err('changing the policy', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const run = async () => {
        const r = await client.updatePolicy(policy_id, parsed.data);
        return r.ok ? ok(r.data) : err('changing the policy', r.data);
      };
      if (parsed.data.status !== 'retired') return run();
      // Retiring a policy is a truth flip (#415): staged and confirmed, bound to exactly this change.
      return confirmGate(
        confirmTokenStore,
        {
          tool: 'bastion_update_policy',
          action: BASTION_CONFIRM_ACTIONS.retire_policy,
          resource: bastionConfirmResource(policy_id, parsed.data),
          label: 'changing the policy',
          what: 'Retiring a policy',
          noun: 'retirement',
          consequence: 'Retiring stops tracking who has read this policy; acknowledgements already recorded are kept.',
        },
        confirm_token,
        run,
      );
    },
  });

  // ── P6. bastion_request_attestations (row 71) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_request_attestations',
    description:
      'Ask the people still due on a policy to read it (POST /policies/:id/request-attestations): one attestation.overdue Bolt event per person, at most once per person, version and day (a repeat the same day nudges nobody). Optionally only the named members. It does not acknowledge anything. Needs bastion.attestation.request (owners and admins).',
    input: {
      policy_id: z.string().uuid(),
      user_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ policy_id, user_ids }) => {
      const r = await client.requestAttestations(policy_id, user_ids ? { user_ids } : {});
      return r.ok ? ok(r.data) : err('asking people to read the policy', r.data);
    },
  });
}

/**
 * M8 questionnaire and answer-library tools (spec 5.1 rows 72-83, 5.4 tools 17-20 and 22, plus
 * the #196 parity writes: create, mapping and details, item review, library edit).
 *
 * Deliberately NO tool for row 79 (POST /questionnaires/:id/approve): category "auth: session
 * required (spec 2.8, #136)". Approving releases answers to a customer; only a person signed in to
 * Bastion, not impersonated, may do it. None for row 80 (the answered file): multipart/binary.
 */
export const BASTION_QUESTIONNAIRE_TOOL_NAMES = [
  'bastion_list_questionnaires',
  'bastion_get_questionnaire',
  'bastion_create_questionnaire',
  'bastion_update_questionnaire',
  'bastion_questionnaire_autofill',
  'bastion_answer_questionnaire_item',
  'bastion_draft_answer',
  'bastion_search_answer_library',
  'bastion_update_answer_library',
] as const;

export function registerBastionQuestionnaireTools(server: McpServer, client: BastionClient): void {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  // Q1. bastion_list_questionnaires (row 72)
  registerTool(server, {
    name: 'bastion_list_questionnaires',
    description:
      'Security questionnaires in Bastion, newest first (GET /questionnaires): title, who asked, status (mapping, answering, in_review, approved, exported, failed), how many rows are drafted and how many are "Sure" (high), "Check this" (medium) and "Needs an expert" (low). Read-only; needs bastion.questionnaire.read (members and above).',
    input: {
      status: BastionQuestionnaireStatus.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      // #274: questionnaires carry customer names and deal links; the same rule as the evidence reads (#217).
      asker_user_id: askerUserId,
    },
    returns: z.record(z.unknown()),
    handler: async ({ status, limit, asker_user_id }) => {
      const r = await client.listQuestionnaires({ status, limit, asker_user_id });
      return r.ok ? ok(r.data) : err('listing questionnaires', r.data);
    },
  });

  // Q2. bastion_get_questionnaire (rows 74, 77)
  registerTool(server, {
    name: 'bastion_get_questionnaire',
    description:
      'One questionnaire (GET /questionnaires/:id) and, with include_items (default true), its answer grid (GET /questionnaires/:id/items): each question, the drafted answer and yes/no, the confidence band and why, the citations (controls and policies, re-checked with can_access for the caller and, with asker_user_id, for that person too), the review state, and what still blocks approval ("N Needs an expert answers still to review"). Read-only; needs bastion.questionnaire.read.',
    input: {
      questionnaire_id: z.string().uuid(),
      include_items: z.boolean().optional(),
      band: BastionConfidenceBand.optional(),
      needs_review: z.boolean().optional().describe('Only "Needs an expert" rows nobody reviewed yet.'),
      asker_user_id: askerUserId,
    },
    returns: z.record(z.unknown()),
    handler: async ({ questionnaire_id, include_items, band, needs_review, asker_user_id }) => {
      const head = await client.getQuestionnaire(questionnaire_id, { asker_user_id });
      if (!head.ok) return err('reading the questionnaire', head.data);
      if (include_items === false) return ok(head.data);
      const items = await client.listQuestionnaireItems(questionnaire_id, { band, needs_review, asker_user_id });
      if (!items.ok) return err('reading the answers', items.data);
      return ok({ questionnaire: head.data.data, items: items.data });
    },
  });

  // Q3. bastion_create_questionnaire (row 73, JSON intake)
  registerTool(server, {
    name: 'bastion_create_questionnaire',
    description:
      'Add a security questionnaire (POST /questionnaires) from a Bin file (xlsx or csv; give bin_asset_id, the file must already be in Bin and virus-scanned) or from pasted rows (pasted_text; tab-separated as copied from a spreadsheet, or csv). Bastion guesses which column holds the questions; check it with bastion_get_questionnaire and fix it with bastion_update_questionnaire before drafting. Optionally link a Bond deal. 409 FILE_NOT_SCANNED_YET, 400 QUESTIONNAIRE_TOO_LARGE (over the per-questionnaire row limit). Needs bastion.questionnaire.write.',
    input: {
      title: z.string().min(1).max(512),
      bin_asset_id: z.string().uuid().optional(),
      pasted_text: z.string().min(1).max(500_000).optional(),
      pasted_format: z.enum(['tsv', 'csv']).optional(),
      requester_label: z.string().max(256).optional(),
      bond_deal_id: z.string().uuid().optional(),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      owner_user_id: z.string().uuid().optional(),
      column_map: bastionQuestionnaireColumnMapSchema.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ bin_asset_id, pasted_text, pasted_format, ...rest }) => {
      if (!bin_asset_id === !pasted_text) return err('adding the questionnaire', { code: 'VALIDATION_ERROR', message: 'Give exactly one of bin_asset_id or pasted_text.' });
      const source = bin_asset_id ? { kind: 'bin_asset' as const, bin_asset_id } : { kind: 'pasted' as const, text: pasted_text as string, format: pasted_format ?? 'tsv' };
      const parsed = bastionQuestionnaireCreateSchema.safeParse(strip({ ...rest, source }));
      if (!parsed.success) return err('adding the questionnaire', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.createQuestionnaire(parsed.data);
      return r.ok ? ok(r.data) : err('adding the questionnaire', r.data);
    },
  });

  // Q4. bastion_update_questionnaire (row 75)
  registerTool(server, {
    name: 'bastion_update_questionnaire',
    description:
      'Change a questionnaire\'s title, requester, due date, owner or Bond deal, or its column mapping (PATCH /questionnaires/:id). The mapping can only change before answers are drafted (409 MAPPING_LOCKED); changing it rebuilds the question list. Needs bastion.questionnaire.write.',
    input: {
      questionnaire_id: z.string().uuid(),
      title: z.string().min(1).max(512).optional(),
      requester_label: z.string().max(256).nullable().optional(),
      due_date: z.string().nullable().optional(),
      owner_user_id: z.string().uuid().nullable().optional(),
      bond_deal_id: z.string().uuid().nullable().optional(),
      column_map: bastionQuestionnaireColumnMapSchema.optional(),
      drop_unmapped_sheets: z
        .boolean()
        .optional()
        .describe('A column_map must list every sheet that holds questions (409 SHEETS_DROPPED); true confirms dropping the questions on the sheets it leaves out.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ questionnaire_id, ...rest }) => {
      const parsed = bastionQuestionnaireUpdateSchema.safeParse(strip(rest));
      if (!parsed.success) return err('changing the questionnaire', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.updateQuestionnaire(questionnaire_id, parsed.data);
      return r.ok ? ok(r.data) : err('changing the questionnaire', r.data);
    },
  });

  // Q5. bastion_questionnaire_autofill (row 76)
  registerTool(server, {
    name: 'bastion_questionnaire_autofill',
    description:
      'Ask Bastion to draft every answer (POST /questionnaires/:id/autofill, 202). The worker drafts in the background from the organization\'s own controls, checks, policies and approved answers (about 10-20 s a question; a 96-row questionnaire takes roughly 16-32 minutes); poll bastion_get_questionnaire. A failing or unprovable control makes an answer "Needs an expert" with "We cannot currently prove this"; an accepted exception caps it at "Check this" and is named. redraft true drafts again every row nobody reviewed. Drafting never approves anything. Needs bastion.questionnaire.write.',
    input: {
      questionnaire_id: z.string().uuid(),
      redraft: z.boolean().optional(),
      use_ai: z.boolean().optional().describe('false drafts without the AI: approved library answers (with the hard rules) or left for a person.'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ questionnaire_id, redraft, use_ai }) => {
      const r = await client.autofillQuestionnaire(questionnaire_id, { redraft: redraft ?? false, use_ai: use_ai ?? true });
      return r.ok ? ok(r.data) : err('starting the drafting', r.data);
    },
  });

  // Q6. bastion_answer_questionnaire_item (row 78). Named for what it records (the answer a person
  // settles on), and kept apart from the evidence-review vouching act, which has no tool.
  registerTool(server, {
    name: 'bastion_answer_questionnaire_item',
    description:
      'Review one drafted answer (PATCH /questionnaire-items/:id): accepted (take the draft), edited (give final_answer and/or final_yes_no), needs_owner (assigned_to: the member who should answer it) or pending (undo). Reviewing is not approving: approval is a person\'s act in Bastion. Needs bastion.questionnaire.write.',
    input: {
      item_id: z.string().uuid(),
      review_status: z.enum(['accepted', 'edited', 'needs_owner', 'pending']),
      final_answer: z.string().max(8000).nullable().optional(),
      final_yes_no: z.boolean().nullable().optional(),
      assigned_to: z.string().uuid().nullable().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ item_id, ...rest }) => {
      const parsed = bastionQuestionnaireItemReviewSchema.safeParse(strip(rest));
      if (!parsed.success) return err('reviewing the answer', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.reviewQuestionnaireItem(item_id, parsed.data);
      return r.ok ? ok(r.data) : err('reviewing the answer', r.data);
    },
  });

  // Q7. bastion_draft_answer (row 81)
  registerTool(server, {
    name: 'bastion_draft_answer',
    description:
      'Draft one answer now, nothing saved (POST /answers/draft): the drafted answer and yes/no, the confidence band ("Sure", "Check this", "Needs an expert") with the reasons, and the citations that passed can_access for the caller. Same hard rules as the autofill. Needs bastion.questionnaire.write.',
    input: {
      question: z.string().min(3).max(4000),
      answer_kind: BastionAnswerKind.optional(),
      asker_user_id: askerUserId,
    },
    returns: z.record(z.unknown()),
    handler: async ({ question, answer_kind, asker_user_id }) => {
      const parsed = bastionDraftAnswerSchema.safeParse(strip({ question, answer_kind }));
      if (!parsed.success) return err('drafting the answer', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.draftAnswer(parsed.data, { asker_user_id });
      return r.ok ? ok(r.data) : err('drafting the answer', r.data);
    },
  });

  // Q8. bastion_search_answer_library (row 82)
  registerTool(server, {
    name: 'bastion_search_answer_library',
    description:
      'Search the approved answers (GET /answer-library): full-text over question and answer, best first, with who approved each and its citations (re-checked with can_access, and for asker_user_id too). An answer is marked stale when a control it relies on changed its status since approval; include_stale false hides those, include_retired true shows retired ones. Read-only; needs bastion.answer_library.read.',
    input: {
      q: z.string().max(500).optional(),
      include_stale: z.boolean().optional(),
      include_retired: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      asker_user_id: askerUserId,
    },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.searchAnswerLibrary(q);
      return r.ok ? ok(r.data) : err('searching the answer library', r.data);
    },
  });

  // Q9. bastion_update_answer_library (row 83)
  registerTool(server, {
    name: 'bastion_update_answer_library',
    description:
      'Curate one approved answer (PATCH /answer-library/:id): reword it, change its yes/no, mark it checked after its control changed (stale false), or retire it (retired true; false brings it back). Needs bastion.answer_library.write (owners and admins).',
    input: {
      answer_id: z.string().uuid(),
      answer_text: z.string().min(1).max(8000).optional(),
      yes_no: z.boolean().nullable().optional(),
      stale: z.literal(false).optional(),
      retired: z.boolean().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ answer_id, ...rest }) => {
      const parsed = bastionAnswerLibraryUpdateSchema.safeParse(strip(rest));
      if (!parsed.success) return err('changing the answer', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.updateAnswerLibrary(answer_id, parsed.data);
      return r.ok ? ok(r.data) : err('changing the answer', r.data);
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * M9 sharing, settings and audit-log tools (spec 5.1 rows 84-100, plus the room Preview).
 *
 * Deliberately NO tool for rows 85-87 (create, revoke and unlock an auditor room): category "auth:
 * session required (spec 2.8, #136)". Opening a room discloses evidence to an outsider; only a
 * person signed in to Bastion, not impersonated, may do it. None for row 93 (the packet zip,
 * multipart/binary) or rows 101-104 (the public room, public-inbound, its own token credential).
 * Rows 84, 88 and 89 are bastion_list_auditor_rooms and bastion_list_auditor_requests (above).
 * ════════════════════════════════════════════════════════════════════════════ */
export const BASTION_SHARING_TOOL_NAMES = [
  'bastion_auditor_room_view',
  'bastion_respond_auditor_request',
  'bastion_create_export',
  'bastion_list_exports',
  'bastion_dismiss_export',
  'bastion_get_settings',
  'bastion_update_settings',
  'bastion_list_delivery_problems',
  'bastion_retry_delivery',
  'bastion_audit_log',
] as const;

export function registerBastionSharingTools(server: McpServer, client: BastionClient): void {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  // S1. bastion_auditor_room_view (GET /auditor-rooms/:id/preview)
  registerTool(server, {
    name: 'bastion_auditor_room_view',
    description:
      'Exactly what an auditor sees in one auditor room (GET /auditor-rooms/:id/preview), without logging a visit: the controls in the room with their state words (Met, Not met, Not met risk accepted, Can\'t prove yet, Not assessed), the restricted items the room shares, accepted risks, the Statement of Applicability for ISO, the signed seal history with public keys, and any restore or missing-file notices. Read-only; floored: needs bastion.auditor_room.read.',
    input: { room_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ room_id }) => {
      const r = await client.previewAuditorRoom(room_id);
      return r.ok ? ok(r.data) : err('previewing the auditor room', r.data);
    },
  });

  // S2. bastion_respond_auditor_request (row 90)
  registerTool(server, {
    name: 'bastion_respond_auditor_request',
    description:
      'Answer or close a question an auditor sent from an auditor room (PATCH /auditor-requests/:id). status "answered" needs answer_note (the reply the team keeps); "closed" just closes it. 409 REQUEST_CLOSED if it was closed already. Needs bastion.auditor_room.respond (owners and admins).',
    input: {
      request_id: z.string().uuid(),
      status: z.enum(['answered', 'closed']),
      answer_note: z.string().min(1).max(5000).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ request_id, ...rest }) => {
      const parsed = bastionAuditorRequestUpdateSchema.safeParse(strip(rest));
      if (!parsed.success) return err('answering the question', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.respondAuditorRequest(request_id, parsed.data);
      return r.ok ? ok(r.data) : err('answering the question', r.data);
    },
  });

  // S3. bastion_create_export (row 91: a JSON request; the worker builds the zip)
  registerTool(server, {
    name: 'bastion_create_export',
    description:
      'Start building an audit packet (POST /exports, 202): a zip of the framework\'s controls and state words, the evidence and uploaded files in the period (at most 400 days), attestations, exceptions, drift, the Statement of Applicability for ISO, a summary PDF and a manifest with every signed seal and public key. include_restricted needs bastion.evidence.read_restricted (403 RESTRICTED_NOT_ALLOWED). An ISO packet is refused until every Annex A requirement has an applicability decision (409 SOA_INCOMPLETE). Follow progress with bastion_list_exports; a person downloads the zip in Bastion. Needs bastion.export.create.',
    input: {
      framework_id: z.string().uuid(),
      period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      include_restricted: z.boolean().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (args) => {
      const parsed = bastionExportCreateSchema.safeParse(strip(args));
      if (!parsed.success) return err('starting the packet', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.createExport(parsed.data);
      return r.ok ? ok(r.data) : err('starting the packet', r.data);
    },
  });

  // S4. bastion_list_exports (row 92)
  registerTool(server, {
    name: 'bastion_list_exports',
    description:
      'Audit packets, newest first (GET /exports): framework, period, whether restricted evidence is included, status (queued, running, succeeded, failed, expired), the current stage in words ("Writing evidence", "Zipping", "Ready to download") and any failure reason. Failed packets someone dismissed are left out unless include_dismissed is true (each row carries dismissed_at). Read-only; floored: needs bastion.export.read.',
    input: {
      status: BastionExportStatus.optional(),
      include_dismissed: z.boolean().optional().describe('Also list failed packets that were dismissed.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.listExports(strip(q));
      return r.ok ? ok(r.data) : err('listing audit packets', r.data);
    },
  });

  // S4b. bastion_dismiss_export (#402)
  registerTool(server, {
    name: 'bastion_dismiss_export',
    description:
      'Dismiss an audit packet that could not be built (POST /exports/:id/dismiss): it drops out of the default packet list. A soft hide, audited as export.dismiss: the packet row is kept and bastion_list_exports with include_dismissed still shows it. Only a failed packet can be dismissed; a built (succeeded) packet or one still queued or running answers 409 PACKET_NOT_FAILED. Dismissing again is a no-op. Needs bastion.export.create.',
    input: { export_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ export_id }) => {
      const r = await client.dismissExport(export_id);
      return r.ok ? ok(r.data) : err('dismissing the audit packet', r.data);
    },
  });

  // S5. bastion_get_settings (row 96)
  registerTool(server, {
    name: 'bastion_get_settings',
    description:
      "Bastion's settings for the organization (GET /settings): remediation mode, check time and timezone, AI provider and the providers available, expiry warnings, staleness, auditor-link and packet limits, questionnaire floors and limits; plus evidence integrity (seal and personal-data key fingerprints, restores awaiting an owner's acknowledgement), the off-site evidence backup status and how many deliveries failed. Read-only; needs bastion.settings.read.",
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.getSettings();
      return r.ok ? ok(r.data) : err('reading settings', r.data);
    },
  });

  // S6. bastion_update_settings (row 97)
  registerTool(server, {
    name: 'bastion_update_settings',
    description:
      'Change Bastion settings (PATCH /settings); send only the fields to change. Each change is audited with its old and new value. 400 BAD_TIMEZONE for an unknown zone, FLOORS_OUT_OF_ORDER when the "Check this" floor is not below the "Sure" floor; 404 for an AI provider the organization cannot use. Needs bastion.settings.write (owners and admins).',
    input: { settings: bastionSettingsUpdateFields },
    returns: z.record(z.unknown()),
    handler: async ({ settings }) => {
      const parsed = bastionSettingsUpdateSchema.safeParse(strip(settings as Record<string, unknown>));
      if (!parsed.success) return err('changing settings', { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message });
      const r = await client.updateSettings(parsed.data);
      return r.ok ? ok(r.data) : err('changing settings', r.data);
    },
  });

  // S7. bastion_list_delivery_problems (row 98)
  registerTool(server, {
    name: 'bastion_list_delivery_problems',
    description:
      'Updates Bastion could not deliver to other apps after every retry (GET /delivery-problems): what it was (a Bolt event, a Compliance task, a comment, a seal copy), how many attempts, when, and the last error. Retry one with bastion_retry_delivery. Needs bastion.settings.write (owners and admins).',
    input: { limit: z.number().int().min(1).max(200).optional() },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.listDeliveryProblems(strip(q));
      return r.ok ? ok(r.data) : err('listing delivery problems', r.data);
    },
  });

  // S8. bastion_retry_delivery (row 99)
  registerTool(server, {
    name: 'bastion_retry_delivery',
    description:
      'Try one failed delivery again (POST /delivery-problems/:id/retry). If a newer update of the same kind for the same thing was already delivered, the old one is marked no longer needed (result "superseded") instead of being replayed. 409 NOT_DEAD when it is not a failed delivery. Needs bastion.settings.write.',
    input: { delivery_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ delivery_id }) => {
      const r = await client.retryDelivery(delivery_id);
      return r.ok ? ok(r.data) : err('retrying the delivery', r.data);
    },
  });

  // S9. bastion_audit_log (row 100)
  registerTool(server, {
    name: 'bastion_audit_log',
    description:
      "Bastion's audit log, newest first (GET /audit): every change made in Bastion with who did it (person or agent), whether they were impersonated, how they signed in, and the details. Filter by action (e.g. auditor_room.create, settings.update) or subject_type; page with cursor. Read-only; floored: needs bastion.audit.read.",
    input: {
      action: z.string().min(1).max(64).optional(),
      subject_type: z.string().min(1).max(48).optional(),
      cursor: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (q) => {
      const r = await client.auditLog(strip(q));
      return r.ok ? ok(r.data) : err('reading the audit log', r.data);
    },
  });
}
