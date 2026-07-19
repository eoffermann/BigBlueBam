import { and, eq } from 'drizzle-orm';
import type { BurnMoneyBlock, BurnRevenueBasis, BurnStoredMetricBasis } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { burnEngagementRollups, burnEngagements } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';
import { buildMoneyBlock } from '../lib/redact-financial-fields.js';
import type { ViewerCaps } from '../lib/viewer-caps.js';
import { engagementScopePredicate } from '../lib/project-scope.js';
import { loadSettings } from './settings.service.js';
import type { Viewer } from './types.js';

/**
 * Per-chain financial figures. Spec 6.1 and 1.2.2.
 *
 * EVERY dollar and derived percentage on this surface goes through `buildMoneyBlock`, which
 * returns the `suppressed` union member for a caller without burn.financials.read_all. That
 * variant has NO cost, margin, or coverage key to populate, so leaking one to a member is
 * structurally impossible rather than conventionally discouraged.
 *
 * `margin_state` exists ONLY on the `true_margin` variant. Under `contract_consumption` the
 * equivalent field is `completion_state`, because a key named `margin_state` on a response
 * whose entire point is "this number is not margin" is the same mislabeling that motivated
 * renaming the `burn_margin` tool to `burn_financials`. A field name is a claim.
 */

function revenueBasisFor(envelopeBasis: string): BurnRevenueBasis {
  switch (envelopeBasis) {
    case 'fixed':
      return 'contract_value';
    case 'not_to_exceed':
      // NTE bills ACTUAL work up to a ceiling and never the ceiling itself. Grouping it with
      // `fixed` would report a $6,000 revenue on $2,000 of delivered work (R3-D1).
      return 'billable_recognized_capped';
    case 'retainer':
      return 'contract_value_per_period';
    default:
      return 'billable_recognized';
  }
}

export interface FinancialsResult {
  data: {
    chain_root_id: string;
    engagement_id: string;
    title: string;
    money: BurnMoneyBlock;
    final: boolean;
    stale: boolean;
  };
}

export async function getChainFinancials(
  viewer: Viewer,
  engagementId: string,
  caps: ViewerCaps,
): Promise<FinancialsResult> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [engagement] = await tx
      .select()
      .from(burnEngagements)
      .where(
        and(
          eq(burnEngagements.organization_id, viewer.org_id),
          eq(burnEngagements.id, engagementId),
          engagementScopePredicate(viewer, burnEngagements.id),
        ),
      )
      .limit(1);
    if (!engagement) throw new NotFoundError('Engagement not found');

    const settings = await loadSettings(tx, viewer.org_id);
    const rootId = engagement.chain_root_id ?? engagement.id;

    const [rollup] = await tx
      .select()
      .from(burnEngagementRollups)
      .where(
        and(
          eq(burnEngagementRollups.organization_id, viewer.org_id),
          eq(burnEngagementRollups.chain_root_id, rootId),
        ),
      )
      .limit(1);

    // A missing rollup is served as an honest zero-state with `stale: true` rather than an
    // unbounded live aggregate (spec 12.1). Computing a full chain roll-up synchronously on
    // a member's dashboard load is how a financials page becomes a 30-second query.
    const maxAgeMinutes = Number(settings.rollup_max_age_minutes ?? 60);
    const computedAt = rollup?.computed_at ? new Date(rollup.computed_at) : null;
    const stale =
      !rollup || !computedAt || Date.now() - computedAt.getTime() > maxAgeMinutes * 60_000;

    const money = buildMoneyBlock(
      {
        metric_basis: (rollup?.metric_basis as BurnStoredMetricBasis) ?? 'contract_consumption',
        revenue_basis:
          (rollup?.revenue_basis as BurnRevenueBasis) ?? revenueBasisFor(engagement.envelope_basis),
        currency: engagement.currency,
        as_of: (computedAt ?? new Date()).toISOString(),
        revenue_amount: rollup ? Number(rollup.attributed_billable ?? 0) : null,
        contract_value: rollup ? Number(rollup.contract_value ?? 0) : Number(engagement.contract_value ?? 0),
        attributed_billable: rollup ? Number(rollup.attributed_billable ?? 0) : null,
        attributed_cost: rollup ? Number(rollup.attributed_cost ?? 0) : null,
        margin_amount: rollup?.margin_amount === null || rollup === undefined ? null : Number(rollup.margin_amount),
        margin_pct: rollup?.margin_pct == null ? null : Number(rollup.margin_pct),
        contract_consumption_pct: rollup?.consumption_pct == null ? null : Number(rollup.consumption_pct),
        cost_rate_coverage_pct:
          rollup?.cost_rate_coverage_pct == null ? null : Number(rollup.cost_rate_coverage_pct),
        margin_state: (rollup?.margin_state as 'in_progress' | 'final' | null) ?? null,
        distinct_contributor_count: Number(rollup?.distinct_contributor_count ?? 0),
        min_contributors_for_cost_aggregate: Number(
          settings.min_contributors_for_cost_aggregate ?? 3,
        ),
      },
      caps,
    );

    return {
      data: {
        chain_root_id: rootId,
        engagement_id: engagement.id,
        title: engagement.title,
        money,
        final: rollup?.margin_state === 'final',
        stale,
      },
    };
  });
}

