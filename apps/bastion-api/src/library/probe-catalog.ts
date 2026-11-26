// The closed probe menu (spec 3.1) as data the compiler, the routes and the SPA share.
//
// Each entry names a hardened definer function from migration 0279 by key and version
// (bastion_probe_<key>_v<version>), the parameters that function reads (validated here, so an
// unknown key or an out-of-range value never reaches `proposed`; spec 2.1 step 3), and the
// thresholds the TypeScript predicate applies at M4. The M4 probe modules
// (apps/bastion-api/src/probes/<key>.ts) import their paramsSchema and predicateSchema from here
// rather than restating them: one place encodes each probe's inputs.

import { z } from 'zod';
import { BASTION_PROBE_KEYS, type BastionPopulationKind, type BastionProbeKey } from '@bigbluebam/shared';

export interface ProbeCatalogEntry {
  key: BastionProbeKey;
  version: number;
  /** Plain name shown on default views (never the key). */
  title: string;
  /** One plain sentence: what the check looks at. */
  description: string;
  /** Set when the probe checks a human-confirmed population (spec 3.1 population rule). */
  population_kind: BastionPopulationKind | null;
  /** "Provided by your hosting platform" (spec 3.1). */
  inherited: boolean;
  paramsSchema: z.ZodTypeAny;
  predicateSchema: z.ZodTypeAny;
}

const days = (max: number) => z.number().int().min(1).max(max);
const population = z.array(z.string().trim().min(1).max(256)).max(500);

/**
 * Population bookkeeping every population probe accepts in its params. The SQL function reads
 * only `expected_population`; the labels and the confirmation stamp are for people and for the
 * population_review gap (spec 2.3).
 */
const populationParams = {
  expected_population: population.optional(),
  population_labels: z.record(z.string().max(256)).optional(),
  population_confirmed_at: z.string().datetime({ offset: true }).optional(),
  population_confirmed_by: z.string().uuid().optional(),
};

const noPredicate = z.object({}).strict();

