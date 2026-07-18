// Deterministic match scoring (spec 4.3). Reproducible and auditable: the full weight
// set is snapshotted into evidence.weights (ST8) so an old candidate re-renders even
// after weights change. The LLM never touches this; it only writes best-effort prose.

export const SCORE_MODEL = 'braid-score-v1';

// Default feature weights (spec 4.3 table). Snapshotted into every candidate's evidence.
export const DEFAULT_WEIGHTS: Record<string, number> = {
  email_exact: 0.45,
  phone_exact: 0.15,
  name_trigram: 0.2,
  embedding_cosine: 0.15,
  domain_match: 0.05,
  platform_user: 0.45,
};

// Strong signals are the high-precision anchors that gate auto-merge (spec 4.4 / D3-6).
const STRONG_FEATURES = new Set(['email_exact', 'phone_exact', 'platform_user']);

export interface ScoreInputIdentity {
  email_norm?: string | null;
  phone_norm?: string | null;
  name_norm?: string | null;
  domain?: string | null;
  /** book_event_attendees.user_id: a real FK to users; a shared value is a strong anchor. */
  platform_user_id?: string | null;
}

export interface ScoredFeature {
  kind: string;
  score: number;
  weight: number;
  strong: boolean;
}

export interface DirectScoreResult {
  score: number;
  strong_signal: boolean;
  features: ScoredFeature[];
}

// JS trigram Jaccard similarity, a deterministic stand-in for the pg_trgm similarity used
// to BLOCK candidates. Blocking finds the pair in SQL; scoring recomputes here so the
// stored score is reproducible without a DB round-trip.
export function trigramSimilarity(a: string, b: string): number {
  const tri = (s: string): Set<string> => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tri(a);
  const tb = tri(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Direct pairwise score (spec 4.3). weights may be overridden per-org in the future;
// today the defaults are always snapshotted. embeddingCosine is passed in when Qdrant
// recall produced a vector distance; absent (Qdrant down / no vector) it contributes 0,
// which is the documented soft-degrade (spec 4.2 / 9.5).
export function scoreDirect(
  a: ScoreInputIdentity,
  b: ScoreInputIdentity,
  opts: { weights?: Record<string, number>; embeddingCosine?: number } = {},
): DirectScoreResult {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const features: ScoredFeature[] = [];

  const emailExact = present(a.email_norm) && a.email_norm === b.email_norm ? 1 : 0;
  const phoneExact = present(a.phone_norm) && a.phone_norm === b.phone_norm ? 1 : 0;
  const platformUser =
    present(a.platform_user_id) && a.platform_user_id === b.platform_user_id ? 1 : 0;
  const nameTrigram =
    present(a.name_norm) && present(b.name_norm) ? trigramSimilarity(a.name_norm, b.name_norm) : 0;
  const domainMatch = present(a.domain) && a.domain === b.domain ? 1 : 0;
  const embeddingCosine =
    typeof opts.embeddingCosine === 'number' ? Math.max(0, Math.min(1, opts.embeddingCosine)) : 0;

  const raw: Array<{ kind: string; score: number }> = [
    { kind: 'email_exact', score: emailExact },
    { kind: 'phone_exact', score: phoneExact },
    { kind: 'name_trigram', score: nameTrigram },
    { kind: 'embedding_cosine', score: embeddingCosine },
    { kind: 'domain_match', score: domainMatch },
    { kind: 'platform_user', score: platformUser },
  ];

  let total = 0;
  let strong = false;
  for (const f of raw) {
    if (f.score <= 0) continue;
    const weight = weights[f.kind] ?? 0;
    total += f.score * weight;
    const isStrong = STRONG_FEATURES.has(f.kind);
    if (isStrong) strong = true;
    features.push({ kind: f.kind, score: round4(f.score), weight, strong: isStrong });
  }

  return { score: clamp01(total), strong_signal: strong, features };
}

// A bridged candidate's score/strong_signal derive from the bridging identity's TWO strong
// links to A and B (spec 4.4 / D-r2-4), NOT a direct A-vs-B comparison. The bridge score is
// the min of the two link scores (both must be strong to auto-merge).
export interface BridgeLink {
  profile: 'A' | 'B';
  bridge_identity_a_id?: string;
  bridge_identity_b_id?: string;
  kind: string;
  score: number;
  strong: boolean;
}

export interface BridgedScoreResult {
  score: number;
  strong_signal: boolean;
  links: BridgeLink[];
}

export function scoreBridged(linkToA: BridgeLink, linkToB: BridgeLink): BridgedScoreResult {
  return {
    score: clamp01(Math.min(linkToA.score, linkToB.score)),
    strong_signal: linkToA.strong && linkToB.strong,
    links: [linkToA, linkToB],
  };
}

function clamp01(n: number): number {
  return round4(Math.max(0, Math.min(1, n)));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
