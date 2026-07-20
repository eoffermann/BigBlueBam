import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';

// ---------------------------------------------------------------------------
// Typed Bursar API client. bursar-api routes are mounted under /v1 and proxied
// at /bursar/api/. Bursar shares Bam's session cookie; every call sends
// credentials. Money-bearing fields are read_all-floored server-side (they are
// DELETED, not nulled, for callers without bursar.spend.read_all), so a missing
// amount means "suppressed", not "zero".
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>[],
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '/bursar/api/v1') {
    this.baseUrl = baseUrl;
  }

  private getOrgId(): string | undefined {
    try {
      const mod = (globalThis as any).__bursarAuthStore;
      return mod?.getState?.()?.user?.org_id;
    } catch {
      return undefined;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {};
    const orgId = this.getOrgId();
    if (orgId) headers['X-Org-Id'] = orgId;
    if (body) headers['Content-Type'] = 'application/json';
    Object.assign(headers, impersonateHeader());

    const response = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorData: {
        error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string };
      } = {};
      try {
        errorData = await response.json();
      } catch {
        // ignore parse errors
      }
      throw new ApiError(
        response.status,
        errorData.error?.code ?? 'UNKNOWN',
        errorData.error?.message ?? `Request failed with status ${response.status}`,
        errorData.error?.details,
        errorData.error?.request_id,
      );
    }

    if (response.status === 204) return undefined as T;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return (await response.text()) as unknown as T;
    }
    return (await response.json()) as T;
  }

  get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

export const api = new ApiClient();

/* ------------------------------------------------------------------ */
/*  Response shapes (DB-row shapes the shared package does not export) */
/* ------------------------------------------------------------------ */

export interface CursorEnvelope<T> {
  data: T[];
  next_cursor?: string | null;
}
export interface PlainEnvelope<T> {
  data: T[];
}

