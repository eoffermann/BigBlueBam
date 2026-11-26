// The TypeScript half of every native probe (spec 3.1). The SQL half is a hardened definer
// function from migration 0279 that returns facts; this module turns those facts into an
// outcome. Per probe: { key, version, paramsSchema, preconditions(), predicate(), explain() }.
//
// One registry rather than twenty files: the contract per probe is the same, and the params and
// predicate schemas are imported from library/probe-catalog.ts so each probe's inputs are encoded
// in exactly one place (M3 decision).
//
// Rules held here:
//   - preconditions never depend on the control operating (spec 3.1 precondition rule);
//   - explain() is counts-only unless detail is allowed, and always names the population checked;
//   - every outcome is pass, fail, or unprovable with one stored reason (spec 3.2).

import type { z } from 'zod';
import { BASTION_DAY_MS, type BastionProbeKey, type BastionProbeResult, type BastionStoredUnprovableReason } from '@bigbluebam/shared';
import { PROBE_CATALOG, type ProbeCatalogEntry } from '../library/probe-catalog.js';

export type ProbeOutcome =
  | { outcome: 'pass' }
  | { outcome: 'fail' }
  | { outcome: 'unprovable'; reason: BastionStoredUnprovableReason };

export interface ProbeDefinition {
  key: BastionProbeKey;
  version: number;
  paramsSchema: z.ZodTypeAny;
  predicateSchema: z.ZodTypeAny;
  /** A reason the probe cannot judge (else null). Evaluated on the facts the function returned. */
  preconditions(result: BastionProbeResult): BastionStoredUnprovableReason | null;
  /** The pass/fail decision on facts that passed the preconditions. */
  predicate(result: BastionProbeResult, predicate: Record<string, unknown>): ProbeOutcome;
  /** One or two plain sentences. Counts only unless detailAllowed. */
  explain(result: BastionProbeResult, detailAllowed: boolean): string;
}

type Facts = Record<string, unknown>;

