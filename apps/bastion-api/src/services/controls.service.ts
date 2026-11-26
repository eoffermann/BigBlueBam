// Controls: list with the "Not set up yet" count, detail, custom controls, edits, one link's
// applicability decision, and a control's assertions (spec 2.1, 2.3; rows 11-16 of 5.1).

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  BastionControlCreate,
  BastionControlListQuery,
  BastionControlUpdate,
  BastionRequirementApplicabilityUpdate,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  bastionAssertions,
  bastionControlRequirements,
  bastionControls,
  bastionFrameworks,
  organizationMemberships,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure, one } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { frameworkTemplate, probeEntry } from '../library/index.js';
import { derivedApplicability, setupCounts, setupStateFor } from '../library/setup-state.js';
import { liveFrameworks, loadFramework } from './shared.js';
import type { Viewer } from './types.js';

async function loadControl(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bastionControls)
    .where(and(eq(bastionControls.id, id), eq(bastionControls.organization_id, orgId)))
    .limit(1);
  if (!row) throw new NotFoundError('We could not find that control.');
  return row;
}

async function orgLinks(tx: DbTx, orgId: string, controlIds?: string[]) {
  const where = controlIds
    ? and(eq(bastionControlRequirements.organization_id, orgId), inArray(bastionControlRequirements.control_id, controlIds))
    : eq(bastionControlRequirements.organization_id, orgId);
  return tx
    .select({
      id: bastionControlRequirements.id,
      control_id: bastionControlRequirements.control_id,
      framework_id: bastionControlRequirements.framework_id,
      framework_name: bastionFrameworks.name,
      framework_status: bastionFrameworks.status,
      ref_code: bastionControlRequirements.ref_code,
      requirement_title: bastionControlRequirements.requirement_title,
      applicability: bastionControlRequirements.applicability,
      not_applicable_reason: bastionControlRequirements.not_applicable_reason,
      decided_at: bastionControlRequirements.decided_at,
      source: bastionControlRequirements.source,
      removed_at: bastionControlRequirements.removed_at,
    })
    .from(bastionControlRequirements)
    .innerJoin(bastionFrameworks, eq(bastionFrameworks.id, bastionControlRequirements.framework_id))
    .where(where);
}

/** Population view of a probe assertion's params, labels instead of raw ids (spec 6.2). */
export function populationView(probeKey: string | null, params: unknown) {
  const entry = probeKey ? probeEntry(probeKey) : undefined;
  if (!entry?.population_kind) return null;
  const p = (params ?? {}) as Record<string, unknown>;
  const values = Array.isArray(p.expected_population) ? (p.expected_population as string[]) : [];
  const labels = (p.population_labels ?? {}) as Record<string, string>;
  return {
    kind: entry.population_kind,
    members: values.map((v) => ({ value: v, label: labels[v] ?? v })),
    confirmed_at: (p.population_confirmed_at as string | undefined) ?? null,
    confirmed_by: (p.population_confirmed_by as string | undefined) ?? null,
  };
}

export function assertionView(a: typeof bastionAssertions.$inferSelect) {
  const entry = a.probe_key ? probeEntry(a.probe_key) : undefined;
  return {
    ...a,
    probe_title: entry?.title ?? null,
    probe_inherited: entry?.inherited ?? false,
    population: populationView(a.probe_key, a.params),
  };
}

export async function listControls(viewer: Viewer, query: BastionControlListQuery) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const frameworks = await liveFrameworks(tx, viewer.org_id);
    if (query.framework_id && !frameworks.some((f) => f.id === query.framework_id)) {
      throw new NotFoundError('We could not find that framework.');
    }
    const view = new Set(query.framework_id ? [query.framework_id] : frameworks.map((f) => f.id));
    const controls = await tx
      .select()
      .from(bastionControls)
      .where(eq(bastionControls.organization_id, viewer.org_id))
      .orderBy(bastionControls.title);
    const links = await orgLinks(tx, viewer.org_id);
    const assertions = await tx
      .select({ control_id: bastionAssertions.control_id, review_status: bastionAssertions.review_status })
      .from(bastionAssertions)
      .where(eq(bastionAssertions.organization_id, viewer.org_id));

    const shaped = controls.map((c) => {
      const cl = links.filter((l) => l.control_id === c.id);
      const ca = assertions.filter((a) => a.control_id === c.id);
      const setup_state = setupStateFor({ lifecycle: c.lifecycle, links: cl, assertions: ca }, view);
      const tally = (s: string) => ca.filter((a) => a.review_status === s).length;
      return {
        control: c,
        links: cl,
        assertions: ca,
        row: {
          id: c.id,
          control_key: c.control_key,
          title: c.title,
          plain_summary: c.plain_summary,
          category: c.category,
          risk_weight: c.risk_weight,
          owner_user_id: c.owner_user_id,
          lifecycle: c.lifecycle,
          status: c.status,
          status_reason: c.status_reason,
          coverage_kind: c.coverage_kind,
          setup_state,
          derived_applicability: derivedApplicability(cl),
          requirements: cl
            .filter((l) => !l.removed_at && view.has(l.framework_id))
            .map((l) => ({
              id: l.id,
              framework_id: l.framework_id,
              framework_name: l.framework_name,
              ref_code: l.ref_code,
              applicability: l.applicability,
            })),
          assertion_counts: { proposed: tally('proposed'), confirmed: tally('confirmed'), rejected: tally('rejected') },
        },
      };
    });

    const counts = setupCounts(
      shaped.map((s) => ({ lifecycle: s.control.lifecycle, links: s.links, assertions: s.assertions })),
      view,
    );
    const lifecycle = query.lifecycle ?? 'active';
    const q = query.q?.toLowerCase();
    const data = shaped
      .map((s) => s.row)
      .filter((r) => r.lifecycle === lifecycle)
      .filter((r) => (lifecycle === 'active' ? r.setup_state !== null : true))
      .filter((r) => (query.setup ? r.setup_state === query.setup : true))
      .filter((r) => (q ? `${r.title} ${r.plain_summary ?? ''}`.toLowerCase().includes(q) : true));
    return { data, counts, framework_id: query.framework_id ?? null, next_cursor: null };
  });
}

