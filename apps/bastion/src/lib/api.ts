import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';
import type {
  BastionDriftTaskStatus,
  BastionEvidenceSourceColumn,
  BastionExceptionScope,
  BastionExceptionStatus,
  BastionFixDraftStatus,
  BastionFixTemplate,
  BastionGapKind,
  BastionGapStatus,
  BastionReadinessBanner,
  BastionReadinessNumbersOut,
} from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Typed Bastion API client. bastion-api routes are mounted under /v1 and proxied
// at /bastion/api/. Bastion shares Bam's session cookie; every call sends
// credentials. Vouching routes (confirm, reject) need that session: an API key
// is refused with SESSION_REQUIRED.
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

type Params = Record<string, string | number | boolean | undefined | null>;

function getOrgId(): string | undefined {
  try {
    const mod = (globalThis as Record<string, unknown>).__bastionAuthStore as
      | { getState?: () => { user?: { org_id?: string } | null } }
      | undefined;
    return mod?.getState?.()?.user?.org_id;
  } catch {
    return undefined;
  }
}

/** Bam's CSRF double-submit token (the csrf_token cookie, echoed in X-CSRF-Token). */
export function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('csrf_token='));
  return match ? decodeURIComponent(match.slice('csrf_token='.length)) : undefined;
}

async function request<T>(baseUrl: string, method: string, path: string, body?: unknown, params?: Params, extra?: Record<string, string>): Promise<T> {
  const url = new URL(`${baseUrl}${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  const orgId = getOrgId();
  if (orgId) headers['X-Org-Id'] = orgId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, impersonateHeader(), extra ?? {});

  const response = await fetch(url.toString(), {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorData: { error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string } } = {};
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
  if (!contentType.includes('application/json')) return (await response.text()) as unknown as T;
  return (await response.json()) as T;
}

const BASE = '/bastion/api/v1';

export const api = {
  get: <T>(path: string, params?: Params) => request<T>(BASE, 'GET', path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>(BASE, 'POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>(BASE, 'PATCH', path, body ?? {}),
};

/* ------------------------------------------------------------------ */
/*  Bam helpers: the required Compliance project (spec 2.5)            */
/* ------------------------------------------------------------------ */

export interface BamProject {
  id: string;
  name: string;
  is_archived?: boolean;
}

export const bamApi = {
  listProjects: () => request<{ data: BamProject[] }>('/b3/api', 'GET', '/projects'),
  createComplianceProject: () => {
    const csrf = readCsrfToken();
    return request<{ data: BamProject }>(
      '/b3/api',
      'POST',
      '/projects',
      {
        name: 'Compliance',
        task_id_prefix: 'COMP',
        description: 'Tasks Bastion files when a control needs attention.',
      },
      undefined,
      csrf ? { 'X-CSRF-Token': csrf } : undefined,
    );
  },
};

/* ------------------------------------------------------------------ */
/*  Response shapes (mirror apps/bastion-api/src/services)             */
/* ------------------------------------------------------------------ */

export interface PopulationView {
  kind: 'github_repos' | 'blip_apps';
  members: Array<{ value: string; label: string }>;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export interface AssertionRow {
  id: string;
  control_id: string;
  kind: 'probe' | 'manual' | 'feed';
  probe_key: string | null;
  probe_title: string | null;
  plain_statement: string;
  review_status: string;
  manual_evidence_spec: { title: string; description: string; kind: string; cadence_days: number } | null;
  population: PopulationView | null;
  control_title?: string;
}

export interface SoaCompleteness {
  complete: boolean;
  unmapped_ref_codes: string[];
  undecided_ref_codes: string[];
  decided_count: number;
  requirement_count: number;
}

export interface SetupCounts {
  total: number;
  set_up: number;
  not_set_up: number;
  not_applicable: number;
}

export interface CompileRun {
  id: string;
  status: string;
  assertions_proposed: number;
  assertions_dropped: number;
  /** M7: progress of an AI-tailored compile the worker drives. */
  controls_done?: number;
  controls_total?: number;
  used_fallback?: boolean;
}

/* ------------------------------ M8: questionnaires ------------------------------ */

export interface QuestionnaireSheetMap {
  sheet_name: string;
  header_row: number | null;
  first_row: number;
  question_column: number;
  answer_column: number | null;
  yes_no_column: number | null;
  section_column: number | null;
  answer_kind: 'yes_no' | 'text' | 'yes_no_text';
}

/** One questionnaire (shapeQuestionnaire in apps/bastion-api/src/services/questionnaires.service.ts). */
export interface QuestionnaireRow {
  id: string;
  title: string;
  requester_label: string | null;
  format: 'xlsx' | 'csv';
  status: 'uploaded' | 'mapping' | 'answering' | 'in_review' | 'approved' | 'exported' | 'failed';
  injection_suspected: boolean;
  row_count: number;
  rows_done: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  due_date: string | null;
  owner_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  drafting_now: boolean;
  created_at: string;
  column_map: { sheets: QuestionnaireSheetMap[]; guessed: boolean } | null;
  source_truncated: boolean;
  sheet_preview?: Array<{ name: string; row_count: number; column_count: number; rows: string[][] }>;
  counts_label: string | null;
}

export interface QuestionnaireCitation {
  entity_type: string;
  entity_id: string;
  label: string | null;
  state_words?: string | null;
}

export interface QuestionnaireItemRow {
  id: string;
  sheet_name: string;
  row_index: number;
  section: string | null;
  question_text: string;
  answer_kind: 'yes_no' | 'text' | 'yes_no_text';
  draft_answer: string | null;
  draft_yes_no: boolean | null;
  final_answer: string | null;
  final_yes_no: boolean | null;
  cited_refs: QuestionnaireCitation[];
  hidden_citation_count: number;
  confidence_band: 'high' | 'medium' | 'low' | null;
  confidence_words: string | null;
  band_reasons: Array<{ code: string; words: string }>;
  review_status: 'pending' | 'accepted' | 'edited' | 'needs_owner';
  assigned_to_name: string | null;
  reviewed_by_name: string | null;
  needs_review: boolean;
}

export interface QuestionnaireApproval {
  low_unreviewed: number;
  waiting_on_owner: number;
  undrafted: number;
  medium_unreviewed: number;
  can_approve: boolean;
  blocked_because: string[];
}

export interface AnswerLibraryRow {
  id: string;
  question_text: string;
  answer_text: string;
  yes_no: boolean | null;
  cited_refs: QuestionnaireCitation[];
  approved_by_name: string | null;
  approved_at: string | null;
  stale: boolean;
  stale_words: string | null;
  retired_at: string | null;
}

/* ------------------------------ M7: policies ------------------------------ */

export type PolicyAudience = { kind: 'all' } | { kind: 'users'; user_ids: string[] };

/** One linked Beacon article (shapePolicy in apps/bastion-api/src/services/policies.service.ts). */
export type PolicyArticleState = 'current' | 'missing' | 'retired' | 'expired';

export interface PolicyRow {
  id: string;
  beacon_entry_id: string;
  title: string;
  audience: PolicyAudience;
  cadence_days: number;
  owner_user_id: string | null;
  owner_name: string | null;
  status: 'active' | 'retired';
  beacon_status: string | null;
  visibility: string | null;
  shared_with_everyone: boolean;
  sharing_problem: string | null;
  current_version: number | null;
  expires_at: string | null;
  days_to_expiry: number | null;
  last_verified_at: string | null;
  required_people: number;
  attested_count: number;
  not_attested_count: number;
  attestation_label: string | null;
  /** The linked Beacon article: only 'current' can be acknowledged (#244); null for a retired policy. */
  article_state?: PolicyArticleState | null;
  /** What the owner should do when the article is missing, retired or expired. */
  article_problem?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyAttestations {
  policy: PolicyRow;
  attested: Array<{ user_id: string; name: string; attested_at: string }>;
  not_attested: Array<{ user_id: string; name: string; can_open: boolean }>;
  cannot_open_count: number;
  cannot_open_label: string | null;
}

export interface PolicyBody {
  policy_id: string;
  beacon_entry_id: string;
  title: string;
  beacon_version: number;
  body_markdown: string;
  body_sha256: string;
  saved_at: string;
  expires_at: string | null;
  cadence_days: number;
  in_audience: boolean;
  attested_at: string | null;
  due: boolean;
}

export interface MyAttestationRow {
  policy_id: string;
  title: string;
  current_version: number | null;
  shared_with_everyone: boolean;
  due: boolean;
  /** Whether the Beacon article can be read and acknowledged (#244). */
  article_state?: PolicyArticleState;
  state_words: string;
  last_attested_version: number | null;
  last_attested_at: string | null;
  next_due_at: string | null;
}

export interface FrameworkView {
  id: string;
  template_key: string;
  name: string;
  status: string;
  is_iso: boolean;
  requirement_count: number;
  setup: SetupCounts;
  statement_of_applicability: SoaCompleteness | null;
  latest_compile_run?: CompileRun | null;
}

export interface SetupState {
  frameworks: FrameworkView[];
  company_profile: Record<string, unknown>;
  compliance_project: { id: string; name: string; archived: boolean } | null;
  proposed_checks: AssertionRow[];
  /** The connected sets a population check may list, by name (issue #195). */
  connected_populations?: Record<PopulationView['kind'], Array<{ value: string; label: string }>>;
  steps: {
    frameworks: { done: boolean };
    profile: { done: boolean; answered: number; total: number };
    compliance_project: { done: boolean };
    compile: { done: boolean };
    review: { done: boolean; waiting: number; populations_waiting: number };
    applicability: { done: boolean; frameworks: Array<{ framework_id: string; name: string; decided: number; total: number }> };
  };
  complete: boolean;
}

export interface TemplateRow {
  template_key: string;
  name: string;
  description: string;
  is_iso: boolean;
  requirement_count: number;
  control_count: number;
  adopted_framework_id: string | null;
}

export interface RequirementRow {
  ref_code: string;
  title: string;
  plain_summary: string;
  applicability: 'applicable' | 'not_applicable' | 'undecided';
  links: Array<{ id: string; control_title: string; not_applicable_reason: string | null }>;
}

export interface RequirementsResponse {
  data: RequirementRow[];
  framework: { id: string; name: string; is_iso: boolean };
  statement_of_applicability: SoaCompleteness | null;
}

export interface ControlRow {
  id: string;
  title: string;
  plain_summary: string | null;
  setup_state: 'set_up' | 'not_set_up' | 'not_applicable' | null;
  requirements: Array<{ id: string; framework_name: string; ref_code: string; applicability: string }>;
}

/* ------------------------------------------------------------------ */
/*  M5: Readiness, Evidence map, Evidence locker, feeds                */
/* ------------------------------------------------------------------ */

/** The shared shapes (#215): the four numbers, banner codes and source columns come from @bigbluebam/shared. */
export type ReadinessNumbers = BastionReadinessNumbersOut;
type SourceColumns = Record<Exclude<BastionEvidenceSourceColumn, 'none'>, number>;

export interface FrameworkOption {
  id: string;
  template_key: string;
  name: string;
  audit_target_date: string | null;
}

export interface SummaryResponse {
  data: {
    frameworks: FrameworkOption[];
    selected: FrameworkOption | null;
    nearest_audit_date: string | null;
    days_to_audit: number | null;
    numbers: ReadinessNumbers;
    headline: string;
    not_met_label: string;
    not_applicable: Array<{ control_id: string; control_key: string; title: string }>;
    banners: Array<{ code: BastionReadinessBanner; message: string; count?: number }>;
    top_gaps: Array<{ id: string; control_id: string; control_title: string; gap_kind: BastionGapKind; risk_score: number; fix_template: BastionFixTemplate | null; fix_cost: number | null }>;
    gaps_ranked: boolean;
    expiring_evidence: Array<{ id: string; title: string; owner_name: string | null; valid_until: string; days_left: number }>;
    last_full_run_at: string | null;
    timezone: string;
    as_of: string;
  };
}

export interface CoverageRow {
  control_id: string;
  control_key: string;
  title: string;
  category: string | null;
  owner_name: string | null;
  set_up: boolean;
  bucket: string;
  state: string | null;
  state_words: string;
  reason: string | null;
  reason_words: string | null;
  risk_accepted: boolean;
  columns: SourceColumns;
  coverage_kind: string;
  manual_expires_at: string | null;
  manual_days_left: number | null;
  last_evaluated_at: string | null;
}

export interface CoverageResponse {
  data: CoverageRow[];
  totals: Record<BastionEvidenceSourceColumn, number>;
  numbers: ReadinessNumbers;
  headline: string;
  not_applicable: Array<{ control_id: string; control_key: string; title: string }>;
  frameworks: FrameworkOption[];
}

export interface EvidenceLink {
  assertion_id: string;
  control_id: string;
  control_title: string;
  plain_statement: string;
  review_verdict: 'pending' | 'accepted' | 'shows_exception';
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  small_team_self_review: boolean;
  linked_at: string;
}

export interface EvidenceItem {
  id: string;
  kind: 'file' | 'attestation_statement';
  title: string;
  description: string | null;
  source_system: string | null;
  owner_name: string | null;
  uploaded_by: string;
  uploaded_by_name: string | null;
  produced_on: string | null;
  period_start: string | null;
  period_end: string | null;
  valid_until: string | null;
  sensitivity: 'standard' | 'restricted';
  status: 'pending_scan' | 'active' | 'superseded' | 'withdrawn' | 'blocked';
  blocked_reason: string | null;
  withdrawn_reason: string | null;
  personal_data_id: string | null;
  restricted: boolean;
  masked: boolean;
  trust_label: string;
  scan_note: string | null;
  days_left: number | null;
  stuck_scan: boolean;
  links: EvidenceLink[];
  created_at: string;
}

export interface EvidenceListResponse {
  data: EvidenceItem[];
  counts: { active: number; pending_scan: number; stuck: number; blocked: number; not_scanned: number };
  next_cursor: string | null;
}

export interface FeedRow {
  id: string;
  feed_key: string;
  label: string;
  source_kind: 'api_push' | 'bolt_event';
  cadence_days: number;
  daily_record_quota: number;
  status: string;
  last_record_at: string | null;
  records_today: number;
  quota_remaining_today: number;
  fresh: boolean;
  freshness: string;
  active_keys: number;
  record_count: number;
}

export interface FeedKeyRow {
  id: string;
  feed_id: string;
  last4: string | null;
  label: string | null;
  status: 'active' | 'grace' | 'revoked';
  grace_expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  usable: boolean;
}

export interface MintedKey {
  id: string;
  feed_id: string;
  last4: string;
  token: string;
  push_path: string;
  grace_expires_at: string | null;
}

export interface ControlsResponse {
  data: ControlRow[];
  counts: SetupCounts;
  framework_id: string | null;
}

/* ------------------------------------------------------------------ */
/*  M6: gaps, fixes, exceptions, drift, control detail                 */
/* ------------------------------------------------------------------ */

export interface GapRow {
  id: string;
  control_id: string;
  control_title: string;
  owner_name: string | null;
  assertion_id: string | null;
  assertion_statement: string | null;
  gap_kind: BastionGapKind;
  gap_words: string;
  risk_score: number;
  fix_template: BastionFixTemplate | null;
  fix_words: string | null;
  fix_cost: number | null;
  status: BastionGapStatus;
  dismissed_reason: string | null;
  latest_fix_draft_id: string | null;
}

export interface AcceptedRisk {
  id: string;
  control_id: string;
  control_title: string;
  scope: BastionExceptionScope;
  reason: string;
  expires_at: string;
  owner_name: string | null;
  approved_by_name: string | null;
  small_team_self_approval: boolean;
  approval_label: string | null;
}

export interface GapsResponse {
  data: GapRow[];
  stale: { gap_kind: 'stale'; gap_words: string; control_count: number; message: string } | null;
  accepted_risks: AcceptedRisk[];
  sort: 'risk' | 'quick_wins';
}

export interface FixDraftRow {
  id: string;
  gap_id: string | null;
  template: BastionFixTemplate;
  template_words: string;
  title: string;
  body_markdown: string | null;
  payload: Record<string, unknown>;
  cited_refs: Array<{ entity_type: string; entity_id: string }>;
  hidden_citation_count: number;
  status: BastionFixDraftStatus;
  decided_by_name: string | null;
  decided_at: string | null;
  created_by_name: string | null;
  created_by_kind: string | null;
  created_at: string;
  gap_kind: BastionGapKind | null;
  gap_words: string | null;
  control_id: string | null;
  control_title: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  proposal_expires_at: string | null;
}

export interface ExceptionRow {
  id: string;
  control_id: string;
  control_title: string;
  owner_user_id: string | null;
  owner_name: string | null;
  assertion_id: string | null;
  assertion_statement: string | null;
  scope: BastionExceptionScope;
  cited_entity_type: string | null;
  cited_entity_id: string | null;
  reason: string;
  compensating_note: string | null;
  status: BastionExceptionStatus;
  proposed_by: string;
  proposed_by_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  small_team_self_approval: boolean;
  approval_label: string | null;
  expires_at: string;
  days_left: number;
  created_at: string;
}

export interface DriftRow {
  id: string;
  control_id: string;
  control_title: string;
  from_words: string;
  to_words: string;
  reason: string;
  reason_words: string;
  task_status: BastionDriftTaskStatus;
  task_words: string;
  bam_task_human_id: string | null;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  detected_at: string;
}

export interface ControlDetail {
  id: string;
  title: string;
  plain_summary: string | null;
  owner_user_id: string | null;
  risk_weight: number;
  setup_state: 'set_up' | 'not_set_up' | 'not_applicable' | null;
  requirements: Array<{ id: string; framework_id: string; ref_code: string; applicability: string }>;
  assertions: AssertionRow[];
}

export interface EvidenceSnapshotRow {
  id: string;
  assertion_id: string;
  outcome: 'pass' | 'fail' | 'unprovable';
  unprovable_reason: string | null;
  explanation: string | null;
  cited_refs: Array<{ entity_type: string; entity_id: string }>;
  /** Plain names of the cited items (detail viewers only), e.g. "PR #42 in rescue-radio-firmware: ...". */
  cited_labels?: string[];
  cited_items?: Array<{ entity_type: string; entity_id: string; label: string | null }>;
  /** Cited items left out because this reader cannot see them (they still count in the explanation). */
  hidden_citation_count?: number;
  created_at: string;
}
