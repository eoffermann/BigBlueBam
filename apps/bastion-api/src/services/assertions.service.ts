// Assertions: propose, revise (a superseding proposed row), confirm and reject (spec 2.1 step 4,
// 2.8; rows 17-20 of 5.1). Confirm and reject are vouching acts: the routes require a session and
// refuse impersonation; the service records who decided and how they signed in.

import { and, eq } from 'drizzle-orm';
import type {
  BastionAssertionConfirm,
  BastionAssertionPropose,
  BastionAssertionReject,
  BastionAssertionResponse,
  BastionAssertionRevise,
  BastionPopulationKind,
} from '@bigbluebam/shared';
import type { Served } from '../lib/served.js';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bastionAssertions, bastionControls, bastionEvidenceFeeds } from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure, one } from '../lib/errors.js';
import { actorKind, audit } from '../lib/audit.js';
import { revisionPendingError } from '../lib/revision-rule.js';
import { probeEntry } from '../library/index.js';
import { validateManualSuggestion, validateProbeSuggestion } from '../library/compile-plan.js';
import { assertionView } from './controls.service.js';
import { connectedPopulations } from './shared.js';
import type { Viewer } from './types.js';

async function loadAssertion(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bastionAssertions)
    .where(and(eq(bastionAssertions.id, id), eq(bastionAssertions.organization_id, orgId)))
    .limit(1);
  if (!row) throw new NotFoundError('We could not find that check.');
  return row;
}

/**
 * The same row, locked until the transaction ends (#393). Revising reads the original's
 * review_status and then writes on the strength of it; without the lock two revisions of one
 * proposed check both saw it `proposed`, both inserted a successor and both marked it superseded,
 * which forked the check into two live proposals. Under the lock the second waits, then re-reads
 * the committed row (`superseded`) and is refused.
 */
async function loadAssertionForUpdate(tx: DbTx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(bastionAssertions)
    .where(and(eq(bastionAssertions.id, id), eq(bastionAssertions.organization_id, orgId)))
    .limit(1)
    .for('update');
  if (!row) throw new NotFoundError('We could not find that check.');
  return row;
}

/**
 * One open revision per check (#401, lib/revision-rule.ts). Revising the waiting revision keeps it
 * the one open revision: the new row replaces the waiting one at once and, like it, supersedes the
 * confirmed check (revisionAnchor). The caller holds the anchor row FOR UPDATE (the #393 lock
 * pattern), so two revisions of the same check serialize and the second sees the first's committed
 * proposal here.
 */
async function assertNoOpenRevision(tx: DbTx, orgId: string, anchorId: string, exceptId: string | null): Promise<void> {
  const open = await tx
    .select({ id: bastionAssertions.id })
    .from(bastionAssertions)
    .where(
      and(
        eq(bastionAssertions.organization_id, orgId),
        eq(bastionAssertions.supersedes_id, anchorId),
        eq(bastionAssertions.review_status, 'proposed'),
      ),
    );
  if (open.some((r) => r.id !== exceptId)) throw revisionPendingError();
}

/**
 * The row a revision of `old` replaces when it is confirmed: `old` itself, unless `old` is a
 * proposed or rejected revision of a check that is still confirmed, in which case it is that
 * confirmed check (so confirming the newest revision retires the check actually in force, not a
 * row that was already superseded). Returned locked FOR UPDATE.
 */
async function revisionAnchor(tx: DbTx, orgId: string, old: typeof bastionAssertions.$inferSelect) {
  if (old.review_status === 'confirmed' || !old.supersedes_id) return old;
  const [parent] = await tx
    .select()
    .from(bastionAssertions)
    .where(and(eq(bastionAssertions.id, old.supersedes_id), eq(bastionAssertions.organization_id, orgId)))
    .limit(1)
    .for('update');
  return parent?.review_status === 'confirmed' ? parent : old;
}

async function loadActiveControl(tx: DbTx, orgId: string, id: string) {
  const [c] = await tx
    .select()
    .from(bastionControls)
    .where(and(eq(bastionControls.id, id), eq(bastionControls.organization_id, orgId)))
    .limit(1);
  if (!c) throw new NotFoundError('We could not find that control.');
  if (c.lifecycle !== 'active') throw new ConflictError('This control is retired.', 'CONTROL_RETIRED');
  return c;
}

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * The members of a revised population with the label people see for each (issue #195; spec 6.2:
 * never a raw id). Blip apps must be tracked apps of the caller's org (an unknown or foreign id is
 * refused) and are labelled with the app's name. Repositories may be ones not yet connected
 * (that is why a person adds them), so they are checked for the `owner/name` shape, compared
 * lower-cased as the probe compares them, and labelled with the connected spelling, the earlier
 * label, or what the person typed.
 */
