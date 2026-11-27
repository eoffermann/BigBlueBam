import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { BastionDb } from '../src/services/bastion-internal.service.js';

// DB-backed tests for the Bastion internal routes' service (APP_DESIGN_bastion.md 2.5, 2.8, 8.4,
// 11.2): "drift, close the task, drift again: the task is open with a 'Drifted again' comment",
// comments by external_id posted once across a retry, and the proposal-close rules. Runs where
// DATABASE_URL points at a migrated database (CI's test.yml; locally through a forwarder).

vi.mock('../src/db/index.js', () => ({ db: {}, connection: { end: vi.fn() } }));

const { upsertBastionTask, commentOnBastionTask, closeBastionProposal, BastionInternalError } = await import(
  '../src/services/bastion-internal.service.js'
);

const DB_URL = process.env.DATABASE_URL;
const run = DB_URL && !DB_URL.includes('test:test@localhost:5432/test') ? describe : describe.skip;

run('bastion internal service (real Postgres)', () => {
  const sql = postgres(DB_URL ?? 'postgres://x@localhost/x', { max: 2, onnotice: () => {} });
  // Schema-less drizzle handle: the service only uses the query builder, never db.query.*.
  const database = drizzle(sql) as unknown as BastionDb;
  const tag = `${Date.now()}`;
  let org = '';
  let other = '';
  let human = '';
  let agent = '';
  let outsider = '';
  let project = '';
  let startPhase = '';
  let donePhase = '';
  const control = '0b0b0b0b-0000-4000-8000-000000000001';
  const externalId = `bastion:control:${control}`;

  beforeAll(async () => {
    [{ id: org }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Bastion internal test', ${`bastion-int-${tag}`}) RETURNING id`;
    [{ id: other }] = await sql`INSERT INTO organizations (name, slug) VALUES ('Bastion internal other', ${`bastion-int-o-${tag}`}) RETURNING id`;
    [{ id: human }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                                VALUES (${org}, ${`h-${tag}@bastion.test`}, 'Human Decider', '!', 'human') RETURNING id`;
    [{ id: agent }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                                VALUES (${org}, ${`a-${tag}@bastion.test`}, 'Agent', '!', 'agent') RETURNING id`;
    [{ id: outsider }] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                                   VALUES (${other}, ${`o-${tag}@bastion.test`}, 'Outsider', '!', 'human') RETURNING id`;
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${human}, ${org}), (${agent}, ${org}), (${outsider}, ${other})`;
    [{ id: project }] = await sql`INSERT INTO projects (org_id, name, slug, task_id_prefix)
                                  VALUES (${org}, 'Compliance', ${`compliance-${tag}`}, 'COMP') RETURNING id`;
    [{ id: startPhase }] = await sql`INSERT INTO phases (project_id, name, position, is_start) VALUES (${project}, 'To do', 0, true) RETURNING id`;
    await sql`INSERT INTO phases (project_id, name, position) VALUES (${project}, 'Doing', 1)`;
    [{ id: donePhase }] = await sql`INSERT INTO phases (project_id, name, position, is_terminal) VALUES (${project}, 'Done', 2, true) RETURNING id`;
  });

  afterAll(async () => {
    await sql`DELETE FROM entity_links WHERE org_id = ${org}`;
    await sql`DELETE FROM agent_proposals WHERE org_id IN (${org}, ${other})`;
    await sql`DELETE FROM activity_log WHERE project_id = ${project}`;
    await sql`DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ${project})`;
    await sql`DELETE FROM tasks WHERE project_id = ${project}`;
    await sql`DELETE FROM phases WHERE project_id = ${project}`;
    await sql`DELETE FROM projects WHERE id = ${project}`;
    await sql`DELETE FROM organization_memberships WHERE org_id IN (${org}, ${other})`;
    await sql`DELETE FROM users WHERE org_id IN (${org}, ${other})`;
    await sql`DELETE FROM organizations WHERE id IN (${org}, ${other})`;
    await sql.end();
  });

  const commentCount = async (taskId: string) =>
    Number((await sql`SELECT count(*)::int AS n FROM comments WHERE task_id = ${taskId}`)[0]!.n);

  it('drift, close the task, drift again: the task is open with a "Drifted again" comment', async () => {
    const base = { org_id: org, project_id: project, control_id: control, external_id: externalId, title: 'Fix: API keys are rotated', assignee_id: human };
    const created = await upsertBastionTask({ ...base, idempotency_key: 'drift:1:bam_task_upsert' }, database);
    expect(created.outcome).toBe('created');
    const [t1] = await sql`SELECT phase_id, assignee_id, reporter_id, human_id FROM tasks WHERE id = ${created.task_id}`;
    expect(t1!.phase_id).toBe(startPhase);
    expect(t1!.assignee_id).toBe(human);
    expect(t1!.reporter_id).toBe('00000000-0000-0000-0000-0000000000b5');
    expect(String(t1!.human_id)).toMatch(/^COMP-\d+$/);
    const links = await sql`SELECT 1 FROM entity_links WHERE org_id = ${org} AND src_type = 'bastion.control' AND src_id = ${control} AND dst_id = ${created.task_id}`;
    expect(links).toHaveLength(1);

    // Someone finishes the task.
    await sql`UPDATE tasks SET phase_id = ${donePhase}, completed_at = now() WHERE id = ${created.task_id}`;

    const again = await upsertBastionTask(
      { ...base, comment: 'Drifted again on 2026-11-26: failed', idempotency_key: 'drift:2:bam_task_upsert' },
      database,
    );
    expect(again).toMatchObject({ task_id: created.task_id, outcome: 'reopened', comment_posted: true });
    const [t2] = await sql`SELECT phase_id, completed_at FROM tasks WHERE id = ${created.task_id}`;
    expect(t2!.phase_id).toBe(startPhase);
    expect(t2!.completed_at).toBeNull();
    const [c] = await sql`SELECT body, author_id FROM comments WHERE task_id = ${created.task_id}`;
    expect(c!.body).toBe('Drifted again on 2026-11-26: failed');

    // A retried delivery of the same row (its response was lost) answers the first outcome and
    // never posts the comment twice (#228).
    const retry = await upsertBastionTask(
      { ...base, comment: 'Drifted again on 2026-11-26: failed', idempotency_key: 'drift:2:bam_task_upsert' },
      database,
    );
    expect(retry).toMatchObject({ task_id: created.task_id, outcome: 'reopened', comment_posted: false });
    expect(await commentCount(created.task_id)).toBe(1);
  });

  it('a retried create answers created and posts no "Drifted again" comment (#228)', async () => {
    const ctl = '0b0b0b0b-0000-4000-8000-000000000002';
    const input = {
      org_id: org,
      project_id: project,
      control_id: ctl,
      external_id: `bastion:control:${ctl}`,
      title: 'Fix: MFA is on for everyone',
      comment: 'Drifted again on 2026-11-26: the check failed.',
      idempotency_key: 'drift:create-retry:bam_task_upsert',
    };
    const first = await upsertBastionTask(input, database);
    expect(first).toMatchObject({ outcome: 'created', comment_posted: false });
    const retry = await upsertBastionTask(input, database);
    expect(retry).toMatchObject({ task_id: first.task_id, outcome: 'created', comment_posted: false });
    expect(await commentCount(first.task_id)).toBe(0);

    // A new drift (a new key) on the open task is a real update with its comment.
    const next = await upsertBastionTask({ ...input, idempotency_key: 'drift:create-retry-2:bam_task_upsert' }, database);
    expect(next).toMatchObject({ outcome: 'updated', comment_posted: true });
    expect(await commentCount(first.task_id)).toBe(1);
  });

  it('comments by external_id are posted once across a forced retry; no task answers no_task', async () => {
    const body = { org_id: org, project_id: project, external_id: externalId, body: 'Back to passing on 2026-11-27.', idempotency_key: 'recovered:run-9' };
    const first = await commentOnBastionTask(body, database);
    expect(first.outcome).toBe('posted');
    const second = await commentOnBastionTask(body, database);
    expect(second).toMatchObject({ outcome: 'duplicate', comment_id: first.comment_id });
    expect(await commentCount(first.task_id!)).toBe(2);
    const none = await commentOnBastionTask(
      { ...body, external_id: 'bastion:control:0b0b0b0b-0000-4000-8000-0000000000ff', idempotency_key: 'x' },
      database,
    );
    expect(none.outcome).toBe('no_task');
  });

  it('refuses a project in another organization', async () => {
    await expect(
      upsertBastionTask({ org_id: other, project_id: project, control_id: control, external_id: externalId, title: 't', idempotency_key: 'k' }, database),
    ).rejects.toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND' });
  });

  it('closes only Bastion proposals, only for a human member, idempotently', async () => {
    const mk = async (owning: string | null) =>
      (
        await sql`INSERT INTO agent_proposals (org_id, actor_id, proposer_kind, proposed_action, owning_app, require_human_decider, expires_at)
                  VALUES (${org}, '00000000-0000-0000-0000-0000000000b5', 'service', 'bastion.fix.evidence_request', ${owning}, true, now() + interval '14 days')
                  RETURNING id`
      )[0]!.id as string;
    const bastionProposal = await mk('bastion');
    const foreign = await mk(null);
    const close = (id: string, decided_by: string) =>
      closeBastionProposal(id, { org_id: org, decision: 'approved', decided_by, decided_auth_method: 'session' }, database);

    await expect(close(foreign, human)).rejects.toMatchObject({ status: 409, code: 'NOT_A_BASTION_PROPOSAL' });
    await expect(close(bastionProposal, agent)).rejects.toMatchObject({ status: 403, code: 'HUMAN_DECIDER_REQUIRED' });
    await expect(close(bastionProposal, outsider)).rejects.toMatchObject({ status: 403, code: 'DECIDER_NOT_MEMBER' });

    const done = await close(bastionProposal, human);
    expect(done.result).toEqual({ proposal_id: bastionProposal, status: 'approved', already_closed: false });
    expect(done.event).not.toBeNull();
    const [p] = await sql`SELECT status, decided_by, decided_by_kind, decided_auth_method, decided_impersonator_id FROM agent_proposals WHERE id = ${bastionProposal}`;
    expect(p).toMatchObject({ status: 'approved', decided_by: human, decided_by_kind: 'human', decided_auth_method: 'session', decided_impersonator_id: null });

    const again = await close(bastionProposal, human);
    expect(again).toMatchObject({ result: { already_closed: true }, event: null });
    expect(BastionInternalError).toBeDefined();
  });
});
