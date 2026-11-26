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
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';
import { createBastionClient, type BastionClient, type BastionFetch } from '../clients/bastion-client.js';
import type { ConfirmTokenStore } from '../lib/confirm-token-store.js';
// #196 parity tools (registerBastionAdminTools at the bottom of this file).
import { randomBytes } from 'node:crypto';
// M5 evidence, feeds and coverage tools (registerBastionEvidenceTools at the very bottom).
import {
  bastionFeedCreateSchema,
  bastionFeedRecordListQuerySchema,
  bastionFeedUpdateSchema,
  bastionManualEvidenceListQuerySchema,
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
 * Bastion MCP tool handlers, PENDING registration (spec 5.4).
 *
 * This file deliberately lives outside src/tools/ and is not named *-tools.ts, and server.ts does
 * not import it: scripts/check-tool-return-coverage.mjs and the docs catalog
 * (scripts/docs/lib/tool-source.mjs listAllToolModules) both read the tools directory, so Bastion's
 * tools stay out of the published counts until the M11 merge unit moves this file to
 * src/tools/bastion-tools.ts and registers it with the Launchpad row. Each milestone adds the
 * handlers for the routes it ships, typed off the shared Zod in @bigbluebam/shared, with tests.
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
 * registerBastionAdminTools below; archive is two-step through a confirm token.
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
  registerBastionEvidenceTools(server, client);

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
        return ok({ framework: (f.data as { data?: unknown }).data ?? f.data, requirements: reqs.data });
      }
      const [list, templates] = await Promise.all([client.listFrameworks(include_archived), client.listTemplates()]);
      if (!list.ok) return err('listing frameworks', list.data);
      if (!templates.ok) return err('listing framework templates', templates.data);
      return ok({
        frameworks: (list.data as { data?: unknown }).data ?? [],
        templates: (templates.data as { data?: unknown }).data ?? [],
      });
    },
  });

  // ── 2. bastion_compile_framework (rows 9, 10) ──────────────────────────────
  registerTool(server, {
    name: 'bastion_compile_framework',
    description:
      'Propose checks for a framework\'s controls (POST /frameworks/:id/compile, 202 with the run), or list its past runs with action="list_runs" (GET /frameworks/:id/compile-runs, newest first; pass next_cursor back as cursor while has_more is true). The compile only PROPOSES: every check lands as proposed and a person must confirm it in Bastion (including "This is the complete list" for any list of systems). Re-running proposes nothing a control already has. A run already going returns 409 COMPILE_RUNNING.',
    input: {
      framework_id: z.string().uuid(),
      action: z.enum(['start', 'list_runs']).optional().describe('Default "start".'),
      cursor: z.string().max(200).optional().describe('list_runs: next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(200).optional().describe('list_runs: page size (default 50).'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, action, cursor, limit }) => {
      if (action === 'list_runs') {
        const r =
          cursor || limit
            ? await client.listCompileRunsPage(framework_id, { cursor, limit })
            : await client.listCompileRuns(framework_id);
        return r.ok ? ok(r.data) : err('listing compile runs', r.data);
      }
      const r = await client.compileFramework(framework_id);
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
      'One control: its stored status and reason, setup state, derived applicability, every framework requirement it satisfies, and its checks (assertions) with their review state and, for population checks, the listed systems and whether a person confirmed the list (GET /controls/:id). Read-only.',
    input: { control_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ control_id }) => {
      const r = await client.getControl(control_id);
      return r.ok ? ok(r.data) : err('reading control', r.data);
    },
  });

  // ── 5. bastion_propose_assertion (rows 17, 20) ─────────────────────────────
  registerTool(server, {
    name: 'bastion_propose_assertion',
    description:
      'Propose a new check for a control (control_id + proposal: POST /controls/:id/assertions) or a revision of an existing one (revise_assertion_id + revision: POST /assertions/:id/revise, which files a superseding proposed check). Probe checks use the closed probe menu (see bastion_list_probes); parameters outside the probe\'s range are refused. Everything lands as proposed; only a signed-in person can confirm it in Bastion. Give exactly one of control_id or revise_assertion_id.',
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
      'The evidence recorded for one control, newest first (GET /controls/:id/evidence): each snapshot\'s outcome (pass, fail, unprovable with a reason), the check that produced it, its window, counts, its hash and ledger position, and a plain explanation. Names and cited records are shown only to owners, admins and the control\'s owner; everyone else gets counts. Optional assertion_id narrows to one check. Pass next_cursor back as cursor while has_more is true. Read-only.',
    input: {
      control_id: z.string().uuid(),
      assertion_id: z.string().uuid().optional(),
      cursor: z.string().max(200).optional().describe('next_cursor from the previous page.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ control_id, assertion_id, cursor, limit }) => {
      const r = await client.listControlEvidence(control_id, { assertion_id, cursor, limit });
      return r.ok ? ok(r.data) : err('listing evidence', r.data);
    },
  });

  // ── 11. bastion_get_evidence (row 26) ──────────────────────────────────────
  registerTool(server, {
    name: 'bastion_get_evidence',
    description:
      'One evidence snapshot by id (GET /evidence/:id), with the same counts-only rule as bastion_evidence_for. Read-only.',
    input: { evidence_id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ evidence_id }) => {
      const r = await client.getEvidence(evidence_id);
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
    handler: async ({ framework_id, confirm_token }) => {
      if (!confirmTokenStore) {
        return err('archiving framework', {
          code: 'CONFIRMATION_UNAVAILABLE',
          message: 'Archiving needs a confirmation step, which is not available on this server.',
        });
      }
      if (!confirm_token) {
        const token = randomBytes(16).toString('hex');
        await confirmTokenStore.set(token, {
          action: BASTION_ARCHIVE_FRAMEWORK_ACTION,
          resource_id: framework_id,
          ttlMs: BASTION_CONFIRM_TTL_MS,
        });
        return ok({
          status: 'pending_confirmation',
          message: `Archiving retires every control that only this framework needs. Re-call bastion_archive_framework with this confirm_token to proceed. Token expires in ${Math.floor(
            BASTION_CONFIRM_TTL_MS / 1000,
          )} seconds.`,
          action: BASTION_ARCHIVE_FRAMEWORK_ACTION,
          resource_id: framework_id,
          confirm_token: token,
        });
      }
      const pending = await confirmTokenStore.get(confirm_token);
      if (!pending || pending.action !== BASTION_ARCHIVE_FRAMEWORK_ACTION || pending.resource_id !== framework_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid or expired confirm_token for this archive. Re-call bastion_archive_framework without a token to stage a new one.',
            },
          ],
          isError: true as const,
        };
      }
      await confirmTokenStore.delete(confirm_token);
      const r = await client.archiveFramework(framework_id);
      return r.ok ? ok(r.data) : err('archiving framework', r.data);
    },
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
      'Record Statement of Applicability decisions. framework_id + decisions: decide several requirements by reference code at once, every control link of each code (POST /frameworks/:id/applicability). requirement_link_id + decision: decide one control-requirement link (PATCH /control-requirements/:id). "not_applicable" needs a plain reason. The decision is audited with who made it. Needs bastion.control.write.',
    input: {
      framework_id: z.string().uuid().optional(),
      decisions: bastionBulkApplicabilitySchema.shape.decisions.optional(),
      requirement_link_id: z.string().uuid().optional(),
      decision: bastionRequirementApplicabilitySchema.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, decisions, requirement_link_id, decision }) => {
      if (framework_id && decisions && !requirement_link_id && !decision) {
        const r = await client.decideApplicability(framework_id, { decisions });
        return r.ok ? ok(r.data) : err('deciding applicability', r.data);
      }
      if (requirement_link_id && decision && !framework_id && !decisions) {
        const r = await client.updateRequirementLink(requirement_link_id, decision);
        return r.ok ? ok(r.data) : err('deciding applicability', r.data);
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

export function registerBastionEvidenceTools(server: McpServer, client: BastionClient): void {
  // ── E1. bastion_list_manual_evidence (rows 33, 34) ─────────────────────────
  registerTool(server, {
    name: 'bastion_list_manual_evidence',
    description:
      'Uploaded evidence and written statements (the Evidence locker). Without manual_evidence_id: a list, newest first, filtered by status (pending_scan, active, superseded, withdrawn, blocked), kind (file or attestation_statement), a check (assertion_id), a control (control_id), or stuck=true for uploads waiting more than a day for a virus scan, plus counts (GET /manual-evidence). With manual_evidence_id: one item with its linked checks and their review state (GET /manual-evidence/:id). Each item shows its owner, who uploaded it, its period, when it expires (days_left), and whether it was virus-scanned. Restricted items are masked, or not found, unless both the caller and the asker may read restricted evidence. Read-only.',
    input: {
      asker_user_id: askerUserId,
      manual_evidence_id: z.string().uuid().optional(),
      // The route's own filters (#215): the tool and GET /manual-evidence validate alike.
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
      'Remove the link between uploaded evidence and a check (DELETE /manual-evidence/:id/links/:assertion_id). If the link had been reviewed, the control is checked again so its status reflects the change. Needs bastion.evidence.link.',
    input: {
      manual_evidence_id: z.string().uuid(),
      assertion_id: z.string().uuid(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ manual_evidence_id, assertion_id }) => {
      const r = await client.unlinkManualEvidence(manual_evidence_id, assertion_id);
      return r.ok ? ok(r.data) : err('unlinking evidence', r.data);
    },
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
      // The route's own paging (#215).
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