export async function resolvePopulation(
  tx: DbTx,
  orgId: string,
  kind: BastionPopulationKind,
  members: string[],
  previousLabels: Record<string, string>,
): Promise<{ values: string[]; labels: Record<string, string> }> {
  const connected = await connectedPopulations(tx, orgId);
  const labels: Record<string, string> = {};
  if (kind === 'blip_apps') {
    const known = new Map(connected.blip_apps.map((a) => [a.value.toLowerCase(), a]));
    const values: string[] = [];
    for (const raw of members) {
      const app = known.get(raw.trim().toLowerCase());
      if (!app) {
        throw new ValidationFailure(
          'One of those apps is not tracked in your organization. Choose apps from the list.',
          'UNKNOWN_POPULATION_MEMBER',
          [{ field: 'expected_population', issue: 'unknown_app' }],
        );
      }
      if (!labels[app.value]) values.push(app.value);
      labels[app.value] = app.label;
    }
    return { values, labels };
  }
  const connectedLabel = new Map(connected.github_repos.map((r) => [r.value, r.label]));
  const values: string[] = [];
  for (const raw of members) {
    const typed = raw.trim();
    if (!REPO_RE.test(typed)) {
      throw new ValidationFailure(
        'Write each repository as owner/name, for example castaways/rescue-radio-firmware.',
        'INVALID_POPULATION_MEMBER',
        [{ field: 'expected_population', issue: 'not_owner_slash_name' }],
      );
    }
    const v = typed.toLowerCase();
    if (!labels[v]) values.push(v);
    labels[v] = connectedLabel.get(v) ?? previousLabels[v] ?? typed;
  }
  return { values, labels };
}

/** Population confirmation fields never carry over to a new proposal: a person confirms again. */
function withoutConfirmation(params: Record<string, unknown>): Record<string, unknown> {
  const { population_confirmed_at: _a, population_confirmed_by: _b, ...rest } = params;
  return rest;
}

export async function proposeAssertion(viewer: Viewer, controlId: string, body: BastionAssertionPropose): Promise<Served<BastionAssertionResponse>> {
  return runInOrgScope(viewer.org_id, (tx) => proposeAssertionIn(tx, viewer, controlId, body));
}

/** proposeAssertion inside a caller's org-scoped transaction (policy-pins.ts pins under one lock). */
export async function proposeAssertionIn(tx: DbTx, viewer: Viewer, controlId: string, body: BastionAssertionPropose): Promise<Served<BastionAssertionResponse>> {
  await loadActiveControl(tx, viewer.org_id, controlId);
  const kind = await actorKind(tx, viewer.id);
  const proposed_by = kind === 'human' ? 'human' : 'agent';
  let values: Partial<typeof bastionAssertions.$inferInsert>;
  if (body.kind === 'probe') {
    const params = withoutConfirmation(body.params ?? {});
    const entry = probeEntry(body.probe_key);
    if (entry?.population_kind && Array.isArray(params.expected_population)) {
      // A proposer-supplied list gets the same org check and human labels as a revision.
      const resolved = await resolvePopulation(
        tx,
        viewer.org_id,
        entry.population_kind,
        params.expected_population.map(String),
        {},
      );
      params.expected_population = resolved.values;
      params.population_labels = resolved.labels;
    }
    const v = validateProbeSuggestion(
      { probe_key: body.probe_key, params, plain_statement: body.plain_statement },
      await connectedPopulations(tx, viewer.org_id),
    );
    if (!v.ok) throw new ValidationFailure(v.reason, 'INVALID_PROBE');
    values = { ...v.value };
  } else if (body.kind === 'manual') {
    const v = validateManualSuggestion({ spec: body.manual_evidence_spec, plain_statement: body.plain_statement });
    if (!v.ok) throw new ValidationFailure(v.reason, 'INVALID_MANUAL_REQUEST');
    values = { ...v.value };
  } else {
    const [feed] = await tx
      .select({ id: bastionEvidenceFeeds.id })
      .from(bastionEvidenceFeeds)
      .where(and(eq(bastionEvidenceFeeds.id, body.feed_id), eq(bastionEvidenceFeeds.organization_id, viewer.org_id)))
      .limit(1);
    if (!feed) throw new NotFoundError('We could not find that evidence feed.');
    values = { kind: 'feed', feed_id: feed.id, plain_statement: body.plain_statement };
  }
  const row = one(await tx
    .insert(bastionAssertions)
    .values({
      ...values,
      kind: (values.kind as string),
      plain_statement: (values.plain_statement as string),
      organization_id: viewer.org_id,
      control_id: controlId,
      proposed_by,
      review_status: 'proposed',
      created_by: viewer.id,
    })
    .returning(), 'row');
  await audit(tx, viewer, 'assertion.propose', { type: 'assertion', id: row.id }, {
    control_id: controlId,
    kind: row.kind,
    probe_key: row.probe_key,
    proposed_by,
  });
  return { data: assertionView(row) };
}

