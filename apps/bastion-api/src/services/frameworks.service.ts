// Frameworks: adopt a built-in template, list, edit, archive, the requirement list with its
// applicability decisions, and the Statement of Applicability (spec 2.1, rows 1-8 of 5.1).

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type {
  BastionAdoptFramework,
  BastionBulkApplicability,
  BastionFrameworkUpdate,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  bastionAssertions,
  bastionControlRequirements,
  bastionControls,
  bastionFrameworks,
} from '../db/schema/index.js';
import { ConflictError, ValidationFailure, one } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  FRAMEWORK_TEMPLATES,
  frameworkTemplate,
  requireTemplate,
  templateControlKeys,
  templateControls,
  type FrameworkTemplate,
} from '../library/index.js';
import { soaCompleteness, soaCsv, type SoaLink } from '../library/soa.js';
import { controlsRetiredByArchive, setupCounts } from '../library/setup-state.js';
import { ensureSettings, liveFrameworks, loadFramework } from './shared.js';
import type { Viewer } from './types.js';

/** GET /library/templates: the built-in templates, and whether this org has adopted each. */
export async function listTemplates(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const adopted = await liveFrameworks(tx, viewer.org_id);
    return {
      data: FRAMEWORK_TEMPLATES.map((t) => templateSummary(t, adopted.find((f) => f.template_key === t.template_key)?.id ?? null)),
    };
  });
}

function templateSummary(t: FrameworkTemplate, adoptedFrameworkId: string | null) {
  return {
    template_key: t.template_key,
    template_version: t.template_version,
    name: t.name,
    description: t.description,
    is_iso: t.is_iso,
    requirement_count: t.requirements.length,
    control_count: templateControlKeys(t).length,
    adopted_framework_id: adoptedFrameworkId,
  };
}

/** Links + assertions for the org, enough to compute setup counts per framework view. */
async function loadSetupInputs(tx: DbTx, orgId: string) {
  const controls = await tx
    .select({ id: bastionControls.id, lifecycle: bastionControls.lifecycle })
    .from(bastionControls)
    .where(eq(bastionControls.organization_id, orgId));
  const links = await tx
    .select({
      control_id: bastionControlRequirements.control_id,
      framework_id: bastionControlRequirements.framework_id,
      applicability: bastionControlRequirements.applicability,
      removed_at: bastionControlRequirements.removed_at,
    })
    .from(bastionControlRequirements)
    .where(eq(bastionControlRequirements.organization_id, orgId));
  const assertions = await tx
    .select({ control_id: bastionAssertions.control_id, review_status: bastionAssertions.review_status })
    .from(bastionAssertions)
    .where(eq(bastionAssertions.organization_id, orgId));
  return controls.map((c) => ({
    id: c.id,
    lifecycle: c.lifecycle,
    links: links.filter((l) => l.control_id === c.id),
    assertions: assertions.filter((a) => a.control_id === c.id),
  }));
}

async function frameworkView(tx: DbTx, orgId: string, f: typeof bastionFrameworks.$inferSelect) {
  const template = frameworkTemplate(f.template_key);
  const inputs = await loadSetupInputs(tx, orgId);
  const counts = setupCounts(inputs, new Set([f.id]));
  let soa = null;
  if (template?.is_iso) soa = soaCompleteness(template, await soaLinks(tx, orgId, f.id));
  return {
    ...f,
    is_iso: template?.is_iso ?? false,
    requirement_count: template?.requirements.length ?? 0,
    setup: counts,
    statement_of_applicability: soa,
  };
}

export async function listFrameworks(viewer: Viewer, opts: { include_archived?: boolean } = {}) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(bastionFrameworks)
      .where(
        opts.include_archived
          ? eq(bastionFrameworks.organization_id, viewer.org_id)
          : and(eq(bastionFrameworks.organization_id, viewer.org_id), ne(bastionFrameworks.status, 'archived')),
      )
      .orderBy(bastionFrameworks.created_at);
    const data = [];
    for (const f of rows) data.push(await frameworkView(tx, viewer.org_id, f));
    return { data, next_cursor: null };
  });
}

export async function getFramework(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    return { data: await frameworkView(tx, viewer.org_id, f) };
  });
}

/**
 * POST /frameworks. Creates bastion_controls rows only for control keys the org lacks (a retired
 * control comes back to life), and always creates the requirement links for this framework. The
 * framework stays `compiling` until a compile succeeds.
 */
