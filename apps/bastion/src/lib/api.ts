import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';

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

export interface ControlsResponse {
  data: ControlRow[];
  counts: SetupCounts;
  framework_id: string | null;
}