export interface VendorRow {
  id: string;
  organization_id: string;
  display_name: string;
  braid_profile_id: string | null;
  bond_company_id: string | null;
  category: string | null;
  criticality: string;
  owner_user_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AliasRow {
  id: string;
  vendor_id: string;
  raw_payee: string;
  normalized_payee: string;
  source: string;
  confidence: string;
  last_seen_at: string | null;
}

export interface RequestRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  scope_status: string;
  injection_suspected: boolean;
  injection_signals: { categories?: string[]; spans?: Array<{ category: string; match: string }> } | null;
  currency: string;
  bin_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LevelingRunRow {
  id: string;
  request_id: string;
  status: string; // running | partial | done | rejected_limits | failed
  offer_count: number;
  node_count: number;
  offers_done?: number | null;
  nodes_done?: number | null;
  windows_done?: number | null;
  windows_total?: number | null;
  progress?: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

// The verdicts / bands / withheld reasons the engine emits (mirrors the DB CHECKs).
export type Verdict =
  | 'covered'
  | 'partial'
  | 'excluded_explicit'
  | 'absent'
  | 'ambiguous'
  | 'not_applicable'
  | 'unverified';
export type ReviewStatus = 'published' | 'needs_review' | 'unverified' | 'pending_review';
export type WithheldReason = 'blanket_cap' | 'concentration' | 'band' | 'throttled' | 'unparseable' | null;
export type ConfidenceBand = 'high' | 'medium' | 'low' | null;

export interface MatrixNode {
  id: string;
  title: string;
  normative_strength: string;
  parent_id: string | null;
  ordinal: number | null;
}
export interface MatrixOffer {
  id: string;
  label: string | null;
  vendor_id: string | null;
  currency: string | null;
  normalization_status: string | null;
  blanket_suspected: boolean;
  injection_suspected: boolean;
}
export interface MatrixCoverage {
  offer_id: string;
  scope_node_id: string;
  verdict: Verdict;
  confidence_band: ConfidenceBand;
  review_status: ReviewStatus;
  withheld_reason: WithheldReason;
  derived_covered: boolean;
  delta_kind: string | null;
  delta_amount_minor?: number | null;
  // The M5 matrix route (owned outside this milestone) does not currently return the coverage row
  // id or its evidence blob. These are typed optional so the chip lights up its full drill-in
  // (cited span, matched lines, rejected candidates) the moment the endpoint carries them, without
  // a client change. Until then the chip renders the verdict/band/withheld/delta it does receive.
  id?: string;
  cited_span?: { quote?: string | null; cited_line?: number | null; verified?: boolean } | null;
  matched_line_ids?: string[];
  rejected_candidates?: Array<{ line?: number | null; quote?: string | null; reason?: string | null } | string>;
}
export interface MatrixTotal {
  offer_id: string;
  total_kind: string; // stated | base_only | gap_adjusted | should_have_supplement
  amount_minor?: number | null;
  renderable: boolean;
  unvalued_gap_count: number;
  estimated: boolean;
}
export interface MatrixResponse {
  data: {
    nodes: MatrixNode[];
    offers: MatrixOffer[];
    coverage: MatrixCoverage[];
    totals: MatrixTotal[];
    sort_key: 'gap_adjusted' | 'stated';
  };
}

// One coverage cell in full, used by the chip drill-in.
export interface CoverageDetail {
  id: string;
  offer_id: string;
  scope_node_id: string;
  verdict: Verdict;
  decided_by: string;
  matched_line_ids: string[];
  cited_span: { quote?: string | null; cited_line?: number | null; verified?: boolean } | null;
  rejected_candidates: Array<{ line?: number | null; quote?: string | null; reason?: string | null } | string>;
  confidence_band: ConfidenceBand;
  review_status: ReviewStatus;
  withheld_reason: WithheldReason;
  delta_kind: string | null;
  delta_amount_minor?: number | null;
}

export interface DiffRow {
  scope_node_id: string;
  title: string;
  verdict: Verdict;
  review_status: ReviewStatus;
  withheld_reason: WithheldReason;
}
export interface DiffOffer {
  offer_id: string;
  label: string | null;
  published: string[];
  needs_review: string[];
  unverified: string[];
  blanket?: boolean;
  blocking: boolean;
  rows: DiffRow[];
}
export interface DiffResponse {
  data: {
    mandatory_count: number;
    offers: DiffOffer[];
  };
}

export interface ReviewRow {
  id: string;
  offer_id: string;
  scope_node_id: string;
  verdict: Verdict;
  confidence_band: ConfidenceBand;
  withheld_reason: WithheldReason;
  created_at: string;
  request_id: string;
  offer_label: string | null;
  node_title: string;
}

export interface OrgSettingsRow {
  organization_id: string;
  llm_provider_id: string | null;
  node_term_overlap_floor: string;
  blanket_fanout_cap: number;
  blanket_cumulative_cap: number;
  evidence_concentration_floor: string;
  max_nodes_per_run: number;
  max_offers_per_run: number;
  max_llm_calls_per_run: number;
  max_lines_per_window: number;
  window_overlap_lines: number;
  price_drift_threshold_pct: string;
  renewal_lead_bands: string[];
  parse_quality_floor: string;
  payee_match_threshold: string;
  payee_auto_accept_threshold: string;
  blanket_lexicon: string[];
  exclusion_lexicon: string[];
  digest_day: number;
  digest_hour: number;
  retention_days: number;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/*  M7/M8 surfaces (award, spend, mismatch, renewal, gate, library,   */
/*  drafts). These routes may not be mounted yet; callers treat a 404 */
/*  as an empty state and never crash.                                */
/* ------------------------------------------------------------------ */

export interface AwardRow {
  id: string;
  request_id: string | null;
  vendor_id: string | null;
  offer_id: string | null;
  status: string;
  amends_award_id?: string | null;
  supersedes_award_id?: string | null;
  awarded_at: string | null;
  created_at: string;
  orphaned_custody?: boolean;
}
export interface BaselineRow {
  id: string;
  award_id: string;
  frozen_at: string | null;
  currency?: string | null;
  total_minor?: number | null;
  item_count?: number | null;
}
export interface SpendByVendorRow {
  vendor_id: string | null;
  vendor_name?: string | null;
  total_minor?: number | null;
  event_count?: number | null;
  currency?: string | null;
  last_event_at?: string | null;
}
export interface MismatchRow {
  id: string;
  vendor_id: string | null;
  award_id: string | null;
  detector: string;
  severity: string;
  status: string;
  // The amount is deliberately optional: some mismatches are "not quantified" and MUST render
  // as text, never as a number (UI rule / spec 8).
  amount_minor?: number | null;
  quantified?: boolean;
  summary: string | null;
  detail?: Record<string, unknown> | null;
  detected_at: string | null;
  created_at: string;
}
export interface RenewalRow {
  id: string;
  vendor_id: string | null;
  award_id: string | null;
  renews_at: string | null;
  lead_band: string | null;
  status: string;
  notice_by?: string | null;
  summary?: string | null;
}
export interface DraftRow {
  id: string;
  kind: string; // clarification | negotiation_brief
  request_id: string | null;
  status: string; // pending | approved | rejected
  subject?: string | null;
  body?: string | null;
  proposal_id?: string | null;
  created_at: string;
}
export interface LibraryRow {
  id: string;
  title: string;
  description: string | null;
  is_global: boolean;
  normative_strength: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Scope tree (M3) - kept from the scaffold, re-expressed on `api`.   */
/* ------------------------------------------------------------------ */

export interface ScopeNode {
  id: string;
  title: string;
  description: string | null;
  node_kind: string;
  normative_strength: string;
  derived_from: string | null;
  review_status: string;
  contributing_offer_ids: string[];
  cited_span: { quote?: string | null; cited_line?: number | null; verified?: boolean } | null;
  confidence: string | null;
}
export interface ScopeRequest {
  id: string;
  title: string;
  scope_status: string;
  injection_suspected: boolean;
  injection_signals: { categories?: string[]; spans?: Array<{ category: string; match: string }> } | null;
}
export interface ScopeRun {
  id: string;
  status: string;
  chunks_failed: number;
  nodes_extracted: number;
  error: string | null;
}
export interface ScopeResponse {
  data: { request: ScopeRequest; nodes: ScopeNode[]; latest_run: ScopeRun | null };
}

export const scopeApi = {
  get: (requestId: string) => api.get<ScopeResponse>(`/requests/${requestId}/scope`),
  derive: (requestId: string, source_text?: string) =>
    api.post<{ data: { run_id: string; scope_status: string } }>(
      `/requests/${requestId}/derive-scope`,
      source_text ? { source_text } : {},
    ),
  applyLibrary: (requestId: string, library_ids: string[]) =>
    api.post<{ data: { applied: number; requested: number } }>(`/requests/${requestId}/scope/apply-library`, {
      library_ids,
    }),
  confirm: (requestId: string, clear_injection?: boolean) =>
    api.post<{ data: ScopeRequest }>(
      `/requests/${requestId}/scope/confirm`,
      clear_injection ? { clear_injection } : {},
    ),
  promoteRival: (nodeId: string) =>
    api.post<{ data: ScopeNode; contributing_offer_ids: string[] }>(`/scope-nodes/${nodeId}/promote-rival`, {}),
};
