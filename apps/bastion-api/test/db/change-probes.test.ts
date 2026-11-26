import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * The GitHub change-evidence chain, checked where it is consumed (spec 3.1, 8.4): rows shaped
 * the way the /webhooks/github route writes them (github_integrations.subscribed_events from
 * `ping`, one github_pr_events row per pull_request / pull_request_review delivery) are read
 * by bastion_probe_change_merge_reviewed_v1 and _merge_traceable_v1.
 *
 * Runs inside a rolled-back transaction against a migrated DB; SKIPS LOUDLY without
 * DATABASE_URL.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bastion-api/change-probes] SKIPPING: DATABASE_URL is not set. Point it at a migrated ' +
      'database to exercise the GitHub change-evidence probes.',
  );
}

const ORG = '00000000-0000-0000-0000-0000ba572001';
const PROJECT = '00000000-0000-0000-0000-0000ba572002';
const INTEGRATION = '00000000-0000-0000-0000-0000ba572003';
const MERGE_UNREVIEWED = '00000000-0000-0000-0000-0000ba572011';
const MERGE_SELF_APPROVED = '00000000-0000-0000-0000-0000ba572012';
const MERGE_REVIEWED = '00000000-0000-0000-0000-0000ba572013';

type ProbeResult = {
  summary: { merges: number; repos: Array<{ repo: string; reviews_subscribed: boolean | null }> };
  cited_refs: Array<{ entity_type: string; entity_id: string }>;
  population_checked: string[];
  population_missing: string[];
  population_unlisted: string[];
};

async function seed(tx: postgres.TransactionSql, subscribed: string[] | null): Promise<void> {
  await tx`INSERT INTO organizations (id, name, slug)
           VALUES (${ORG}, 'Bastion Change Probes', 'bastion-change-probes') ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO projects (id, org_id, name, slug) VALUES (${PROJECT}, ${ORG}, 'Radio', 'radio')`;
  await tx`INSERT INTO github_integrations (id, project_id, repo_owner, repo_name, webhook_secret, subscribed_events)
           VALUES (${INTEGRATION}, ${PROJECT}, 'skipper', 'rescue-radio-firmware', 'x', ${subscribed})`;
  const merge = (id: string, pr: number, author: string, refs: string[]) => tx`
    INSERT INTO github_pr_events (id, org_id, integration_id, project_id, repo_owner, repo_name,
                                  delivery_id, event_type, action, pr_number, pr_author_login,
                                  base_ref, default_branch, merged, merged_at, task_refs, occurred_at)
    VALUES (${id}, ${ORG}, ${INTEGRATION}, ${PROJECT}, 'skipper', 'rescue-radio-firmware',
            ${`merge-${pr}`}, 'pull_request', 'closed', ${pr}, ${author}, 'main', 'main', true,
            now() - interval '2 days', ${refs}, now() - interval '2 days')`;
  const review = (pr: number, reviewer: string, reviewId: number) => tx`
    INSERT INTO github_pr_events (org_id, integration_id, project_id, repo_owner, repo_name,
                                  delivery_id, event_type, action, pr_number, review_id,
                                  review_state, reviewer_login, review_submitted_at, occurred_at)
    VALUES (${ORG}, ${INTEGRATION}, ${PROJECT}, 'skipper', 'rescue-radio-firmware',
            ${`review-${reviewId}`}, 'pull_request_review', 'submitted', ${pr}, ${reviewId},
            'approved', ${reviewer}, now() - interval '3 days', now() - interval '3 days')`;
  await merge(MERGE_UNREVIEWED, 42, 'gilligan', []);
  await merge(MERGE_SELF_APPROVED, 43, 'gilligan', ['RADIO-1']);
  await review(43, 'gilligan', 1);
  await merge(MERGE_REVIEWED, 44, 'gilligan', ['RADIO-2']);
  await review(44, 'professor', 2);
}

async function run(
  sql: postgres.Sql,
  subscribed: string[] | null,
  fn: string,
  params: Record<string, unknown>,
): Promise<ProbeResult> {
  let out: ProbeResult | null = null;
  try {
    await sql.begin(async (tx) => {
      await seed(tx, subscribed);
      await tx`SELECT set_config('app.current_org_id', ${ORG}, true)`;
      // $2 is bound as text and cast, so postgres.js does not JSON-encode the string a second
      // time (a jsonb STRING would reach the probe and every params lookup would read NULL).
      const rows = await tx.unsafe(`SELECT ${fn}($1::uuid, now(), $2::text::jsonb) AS r`, [
        ORG,
        JSON.stringify(params),
      ]);
      out = rows[0]?.r as ProbeResult;
      throw new Error('ROLLBACK_SENTINEL');
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'ROLLBACK_SENTINEL') throw err;
  }
  return out as unknown as ProbeResult;
}

describe.skipIf(!DATABASE_URL)('GitHub change-evidence probes', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('merge_reviewed cites merges without a non-author approval before the merge', async () => {
    const r = await run(sql, ['ping', 'pull_request', 'pull_request_review', 'push'], 'bastion_probe_change_merge_reviewed_v1', {
      expected_population: ['Skipper/Rescue-Radio-Firmware', 'skipper/lagoon-booking-site'],
    });
    expect(r.summary.merges).toBe(3);
    expect(r.cited_refs.map((c) => c.entity_id).sort()).toEqual([MERGE_UNREVIEWED, MERGE_SELF_APPROVED].sort());
    expect(r.summary.repos).toEqual([
      expect.objectContaining({ repo: 'skipper/rescue-radio-firmware', reviews_subscribed: true }),
    ]);
    expect(r.population_missing).toEqual(['skipper/lagoon-booking-site']);
  });

  it('reports subscribed_events NULL as unknown, not as "not subscribed"', async () => {
    const unknown = await run(sql, null, 'bastion_probe_change_merge_reviewed_v1', {});
    expect(unknown.summary.repos[0]?.reviews_subscribed).toBeNull();
    expect(unknown.cited_refs).toHaveLength(2);
    const lacking = await run(sql, ['push', 'pull_request'], 'bastion_probe_change_merge_reviewed_v1', {});
    expect(lacking.summary.repos[0]?.reviews_subscribed).toBe(false);
  });

  it('merge_traceable cites merges whose title and body named no task', async () => {
    const r = await run(sql, null, 'bastion_probe_change_merge_traceable_v1', {});
    expect(r.cited_refs.map((c) => c.entity_id)).toEqual([MERGE_UNREVIEWED]);
    expect(r.population_checked).toEqual(['skipper/rescue-radio-firmware']);
  });
});