/**
 * POST /assertions/:id/revise. Files a superseding `proposed` row (confirmed assertions are
 * content-immutable). A proposed or rejected original is marked superseded at once; a confirmed
 * original stays in force until the revision is confirmed, and has at most one revision waiting
 * (#401: a second is refused with REVISION_PENDING; see assertNoOpenRevision).
 */
export async function reviseAssertion(viewer: Viewer, id: string, body: BastionAssertionRevise): Promise<Served<BastionAssertionResponse>> {
  return runInOrgScope(viewer.org_id, (tx) => reviseAssertionIn(tx, viewer, id, body));
}

/** reviseAssertion inside a caller's org-scoped transaction (policy-pins.ts pins under one lock). */
export async function reviseAssertionIn(tx: DbTx, viewer: Viewer, id: string, body: BastionAssertionRevise): Promise<Served<BastionAssertionResponse>> {
  // Locked, so the superseded check below is authoritative (#393).
  const old = await loadAssertionForUpdate(tx, viewer.org_id, id);
  if (old.review_status === 'superseded') {
    throw new ConflictError('This check was already replaced; revise the newer version.', 'ASSERTION_SUPERSEDED');
  }
  // One open revision per check (#401): lock what this revision will replace, then make sure no
  // other revision of it is waiting (the one being revised here is about to be replaced).
  const anchor = await revisionAnchor(tx, viewer.org_id, old);
  await assertNoOpenRevision(tx, viewer.org_id, anchor.id, old.id);
  await loadActiveControl(tx, viewer.org_id, old.control_id);
  const plain_statement = body.plain_statement ?? old.plain_statement;
  let content: Partial<typeof bastionAssertions.$inferInsert>;
  if (old.kind === 'probe') {
    if (body.manual_evidence_spec) throw new ValidationFailure('A probe check has no manual evidence request.', 'WRONG_KIND');
    const params = withoutConfirmation({ ...((old.params ?? {}) as Record<string, unknown>), ...(body.params ?? {}) });
    if (body.expected_population) {
      const entry = probeEntry(old.probe_key ?? '');
      if (!entry?.population_kind) {
        throw new ValidationFailure('This check does not take a list of systems.', 'NOT_A_POPULATION_CHECK');
      }
      const resolved = await resolvePopulation(
        tx,
        viewer.org_id,
        entry.population_kind,
        body.expected_population,
        (params.population_labels ?? {}) as Record<string, string>,
      );
      params.expected_population = resolved.values;
      params.population_labels = resolved.labels;
    }
    const v = validateProbeSuggestion({
      probe_key: old.probe_key as never,
      params,
      predicate: (old.predicate ?? {}) as Record<string, unknown>,
      plain_statement,
    });
    if (!v.ok) throw new ValidationFailure(v.reason, 'INVALID_PROBE');
    content = { ...v.value };
  } else if (old.kind === 'manual') {
    if (body.params || body.expected_population) {
      throw new ValidationFailure('A manual check has no probe settings.', 'WRONG_KIND');
    }
    const v = validateManualSuggestion({
      spec: body.manual_evidence_spec ?? (old.manual_evidence_spec as never),
      plain_statement,
    });
    if (!v.ok) throw new ValidationFailure(v.reason, 'INVALID_MANUAL_REQUEST');
    content = { ...v.value };
  } else {
    content = { kind: 'feed', feed_id: old.feed_id, plain_statement };
  }
  const kind = await actorKind(tx, viewer.id);
  const row = one(await tx
    .insert(bastionAssertions)
    .values({
      ...content,
      kind: (content.kind as string),
      plain_statement: (content.plain_statement as string),
      organization_id: viewer.org_id,
      control_id: old.control_id,
      proposed_by: kind === 'human' ? 'human' : 'agent',
      review_status: 'proposed',
      supersedes_id: anchor.id,
      created_by: viewer.id,
    })
    .returning(), 'row');
  if (old.review_status === 'proposed' || old.review_status === 'rejected') {
    await tx
      .update(bastionAssertions)
      .set({ review_status: 'superseded' })
      .where(and(eq(bastionAssertions.id, old.id), eq(bastionAssertions.organization_id, viewer.org_id)));
  }
  await audit(tx, viewer, 'assertion.revise', { type: 'assertion', id: row.id }, { supersedes_id: anchor.id, revises_id: old.id });
  return { data: assertionView(row) };
}

