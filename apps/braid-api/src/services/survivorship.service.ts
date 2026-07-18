import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { braidSurvivorshipRules } from '../db/schema/index.js';
import type { BraidSetSurvivorshipRuleInput } from './types.js';

// Per-org, per-field survivorship: which member value wins when a golden profile's
// identity set changes (spec 3.1 / 4.4). Implements the five strategies and the
// deterministic attribute recompute the merge executor relies on.

export type SurvivorshipStrategy =
  | 'most_recent'
  | 'source_priority'
  | 'longest_non_null'
  | 'most_frequent'
  | 'manual_pin';

export interface SurvivorshipRule {
  kind: string;
  field: string;
  strategy: SurvivorshipStrategy;
  source_priority: string[];
  pinned_value: unknown;
}

// A member identity as seen by the recompute. raw_attributes is the snapshot of the
// source fields Braid read; source_synced_at/linked_at drive most_recent tie-breaks.
export interface MemberIdentity {
  id: string;
  source_type: string;
  raw_attributes: Record<string, unknown>;
  source_synced_at: Date | string | null;
  linked_at: Date | string | null;
  link_confidence: string | number | null;
}

export interface AttributeProvenance {
  value: unknown;
  source_identity_id?: string;
  source_app?: string;
  rule?: string;
}

export interface RecomputedGolden {
  attributes: Record<string, AttributeProvenance>;
  display_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  company_profile_id: string | null;
  identity_count: number;
  confidence: string | null;
}

// The standard golden scalars are derived from these raw-attribute keys (first
// non-null wins). A source may store the name under `display_name` or `name`.
const NAME_KEYS = ['display_name', 'name'];
const EMAIL_KEYS = ['primary_email', 'email'];
const PHONE_KEYS = ['primary_phone', 'phone'];

const DEFAULT_STRATEGY: SurvivorshipStrategy = 'most_recent';

function ts(v: Date | string | null): number {
  if (!v) return 0;
  const d = v instanceof Date ? v : new Date(v);
  const n = d.getTime();
  return Number.isNaN(n) ? 0 : n;
}

function isPresent(v: unknown): boolean {
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
}

interface Candidate {
  value: unknown;
  member: MemberIdentity;
}

// Pick the winning member value for one field under one strategy.
function pickWinner(
  members: MemberIdentity[],
  field: string,
  rule: SurvivorshipRule,
): { value: unknown; source_identity_id?: string; source_app?: string } | null {
  if (rule.strategy === 'manual_pin') {
    if (isPresent(rule.pinned_value)) return { value: rule.pinned_value };
    return null;
  }

  const candidates: Candidate[] = [];
  for (const m of members) {
    const value = m.raw_attributes?.[field];
    if (isPresent(value)) candidates.push({ value, member: m });
  }
  if (candidates.length === 0) return null;

  switch (rule.strategy) {
    case 'source_priority': {
      for (const source of rule.source_priority) {
        const hit = candidates.find((c) => c.member.source_type === source);
        if (hit) return provenance(hit);
      }
      // No priority source had a value: fall back to most_recent.
      return provenance(mostRecent(candidates));
    }
    case 'longest_non_null': {
      let best = candidates[0]!;
      for (const c of candidates) {
        if (String(c.value).length > String(best.value).length) best = c;
      }
      return provenance(best);
    }
    case 'most_frequent': {
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const k = String(c.value);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let bestKey = '';
      let bestN = -1;
      for (const [k, n] of counts) {
        if (n > bestN) {
          bestN = n;
          bestKey = k;
        }
      }
      // Tie-break the modal value by most_recent among members holding it.
      const holders = candidates.filter((c) => String(c.value) === bestKey);
      return provenance(mostRecent(holders));
    }
    default: // most_recent
      return provenance(mostRecent(candidates));
  }
}

function mostRecent(candidates: Candidate[]): Candidate {
  let best = candidates[0]!;
  for (const c of candidates) {
    const cScore = Math.max(ts(c.member.source_synced_at), ts(c.member.linked_at));
    const bScore = Math.max(ts(best.member.source_synced_at), ts(best.member.linked_at));
    if (cScore > bScore) best = c;
  }
  return best;
}

function provenance(c: Candidate): { value: unknown; source_identity_id: string; source_app: string } {
  return { value: c.value, source_identity_id: c.member.id, source_app: c.member.source_type };
}

function firstScalar(attributes: Record<string, AttributeProvenance>, keys: string[]): string | null {
  for (const k of keys) {
    const a = attributes[k];
    if (a && isPresent(a.value)) return String(a.value);
  }
  return null;
}

