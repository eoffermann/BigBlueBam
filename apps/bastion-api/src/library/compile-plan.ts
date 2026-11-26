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
  /** `library` (verbatim suggestion) or `compiler` (AI-tailored, validated). Default library. */
  proposed_by?: 'library' | 'compiler';
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

export interface ControlPlan {
  planned: PlannedAssertion[];
  dropped: DroppedSuggestion[];
  skipped_existing: number;
}

function liveSignatures(existing: readonly ExistingAssertionSignature[]): Set<string> {
  return new Set(existing.filter((e) => LIVE.has(e.review_status)).map((e) => `${e.control_key}|${signatureOf(e)}`));
}

/**
 * Plan one control from a set of suggestions (the library's, or the AI's after tailoring). Every
 * suggestion goes through the same validator; anything already live on the control is skipped.
 */
export function planControl(
  key: string,
  suggestions: { probes: readonly ProbeSuggestion[]; manual: readonly ManualSuggestion[] },
  existing: readonly ExistingAssertionSignature[],
  populations: ConnectedPopulations,
  proposedBy: 'library' | 'compiler' = 'library',
): ControlPlan {
  const live = liveSignatures(existing);
  const out: ControlPlan = { planned: [], dropped: [], skipped_existing: 0 };
  const seen = new Set<string>();
  for (const s of suggestions.probes) {
    const sig = `${key}|probe:${s.probe_key}`;
    if (live.has(sig) || seen.has(sig)) {
      out.skipped_existing += 1;
      continue;
    }
    const v = validateProbeSuggestion(s, populations);
    if (!v.ok) out.dropped.push({ control_key: key, what: `probe ${s.probe_key}`, reason: v.reason });
    else {
      seen.add(sig);
      out.planned.push({ control_key: key, ...v.value, proposed_by: proposedBy });
    }
  }
  for (const s of suggestions.manual) {
    const title = typeof s.spec?.title === 'string' ? s.spec.title : '';
    const sig = `${key}|manual:${title.toLowerCase()}`;
    if (live.has(sig) || seen.has(sig)) {
      out.skipped_existing += 1;
      continue;
    }
    const v = validateManualSuggestion(s);
    if (!v.ok) out.dropped.push({ control_key: key, what: `manual ${title}`, reason: v.reason });
    else {
      seen.add(sig);
      out.planned.push({ control_key: key, ...v.value, proposed_by: proposedBy });
    }
  }
  return out;
}

/** The library's suggestions for one control (custom controls have none). */
export function librarySuggestions(key: string): { probes: ProbeSuggestion[]; manual: ManualSuggestion[] } {
  const lib = libraryControl(key);
  return { probes: lib ? [...lib.suggested_assertions] : [], manual: lib ? [...lib.suggested_manual_evidence] : [] };
}

export interface TailoredControlPlan extends ControlPlan {
  /** The AI's per-requirement "not applicable" suggestions (a person decides them in Setup). */
  not_applicable: Array<{ ref_code: string; reason: string }>;
  /** True when the library's suggestions were used because the AI gave nothing usable. */
  used_fallback: boolean;
}

/**
 * Plan one control from the AI's validated suggestions, falling back to the library verbatim
 * (spec 2.1 step 5) when nothing the AI said survives validation and it claimed no requirement is
 * out of scope. So every control ends with a check, an evidence request or a not-applicable
 * suggestion (the compiler coverage gate, spec 11.3), or already had them.
 */
export function planTailoredControl(
  key: string,
  tailored: { probes: readonly ProbeSuggestion[]; manual: readonly ManualSuggestion[]; not_applicable: ReadonlyArray<{ ref_code: string; reason: string }>; dropped: readonly DroppedSuggestion[] } | null,
  existing: readonly ExistingAssertionSignature[],
  populations: ConnectedPopulations,
  fallbackReason: string | null = null,
): TailoredControlPlan {
  if (tailored) {
    const ai = planControl(key, tailored, existing, populations, 'compiler');
    const dropped = [...tailored.dropped, ...ai.dropped];
    if (ai.planned.length > 0 || ai.skipped_existing > 0 || tailored.not_applicable.length > 0) {
      return { ...ai, dropped, not_applicable: [...tailored.not_applicable], used_fallback: false };
    }
    const lib = planControl(key, librarySuggestions(key), existing, populations, 'library');
    return {
      ...lib,
      dropped: [...dropped, ...lib.dropped, { control_key: key, what: 'AI suggestions', reason: 'nothing usable came back, so the library suggestions were proposed' }],
      not_applicable: [],
      used_fallback: true,
    };
  }
  const lib = planControl(key, librarySuggestions(key), existing, populations, 'library');
  return {
    ...lib,
    dropped: fallbackReason ? [...lib.dropped, { control_key: key, what: 'AI suggestions', reason: fallbackReason }] : lib.dropped,
    not_applicable: [],
    used_fallback: true,
  };
}

export function planCompile(
  controlKeys: readonly string[],
  existing: readonly ExistingAssertionSignature[],
  populations: ConnectedPopulations,
  overrides?: { probe?: (key: string) => ProbeSuggestion[] | undefined },
): CompilePlan {
  const planned: PlannedAssertion[] = [];
  const dropped: DroppedSuggestion[] = [];
  let skipped = 0;
  for (const key of controlKeys) {
    if (!libraryControl(key)) continue; // custom controls have no library suggestions
    const lib = librarySuggestions(key);
    const p = planControl(key, { probes: overrides?.probe?.(key) ?? lib.probes, manual: lib.manual }, existing, populations, 'library');
    planned.push(...p.planned);
    dropped.push(...p.dropped);
    skipped += p.skipped_existing;
  }
  return { planned, dropped, skipped_existing: skipped, controls_total: controlKeys.length };
}
