import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Spec section 12.1 assertions covering section 3, BEHAVIORAL half.
 *
 * These exercise the constraints and indexes against a real migrated Postgres, because the
 * properties under test are properties of the DATABASE, not of the declarations. The
 * partial live-row index in particular cannot be proven by reading SQL: the whole question
 * is what happens on the second and third insert.
 *
 * CI provides a migrated Postgres and DATABASE_URL (.github/workflows/test.yml). Locally,
 * point DATABASE_URL at the compose stack. When it is absent the suite SKIPS LOUDLY rather
 * than silently passing, because a silently-skipped constraint test is worse than none.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[burn-api/live-schema] SKIPPING: DATABASE_URL is not set, so the live constraint and ' +
      'index assertions cannot run. These cover the partial live-row unique index (including ' +
      'the revert-to-prior-value case), the amendment-never-active CHECK, the rule ' +
      'discriminating-key CHECK, and the rollup period-shape CHECK. Set DATABASE_URL to a ' +
      'migrated database to exercise them.',
  );
}

// A fixed sentinel namespace so a crashed run leaves findable, cleanable rows.
const ORG_ID = '00000000-0000-0000-0000-00000b000001';
const USER_ID = '00000000-0000-0000-0000-00000b000002';
const PROJECT_ID = '00000000-0000-0000-0000-00000b000003';
const SOURCE_ID = '00000000-0000-0000-0000-00000b000004';

const uuid = () => crypto.randomUUID();