/**
 * Firm-wide roll-up. read_all + the second in-route role guard.
 *
 * THE ACCOUNT BASIS IS THE WEAKEST MEMBER (spec 6.1). If any chain under an account reports
 * `contract_consumption` (because cost-rate coverage is incomplete somewhere), the ACCOUNT
 * reports `contract_consumption` too. The alternative -- reporting `true_margin` because most
 * chains have rates -- would put the word "Margin" above a number that is partly consumption,
 * which is the precise mislabeling this whole basis discriminator exists to prevent.
 */
export async function getAccountFinancials(viewer: Viewer, caps: ViewerCaps) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await loadSettings(tx, viewer.org_id);
    const rows = await tx
      .select({
        rollup: burnEngagementRollups,
        account_id: burnEngagements.account_id,
        account_type: burnEngagements.account_type,
        braid_profile_id: burnEngagements.braid_profile_id,
        currency: burnEngagements.currency,
        envelope_basis: burnEngagements.envelope_basis,
        title: burnEngagements.title,
      })
      .from(burnEngagementRollups)
      .innerJoin(
        burnEngagements,
        eq(burnEngagements.id, burnEngagementRollups.chain_root_id),
      )
      .where(eq(burnEngagementRollups.organization_id, viewer.org_id));

    // Group by the Braid golden id when one resolved, else by the raw account id. That is
    // what makes three differently-spelled versions of one client roll up as one account.
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.braid_profile_id ?? r.account_id ?? 'unassigned';
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const accounts = [...groups.entries()].map(([key, members]) => {
      const weakestBasis: BurnStoredMetricBasis = members.some(
        (m) => (m.rollup.metric_basis ?? 'contract_consumption') === 'contract_consumption',
      )
        ? 'contract_consumption'
        : 'true_margin';

      const sum = (pick: (r: (typeof members)[number]) => number | null) =>
        members.reduce((acc, m) => acc + (Number(pick(m) ?? 0) || 0), 0);

      const contractValue = sum((m) => m.rollup.contract_value);
      const billable = sum((m) => m.rollup.attributed_billable);
      const cost = sum((m) => m.rollup.attributed_cost);
      const contributors = members.reduce(
        (acc, m) => acc + Number(m.rollup.distinct_contributor_count ?? 0),
        0,
      );

      return {
        account_key: key,
        account_type: members[0]?.account_type ?? null,
        chain_count: members.length,
        money: buildMoneyBlock(
          {
            metric_basis: weakestBasis,
            revenue_basis: revenueBasisFor(members[0]?.envelope_basis ?? 'fixed'),
            currency: members[0]?.currency ?? 'USD',
            as_of: new Date().toISOString(),
            revenue_amount: billable,
            contract_value: contractValue,
            attributed_billable: billable,
            attributed_cost: cost,
            margin_amount: weakestBasis === 'true_margin' ? billable - cost : null,
            margin_pct:
              weakestBasis === 'true_margin' && billable > 0
                ? ((billable - cost) / billable) * 100
                : null,
            contract_consumption_pct: contractValue > 0 ? (billable / contractValue) * 100 : null,
            cost_rate_coverage_pct: null,
            margin_state: 'in_progress',
            distinct_contributor_count: contributors,
            min_contributors_for_cost_aggregate: Number(
              settings.min_contributors_for_cost_aggregate ?? 3,
            ),
          },
          caps,
        ),
      };
    });

    return { data: accounts };
  });
}

/**
 * CSV export. read_all + the in-route guard, and the HEADER ROW CARRIES THE DISCRIMINATOR.
 *
 * A CSV that says "Margin" in a column header when the underlying basis is
 * `contract_consumption` is the single most durable form of this mislabeling, because the
 * file outlives the request, gets emailed, and lands in a board deck with no context. So the
 * header names the basis explicitly and the column name changes with it.
 */
export async function exportFinancialsCsv(viewer: Viewer, caps: ViewerCaps): Promise<string> {
  const { data: accounts } = await getAccountFinancials(viewer, caps);
  const lines: string[] = [];
  const anyConsumption = accounts.some((a) => a.money.metric_basis !== 'true_margin');
  const valueHeader = anyConsumption ? 'contract_consumption_pct' : 'margin_pct';
  lines.push(`# metric_basis=${anyConsumption ? 'contract_consumption' : 'true_margin'}`);
  lines.push(`account_key,account_type,chain_count,metric_basis,revenue_basis,currency,${valueHeader}`);
  for (const a of accounts) {
    const value =
      a.money.metric_basis === 'true_margin'
        ? (a.money.margin_pct ?? '')
        : (a.money.contract_consumption_pct ?? '');
    lines.push(
      [
        csvCell(a.account_key),
        csvCell(a.account_type ?? ''),
        a.chain_count,
        a.money.metric_basis,
        a.money.revenue_basis,
        a.money.currency,
        value,
      ].join(','),
    );
  }
  return lines.join('\n');
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