export async function adoptFramework(viewer: Viewer, body: BastionAdoptFramework) {
  const template = requireTemplate(body.template_key);
  return runInOrgScope(viewer.org_id, async (tx) => {
    const live = await liveFrameworks(tx, viewer.org_id);
    if (live.some((f) => f.template_key === template.template_key)) {
      throw new ConflictError(`${template.name} is already adopted.`, 'FRAMEWORK_ALREADY_ADOPTED');
    }
    await ensureSettings(tx, viewer.org_id);
    const framework = one(await tx
      .insert(bastionFrameworks)
      .values({
        organization_id: viewer.org_id,
        template_key: template.template_key,
        template_version: template.template_version,
        name: template.name,
        status: 'compiling',
        audit_target_date: body.audit_target_date ?? null,
        period_start: body.period_start ?? null,
        period_end: body.period_end ?? null,
        adopted_at: new Date(),
        adopted_by: viewer.id,
      })
      .returning(), 'framework');

    const libControls = templateControls(template);
    const keys = libControls.map((c) => c.control_key);
    const before = await tx
      .select({ id: bastionControls.id, control_key: bastionControls.control_key, lifecycle: bastionControls.lifecycle })
      .from(bastionControls)
      .where(and(eq(bastionControls.organization_id, viewer.org_id), inArray(bastionControls.control_key, keys)));
    const have = new Map(before.map((c) => [c.control_key, c]));
    const missing = libControls.filter((c) => !have.has(c.control_key));
    if (missing.length > 0) {
      await tx
        .insert(bastionControls)
        .values(
          missing.map((c) => ({
            organization_id: viewer.org_id,
            control_key: c.control_key,
            title: c.title,
            plain_summary: c.plain_summary,
            category: c.category,
            risk_weight: c.risk_weight,
          })),
        )
        .onConflictDoNothing();
    }
    const revived = before.filter((c) => c.lifecycle === 'retired').map((c) => c.id);
    if (revived.length > 0) {
      await tx.update(bastionControls).set({ lifecycle: 'active' }).where(inArray(bastionControls.id, revived));
    }
    const all = await tx
      .select({ id: bastionControls.id, control_key: bastionControls.control_key })
      .from(bastionControls)
      .where(and(eq(bastionControls.organization_id, viewer.org_id), inArray(bastionControls.control_key, keys)));
    const idByKey = new Map(all.map((c) => [c.control_key, c.id]));
    const linkRows = template.requirements.flatMap((req) =>
      req.control_keys.map((k) => ({
        organization_id: viewer.org_id,
        control_id: (idByKey.get(k) as string),
        framework_id: framework.id,
        ref_code: req.ref_code,
        requirement_title: req.title,
        source: 'crosswalk',
      })),
    );
    if (linkRows.length > 0) await tx.insert(bastionControlRequirements).values(linkRows).onConflictDoNothing();

    const summary = {
      controls_created: missing.length,
      controls_reused: before.length - revived.length,
      controls_revived: revived.length,
      requirement_links: linkRows.length,
    };
    await audit(tx, viewer, 'framework.adopt', { type: 'framework', id: framework.id }, {
      template_key: template.template_key,
      ...summary,
    });
    return { data: { ...framework, ...summary } };
  });
}

export async function updateFramework(viewer: Viewer, id: string, body: BastionFrameworkUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    if (f.status === 'archived') throw new ConflictError('This framework is archived.', 'FRAMEWORK_ARCHIVED');
    const [row] = await tx
      .update(bastionFrameworks)
      .set({ ...body })
      .where(and(eq(bastionFrameworks.id, id), eq(bastionFrameworks.organization_id, viewer.org_id)))
      .returning();
    await audit(tx, viewer, 'framework.update', { type: 'framework', id }, { fields: Object.keys(body) });
    return { data: row };
  });
}

/**
 * POST /frameworks/:id/archive. Retires every control whose only live links were to this
 * framework (spec 2.1); retired controls keep their history and leave every number.
 */
export async function archiveFramework(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    if (f.status === 'archived') throw new ConflictError('This framework is already archived.', 'FRAMEWORK_ARCHIVED');
    const others = new Set((await liveFrameworks(tx, viewer.org_id)).filter((x) => x.id !== id).map((x) => x.id));
    const inputs = await loadSetupInputs(tx, viewer.org_id);
    const retire = controlsRetiredByArchive(
      inputs.filter((c) => c.lifecycle === 'active'),
      id,
      others,
    );
    if (retire.length > 0) {
      await tx
        .update(bastionControls)
        .set({ lifecycle: 'retired' })
        .where(and(eq(bastionControls.organization_id, viewer.org_id), inArray(bastionControls.id, retire)));
    }
    const row = one(await tx
      .update(bastionFrameworks)
      .set({ status: 'archived' })
      .where(and(eq(bastionFrameworks.id, id), eq(bastionFrameworks.organization_id, viewer.org_id)))
      .returning(), 'row');
    await audit(tx, viewer, 'framework.archive', { type: 'framework', id }, { controls_retired: retire.length });
    return { data: { ...row, controls_retired: retire.length } };
  });
}