export const PROBE_CATALOG: readonly ProbeCatalogEntry[] = [
  {
    key: 'keys.max_age',
    version: 1,
    title: 'API key age',
    description: 'Looks for API keys that have not been replaced for longer than the limit.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ max_age_days: days(3650).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'keys.unused_active',
    version: 1,
    title: 'Unused API keys',
    description: 'Looks for API keys that still work but have not been used for a long time.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ unused_days: days(3650).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'access.departed_still_holding',
    version: 1,
    title: 'Leavers still holding access',
    description: 'Looks for people who have left the organization but still have a key or a live sign-in.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({}).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'access.dormant_accounts',
    version: 1,
    title: 'Dormant accounts',
    description: 'Looks for members who have not signed in for a long time.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ dormant_days: days(3650).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'access.privileged_roster',
    version: 1,
    title: 'Number of owners and admins',
    description: 'Counts the people who can change organization-wide settings.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ max_privileged: z.number().int().min(1).max(1000).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'auth.failed_login_spikes',
    version: 1,
    title: 'Bursts of failed sign-ins',
    description: 'Looks for hours in which one account failed to sign in many times.',
    population_kind: null,
    inherited: false,
    paramsSchema: z
      .object({ window_days: days(365).optional(), spike_threshold: z.number().int().min(2).max(10000).optional() })
      .strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'agents.policy_coverage',
    version: 1,
    title: 'AI agent rules',
    description: 'Checks that every AI agent has a written rule set and none may use every tool.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({}).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'agents.human_approval',
    version: 1,
    title: 'Human approval of agent actions',
    description: 'Checks that agent proposals are decided by people and few are left to expire.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ window_days: days(365).optional() }).strict(),
    predicateSchema: z.object({ max_expired_undecided: z.number().int().min(0).max(1000).optional() }).strict(),
  },
  {
    key: 'change.merge_reviewed',
    version: 1,
    title: 'Code changes reviewed by a second person',
    description: 'Checks that changes merged in the listed repositories were approved by someone other than the author.',
    population_kind: 'github_repos',
    inherited: false,
    paramsSchema: z.object({ window_days: days(365).optional(), ...populationParams }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'change.merge_traceable',
    version: 1,
    title: 'Code changes linked to planned work',
    description: 'Checks that changes merged in the listed repositories mention a task.',
    population_kind: 'github_repos',
    inherited: false,
    paramsSchema: z.object({ window_days: days(365).optional(), ...populationParams }).strict(),
    predicateSchema: z.object({ min_ratio: z.number().min(0.5).max(1).optional() }).strict(),
  },
  {
    key: 'ops.backup_fresh',
    version: 1,
    title: 'Recent off-site backup',
    description: 'Checks that a backup finished in the last day and an off-site copy is current.',
    population_kind: null,
    inherited: true,
    paramsSchema: z.object({}).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'ops.restore_tested',
    version: 1,
    title: 'Restore tested',
    description: 'Checks that a backup was restored successfully within the last year.',
    population_kind: null,
    inherited: true,
    paramsSchema: z.object({ window_days: days(1095).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'logging.retention_floor',
    version: 1,
    title: 'How long logs are kept',
    description: 'Checks that every listed app keeps its logs for at least the minimum time.',
    population_kind: 'blip_apps',
    inherited: false,
    paramsSchema: z.object({ floor_days: days(3650).optional(), ...populationParams }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'logging.audit_trail_alive',
    version: 1,
    title: 'Activity trail recording',
    description: 'Checks that the suite recorded activity recently.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ window_days: days(90).optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'automation.failure_rate',
    version: 1,
    title: 'Automation failures',
    description: 'Checks that few automation runs failed recently.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ window_days: days(365).optional() }).strict(),
    predicateSchema: z.object({ max_failure_ratio: z.number().min(0).max(0.5).optional() }).strict(),
  },
  {
    key: 'policy.attested',
    // v2 (migration 0288, #244): reports the Beacon article's state; nobody is due on an article
    // that is missing, retired or expired.
    version: 2,
    title: 'Policy read and acknowledged',
    description: 'Checks that everyone required has acknowledged the current version of a policy.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({ policy_id: z.string().uuid().optional() }).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'policy.current',
    version: 1,
    title: 'Policy kept current',
    description: 'Checks that a policy article is active, visible to the organization and recently reviewed.',
    population_kind: null,
    inherited: false,
    paramsSchema: z
      .object({ policy_id: z.string().uuid().optional(), beacon_entry_id: z.string().uuid().optional() })
      .strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'platform.superuser_access',
    version: 1,
    title: 'Hosting platform staff access',
    description: 'Counts actions the hosting platform staff took inside this organization.',
    population_kind: null,
    inherited: true,
    paramsSchema: z.object({ window_days: days(365).optional() }).strict(),
    predicateSchema: z.object({ max_actions: z.number().int().min(0).max(100000).optional() }).strict(),
  },
  {
    key: 'vendors.critical_have_award',
    version: 1,
    title: 'Critical suppliers under contract',
    description: 'Checks that every supplier marked critical has an active award on file.',
    population_kind: null,
    inherited: false,
    paramsSchema: z.object({}).strict(),
    predicateSchema: noPredicate,
  },
  {
    key: 'feed.fresh',
    version: 1,
    title: 'Evidence feed is up to date',
    description: 'Checks that a connected system sent its evidence records on time.',
    population_kind: null,
    inherited: false,
    paramsSchema: z
      .object({ feed_id: z.string().uuid().optional(), cadence_days: days(365).optional() })
      .strict(),
    predicateSchema: z.object({ min_records: z.number().int().min(1).max(1000000).optional() }).strict(),
  },
];

const BY_KEY = new Map<string, ProbeCatalogEntry>(PROBE_CATALOG.map((p) => [p.key, p]));

export function probeEntry(key: string): ProbeCatalogEntry | undefined {
  return BY_KEY.get(key);
}

/** Every key the shared enum knows must have exactly one catalog entry (tested). */
export function catalogCoversSharedKeys(): boolean {
  return BASTION_PROBE_KEYS.every((k) => BY_KEY.has(k)) && BY_KEY.size === BASTION_PROBE_KEYS.length;
}

/** The public view of the catalog for GET /probes (no Zod objects). */
export function publicProbeCatalog() {
  return PROBE_CATALOG.map((p) => ({
    key: p.key,
    version: p.version,
    title: p.title,
    description: p.description,
    population_kind: p.population_kind,
    inherited: p.inherited,
  }));
}
