import type {
  BastionAssertionPropose,
  BastionAssertionRevise,
  BastionControlListQuery,
  BastionEvaluationListQuery,
  BastionEvidenceListQuery,
  BastionRestoreListQuery,
  BastionRunEvaluation,
  BastionSealListQuery,
} from '@bigbluebam/shared';
import type {
  BastionAdoptFramework,
  BastionBulkApplicability,
  BastionCompanyProfile,
  BastionCompileRunListQuery,
  BastionControlCreate,
  BastionControlUpdate,
  BastionFrameworkUpdate,
  BastionRequirementApplicabilityUpdate,
  BastionSetupComplianceProject,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * HTTP client for bastion-api (spec 5.4), shaped like createBursarClient: it forwards the
 * caller's bearer token so bastion-api applies the same requireCan gating and per-viewer rules
 * the human UI does. BASTION_API_URL already ends in /v1 (apps/mcp-server/src/env.ts), so paths
 * here carry no /v1 prefix.
 *
 * Started at M3 with the routes M3 ships; later milestones add their routes here, and M10
 * completes it. It is not wired into server.ts until the M11 merge unit.
 */

export interface BastionResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export type BastionFetch = (input: string, init: RequestInit) => Promise<Response>;

export function createBastionClient(bastionApiUrl: string, api: ApiClient, fetchImpl: BastionFetch = fetch) {
  const baseUrl = bastionApiUrl.replace(/\/$/, '');

  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<BastionResult<T>> {
    const headers: Record<string, string> = {};
    const token = (api as unknown as { token?: string }).token;
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: res.ok, status: res.status, data: data as T };
  }

  const qs = (params: Record<string, string | boolean | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    request,
    // Frameworks (spec 5.1 rows 1, 2, 4, 7, 9, 10)
    listTemplates: () => request('GET', '/library/templates'),
    listFrameworks: (includeArchived?: boolean) =>
      request('GET', `/frameworks${qs({ include_archived: includeArchived ? 'true' : undefined })}`),
    getFramework: (id: string) => request('GET', `/frameworks/${id}`),
    listRequirements: (id: string) => request('GET', `/frameworks/${id}/requirements`),
    compileFramework: (id: string) => request('POST', `/frameworks/${id}/compile`, {}),
    listCompileRuns: (id: string) => request('GET', `/frameworks/${id}/compile-runs`),
    // Controls and assertions (rows 11, 13, 16, 17, 20, 21)
    listControls: (q: BastionControlListQuery) =>
      request('GET', `/controls${qs({ framework_id: q.framework_id, lifecycle: q.lifecycle, setup: q.setup, q: q.q })}`),
    getControl: (id: string) => request('GET', `/controls/${id}`),
    listControlAssertions: (id: string) => request('GET', `/controls/${id}/assertions`),
    proposeAssertion: (controlId: string, body: BastionAssertionPropose) =>
      request('POST', `/controls/${controlId}/assertions`, body),
    reviseAssertion: (assertionId: string, body: BastionAssertionRevise) =>
      request('POST', `/assertions/${assertionId}/revise`, body),
    listProbes: () => request('GET', '/probes'),
    // Setup wizard state
    getSetup: () => request('GET', '/setup'),
    // Evaluations, evidence, ledger (M4: rows 22-27, 29, 30)
    runEvaluation: (body: BastionRunEvaluation) => request('POST', '/evaluations', body),
    listEvaluations: (q: Partial<BastionEvaluationListQuery>) =>
      request('GET', `/evaluations${qs({ status: q.status, cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`),
    getEvaluation: (id: string) => request('GET', `/evaluations/${id}`),
    listControlEvidence: (controlId: string, q: Partial<BastionEvidenceListQuery>) =>
      request(
        'GET',
        `/controls/${controlId}/evidence${qs({ assertion_id: q.assertion_id, cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`,
      ),
    getEvidence: (id: string) => request('GET', `/evidence/${id}`),
    verifyEvidence: (id: string) => request('GET', `/evidence/${id}/verify`),
    listSeals: (q: Partial<BastionSealListQuery> = {}) =>
      request('GET', `/ledger/seals${qs({ cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`),
    listRestores: (q: Partial<BastionRestoreListQuery> = {}) =>
      request('GET', `/ledger/restores${qs({ cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`),

    // ── #196 parity: admin and setup writes plus the floored room reads ─────────
    // (grouped here so milestone appends above merge cleanly)
    listCompileRunsPage: (id: string, q: BastionCompileRunListQuery) =>
      request('GET', `/frameworks/${id}/compile-runs${qs({ cursor: q.cursor, limit: q.limit === undefined ? undefined : String(q.limit) })}`),
    adoptFramework: (body: BastionAdoptFramework) => request('POST', '/frameworks', body),
    updateFramework: (id: string, body: BastionFrameworkUpdate) => request('PATCH', `/frameworks/${id}`, body),
    archiveFramework: (id: string) => request('POST', `/frameworks/${id}/archive`, { confirm: true }),
    createControl: (body: BastionControlCreate) => request('POST', '/controls', body),
    updateControl: (id: string, body: BastionControlUpdate) => request('PATCH', `/controls/${id}`, body),
    decideApplicability: (frameworkId: string, body: BastionBulkApplicability) =>
      request('POST', `/frameworks/${frameworkId}/applicability`, body),
    updateRequirementLink: (linkId: string, body: BastionRequirementApplicabilityUpdate) =>
      request('PATCH', `/control-requirements/${linkId}`, body),
    saveCompanyProfile: (body: BastionCompanyProfile) => request('PATCH', '/setup/profile', body),
    setComplianceProject: (body: BastionSetupComplianceProject) => request('POST', '/setup/compliance-project', body),
    // Spec 5.1 rows 84, 88, 89 (routes ship at M8).
    listAuditorRooms: () => request('GET', '/auditor-rooms'),
    getAuditorRoomAccessLog: (roomId: string) => request('GET', `/auditor-rooms/${roomId}/access-log`),
    listAuditorRequests: (q: { room_id?: string; status?: string }) =>
      request('GET', `/auditor-requests${qs({ room_id: q.room_id, status: q.status })}`),
  };
}

export type BastionClient = ReturnType<typeof createBastionClient>;
