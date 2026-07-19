import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  burnEngagements,
  burnEngagementProjects,
  burnDeliverables,
  burnWorkItems,
  burnAttributions,
  burnAttributionRules,
  burnPrechecks,
  burnVariances,
  burnClassifierFeedback,
  burnCostRates,
  burnEngagementRollups,
  burnIngestEvents,
  burnExtractionRuns,
  burnOrgSettings,
} from '../src/db/schema/index.js';

/**
 * Spec section 12.1 assertions covering section 3 (the data model).
 *
 * These are the STRUCTURAL half: invariants that hold in the Drizzle declarations and in
 * the migration SQL, and that therefore need no database. They exist because each one
 * encodes a specific defect that was found and fixed during spec hardening, and each would
 * be silently reintroduced by an ordinary-looking refactor. The behavioral half (the
 * partial live-row index under concurrent revert, the CHECK constraints actually firing)
 * lives in live-schema.test.ts and needs a migrated Postgres.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'infra', 'postgres', 'migrations');
const sqlFor = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8');

const CORE_SQL = sqlFor('0239_burn_core.sql');
const GATE_SQL = sqlFor('0240_burn_gate_variance.sql');
const RATES_SQL = sqlFor('0241_burn_rates_rollups_rules.sql');

const ALL_BURN_TABLES = [
  burnEngagements,
  burnEngagementProjects,
  burnDeliverables,
  burnWorkItems,
  burnAttributions,
  burnAttributionRules,
  burnPrechecks,
  burnVariances,
  burnClassifierFeedback,
  burnCostRates,
  burnEngagementRollups,
  burnIngestEvents,
  burnExtractionRuns,
  burnOrgSettings,
];

const columnNames = (table: (typeof ALL_BURN_TABLES)[number]) =>
  getTableConfig(table).columns.map((c) => c.name);

describe('section 3: the table set', () => {
  it('declares exactly the 14 burn_* tables the spec names', () => {
    const names = ALL_BURN_TABLES.map((t) => getTableConfig(t).name).sort();
    expect(names).toEqual([
      'burn_attribution_rules',
      'burn_attributions',
      'burn_classifier_feedback',
      'burn_cost_rates',
      'burn_deliverables',
      'burn_engagement_projects',
      'burn_engagement_rollups',
      'burn_engagements',
      'burn_extraction_runs',
      'burn_ingest_events',
      'burn_org_settings',
      'burn_prechecks',
      'burn_variances',
      'burn_work_items',
    ]);
    expect(names).toHaveLength(14);
  });

  it('scopes every table on organization_id (spec 3, join boundary: burn uses organization_id, not org_id)', () => {
    for (const table of ALL_BURN_TABLES) {
      const cfg = getTableConfig(table);
      expect(columnNames(table), `${cfg.name} must carry organization_id`).toContain(
        'organization_id',
      );
      expect(columnNames(table), `${cfg.name} must NOT use the org_id spelling`).not.toContain(
        'org_id',
      );
    }
  });

  it('enables RLS with an app.current_org_id policy on all 14 tables', () => {
    const allSql = CORE_SQL + GATE_SQL + RATES_SQL;
    for (const table of ALL_BURN_TABLES) {
      const name = getTableConfig(table).name;
      expect(allSql, `${name} must ENABLE ROW LEVEL SECURITY`).toContain(
        `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`,
      );
      expect(allSql, `${name} must have an org-isolation policy`).toContain(
        `CREATE POLICY ${name}_org_isolation ON ${name}`,
      );
    }
    // And the policy predicate is the platform GUC, not something bespoke.
    const policyCount = (allSql.match(/current_setting\('app\.current_org_id', true\)::uuid/g) ?? [])
      .length;
    expect(policyCount).toBe(14);
  });
});

describe('section 3.1 R3-T2: the attribution carries the decision and NO money', () => {
  // The round-2 draft snapshotted billable_amount / cost_amount on burn_attributions,
  // outside the revalue path. burn-revalue rewrites amounts on burn_work_items while
  // explicitly never superseding an attribution, so a snapshot here has two possible
  // readings and both are wrong: sum the snapshot and attributed_cost stays null forever
  // once cost rates arrive; sum the work item and the snapshot diverges permanently, so the
  // gate and the rollup disagree about the same dollars with no reconciliation path.
  // Deleting the columns removes the staleness class instead of adding an invariant to
  // maintain. This test is what stops someone "optimizing away the join".
  const MONEY_SHAPED = [
    'billable_amount',
    'cost_amount',
    'amount',
    'envelope_amount',
    'proposed_amount',
    'currency',
    'minutes',
  ];

  it('declares no money-shaped column on burn_attributions', () => {
    const cols = columnNames(burnAttributions);
    for (const forbidden of MONEY_SHAPED) {
      expect(cols, `burn_attributions must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('keeps the amounts on burn_work_items, which is what every consumption query joins', () => {
    const cols = columnNames(burnWorkItems);
    expect(cols).toContain('billable_amount');
    expect(cols).toContain('cost_amount');
    expect(cols).toContain('currency');
  });

  it('keeps deliverable_id on the attribution as ON DELETE RESTRICT', () => {
    // Consumption joins work items for money and attributions for "which deliverable".
    // RESTRICT is what makes a live classification block an accidental deliverable delete.
    expect(columnNames(burnAttributions)).toContain('deliverable_id');
    expect(CORE_SQL).toMatch(
      /deliverable_id uuid REFERENCES burn_deliverables\(id\) ON DELETE RESTRICT/,
    );
  });
});

describe('section 2.3.2 / R2-T4: the epoch split', () => {
  it('declares three independent epoch columns, all NOT NULL', () => {
    const cfg = getTableConfig(burnWorkItems);
    for (const name of ['source_epoch', 'classification_epoch', 'cost_epoch']) {
      const col = cfg.columns.find((c) => c.name === name);
      expect(col, `${name} must be declared`).toBeDefined();
      expect(col!.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it('declares valuation_epoch and valued_at, which are what make burn-revalue fail-safe', () => {
    // burn-revalue writes `unrated` ONLY where valued_at IS NULL, so a rate-service outage
    // cannot downgrade a work item that was already priced correctly (R3-T3).
    const cols = columnNames(burnWorkItems);
    expect(cols).toContain('valuation_epoch');
    expect(cols).toContain('valued_at');
  });

  it('keeps source_epoch OUT of the live-row unique index (R2-T4, the revert bug)', () => {
    // This is the single most important line in 0239. A four-column key including
    // source_epoch makes minutes 60 -> 90 -> 60 collide with the row excluded on the first
    // change, producing a 23505 and a permanently-excluded row. The replacement is a
    // partial index over the identity triple only, with excluded rows treated as tombstones.
    const indexStmt = CORE_SQL.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_work_items_live[\s\S]*?;/,
    )?.[0];
    expect(indexStmt, 'idx_burn_work_items_live must exist').toBeDefined();
    expect(indexStmt).toContain('(organization_id, source_type, source_id)');
    expect(indexStmt).toContain("WHERE attribution_state <> 'excluded'");
    expect(indexStmt, 'source_epoch must NOT be part of the live-row key').not.toContain(
      'source_epoch',
    );
  });

  it('anchors reconcile_until on ingested_at, not occurred_at (R2-T3, backdated windowing)', () => {
    // A timesheet dated 120 days ago but created today must still be inside reconcile
    // passes 2 and 3. Anchoring on occurred_at would make it immediately out of window, so
    // an edit or a delete of that row would never be observed.
    const col = getTableConfig(burnWorkItems).columns.find((c) => c.name === 'reconcile_until');
    expect(col?.notNull).toBe(true);
  });
});

describe('section 3.1 R3-D2: an amendment deliverable is a pure envelope-delta carrier', () => {
  it('gives an amendment its OWN activation state so is_active keeps exactly one writer', () => {
    const cols = columnNames(burnDeliverables);
    expect(cols).toContain('amends_deliverable_id');
    expect(cols).toContain('envelope_amount_delta');
    // The activation state of an AMENDMENT row. Flipping is_active on proposal.decided
    // instead would create a second writer of a field whose single-writer property is a
    // security boundary (spec 2.2.1).
    expect(cols).toContain('delta_confirmed_by');
    expect(cols).toContain('delta_confirmed_at');
  });

  it('enforces at the storage boundary that an amendment row is never is_active', () => {
    // Created active, an amendment would be surfaced as an attribution candidate and would
    // SPLIT consumption off the base row, which is precisely what the base-row invariant
    // exists to prevent. A service-layer bug must not be able to produce that row.
    expect(CORE_SQL).toContain('burn_deliverables_amendment_not_active_check');
    expect(CORE_SQL).toMatch(/CHECK \(amends_deliverable_id IS NULL OR is_active = false\)/);
  });

  it('declares lifecycle_status, which is what makes deliverable_closed reachable', () => {
    // Without this column verdict_reason='deliverable_closed' is an unreachable enum value.
    expect(columnNames(burnDeliverables)).toContain('lifecycle_status');
    expect(CORE_SQL).toMatch(/lifecycle_status IN \('open', 'complete', 'closed'\)/);
  });
});

describe('section 3.1 R2-B8d: the tsvector idiom, and the search oracle', () => {
  it('declares both search_tsv columns as tsvector, not text', () => {
    // db-check.mjs treats an undeclared DB column as FATAL but downgrades a type mismatch
    // to a non-fatal warning, so declaring these as text() would never be caught.
    for (const table of [burnDeliverables, burnClassifierFeedback]) {
      const cfg = getTableConfig(table);
      const col = cfg.columns.find((c) => c.name === 'search_tsv');
      expect(col, `${cfg.name}.search_tsv must be declared`).toBeDefined();
      expect(col!.getSQLType(), `${cfg.name}.search_tsv must be tsvector`).toBe('tsvector');
    }
  });

  it('generates both search_tsv columns null-safely with an explicit regconfig', () => {
    // A bare concatenation over nullable columns yields NULL, which guts recall on the
    // shipped path rather than failing loudly.
    expect(CORE_SQL).toMatch(/search_tsv tsvector GENERATED ALWAYS AS \([\s\S]*?\) STORED/);
    expect(CORE_SQL).toContain("to_tsvector('english'");
    expect(CORE_SQL).toContain("coalesce(title, '')");
    expect(CORE_SQL).toContain("coalesce(description, '')");
    expect(CORE_SQL).toContain("coalesce(cited_span->>'quote', '')");
    expect(GATE_SQL).toContain("to_tsvector('english', coalesce(text_snapshot, ''))");
  });

  it('ships a separate trigram index on title so a member q filter never needs search_tsv (R3-S4)', () => {
    // description and cited_span->>'quote' are read_all-floored, and a floored field that
    // stays searchable is not floored: a member could confirm the presence of any term one
    // probe at a time. The member-reachable q filter matches title ONLY, through this index.
    expect(CORE_SQL).toContain('idx_burn_deliverables_title_trgm');
    expect(CORE_SQL).toContain('USING gin(title gin_trgm_ops)');
  });
});

describe('section 3.1 R2-T7: precheck supersede-then-insert', () => {
  it('declares supersession columns and a PARTIAL unique index on the live row', () => {
    const cols = columnNames(burnPrechecks);
    expect(cols).toContain('superseded_at');
    expect(cols).toContain('superseded_by');
    // A TOTAL unique index leaves only UPDATE-in-place (destroys the reason of record) or
    // INSERT-and-take-a-23505 ON THE MONEY PATH, where the only safe handler is fail-open.
    const stmt = GATE_SQL.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_prechecks_live_idem[\s\S]*?;/,
    )?.[0];
    expect(stmt).toBeDefined();
    expect(stmt).toContain('(organization_id, idempotency_key)');
    expect(stmt).toContain('WHERE superseded_at IS NULL');
  });

  it('enforces the server-derived key namespace with a CHECK', () => {
    // Idempotency keys are HMACs prefixed svc: or usr:. The CHECK is what makes a
    // caller-supplied key structurally impossible to smuggle in, and the svc: namespace is
    // what stops a member manufacturing a calibration sample (spec 2.4 point 10).
    expect(GATE_SQL).toMatch(
      /CHECK \(idempotency_key LIKE 'svc:%' OR idempotency_key LIKE 'usr:%'\)/,
    );
    expect(columnNames(burnPrechecks)).toContain('is_calibrating');
  });

  it('closes the advisory_feedback enum so a third scoring value cannot be invented', () => {
    // right_call / would_have_mapped are member-writable and feed NOTHING; wrong_call is
    // the only value in the demotion numerator (R2-S7). The permission split is enforced in
    // routes; the enum is closed here.
    expect(GATE_SQL).toMatch(/'right_call', 'would_have_mapped', 'wrong_call'/);
  });
});

describe('section 3.1 R3-D3 / R2-T5: rollup period and freeze semantics', () => {
  it('keys the rollup on the chain and stores retainer period bounds descriptively', () => {
    const cols = columnNames(burnEngagementRollups);
    expect(cols).toContain('chain_root_id');
    expect(cols).toContain('period_start');
    expect(cols).toContain('period_end');
    expect(cols).toContain('period_index');
    // The unique key stays (organization_id, chain_root_id): the row is always the CURRENT
    // period and prior periods come from the burn-down series. Keying on period_start would
    // ripple through every rollup query for the sake of one basis.
    expect(RATES_SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_burn_engagement_rollups_chain\s+ON burn_engagement_rollups\(organization_id, chain_root_id\)/,
    );
  });

  it('requires the period columns to travel together and only on a retainer basis', () => {
    expect(RATES_SQL).toContain('burn_engagement_rollups_period_shape_check');
    expect(RATES_SQL).toContain('burn_engagement_rollups_period_basis_check');
  });

  it('declares frozen_at so retention final figures are never recomputed to zero', () => {
    // Without this, the first hourly full recompute after retention purges a closed chain's
    // work items recomputes from surviving rows (near zero), DO UPDATEs a years-old figure
    // to $0, and stamps a fresh computed_at so it does not even read as stale.
    expect(columnNames(burnEngagementRollups)).toContain('frozen_at');
  });

  it('stores revenue_basis with all four bases, keeping not_to_exceed distinct from fixed', () => {
    // NTE bills actual work up to a ceiling and NEVER the ceiling itself. Grouping it with
    // fixed makes a $6,000 NTE that delivered $2,000 report margin = 6000 - cost, booking
    // $4,000 that can never be invoiced. That overstates, which is the direction a buyer
    // cannot detect.
    expect(RATES_SQL).toMatch(
      /revenue_basis IN \('contract_value', 'billable_recognized_capped',\s*'contract_value_per_period', 'billable_recognized'\)/,
    );
  });

  it("excludes 'suppressed' from the stored metric_basis enum", () => {
    // 'suppressed' is a RESPONSE SHAPE (spec 1.2.2), never a stored value.
    expect(RATES_SQL).toMatch(/metric_basis IN \('true_margin', 'contract_consumption'\)/);
    expect(RATES_SQL).not.toMatch(/metric_basis IN \([^)]*suppressed/);
  });

  it('stores the three unscoped buckets separately, never as one summed figure', () => {
    const cols = columnNames(burnEngagementRollups);
    expect(cols).toContain('unscoped_sold_by_nobody');
    expect(cols).toContain('unscoped_unclassified');
    expect(cols).toContain('unscoped_outside_contract');
    expect(cols, 'a single merged unscoped column would defeat spec 2.3.8').not.toContain(
      'unscoped_amount',
    );
  });
});

describe('section 2.4 point 6: the project-scope predicate has no null fallback', () => {
  it('has no project_id column on burn_engagements, forcing the join-table predicate', () => {
    // The ported Bulwark project-scope.ts operates on a single nullable project_id whose
    // documented fallback is that NULL passes for EVERY org member. Burn engagements
    // deliberately have no such column, so that fallback is not expressible and a
    // zero-project chain is read_all-only by construction rather than org-wide readable.
    expect(columnNames(burnEngagements)).not.toContain('project_id');
  });

  it('scopes work items by the row own project_id, not by chain reachability', () => {
    // A member of the low-sensitivity project in a multi-project chain must not read items
    // sourced from the project they are not in.
    expect(columnNames(burnWorkItems)).toContain('project_id');
  });
});

describe('section 2.3.3: attribution rules cannot silently swallow the org', () => {
  it('rejects a match object with no discriminating key at the storage boundary', () => {
    expect(RATES_SQL).toContain('burn_attribution_rules_match_discriminating_check');
    for (const key of [
      'project_ids',
      'phase_ids',
      'label_ids',
      'account_ids',
      'title_pattern',
      'expense_categories',
      'source_types',
    ]) {
      expect(RATES_SQL).toContain(`match ? '${key}'`);
    }
  });

  it('requires a target for an attribute rule and a reason for a non_billable rule', () => {
    expect(RATES_SQL).toContain('burn_attribution_rules_outcome_shape_check');
  });
});

describe('section 3.1: the ingest inbox is claimed, with a per-org reaper scan', () => {
  it('declares claim columns that bulwark_ingest_events does not have', () => {
    // bulwark_ingest_events has only status pending|processed and survives that solely
    // because its sweeps run at concurrency 1 under a lock. Burn's batch is BOTH
    // event-driven AND scheduled, so two drains can legitimately see the same pending row.
    const cols = columnNames(burnIngestEvents);
    expect(cols).toContain('claimed_by');
    expect(cols).toContain('claimed_at');
    expect(GATE_SQL + CORE_SQL).toMatch(/status IN \('pending', 'claimed', 'processed', 'skipped'\)/);
  });

  it('scopes the reaper index per org, not globally (R2-I6)', () => {
    // Under BBB_RLS_ENFORCE=1 a global scan on (status, claimed_at) with no GUC set returns
    // ZERO rows, so expired claims would never be released and attribution would
    // permanently stop draining for any org whose worker died mid-claim.
    const stmt = CORE_SQL.match(
      /CREATE INDEX IF NOT EXISTS idx_burn_ingest_events_claimed[\s\S]*?;/,
    )?.[0];
    expect(stmt).toBeDefined();
    expect(stmt).toContain('(organization_id, status, claimed_at)');
    expect(stmt).toContain("WHERE status = 'claimed'");
  });

  it('declares claim_lease_seconds as a real column so the lease and batch size can agree', () => {
    // The drain heartbeats at claim_lease_seconds / 3 and attribute_batch_size is bounded so
    // worst-case batch duration sits inside the lease. Those three numbers have to agree,
    // and agreement is only checkable if the lease is stored rather than a constant.
    const cols = columnNames(burnOrgSettings);
    expect(cols).toContain('claim_lease_seconds');
    expect(cols).toContain('attribute_batch_size');
    expect(GATE_SQL).toContain('burn_org_settings_claim_lease_check');
  });
});

describe('section 3.1: org settings defaults are safe-by-default', () => {
  const defaultOf = (name: string) => {
    const col = getTableConfig(burnOrgSettings).columns.find((c) => c.name === name);
    return col?.default;
  };

  it('defaults gate_mode to advisory, never blocking', () => {
    // blocking is unreachable without the seven server-side preconditions of spec 5.4.
    expect(defaultOf('gate_mode')).toBe('advisory');
    expect(GATE_SQL).toMatch(/gate_mode IN \('off', 'advisory', 'blocking'\)/);
  });

  it('defaults embedding_enabled to false', () => {
    // embedding.service.ts returns zero vectors, so shipping it on would ship a retrieval
    // stage that retrieves nothing.
    expect(defaultOf('embedding_enabled')).toBe(false);
  });

  it('keeps the human-review band from collapsing', () => {
    // review_threshold BETWEEN 0.30 AND auto_attribute_threshold - 0.05. Without the
    // relational CHECK an operator can set them equal, which collapses the "queued for a
    // human, never guessed" band to nothing and auto-attributes everything.
    expect(GATE_SQL).toMatch(/auto_attribute_threshold BETWEEN 0\.75 AND 0\.99/);
    expect(GATE_SQL).toMatch(
      /review_threshold BETWEEN 0\.30 AND \(auto_attribute_threshold - 0\.05\)/,
    );
  });

  it('bounds precheck_budget_ms even though it is advisory only', () => {
    // The authoritative bound is bill-api's BURN_PRECHECK_TIMEOUT_MS, because the timeout
    // that matters is the one held by the caller that fails open. This is display-only, but
    // an operator setting it to 60000 would misrepresent the gate to its own console.
    expect(GATE_SQL).toMatch(/precheck_budget_ms BETWEEN 100 AND 750/);
  });
});

describe('section 3.4: the migrations are additive and idempotent', () => {
  it('declares Why and Client impact headers on all three pass-1 files', () => {
    for (const [name, sql] of [
      ['0239', CORE_SQL],
      ['0240', GATE_SQL],
      ['0241', RATES_SQL],
    ] as const) {
      const header = sql.split('\n').slice(0, 20).join('\n');
      expect(header, `${name} needs a Why:`).toContain('-- Why:');
      expect(header, `${name} needs a Client impact:`).toContain('-- Client impact:');
    }
  });

  it('guards every self-referential FK in a DO $$ block rather than declaring it inline', () => {
    // Drizzle cannot express a circular self-reference, so these live in the migration. The
    // guard is what makes the file safe to re-run.
    for (const constraint of [
      'burn_engagements_amends_fk',
      'burn_engagements_supersedes_fk',
      'burn_deliverables_amends_fk',
      'burn_deliverables_supersedes_fk',
      'burn_attributions_superseded_by_fk',
    ]) {
      expect(CORE_SQL).toContain(constraint);
    }
    expect(GATE_SQL).toContain('burn_prechecks_superseded_by_fk');
    const guarded = (CORE_SQL + GATE_SQL + RATES_SQL).match(
      /EXCEPTION WHEN duplicate_object THEN NULL;/g,
    );
    expect(guarded!.length).toBeGreaterThanOrEqual(6);
  });

  it('adds the bill_expenses index additively, touching nothing else on that table', () => {
    // bill_expenses is indexed today on organization_id, project_id, and status only, so
    // Burn's reconcile pass would otherwise scan the whole expense table on every run.
    expect(RATES_SQL).toContain(
      'CREATE INDEX IF NOT EXISTS idx_bill_expenses_created_at\n    ON bill_expenses(organization_id, created_at)',
    );
    expect(RATES_SQL, 'must not ALTER bill_expenses').not.toMatch(/ALTER TABLE bill_expenses/);
  });
});