/**
 * POST /assertions/:id/confirm. A population check needs `population_confirmed: true` ("This is
 * the complete list"), stored as population_confirmed_at/by in the params, and at least one
 * member: an empty list would make the probe silently check whatever happens to be connected.
 */
export async function confirmAssertion(viewer: Viewer, id: string, body: BastionAssertionConfirm): Promise<Served<BastionAssertionResponse>> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const a = await loadAssertion(tx, viewer.org_id, id);
    if (a.review_status !== 'proposed') {
      throw new ConflictError('Only a proposed check can be confirmed.', 'ASSERTION_NOT_PROPOSED');
    }
    await loadActiveControl(tx, viewer.org_id, a.control_id);
    let params = (a.params ?? {}) as Record<string, unknown>;
    const entry = a.kind === 'probe' ? probeEntry(a.probe_key ?? '') : undefined;
    const now = new Date();
    if (entry?.population_kind) {
      const members = Array.isArray(params.expected_population) ? params.expected_population : [];
      if (members.length === 0) {
        throw new ValidationFailure(
          'Add at least one system to the list before confirming this check.',
          'POPULATION_EMPTY',
          [{ field: 'expected_population', issue: 'empty' }],
        );
      }
      if (body.population_confirmed !== true) {
        throw new ValidationFailure(
          'Confirm that this is the complete list before turning the check on.',
          'POPULATION_CONFIRMATION_REQUIRED',
          [{ field: 'population_confirmed', issue: 'required' }],
        );
      }
      params = { ...params, population_confirmed_at: now.toISOString(), population_confirmed_by: viewer.id };
    }
    const [row] = await tx
      .update(bastionAssertions)
      .set({ params, review_status: 'confirmed', confirmed_by: viewer.id, confirmed_at: now })
      .where(
        and(
          eq(bastionAssertions.id, id),
          eq(bastionAssertions.organization_id, viewer.org_id),
          eq(bastionAssertions.review_status, 'proposed'),
        ),
      )
      .returning();
    if (!row) throw new ConflictError('Someone else decided this check first.', 'ASSERTION_NOT_PROPOSED');
    if (row.supersedes_id) {
      await tx
        .update(bastionAssertions)
        .set({ review_status: 'superseded' })
        .where(
          and(
            eq(bastionAssertions.id, row.supersedes_id),
            eq(bastionAssertions.organization_id, viewer.org_id),
            eq(bastionAssertions.review_status, 'confirmed'),
          ),
        );
    }
    await audit(tx, viewer, 'assertion.confirm', { type: 'assertion', id }, {
      control_id: row.control_id,
      population_confirmed: Boolean(entry?.population_kind),
    });
    return { data: assertionView(row) };
  });
}

export async function rejectAssertion(viewer: Viewer, id: string, body: BastionAssertionReject): Promise<Served<BastionAssertionResponse>> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const a = await loadAssertion(tx, viewer.org_id, id);
    if (a.review_status !== 'proposed') {
      throw new ConflictError('Only a proposed check can be rejected.', 'ASSERTION_NOT_PROPOSED');
    }
    const [row] = await tx
      .update(bastionAssertions)
      .set({ review_status: 'rejected' })
      .where(
        and(
          eq(bastionAssertions.id, id),
          eq(bastionAssertions.organization_id, viewer.org_id),
          eq(bastionAssertions.review_status, 'proposed'),
        ),
      )
      .returning();
    if (!row) throw new ConflictError('Someone else decided this check first.', 'ASSERTION_NOT_PROPOSED');
    await audit(tx, viewer, 'assertion.reject', { type: 'assertion', id }, {
      control_id: row.control_id,
      reason: body.reason ?? null,
    });
    return { data: assertionView(row) };
  });
}