describe.skipIf(!DATABASE_URL)('section 3 live constraints', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    // Fixtures. The burn_* FKs to organizations/users/projects are real, so these have to
    // exist. Idempotent so a crashed previous run does not wedge the suite.
    await sql`
      INSERT INTO organizations (id, name, slug)
      VALUES (${ORG_ID}, 'Burn Test Org', 'burn-test-org-fixture')
      ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO users (id, org_id, email, display_name, password_hash,
                         is_active, is_superuser, email_verified, kind)
      VALUES (${USER_ID}, ${ORG_ID}, 'burn-fixture@bigbluebam.internal', 'Burn Fixture', '!',
              true, false, true, 'service')
      ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO projects (id, org_id, name, slug, created_by)
      VALUES (${PROJECT_ID}, ${ORG_ID}, 'Burn Fixture Project', 'burn-fixture-project', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
  });

  afterAll(async () => {
    if (!sql) return;
    // ORDER MATTERS. Every burn_* table CASCADEs from organizations, but
    // burn_engagements.created_by references users(id) with NO on-delete action, so the
    // user cannot be dropped while any engagement still points at it. Dropping the org
    // first cascades the burn rows away and unblocks the rest.
    await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`;
    await sql`DELETE FROM projects WHERE id = ${PROJECT_ID}`;
    await sql`DELETE FROM users WHERE id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  async function insertWorkItem(opts: {
    sourceEpoch: string;
    minutes: number;
    state?: string;
  }) {
    const [row] = await sql`
      INSERT INTO burn_work_items (
        organization_id, source_type, source_id, source_epoch,
        classification_epoch, cost_epoch, project_id, occurred_at,
        reconcile_until, minutes, attribution_state
      ) VALUES (
        ${ORG_ID}, 'bam.time_entry', ${SOURCE_ID}, ${opts.sourceEpoch},
        'cls-v1', 'cost-v1', ${PROJECT_ID}, now(),
        now() + interval '90 days', ${opts.minutes}, ${opts.state ?? 'pending'}
      ) RETURNING id, source_epoch, minutes, attribution_state`;
    return row;
  }

  async function clearWorkItems() {
    await sql`DELETE FROM burn_work_items WHERE organization_id = ${ORG_ID}`;
  }

  describe('the partial live-row unique index (R2-T4)', () => {
    it('rejects a second LIVE row for the same (org, source_type, source_id)', async () => {
      await clearWorkItems();
      await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });
      await expect(insertWorkItem({ sourceEpoch: 'e90', minutes: 90 })).rejects.toMatchObject({
        code: '23505',
      });
    });

    it("permits a new live row once the prior one is 'excluded' (tombstone semantics)", async () => {
      await clearWorkItems();
      const first = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });
      await sql`
        UPDATE burn_work_items
        SET attribution_state = 'excluded', exclusion_reason = 'superseded_epoch'
        WHERE id = ${first.id}`;
      const second = await insertWorkItem({ sourceEpoch: 'e90', minutes: 90 });
      expect(second.minutes).toBe(90);

      const live = await sql`
        SELECT count(*)::int AS n FROM burn_work_items
        WHERE organization_id = ${ORG_ID} AND attribution_state <> 'excluded'`;
      expect(live[0].n).toBe(1);
    });

    it('THE REVERT CASE: 60 -> 90 -> 60 yields exactly one live row, correct dollars, no 23505', async () => {
      // This is the defect that killed the four-column key. With source_epoch in the unique
      // index, reverting to a prior value collides with the tombstone left by the first
      // change, so the third write takes a 23505 and the row stays permanently excluded.
      await clearWorkItems();

      const supersede = async (id: string) => {
        await sql`
          UPDATE burn_work_items
          SET attribution_state = 'excluded', exclusion_reason = 'superseded_epoch'
          WHERE id = ${id}`;
      };

      const a = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });
      await supersede(a.id);
      const b = await insertWorkItem({ sourceEpoch: 'e90', minutes: 90 });
      await supersede(b.id);
      // Back to the ORIGINAL epoch value. This is the write that used to fail.
      const c = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });

      expect(c.source_epoch).toBe('e60');
      expect(c.minutes).toBe(60);

      const live = await sql`
        SELECT id, minutes FROM burn_work_items
        WHERE organization_id = ${ORG_ID} AND attribution_state <> 'excluded'`;
      expect(live).toHaveLength(1);
      expect(live[0].minutes).toBe(60);
      expect(live[0].id).toBe(c.id);

      // And no row is permanently stranded: the two tombstones are the audit trail.
      const excluded = await sql`
        SELECT count(*)::int AS n FROM burn_work_items
        WHERE organization_id = ${ORG_ID} AND attribution_state = 'excluded'`;
      expect(excluded[0].n).toBe(2);
    });

    it('THE REVERT CASE, opposite ordering: 90 -> 60 -> 90 behaves identically', async () => {
      await clearWorkItems();
      const supersede = async (id: string) => {
        await sql`
          UPDATE burn_work_items SET attribution_state = 'excluded',
          exclusion_reason = 'superseded_epoch' WHERE id = ${id}`;
      };

      const a = await insertWorkItem({ sourceEpoch: 'e90', minutes: 90 });
      await supersede(a.id);
      const b = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });
      await supersede(b.id);
      const c = await insertWorkItem({ sourceEpoch: 'e90', minutes: 90 });

      const live = await sql`
        SELECT minutes FROM burn_work_items
        WHERE organization_id = ${ORG_ID} AND attribution_state <> 'excluded'`;
      expect(live).toHaveLength(1);
      expect(live[0].minutes).toBe(90);
      expect(c.minutes).toBe(90);
    });

    it('CONCURRENT first insert yields one live row and no aborted transaction (R3-T7)', async () => {
      // The event path and reconcile pass 1 can observe the same brand-new source record
      // simultaneously. Exercised concurrently, not merely in sequence.
      await clearWorkItems();
      const results = await Promise.allSettled([
        insertWorkItem({ sourceEpoch: 'e60', minutes: 60 }),
        insertWorkItem({ sourceEpoch: 'e60', minutes: 60 }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser gets a clean, catchable 23505 rather than a deadlock or a serialization
      // failure, which is what lets the caller treat it as "someone else won, re-read".
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });

      const live = await sql`
        SELECT count(*)::int AS n FROM burn_work_items
        WHERE organization_id = ${ORG_ID} AND attribution_state <> 'excluded'`;
      expect(live[0].n).toBe(1);
    });
  });

  describe('the epoch split is genuinely independent (section 2.3.2)', () => {
    it('lets cost_epoch change without touching classification_epoch, and vice versa', async () => {
      await clearWorkItems();
      const row = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });

      // A cost_epoch-only change REVALUES. It must not disturb the classification epoch,
      // which is what guarantees it never re-classifies and never calls the llm-provider.
      await sql`UPDATE burn_work_items SET cost_epoch = 'cost-v2' WHERE id = ${row.id}`;
      let [after] = await sql`
        SELECT classification_epoch, cost_epoch FROM burn_work_items WHERE id = ${row.id}`;
      expect(after.cost_epoch).toBe('cost-v2');
      expect(after.classification_epoch).toBe('cls-v1');

      // And the converse.
      await sql`UPDATE burn_work_items SET classification_epoch = 'cls-v2' WHERE id = ${row.id}`;
      [after] = await sql`
        SELECT classification_epoch, cost_epoch FROM burn_work_items WHERE id = ${row.id}`;
      expect(after.classification_epoch).toBe('cls-v2');
      expect(after.cost_epoch).toBe('cost-v2');
    });

    it('does not require a valuation to exist, so an unvalued row is representable', async () => {
      // burn-revalue writes `unrated` ONLY where valued_at IS NULL (R3-T3), so the null
      // state has to be a first-class representable thing rather than an accident.
      await clearWorkItems();
      const row = await insertWorkItem({ sourceEpoch: 'e60', minutes: 60 });
      const [r] = await sql`
        SELECT valuation_epoch, valued_at, valuation_basis
        FROM burn_work_items WHERE id = ${row.id}`;
      expect(r.valuation_epoch).toBeNull();
      expect(r.valued_at).toBeNull();
      expect(r.valuation_basis).toBe('none');
    });
  });

  describe('burn_attributions carries no money, in the DATABASE (R3-T2)', () => {
    it('has no money-shaped column in information_schema', async () => {
      const cols = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'burn_attributions'`;
      const names = cols.map((c) => c.column_name);
      for (const forbidden of ['billable_amount', 'cost_amount', 'amount', 'currency']) {
        expect(names, `burn_attributions.${forbidden} must not exist`).not.toContain(forbidden);
      }
    });
  });

  describe('the amendment deliverable CHECK (R3-D2)', () => {
    let engagementId: string;

    beforeAll(async () => {
      engagementId = uuid();
      await sql`
        INSERT INTO burn_engagements (id, organization_id, title, chain_root_id, created_by)
        VALUES (${engagementId}, ${ORG_ID}, 'Fixture SOW', ${engagementId}, ${USER_ID})`;
    });

    const insertDeliverable = (opts: {
      dedupKey: string;
      amends?: string | null;
      isActive?: boolean;
    }) => sql`
      INSERT INTO burn_deliverables (
        organization_id, engagement_id, dedup_key, title, amends_deliverable_id, is_active
      ) VALUES (
        ${ORG_ID}, ${engagementId}, ${opts.dedupKey}, 'Fixture deliverable',
        ${opts.amends ?? null}, ${opts.isActive ?? false}
      ) RETURNING id, is_active`;

    it('permits a base deliverable to be active', async () => {
      const [row] = await insertDeliverable({ dedupKey: `base-${uuid()}`, isActive: true });
      expect(row.is_active).toBe(true);
    });

    it('REFUSES an amendment deliverable that is_active, at the storage boundary', async () => {
      const [base] = await insertDeliverable({ dedupKey: `base-${uuid()}` });
      await expect(
        insertDeliverable({ dedupKey: `amd-${uuid()}`, amends: base.id, isActive: true }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('permits an amendment created inactive, carrying its delta and its own activation state', async () => {
      const [base] = await insertDeliverable({ dedupKey: `base-${uuid()}` });
      const [amd] = await sql`
        INSERT INTO burn_deliverables (
          organization_id, engagement_id, dedup_key, title,
          amends_deliverable_id, envelope_amount_delta, delta_confirmed_by, delta_confirmed_at
        ) VALUES (
          ${ORG_ID}, ${engagementId}, ${`amd-${uuid()}`}, 'Change order line',
          ${base.id}, 250000, ${USER_ID}, now()
        ) RETURNING id, is_active, envelope_amount_delta, delta_confirmed_at`;
      expect(amd.is_active).toBe(false);
      expect(Number(amd.envelope_amount_delta)).toBe(250000);
      expect(amd.delta_confirmed_at).not.toBeNull();
    });

    it('refuses to delete a base deliverable while an amendment references it (RESTRICT)', async () => {
      const [base] = await insertDeliverable({ dedupKey: `base-${uuid()}` });
      await insertDeliverable({ dedupKey: `amd-${uuid()}`, amends: base.id });
      await expect(
        sql`DELETE FROM burn_deliverables WHERE id = ${base.id}`,
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('attribution-rule discriminating-key CHECK (R2-S4a)', () => {
    it('REFUSES a rule whose match has no discriminating key', async () => {
      // An empty match is a rule that silently swallows every work item in the org.
      await expect(sql`
        INSERT INTO burn_attribution_rules (
          organization_id, name, match, outcome_kind, outcome_reason, created_by
        ) VALUES (
          ${ORG_ID}, 'Swallow everything', '{}'::jsonb, 'non_billable', 'internal', ${USER_ID}
        )`).rejects.toMatchObject({ code: '23514' });
    });

    it('REFUSES a match object carrying only unrecognized keys', async () => {
      await expect(sql`
        INSERT INTO burn_attribution_rules (
          organization_id, name, match, outcome_kind, outcome_reason, created_by
        ) VALUES (
          ${ORG_ID}, 'Sneaky', '{"anything": "x"}'::jsonb, 'non_billable', 'internal', ${USER_ID}
        )`).rejects.toMatchObject({ code: '23514' });
    });

    it('accepts a rule with a real selector', async () => {
      const [row] = await sql`
        INSERT INTO burn_attribution_rules (
          organization_id, name, match, outcome_kind, outcome_reason, created_by
        ) VALUES (
          ${ORG_ID}, 'Internal retros', ${sql.json({ title_pattern: 'retro*' })},
          'non_billable', 'internal', ${USER_ID}
        ) RETURNING id`;
      expect(row.id).toBeTruthy();
    });

    it('REFUSES an attribute rule with no target deliverable', async () => {
      await expect(sql`
        INSERT INTO burn_attribution_rules (
          organization_id, name, match, outcome_kind, created_by
        ) VALUES (
          ${ORG_ID}, 'Targetless', ${sql.json({ title_pattern: 'x*' })}, 'attribute', ${USER_ID}
        )`).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('rollup period shape and basis CHECKs (R3-D3)', () => {
    const insertRollup = (fields: Record<string, unknown>) => sql`
      INSERT INTO burn_engagement_rollups ${sql({
        organization_id: ORG_ID,
        chain_root_id: uuid(),
        metric_basis: 'contract_consumption',
        revenue_basis: 'contract_value',
        ...fields,
      })} RETURNING id`;

    it('accepts a non-retainer rollup with all three period columns null', async () => {
      const [row] = await insertRollup({});
      expect(row.id).toBeTruthy();
    });

    it('REFUSES a half-specified period (start with no end)', async () => {
      // A start with no end is an unlabeled window, which is exactly the ambiguity that let
      // an implementer silently pick current, trailing, or lifetime.
      await expect(
        insertRollup({
          revenue_basis: 'contract_value_per_period',
          period_start: '2026-07-01',
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('REFUSES period columns on a non-retainer revenue basis', async () => {
      await expect(
        insertRollup({
          revenue_basis: 'billable_recognized',
          period_start: '2026-07-01',
          period_end: '2026-07-31',
          period_index: 3,
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('accepts a fully specified retainer period', async () => {
      const [row] = await insertRollup({
        revenue_basis: 'contract_value_per_period',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        period_index: 3,
      });
      expect(row.id).toBeTruthy();
    });

    it("REFUSES 'suppressed' as a STORED metric_basis (it is a response shape only)", async () => {
      await expect(insertRollup({ metric_basis: 'suppressed' })).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  describe('precheck idempotency-key namespace and supersession (R2-T7)', () => {
    const insertPrecheck = (fields: Record<string, unknown>) => sql`
      INSERT INTO burn_prechecks ${sql({
        organization_id: ORG_ID,
        idempotency_key: `svc:${uuid()}`,
        valid_until: sql`now() + interval '5 minutes'` as unknown as string,
        work_ref_type: 'bill.expense',
        verdict: 'allow',
        verdict_reason: 'within_envelope',
        mode_at_decision: 'advisory',
        ...fields,
      })} RETURNING id`;

    it('REFUSES an idempotency key outside the svc:/usr: namespaces', async () => {
      await expect(
        insertPrecheck({ idempotency_key: 'caller-supplied-key' }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('supersede-then-insert produces a live row AND a retained superseded row, no 23505', async () => {
      const key = `svc:${uuid()}`;
      const [first] = await insertPrecheck({ idempotency_key: key });

      // The recompute shape: supersede, then insert, in one transaction.
      const [second] = await sql.begin(async (tx) => {
        await tx`
          UPDATE burn_prechecks SET superseded_at = now() WHERE id = ${first.id}`;
        return tx`
          INSERT INTO burn_prechecks (
            organization_id, idempotency_key, valid_until, work_ref_type,
            verdict, verdict_reason, mode_at_decision, superseded_by
          ) VALUES (
            ${ORG_ID}, ${key}, now() + interval '5 minutes', 'bill.expense',
            'deny', 'envelope_would_exceed', 'advisory', ${first.id}
          ) RETURNING id`;
      });

      const rows = await sql`
        SELECT id, verdict, superseded_at FROM burn_prechecks
        WHERE organization_id = ${ORG_ID} AND idempotency_key = ${key}
        ORDER BY superseded_at NULLS LAST`;
      expect(rows).toHaveLength(2);

      const live = rows.filter((r) => r.superseded_at === null);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(second.id);
      expect(live[0].verdict).toBe('deny');

      // The superseded row is RETAINED: it is part of the dispute record, not a dead row.
      const superseded = rows.filter((r) => r.superseded_at !== null);
      expect(superseded).toHaveLength(1);
      expect(superseded[0].verdict).toBe('allow');
    });

    it('still rejects two LIVE rows for the same key', async () => {
      const key = `svc:${uuid()}`;
      await insertPrecheck({ idempotency_key: key });
      await expect(insertPrecheck({ idempotency_key: key })).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  describe('engagement basis constraints (section 1.2.1)', () => {
    const insertEngagement = (fields: Record<string, unknown>) => {
      const id = uuid();
      return sql`
        INSERT INTO burn_engagements ${sql({
          id,
          organization_id: ORG_ID,
          title: 'Basis fixture',
          chain_root_id: id,
          created_by: USER_ID,
          ...fields,
        })} RETURNING id, envelope_basis`;
    };

    it('accepts all four envelope bases', async () => {
      for (const basis of ['fixed', 'time_and_materials', 'not_to_exceed']) {
        const [row] = await insertEngagement({ envelope_basis: basis });
        expect(row.envelope_basis).toBe(basis);
      }
      const [retainer] = await insertEngagement({
        envelope_basis: 'retainer',
        period_length_days: 30,
      });
      expect(retainer.envelope_basis).toBe('retainer');
    });

    it('REFUSES a retainer with no period_length_days', async () => {
      // The per-period boundary cannot be computed without it, and 1.2.1 computes retainer
      // margin per period.
      await expect(insertEngagement({ envelope_basis: 'retainer' })).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('REFUSES an unknown envelope basis, since the margin formula branches on it', async () => {
      await expect(insertEngagement({ envelope_basis: 'milestone' })).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  describe('org settings threshold CHECKs', () => {
    it('REFUSES a review_threshold that collapses the human-review band', async () => {
      await expect(sql`
        INSERT INTO burn_org_settings (organization_id, auto_attribute_threshold, review_threshold)
        VALUES (${ORG_ID}, 0.90, 0.90)`).rejects.toMatchObject({ code: '23514' });
    });

    it('accepts the shipped defaults and applies gate_mode advisory', async () => {
      await sql`DELETE FROM burn_org_settings WHERE organization_id = ${ORG_ID}`;
      const [row] = await sql`
        INSERT INTO burn_org_settings (organization_id) VALUES (${ORG_ID})
        RETURNING gate_mode, embedding_enabled, claim_lease_seconds, attribute_batch_size,
                  overage_bucket_amount, min_contributors_for_cost_aggregate`;
      expect(row.gate_mode).toBe('advisory');
      expect(row.embedding_enabled).toBe(false);
      expect(row.claim_lease_seconds).toBe(300);
      expect(row.attribute_batch_size).toBe(25);
      expect(Number(row.overage_bucket_amount)).toBe(10000);
      expect(row.min_contributors_for_cost_aggregate).toBe(3);
      await sql`DELETE FROM burn_org_settings WHERE organization_id = ${ORG_ID}`;
    });

    it('REFUSES a precheck_budget_ms outside the advisory bound', async () => {
      await expect(sql`
        INSERT INTO burn_org_settings (organization_id, precheck_budget_ms)
        VALUES (${ORG_ID}, 60000)`).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the project-scope predicate has no null fallback (R2-S6)', () => {
    it('resolves a zero-project chain to zero members through the EXISTS predicate', async () => {
      // A chain with no linked projects is read_all-only BY CONSTRUCTION: the predicate
      // simply matches nobody. This is the assertion that would fail if someone ported
      // Bulwark's NULL-passes-for-all-members fallback.
      const id = uuid();
      await sql`
        INSERT INTO burn_engagements (id, organization_id, title, chain_root_id, created_by)
        VALUES (${id}, ${ORG_ID}, 'Unlinked chain', ${id}, ${USER_ID})`;

      const [row] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM burn_engagement_projects ep
          JOIN project_memberships pm ON pm.project_id = ep.project_id
          WHERE ep.engagement_id = ${id} AND pm.user_id = ${USER_ID}
        ) AS visible`;
      expect(row.visible).toBe(false);
    });
  });
});