const num = (s: Facts, k: string): number => {
  const v = s[k];
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : 0;
};
const bool = (s: Facts, k: string): boolean | null => (typeof s[k] === 'boolean' ? (s[k] as boolean) : null);
const str = (s: Facts, k: string): string | null => (typeof s[k] === 'string' ? (s[k] as string) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PASS: ProbeOutcome = { outcome: 'pass' };
const FAIL: ProbeOutcome = { outcome: 'fail' };
const unprovable = (reason: BastionStoredUnprovableReason): ProbeOutcome => ({ outcome: 'unprovable', reason });

function populationSentence(r: BastionProbeResult, detailAllowed: boolean, noun: string): string {
  const checked = r.population_checked ?? [];
  const missing = r.population_missing ?? [];
  const unlisted = r.population_unlisted ?? [];
  let out = `Checked ${plural(checked.length, noun)}`;
  if (detailAllowed && checked.length > 0) out += ` (${checked.join(', ')})`;
  out += '.';
  if (missing.length > 0) out += ` ${plural(missing.length, noun)} on the list ${missing.length === 1 ? 'is' : 'are'} not connected.`;
  if (unlisted.length > 0) out += ` ${plural(unlisted.length, noun)} connected but not on the list.`;
  return out;
}

/** Population probes: a listed member that is not connected means the source is not connected. */
function populationPrecondition(r: BastionProbeResult): BastionStoredUnprovableReason | null {
  if ((r.population_checked ?? []).length === 0) return 'source_not_connected';
  if ((r.population_missing ?? []).length > 0) return 'source_not_connected';
  return null;
}

const none = () => null;

type Impl = Omit<ProbeDefinition, 'key' | 'version' | 'paramsSchema' | 'predicateSchema'>;

const IMPLS: Record<BastionProbeKey, Impl> = {
  'keys.max_age': {
    preconditions: none,
    predicate: (r) => (r.cited_count > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'keys_checked'), 'API key')} checked; ${plural(r.cited_count, 'key')} not replaced within ${num(r.summary, 'max_age_days')} days.`,
  },
  'keys.unused_active': {
    preconditions: none,
    predicate: (r) => (r.cited_count > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'keys_checked'), 'API key')} checked; ${plural(r.cited_count, 'key')} unused for ${num(r.summary, 'unused_days')} days or more.`,
  },
  'access.departed_still_holding': {
    preconditions: none,
    predicate: (r) => (r.cited_count > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'people_holding_access'), 'person', 'people')} hold a key or a live sign-in; ${plural(r.cited_count, 'of them has', 'of them have')} left the organization or been disabled.`,
  },
  'access.dormant_accounts': {
    preconditions: none,
    predicate: (r) => (r.cited_count > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'members_checked'), 'member')} checked; ${plural(r.cited_count, 'has', 'have')} not signed in for ${num(r.summary, 'dormant_days')} days.`,
  },
  'access.privileged_roster': {
    preconditions: none,
    predicate: (r) => (bool(r.summary, 'over_limit') ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'privileged_count'), 'person', 'people')} can change organization-wide settings; the limit is ${num(r.summary, 'max_privileged')}.`,
  },
  'auth.failed_login_spikes': {
    preconditions: none,
    predicate: (r) => (num(r.summary, 'spike_hours') > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'spike_hours'), 'hour')} in the last ${num(r.summary, 'window_days')} days had ${num(r.summary, 'spike_threshold')} or more failed sign-ins for one account.`,
  },
  'agents.policy_coverage': {
    preconditions: none,
    predicate: (r) => (r.cited_count > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'agents_checked'), 'AI agent')} checked; ${num(r.summary, 'missing_policy')} without a rule set and ${num(r.summary, 'bare_wildcard')} allowed every tool.`,
  },
  'agents.human_approval': {
    preconditions: none,
    predicate: (r, p) => {
      const maxExpired = typeof p.max_expired_undecided === 'number' ? p.max_expired_undecided : 5;
      if (num(r.summary, 'decided_without_required_human') > 0) return FAIL;
      return num(r.summary, 'expired_undecided') > maxExpired ? FAIL : PASS;
    },
    explain: (r) =>
      `${plural(num(r.summary, 'decided'), 'agent proposal')} decided in ${num(r.summary, 'window_days')} days; ${num(r.summary, 'expired_undecided')} expired undecided and ${num(r.summary, 'decided_without_required_human')} needed a person but were not decided by one.`,
  },
  'change.merge_reviewed': {
    preconditions: (r) => {
      const pre = populationPrecondition(r);
      if (pre) return pre;
      const repos = Array.isArray(r.summary.repos) ? (r.summary.repos as Facts[]) : [];
      // A known subscription list that lacks review events cannot prove anything. NULL is
      // unknown, not "not subscribed": the predicate still runs (spec 3.1).
      if (repos.some((x) => x.reviews_subscribed === false)) return 'source_not_connected';
      if (num(r.summary, 'merges') === 0) return 'insufficient_data';
      return null;
    },
    predicate: (r) => (num(r.summary, 'unreviewed_merges') > 0 ? FAIL : PASS),
    explain: (r, detail) => {
      const repos = Array.isArray(r.summary.repos) ? (r.summary.repos as Facts[]) : [];
      let out = `${populationSentence(r, detail, 'repository')} ${plural(num(r.summary, 'merges'), 'merge')} in ${num(r.summary, 'window_days')} days; ${num(r.summary, 'unreviewed_merges')} without approval from someone other than the author.`;
      if (repos.some((x) => x.reviews_subscribed === null)) {
        out +=
          ' We could not confirm GitHub sends review events; in GitHub open the webhook\'s Recent Deliveries and click Redeliver on the ping.';
      }
      return out;
    },
  },
  'change.merge_traceable': {
    preconditions: (r) => populationPrecondition(r) ?? (num(r.summary, 'merges') === 0 ? 'insufficient_data' : null),
    predicate: (r, p) => {
      const minRatio = typeof p.min_ratio === 'number' ? p.min_ratio : 0.9;
      const merges = num(r.summary, 'merges');
      const traced = merges - num(r.summary, 'untraced_merges');
      return traced / merges >= minRatio ? PASS : FAIL;
    },
    explain: (r, detail) =>
      `${populationSentence(r, detail, 'repository')} ${plural(num(r.summary, 'merges'), 'merge')} in ${num(r.summary, 'window_days')} days; ${num(r.summary, 'untraced_merges')} did not mention a task.`,
  },
  'ops.backup_fresh': {
    preconditions: (r) => (bool(r.summary, 'offsite_backup_configured') ? null : 'source_not_connected'),
    predicate: (r) => {
      if (num(r.summary, 'completed_backups') === 0) return FAIL;
      const hours = r.summary.hours_since_latest;
      if (typeof hours !== 'number' && typeof hours !== 'string') return FAIL;
      if (Number(hours) > 26) return FAIL;
      return str(r.summary, 'latest_mirror_status') === 'completed' ? PASS : FAIL;
    },
    explain: (r) =>
      `${plural(num(r.summary, 'completed_backups'), 'completed backup')}; the newest finished ${r.summary.hours_since_latest ?? 'never'} hours ago and its off-site copy is ${str(r.summary, 'latest_mirror_status') ?? 'not made'}.`,
  },
  'ops.restore_tested': {
    preconditions: none,
    predicate: (r) => (num(r.summary, 'completed_in_window') > 0 ? PASS : FAIL),
    explain: (r) =>
      `${plural(num(r.summary, 'completed_in_window'), 'successful restore')} in the last ${num(r.summary, 'window_days')} days.`,
  },
  'logging.retention_floor': {
    preconditions: populationPrecondition,
    predicate: (r) => (num(r.summary, 'below_floor') > 0 ? FAIL : PASS),
    explain: (r, detail) =>
      `${populationSentence(r, detail, 'app')} ${plural(num(r.summary, 'below_floor'), 'app')} keep logs for less than ${num(r.summary, 'floor_days')} days.`,
  },
  'logging.audit_trail_alive': {
    preconditions: none,
    predicate: (r) => (num(r.summary, 'activity_count') > 0 ? PASS : FAIL),
    explain: (r) =>
      `${plural(num(r.summary, 'activity_count'), 'activity record')} in the last ${num(r.summary, 'window_days')} days.`,
  },
  'automation.failure_rate': {
    preconditions: (r) => (num(r.summary, 'executions') === 0 ? 'insufficient_data' : null),
    predicate: (r, p) => {
      const max = typeof p.max_failure_ratio === 'number' ? p.max_failure_ratio : 0.05;
      return num(r.summary, 'failed') / num(r.summary, 'executions') <= max ? PASS : FAIL;
    },
    explain: (r) =>
      `${plural(num(r.summary, 'executions'), 'automation run')} in ${num(r.summary, 'window_days')} days; ${num(r.summary, 'failed')} failed.`,
  },
  'policy.attested': {
    preconditions: (r) => {
      if (!bool(r.summary, 'policy_found')) return 'no_evidence_source';
      return num(r.summary, 'required_people') === 0 ? 'insufficient_data' : null;
    },
    predicate: (r) => (num(r.summary, 'not_attested') > 0 ? FAIL : PASS),
    explain: (r) =>
      bool(r.summary, 'policy_found')
        ? `${plural(num(r.summary, 'required_people'), 'person', 'people')} must read the current version; ${num(r.summary, 'not_attested')} have not.`
        : 'No policy is linked to this check yet.',
  },
  'policy.current': {
    preconditions: (r) => (bool(r.summary, 'found') ? null : 'no_evidence_source'),
    predicate: (r) => {
      const status = (str(r.summary, 'status') ?? '').toLowerCase();
      const visibility = (str(r.summary, 'visibility') ?? '').toLowerCase();
      if (status !== 'active') return FAIL;
      if (visibility !== 'organization' && visibility !== 'public') return FAIL;
      const toExpiry = r.summary.days_to_expiry;
      if (typeof toExpiry === 'number' && toExpiry < 30) return FAIL;
      const sinceVerified = r.summary.days_since_verified;
      if (typeof sinceVerified !== 'number' || sinceVerified > 365) return FAIL;
      return PASS;
    },
    explain: (r) =>
      bool(r.summary, 'found')
        ? `The policy is ${str(r.summary, 'status') ?? 'unknown'} and shared with ${str(r.summary, 'visibility') ?? 'nobody'}; last reviewed ${r.summary.days_since_verified ?? 'never'} days ago.`
        : 'No policy is linked to this check yet.',
  },
  'platform.superuser_access': {
    preconditions: none,
    predicate: (r, p) => (typeof p.max_actions === 'number' && num(r.summary, 'actions') > p.max_actions ? FAIL : PASS),
    explain: (r) =>
      `Hosting platform staff took ${plural(num(r.summary, 'actions'), 'action')} in this organization in the last ${num(r.summary, 'window_days')} days.`,
  },
  'vendors.critical_have_award': {
    preconditions: none,
    predicate: (r) => (num(r.summary, 'without_award') > 0 ? FAIL : PASS),
    explain: (r) =>
      `${plural(num(r.summary, 'critical_vendors'), 'critical supplier')}; ${num(r.summary, 'without_award')} without an active award.`,
  },
  'feed.fresh': {
    preconditions: (r) => (bool(r.summary, 'feed_found') ? null : 'source_not_connected'),
    predicate: (r, p) => {
      const min = typeof p.min_records === 'number' ? p.min_records : 1;
      return num(r.summary, 'records_in_cadence') >= min ? PASS : FAIL;
    },
    explain: (r) =>
      bool(r.summary, 'feed_found')
        ? `${plural(num(r.summary, 'records_in_cadence'), 'record')} received in the last ${num(r.summary, 'cadence_days')} days.`
        : 'The evidence feed for this check is not set up.',
  },
};

function build(entry: ProbeCatalogEntry): ProbeDefinition {
  const impl = IMPLS[entry.key];
  return {
    key: entry.key,
    version: entry.version,
    paramsSchema: entry.paramsSchema,
    predicateSchema: entry.predicateSchema,
    ...impl,
  };
}

export const PROBES: ReadonlyMap<string, ProbeDefinition> = new Map(PROBE_CATALOG.map((e) => [e.key, build(e)]));

export function probeDefinition(key: string): ProbeDefinition | undefined {
  return PROBES.get(key);
}

/** Decide one probe result: preconditions first, then the predicate. */
export function decide(def: ProbeDefinition, result: BastionProbeResult, predicate: Record<string, unknown>): ProbeOutcome {
  const pre = def.preconditions(result);
  if (pre) return unprovable(pre);
  return def.predicate(result, predicate);
}

/** The evaluation window a probe looked at, from its own window_days fact. */
export function probeWindow(result: BastionProbeResult, asOf: Date): { start: Date | null; end: Date } {
  const days = result.summary.window_days ?? result.summary.cadence_days;
  if (typeof days === 'number' && days > 0) {
    return { start: new Date(asOf.getTime() - days * BASTION_DAY_MS), end: asOf };
  }
  return { start: null, end: asOf };
}