// Recompute the whole golden record from its member identities plus the org's
// survivorship rules (spec 2.1 invariant: a pure function of members + rules).
// confidence is the weakest link (min link_confidence) - the per-viewer read path
// re-derives it over only visible members (spec 2.5 S-r2-3).
export function recomputeGolden(
  members: MemberIdentity[],
  rules: SurvivorshipRule[],
): RecomputedGolden {
  const rulesByField = new Map<string, SurvivorshipRule>();
  for (const r of rules) rulesByField.set(r.field, r);

  // The fields to resolve: every key present across members, plus any manual_pin /
  // configured rule field (so a pin materializes even with no source value).
  const fields = new Set<string>();
  for (const m of members) for (const k of Object.keys(m.raw_attributes ?? {})) fields.add(k);
  for (const r of rules) fields.add(r.field);
  // company_profile_id is a golden concept, not a raw source column; resolve it only
  // if a rule or a member snapshot carries it.

  const attributes: Record<string, AttributeProvenance> = {};
  for (const field of fields) {
    const rule = rulesByField.get(field) ?? {
      kind: members[0]?.source_type ?? 'person',
      field,
      strategy: DEFAULT_STRATEGY,
      source_priority: [],
      pinned_value: null,
    };
    const winner = pickWinner(members, field, rule);
    if (winner) {
      attributes[field] = {
        value: winner.value,
        source_identity_id: winner.source_identity_id,
        source_app: winner.source_app,
        rule: rule.strategy,
      };
    }
  }

  const confidences = members
    .map((m) => (m.link_confidence == null ? null : Number(m.link_confidence)))
    .filter((n): n is number => n != null && !Number.isNaN(n));
  const confidence = confidences.length > 0 ? Math.min(...confidences).toFixed(2) : null;

  const companyAttr = attributes.company_profile_id;
  return {
    attributes,
    display_name: firstScalar(attributes, NAME_KEYS),
    primary_email: firstScalar(attributes, EMAIL_KEYS),
    primary_phone: firstScalar(attributes, PHONE_KEYS),
    company_profile_id:
      companyAttr && isPresent(companyAttr.value) ? String(companyAttr.value) : null,
    identity_count: members.length,
    confidence,
  };
}

/* ------------------------------------------------------------------ */
/*  Rule CRUD (spec 5.1 survivorship-rules get/put)                    */
/* ------------------------------------------------------------------ */

export async function listRules(orgId: string): Promise<SurvivorshipRule[]> {
  const rows = await db
    .select()
    .from(braidSurvivorshipRules)
    .where(eq(braidSurvivorshipRules.organization_id, orgId));
  return rows.map((r) => ({
    kind: r.kind,
    field: r.field,
    strategy: r.strategy as SurvivorshipStrategy,
    source_priority: Array.isArray(r.source_priority) ? (r.source_priority as string[]) : [],
    pinned_value: r.pinned_value ?? null,
  }));
}

export async function upsertRule(
  orgId: string,
  userId: string,
  kind: string,
  field: string,
  input: BraidSetSurvivorshipRuleInput,
): Promise<SurvivorshipRule> {
  const values = {
    organization_id: orgId,
    kind,
    field,
    strategy: input.strategy,
    source_priority: input.source_priority ?? [],
    pinned_value: input.pinned_value ?? null,
    updated_by: userId,
    updated_at: new Date(),
  };
  await db
    .insert(braidSurvivorshipRules)
    .values(values)
    .onConflictDoUpdate({
      target: [
        braidSurvivorshipRules.organization_id,
        braidSurvivorshipRules.kind,
        braidSurvivorshipRules.field,
      ],
      set: {
        strategy: values.strategy,
        source_priority: values.source_priority,
        pinned_value: values.pinned_value,
        updated_by: userId,
        updated_at: values.updated_at,
      },
    });
  const [row] = await db
    .select()
    .from(braidSurvivorshipRules)
    .where(
      and(
        eq(braidSurvivorshipRules.organization_id, orgId),
        eq(braidSurvivorshipRules.kind, kind),
        eq(braidSurvivorshipRules.field, field),
      ),
    )
    .limit(1);
  return {
    kind: row!.kind,
    field: row!.field,
    strategy: row!.strategy as SurvivorshipStrategy,
    source_priority: Array.isArray(row!.source_priority) ? (row!.source_priority as string[]) : [],
    pinned_value: row!.pinned_value ?? null,
  };
}
