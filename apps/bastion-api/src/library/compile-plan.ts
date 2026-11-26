// The deterministic compile (spec 2.1 steps 3 to 5) as a pure planner. Given the controls a
// framework needs, what each already has, and the connected populations, it returns the
// assertions to propose and the suggestions it dropped with a recorded reason. No LLM: the
// library's suggestions are proposed verbatim and each population is proposed from the connected
// set, for a person to confirm as complete (LLM tailoring is M7 and runs through the same
// validator).

import { bastionManualEvidenceSpecSchema, type BastionManualEvidenceSpec, type BastionPopulationKind } from '@bigbluebam/shared';
import { libraryControl, type ManualSuggestion, type ProbeSuggestion } from './controls.js';
import { probeEntry } from './probe-catalog.js';

export interface PopulationMember {
  value: string;
  label: string;
}

export type ConnectedPopulations = Record<BastionPopulationKind, PopulationMember[]>;

export interface ExistingAssertionSignature {
  control_key: string;
  kind: string;
  probe_key: string | null;
  manual_title: string | null;
  review_status: string;
}

export interface PlannedAssertion {
  control_key: string;
  kind: 'probe' | 'manual';
  probe_key: string | null;
  probe_version: number | null;
  params: Record<string, unknown>;
  predicate: Record<string, unknown>;
  manual_evidence_spec: BastionManualEvidenceSpec | null;
  plain_statement: string;
}

export interface DroppedSuggestion {
  control_key: string;
  what: string;
  reason: string;
}

export interface CompilePlan {
  planned: PlannedAssertion[];
  dropped: DroppedSuggestion[];
  /** Controls that got nothing new because they already have a live assertion of that shape. */
  skipped_existing: number;
  controls_total: number;
}

type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Validate one probe suggestion against the closed menu: the key must exist, and the parameters
 * and thresholds must pass the probe's own schemas (out-of-range values are dropped, not clamped).
 */
export function validateProbeSuggestion(
  s: ProbeSuggestion,
  populations?: ConnectedPopulations,
): Validated<Omit<PlannedAssertion, 'control_key'>> {
  const entry = probeEntry(s.probe_key);
  if (!entry) return { ok: false, reason: `unknown probe "${s.probe_key}"` };
  const params: Record<string, unknown> = { ...(s.params ?? {}) };
  if (entry.population_kind && populations && params.expected_population === undefined) {
    const members = populations[entry.population_kind] ?? [];
    params.expected_population = members.map((m) => m.value);
    params.population_labels = Object.fromEntries(members.map((m) => [m.value, m.label]));
  }
  const p = entry.paramsSchema.safeParse(params);
  if (!p.success) return { ok: false, reason: `parameters out of range for "${s.probe_key}": ${p.error.issues[0]?.message ?? 'invalid'}` };
  const pred = entry.predicateSchema.safeParse(s.predicate ?? {});
  if (!pred.success) {
    return { ok: false, reason: `threshold out of range for "${s.probe_key}": ${pred.error.issues[0]?.message ?? 'invalid'}` };
  }
  return {
    ok: true,
    value: {
      kind: 'probe',
      probe_key: entry.key,
      probe_version: entry.version,
      params: p.data as Record<string, unknown>,
      predicate: pred.data as Record<string, unknown>,
      manual_evidence_spec: null,
      plain_statement: s.plain_statement,
    },
  };
}

export function validateManualSuggestion(s: ManualSuggestion): Validated<Omit<PlannedAssertion, 'control_key'>> {
  const spec = bastionManualEvidenceSpecSchema.safeParse(s.spec);
  if (!spec.success) return { ok: false, reason: `manual evidence request is invalid: ${spec.error.issues[0]?.message ?? 'invalid'}` };
  return {
    ok: true,
    value: {
      kind: 'manual',
      probe_key: null,
      probe_version: null,
      params: {},
      predicate: {},
      manual_evidence_spec: spec.data,
      plain_statement: s.plain_statement,
    },
  };
}

const LIVE = new Set(['proposed', 'confirmed']);

function signatureOf(a: { kind: string; probe_key: string | null; manual_title: string | null }): string {
  return a.kind === 'probe' ? `probe:${a.probe_key}` : `${a.kind}:${(a.manual_title ?? '').toLowerCase()}`;
}

export function planCompile(
  controlKeys: readonly string[],
  existing: readonly ExistingAssertionSignature[],
  populations: ConnectedPopulations,
  overrides?: { probe?: (key: string) => ProbeSuggestion[] | undefined },
): CompilePlan {
  const live = new Set(
    existing.filter((e) => LIVE.has(e.review_status)).map((e) => `${e.control_key}|${signatureOf(e)}`),
  );
  const planned: PlannedAssertion[] = [];
  const dropped: DroppedSuggestion[] = [];
  let skipped = 0;
  for (const key of controlKeys) {
    const lib = libraryControl(key);
    if (!lib) continue; // custom controls have no library suggestions
    const probes = overrides?.probe?.(key) ?? lib.suggested_assertions;
    for (const s of probes) {
      if (live.has(`${key}|probe:${s.probe_key}`)) {
        skipped += 1;
        continue;
      }
      const v = validateProbeSuggestion(s, populations);
      if (!v.ok) dropped.push({ control_key: key, what: `probe ${s.probe_key}`, reason: v.reason });
      else planned.push({ control_key: key, ...v.value });
    }
    for (const s of lib.suggested_manual_evidence) {
      if (live.has(`${key}|manual:${s.spec.title.toLowerCase()}`)) {
        skipped += 1;
        continue;
      }
      const v = validateManualSuggestion(s);
      if (!v.ok) dropped.push({ control_key: key, what: `manual ${s.spec.title}`, reason: v.reason });
      else planned.push({ control_key: key, ...v.value });
    }
  }
  return { planned, dropped, skipped_existing: skipped, controls_total: controlKeys.length };
}