export async function getControl(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const c = await loadControl(tx, viewer.org_id, id);
    const links = await orgLinks(tx, viewer.org_id, [id]);
    const assertions = await tx
      .select()
      .from(bastionAssertions)
      .where(and(eq(bastionAssertions.organization_id, viewer.org_id), eq(bastionAssertions.control_id, id)))
      .orderBy(desc(bastionAssertions.created_at));
    const frameworks = await liveFrameworks(tx, viewer.org_id);
    const setup_state = setupStateFor(
      { lifecycle: c.lifecycle, links, assertions },
      new Set(frameworks.map((f) => f.id)),
    );
    return {
      data: {
        ...c,
        tsv: undefined,
        setup_state,
        derived_applicability: derivedApplicability(links),
        requirements: links.filter((l) => !l.removed_at),
        assertions: assertions.map(assertionView),
      },
    };
  });
}

export async function listControlAssertions(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadControl(tx, viewer.org_id, id);
    const rows = await tx
      .select()
      .from(bastionAssertions)
      .where(and(eq(bastionAssertions.organization_id, viewer.org_id), eq(bastionAssertions.control_id, id)))
      .orderBy(desc(bastionAssertions.created_at));
    return { data: rows.map(assertionView), next_cursor: null };
  });
}

async function assertMember(tx: DbTx, orgId: string, userId: string) {
  const [m] = await tx
    .select({ user_id: organizationMemberships.user_id })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.org_id, orgId), eq(organizationMemberships.user_id, userId)))
    .limit(1);
  if (!m) throw new ValidationFailure('The owner must be a member of this organization.', 'OWNER_NOT_MEMBER');
}

/** POST /controls: an org-authored custom control, `control_key = custom:<slug>` (spec 2.1). */
export async function createControl(viewer: Viewer, body: BastionControlCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    if (body.owner_user_id) await assertMember(tx, viewer.org_id, body.owner_user_id);
    const links: Array<{ framework_id: string; ref_code: string; title: string }> = [];
    for (const l of body.requirement_links ?? []) {
      const f = await loadFramework(tx, viewer.org_id, l.framework_id);
      const req = frameworkTemplate(f.template_key)?.requirements.find((r) => r.ref_code === l.ref_code);
      if (!req) throw new ValidationFailure(`${f.name} has no requirement ${l.ref_code}.`, 'UNKNOWN_REQUIREMENT');
      links.push({ framework_id: f.id, ref_code: req.ref_code, title: req.title });
    }
    // ON CONFLICT DO NOTHING keeps the transaction usable; no row back means the key is taken.
    const [row] = await tx
      .insert(bastionControls)
      .values({
        organization_id: viewer.org_id,
        control_key: `custom:${body.slug}`,
        title: body.title,
        plain_summary: body.plain_summary ?? null,
        category: body.category ?? 'custom',
        risk_weight: body.risk_weight ?? 3,
        owner_user_id: body.owner_user_id ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictError('A control with that short name already exists.', 'CONTROL_EXISTS');
    if (links.length > 0) {
      await tx.insert(bastionControlRequirements).values(
        links.map((l) => ({
          organization_id: viewer.org_id,
          control_id: row.id,
          framework_id: l.framework_id,
          ref_code: l.ref_code,
          requirement_title: l.title,
          source: 'admin',
        })),
      );
    }
    await audit(tx, viewer, 'control.create', { type: 'control', id: row.id }, {
      control_key: row.control_key,
      requirement_links: links.map((l) => l.ref_code),
    });
    return { data: { ...row, tsv: undefined } };
  });
}

export async function updateControl(viewer: Viewer, id: string, body: BastionControlUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadControl(tx, viewer.org_id, id);
    if (body.owner_user_id) await assertMember(tx, viewer.org_id, body.owner_user_id);
    const row = one(await tx
      .update(bastionControls)
      .set({ ...body })
      .where(and(eq(bastionControls.id, id), eq(bastionControls.organization_id, viewer.org_id)))
      .returning(), 'row');
    await audit(tx, viewer, 'control.update', { type: 'control', id }, { fields: Object.keys(body) });
    return { data: { ...row, tsv: undefined } };
  });
}

/** PATCH /control-requirements/:id: one link's applicability decision (audited). */
export async function decideRequirementLink(viewer: Viewer, id: string, body: BastionRequirementApplicabilityUpdate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [row] = await tx
      .update(bastionControlRequirements)
      .set({
        applicability: body.applicability,
        not_applicable_reason: body.applicability === 'not_applicable' ? (body.not_applicable_reason ?? '').trim() : null,
        decided_by: viewer.id,
        decided_at: new Date(),
      })
      .where(and(eq(bastionControlRequirements.id, id), eq(bastionControlRequirements.organization_id, viewer.org_id)))
      .returning();
    if (!row) throw new NotFoundError('We could not find that requirement link.');
    await audit(tx, viewer, 'requirement.applicability', { type: 'control_requirement', id }, {
      ref_code: row.ref_code,
      applicability: row.applicability,
    });
    return { data: row };
  });
}
