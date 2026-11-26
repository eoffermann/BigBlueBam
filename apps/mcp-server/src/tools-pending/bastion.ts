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
import { createBastionClient, type BastionFetch } from '../clients/bastion-client.js';

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
 *
 * Agent policy: every tool goes through registerTool, so the section 15 kill switch and the
 * `bastion.*` allowlist apply; bastion_* tools fail closed until an operator allowlists them.
 *
 * Deliberately NO tool (spec 2.8 and the M3 parity reconciliation in the build log): adopting,
 * editing or archiving a framework and the setup wizard writes (human setup acts), applicability
 * decisions (the Statement of Applicability is a human statement), confirming or rejecting a check
 * (vouching: bastion-api requires a cookie session, so an API key could not do it anyway), and the
 * Statement of Applicability CSV (binary download). Do not "complete the surface" by adding them.
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
): void {
  const client = createBastionClient(bastionApiUrl, api, fetchImpl);

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
      'Propose checks for a framework\'s controls (POST /frameworks/:id/compile, 202 with the run), or list its past runs with action="list_runs" (GET /frameworks/:id/compile-runs). The compile only PROPOSES: every check lands as proposed and a person must confirm it in Bastion (including "This is the complete list" for any list of systems). Re-running proposes nothing a control already has. A run already going returns 409 COMPILE_RUNNING.',
    input: {
      framework_id: z.string().uuid(),
      action: z.enum(['start', 'list_runs']).optional().describe('Default "start".'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ framework_id, action }) => {
      if (action === 'list_runs') {
        const r = await client.listCompileRuns(framework_id);
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
      'Evaluation runs, newest first (GET /evaluations, optional status filter and limit), or one run with run_id (GET /evaluations/:id): trigger (nightly, manual, agent), scope, status (queued, running, succeeded, partial with a reason such as restore_pending, failed), and the counts checked so far. Read-only.',
    input: {
      run_id: z.string().uuid().optional(),
      status: bastionEvaluationListQuerySchema.shape.status,
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ run_id, status, limit }) => {
      const r = run_id ? await client.getEvaluation(run_id) : await client.listEvaluations({ status, limit });
      return r.ok ? ok(r.data) : err(run_id ? 'reading evaluation' : 'listing evaluations', r.data);
    },
  });

  // ── 10. bastion_evidence_for (row 25) ──────────────────────────────────────
  registerTool(server, {
    name: 'bastion_evidence_for',
    description:
      'The evidence recorded for one control, newest first (GET /controls/:id/evidence): each snapshot\'s outcome (pass, fail, unprovable with a reason), the check that produced it, its window, counts, its hash and ledger position, and a plain explanation. Names and cited records are shown only to owners, admins and the control\'s owner; everyone else gets counts. Optional assertion_id narrows to one check. Read-only.',
    input: {
      control_id: z.string().uuid(),
      assertion_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ control_id, assertion_id, limit }) => {
      const r = await client.listControlEvidence(control_id, { assertion_id, limit });
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
      'The signed daily seals of the evidence ledger (GET /ledger/seals): seal date, epoch, head position and hash, Ed25519 signature, signing key id, and when the seal object reached storage and was published; plus every signing key (current and retired) with its public key so anyone can check old seals. Read-only.',
    input: { limit: z.number().int().min(1).max(400).optional() },
    returns: z.record(z.unknown()),
    handler: async ({ limit }) => {
      const r = await client.listSeals(limit);
      return r.ok ? ok(r.data) : err('listing seals', r.data);
    },
  });

  // ── 14. bastion_list_restores (row 30; M3 parity reconciliation) ───────────
  registerTool(server, {
    name: 'bastion_list_restores',
    description:
      'Gaps in the evidence ledger found after a database restore (GET /ledger/restores): each lost range as "History lost by restore, epoch E seq X-Y" or "Unexplained gap, epoch E seq X-Y", whether recording is paused until an owner resolves it, and the ranges recorded in storage that the database no longer holds. Read-only; resolving a gap is a signed-in owner\'s act in Bastion and has no tool.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.listRestores();
      return r.ok ? ok(r.data) : err('listing restores', r.data);
    },
  });
}
