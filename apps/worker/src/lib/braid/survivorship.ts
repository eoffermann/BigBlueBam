// Survivorship recompute (spec 3.1 / 4.4). Byte-faithful copy of the pure recompute
// core in apps/braid-api/src/services/survivorship.service.ts so the worker's merge and
// attach paths derive the same golden record braid-api's REST merge does. Keep in sync.

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
      const holders = candidates.filter((c) => String(c.value) === bestKey);
      return provenance(mostRecent(holders));
    }
    default:
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

export function recomputeGolden(
  members: MemberIdentity[],
  rules: SurvivorshipRule[],
): RecomputedGolden {
  const rulesByField = new Map<string, SurvivorshipRule>();
  for (const r of rules) rulesByField.set(r.field, r);

  const fields = new Set<string>();
  for (const m of members) for (const k of Object.keys(m.raw_attributes ?? {})) fields.add(k);
  for (const r of rules) fields.add(r.field);

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
