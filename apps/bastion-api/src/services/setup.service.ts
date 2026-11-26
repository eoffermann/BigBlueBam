// Setup wizard state (spec 6.1 /bastion/setup): frameworks, the ten-question company profile,
// the required Compliance project (spec 2.5), compile runs, proposed checks waiting for review
// (with the populations that need "This is the complete list"), and ISO applicability.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  BASTION_COMPANY_PROFILE_QUESTION_COUNT,
  type BastionCompanyProfile,
  type BastionSetupComplianceProject,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bastionAssertions, bastionCompileRuns, bastionControls, bastionOrgSettings } from '../db/schema/index.js';
import { NotFoundError, one, ValidationFailure } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { frameworkTemplate } from '../library/index.js';
import { connectedPopulations, ensureSettings, liveFrameworks } from './shared.js';
import { getFramework } from './frameworks.service.js';
import { assertionView } from './controls.service.js';
import type { Viewer } from './types.js';

async function projectInOrg(tx: DbTx, orgId: string, projectId: string) {
  const rows = (await tx.execute(sql`
    SELECT id, name, is_archived FROM projects WHERE id = ${projectId} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as Array<{ id: string; name: string; is_archived: boolean }>;
  return rows[0] ?? null;
}

/**
 * The project, if the viewer may use it in Bam (issue #191): in the org AND the viewer has a
 * project_memberships row, the rule Bam's requireProjectAccess applies to every non-SuperUser
 * (org owners and admins included). SuperUsers bypass membership, as in Bam. Anything else is
 * null, so "not a member" and "no such project" look the same to the caller.
 */
export async function projectVisibleTo(tx: DbTx, viewer: Viewer, projectId: string) {
  const rows = (await tx.execute(sql`
    SELECT p.id, p.name, p.is_archived
      FROM projects p
     WHERE p.id = ${projectId}
       AND p.org_id = ${viewer.org_id}
       AND (
         ${viewer.is_superuser}::boolean
         OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = ${viewer.id})
       )
     LIMIT 1
  `)) as unknown as Array<{ id: string; name: string; is_archived: boolean }>;
  return rows[0] ?? null;
}

function answeredCount(profile: unknown): number {
  return Object.values((profile ?? {}) as Record<string, unknown>).filter((v) => v !== undefined && v !== null).length;
}

export async function getSetup(viewer: Viewer) {
  const base = await runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await ensureSettings(tx, viewer.org_id);
    const frameworks = await liveFrameworks(tx, viewer.org_id);
    const project = settings.compliance_project_id
      ? await projectInOrg(tx, viewer.org_id, settings.compliance_project_id)
      : null;
    const runs = frameworks.length
      ? await tx
          .select()
          .from(bastionCompileRuns)
          .where(
            and(
              eq(bastionCompileRuns.organization_id, viewer.org_id),
              inArray(
                bastionCompileRuns.framework_id,
                frameworks.map((f) => f.id),
              ),
            ),
          )
          .orderBy(desc(bastionCompileRuns.created_at))
      : [];
    const proposed = await tx
      .select({ assertion: bastionAssertions, control_title: bastionControls.title, control_lifecycle: bastionControls.lifecycle })
      .from(bastionAssertions)
      .innerJoin(bastionControls, eq(bastionControls.id, bastionAssertions.control_id))
      .where(and(eq(bastionAssertions.organization_id, viewer.org_id), eq(bastionAssertions.review_status, 'proposed')))
      .orderBy(bastionControls.title, bastionAssertions.created_at);
    // The connected sets, so the wizard can offer people (by name) the apps and repositories a
    // population check may list (issue #195).
    const connected = await connectedPopulations(tx, viewer.org_id);
    return {
      settings,
      frameworks,
      project,
      runs,
      connected,
      proposed: proposed.filter((p) => p.control_lifecycle === 'active'),
    };
  });

  const frameworkViews = [];
  for (const f of base.frameworks) frameworkViews.push((await getFramework(viewer, f.id)).data);

  const latestRun = (frameworkId: string) => base.runs.find((r) => r.framework_id === frameworkId) ?? null;
  const reviews = base.proposed.map((p) => ({ ...assertionView(p.assertion), control_title: p.control_title }));
  const populationsPending = reviews.filter((r) => r.population !== null);
  const isoFrameworks = frameworkViews.filter((f) => f.is_iso);
  const answered = answeredCount(base.settings.company_profile);

  const steps = {
    frameworks: { done: base.frameworks.length > 0 },
    profile: { done: answered >= BASTION_COMPANY_PROFILE_QUESTION_COUNT, answered, total: BASTION_COMPANY_PROFILE_QUESTION_COUNT },
    compliance_project: { done: Boolean(base.project && !base.project.is_archived) },
    compile: {
      done: base.frameworks.length > 0 && base.frameworks.every((f) => latestRun(f.id)?.status === 'succeeded'),
    },
    review: { done: base.frameworks.length > 0 && reviews.length === 0, waiting: reviews.length, populations_waiting: populationsPending.length },
    applicability: {
      done: isoFrameworks.every((f) => f.statement_of_applicability?.complete === true),
      frameworks: isoFrameworks.map((f) => ({
        framework_id: f.id,
        name: f.name,
        decided: f.statement_of_applicability?.decided_count ?? 0,
        total: f.statement_of_applicability?.requirement_count ?? 0,
      })),
    },
  };

  return {
    data: {
      frameworks: frameworkViews.map((f) => ({
        ...f,
        latest_compile_run: latestRun(f.id),
        template_name: frameworkTemplate(f.template_key)?.name ?? f.name,
      })),
      company_profile: base.settings.company_profile,
      compliance_project: base.project ? { id: base.project.id, name: base.project.name, archived: base.project.is_archived } : null,
      remediation_tasks: base.settings.remediation_tasks,
      proposed_checks: reviews,
      connected_populations: base.connected,
      steps,
      // Required to finish setup: a framework, a Compliance project, a finished compile, and (for
      // ISO) every Annex A requirement decided. Reviewing every proposed check is not required:
      // anything left is counted under "Not set up yet".
      complete: steps.frameworks.done && steps.compliance_project.done && steps.compile.done && steps.applicability.done,
    },
  };
}

export async function saveCompanyProfile(viewer: Viewer, profile: BastionCompanyProfile) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await ensureSettings(tx, viewer.org_id);
    const merged = { ...((settings.company_profile ?? {}) as Record<string, unknown>), ...profile };
    const row = one(await tx
      .update(bastionOrgSettings)
      .set({ company_profile: merged, updated_by: viewer.id })
      .where(eq(bastionOrgSettings.organization_id, viewer.org_id))
      .returning(), 'row');
    await audit(tx, viewer, 'setup.profile', { type: 'org_settings', id: null }, { answered: answeredCount(merged) });
    return { data: { company_profile: row.company_profile, answered: answeredCount(merged) } };
  });
}

/**
 * POST /setup/compliance-project. The project itself is created through the existing Bam API
 * (`POST /b3/api/projects`, by the person in the wizard, so Bam applies its own permission and
 * membership rules); Bastion records which project its tasks go to, after checking it belongs to
 * this organization and the caller is a member of it (the same rule Bam applies to "Use an
 * existing project"; SuperUsers bypass). Not a member answers the same 404 as no such project.
 */
export async function setComplianceProject(viewer: Viewer, body: BastionSetupComplianceProject) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const project = await projectVisibleTo(tx, viewer, body.project_id);
    if (!project || project.is_archived) throw new NotFoundError('We could not find that project in your organization.');
    // The same question the api asks before it files a task (#229): a project with no open
    // phase would refuse every task, so it cannot be the Compliance project.
    const open = (await tx.execute(sql`
      SELECT 1 FROM phases WHERE project_id = ${project.id} AND (is_start OR NOT is_terminal) LIMIT 1
    `)) as unknown as unknown[];
    if (open.length === 0) {
      throw new ValidationFailure(
        'That project has no open phase for Bastion to put tasks in. Add one in Bam, or pick another project.',
        'PROJECT_HAS_NO_OPEN_PHASE',
        [{ field: 'project_id', issue: 'no_open_phase' }],
      );
    }
    await ensureSettings(tx, viewer.org_id);
    await tx
      .update(bastionOrgSettings)
      .set({ compliance_project_id: project.id, updated_by: viewer.id })
      .where(eq(bastionOrgSettings.organization_id, viewer.org_id));
    await audit(tx, viewer, 'setup.compliance_project', { type: 'project', id: project.id }, {});
    return { data: { compliance_project: { id: project.id, name: project.name, archived: false } } };
  });
}