async function soaLinks(tx: DbTx, orgId: string, frameworkId: string): Promise<SoaLink[]> {
  const rows = await tx
    .select({
      ref_code: bastionControlRequirements.ref_code,
      control_title: bastionControls.title,
      control_status: bastionControls.status,
      applicability: bastionControlRequirements.applicability,
      not_applicable_reason: bastionControlRequirements.not_applicable_reason,
      decided_at: bastionControlRequirements.decided_at,
      removed_at: bastionControlRequirements.removed_at,
    })
    .from(bastionControlRequirements)
    .innerJoin(bastionControls, eq(bastionControls.id, bastionControlRequirements.control_id))
    .where(
      and(
        eq(bastionControlRequirements.organization_id, orgId),
        eq(bastionControlRequirements.framework_id, frameworkId),
      ),
    );
  return rows.map((r) => ({ ...r, applicability: r.applicability as SoaLink['applicability'] }));
}

/** GET /frameworks/:id/requirements: every template requirement with its links and decisions. */
export async function listRequirements(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    const template = requireTemplate(f.template_key);
    const links = await tx
      .select({
        id: bastionControlRequirements.id,
        ref_code: bastionControlRequirements.ref_code,
        control_id: bastionControlRequirements.control_id,
        control_key: bastionControls.control_key,
        control_title: bastionControls.title,
        applicability: bastionControlRequirements.applicability,
        not_applicable_reason: bastionControlRequirements.not_applicable_reason,
        decided_at: bastionControlRequirements.decided_at,
        decided_by: bastionControlRequirements.decided_by,
        source: bastionControlRequirements.source,
      })
      .from(bastionControlRequirements)
      .innerJoin(bastionControls, eq(bastionControls.id, bastionControlRequirements.control_id))
      .where(
        and(
          eq(bastionControlRequirements.organization_id, viewer.org_id),
          eq(bastionControlRequirements.framework_id, id),
          isNull(bastionControlRequirements.removed_at),
        ),
      );
    const data = template.requirements.map((req) => {
      const ls = links.filter((l) => l.ref_code === req.ref_code);
      const decided = ls.length > 0 && ls.every((l) => l.decided_at);
      const applicability = !decided
        ? 'undecided'
        : ls.some((l) => l.applicability === 'applicable')
          ? 'applicable'
          : 'not_applicable';
      return {
        ref_code: req.ref_code,
        title: req.title,
        plain_summary: req.plain_summary,
        applicability,
        links: ls,
      };
    });
    const soa = template.is_iso ? soaCompleteness(template, await soaLinks(tx, viewer.org_id, id)) : null;
    return { data, framework: { id: f.id, name: f.name, is_iso: template.is_iso }, statement_of_applicability: soa };
  });
}

/**
 * POST /frameworks/:id/applicability. Decides one or more requirements: every live link of each
 * ref code takes the decision (spec 2.1 per-requirement applicability).
 */
export async function decideApplicability(viewer: Viewer, id: string, body: BastionBulkApplicability) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    if (f.status === 'archived') throw new ConflictError('This framework is archived.', 'FRAMEWORK_ARCHIVED');
    const template = requireTemplate(f.template_key);
    const known = new Set(template.requirements.map((r) => r.ref_code));
    const unknown = body.decisions.filter((d) => !known.has(d.ref_code)).map((d) => d.ref_code);
    if (unknown.length > 0) {
      throw new ValidationFailure(`${f.name} has no requirement ${unknown.join(', ')}.`, 'UNKNOWN_REQUIREMENT');
    }
    const now = new Date();
    let updated = 0;
    for (const d of body.decisions) {
      const rows = await tx
        .update(bastionControlRequirements)
        .set({
          applicability: d.applicability,
          not_applicable_reason: d.applicability === 'not_applicable' ? (d.not_applicable_reason ?? '').trim() : null,
          decided_by: viewer.id,
          decided_at: now,
        })
        .where(
          and(
            eq(bastionControlRequirements.organization_id, viewer.org_id),
            eq(bastionControlRequirements.framework_id, id),
            eq(bastionControlRequirements.ref_code, d.ref_code),
            isNull(bastionControlRequirements.removed_at),
          ),
        )
        .returning({ id: bastionControlRequirements.id });
      updated += rows.length;
    }
    await audit(tx, viewer, 'framework.applicability', { type: 'framework', id }, {
      decisions: body.decisions.map((d) => ({ ref_code: d.ref_code, applicability: d.applicability })),
      links_updated: updated,
    });
    const soa = template.is_iso ? soaCompleteness(template, await soaLinks(tx, viewer.org_id, id)) : null;
    return { data: { links_updated: updated, statement_of_applicability: soa } };
  });
}

/** GET /frameworks/:id/statement-of-applicability (csv; ISO frameworks only). */
export async function statementOfApplicabilityCsv(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, id);
    const template = requireTemplate(f.template_key);
    if (!template.is_iso) {
      throw new ValidationFailure('A Statement of Applicability is only produced for ISO frameworks.', 'SOA_ISO_ONLY');
    }
    return { csv: soaCsv(template, await soaLinks(tx, viewer.org_id, id)), filename: 'statement_of_applicability.csv' };
  });
}
