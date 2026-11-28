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
import type {
  BastionCoverageQuery,
  BastionFeedCreate,
  BastionFeedRecordListQuery,
  BastionFeedUpdate,
  BastionManualEvidenceLink,
  BastionManualEvidenceListQuery,
} from '@bigbluebam/shared';
import type {
  BastionDriftAcknowledge,
  BastionDriftListQuery,
  BastionExceptionListQuery,
  BastionExceptionPropose,
  BastionFixDraftListQuery,
  BastionFixMarkApplied,
  BastionGapDismiss,
  BastionGapListQuery,
  BastionProposeFix,
} from '@bigbluebam/shared';
import type {
  BastionCompileFramework,
  BastionPolicyCreate,
  BastionPolicyListQuery,
  BastionPolicyUpdate,
  BastionRequestAttestations,
} from '@bigbluebam/shared';
import type {
  BastionAnswerLibraryQuery,
  BastionAnswerLibraryUpdate,
  BastionDraftAnswer,
  BastionQuestionnaireAutofill,
  BastionQuestionnaireCreate,
  BastionQuestionnaireItemListQuery,
  BastionQuestionnaireItemReview,
  BastionQuestionnaireListQuery,
  BastionQuestionnaireUpdate,
} from '@bigbluebam/shared';
import type {
  BastionAuditLogQuery,
  BastionAuditorRequestUpdate,
  BastionDeliveryProblemListQuery,
  BastionExportCreate,
  BastionExportListQuery,
  BastionSearchQuery,
  BastionSettingsUpdate,
} from '@bigbluebam/shared';
import type {
  BastionFrameworkListResponse,
  BastionFrameworkResponse,
  BastionQuestionnaireResponse,
  BastionRequirementsResponse,
  BastionTemplateListResponse,
} from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * HTTP client for bastion-api (spec 5.4), shaped like createBursarClient: it forwards the
 * caller's bearer token so bastion-api applies the same requireCan gating and per-viewer rules
 * the human UI does. BASTION_API_URL already ends in /v1 (apps/mcp-server/src/env.ts), so paths
 * here carry no /v1 prefix.
 *
 * Started at M3 with the routes M3 ships; later milestones added theirs, and M10 completed it:
 * every bastion-api route an API key may call has a method here, and every route without one is
 * a sanctioned skip (session-required vouching acts, byte downloads, feed-key credentials, the
 * public room and the machine push, internal routes). test/bastion-parity.test.ts holds that
 * cross-walk against the route files. It is not wired into server.ts until the M11 merge unit.
 */

export interface BastionResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export type BastionFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The person an agent reads for (#217); narrows, never widens. */
export interface Asker {
  asker_user_id: string;
}

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
    // The responses the tools take apart are typed from the shared schemas (#371); on !ok, data is
    // the error envelope instead.
    listTemplates: () => request<BastionTemplateListResponse>('GET', '/library/templates'),
    listFrameworks: (includeArchived?: boolean) =>
      request<BastionFrameworkListResponse>('GET', `/frameworks${qs({ include_archived: includeArchived ? 'true' : undefined })}`),
    getFramework: (id: string) => request<BastionFrameworkResponse>('GET', `/frameworks/${id}`),
    listRequirements: (id: string) => request<BastionRequirementsResponse>('GET', `/frameworks/${id}/requirements`),
    listNotApplicableSuggestions: (id: string) => request('GET', `/frameworks/${id}/not-applicable-suggestions`),
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
    // Evidence cites source records: both reads carry asker_user_id (#414).
    listControlEvidence: (controlId: string, q: Partial<BastionEvidenceListQuery> & Asker) =>
      request(
        'GET',
        `/controls/${controlId}/evidence${qs({
          assertion_id: q.assertion_id,
          latest: q.latest,
          cursor: q.cursor,
          limit: q.limit !== undefined ? String(q.limit) : undefined,
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    getEvidence: (id: string, a: Asker) => request('GET', `/evidence/${id}${qs({ asker_user_id: a.asker_user_id })}`),
    verifyEvidence: (id: string) => request('GET', `/evidence/${id}/verify`),
    listSeals: (q: Partial<BastionSealListQuery> = {}) =>
      request('GET', `/ledger/seals${qs({ cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`),
    listRestores: (q: Partial<BastionRestoreListQuery> = {}) =>
      request('GET', `/ledger/restores${qs({ cursor: q.cursor, limit: q.limit !== undefined ? String(q.limit) : undefined })}`),
    // Manual evidence, feeds, coverage (M5: rows 33, 34, 36, 37, check-again, 42, 49, 50, 94).
    // The detail-bearing reads carry asker_user_id (#217): bastion-api answers with the
    // intersection of the bearer's and the asker's permissions. Withdrawal (row 39) has no
    // client method: it is a destructive human act with no tool (spec 2.8).
    listManualEvidence: (q: Partial<BastionManualEvidenceListQuery> & Asker) =>
      request(
        'GET',
        `/manual-evidence${qs({
          status: q.status,
          kind: q.kind,
          assertion_id: q.assertion_id,
          control_id: q.control_id,
          stuck: q.stuck === undefined ? undefined : String(q.stuck),
          limit: q.limit === undefined ? undefined : String(q.limit),
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    getManualEvidence: (id: string, a: Asker) => request('GET', `/manual-evidence/${id}${qs({ asker_user_id: a.asker_user_id })}`),
    linkManualEvidence: (id: string, body: BastionManualEvidenceLink) => request('POST', `/manual-evidence/${id}/links`, body),
    unlinkManualEvidence: (id: string, assertionId: string) => request('DELETE', `/manual-evidence/${id}/links/${assertionId}`),
    checkEvidenceScanAgain: (id: string) => request('POST', `/manual-evidence/${id}/check-again`, {}),
    listFeeds: () => request('GET', '/feeds'),
    listFeedRecords: (feedId: string, q: Partial<BastionFeedRecordListQuery> & Asker) =>
      request(
        'GET',
        `/feeds/${feedId}/records${qs({ limit: q.limit === undefined ? undefined : String(q.limit), before: q.before, asker_user_id: q.asker_user_id })}`,
      ),
    getSummary: (q: BastionCoverageQuery & Asker) => request('GET', `/summary${qs({ framework_id: q.framework_id, asker_user_id: q.asker_user_id })}`),
    getCoverage: (q: BastionCoverageQuery & Asker) => request('GET', `/coverage${qs({ framework_id: q.framework_id, asker_user_id: q.asker_user_id })}`),

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
    // Spec 5.1 rows 43, 44 (M5 feed configuration).
    createFeed: (body: BastionFeedCreate) => request('POST', '/feeds', body),
    updateFeed: (id: string, body: BastionFeedUpdate) => request('PATCH', `/feeds/${id}`, body),

    // ── M6: gaps, fix drafts, exceptions, drift (spec 5.1 rows 51-63) ───────────
    // Rows 56 and 61 (both decide routes) have no client method: session required (spec 2.8).
    listGaps: (q: Partial<BastionGapListQuery>) =>
      request(
        'GET',
        `/gaps${qs({
          framework_id: q.framework_id,
          control_id: q.control_id,
          status: q.status,
          gap_kind: q.gap_kind,
          sort: q.sort,
          limit: q.limit === undefined ? undefined : String(q.limit),
        })}`,
      ),
    proposeFix: (gapId: string, body: BastionProposeFix) => request('POST', `/gaps/${gapId}/propose-fix`, body),
    dismissGap: (gapId: string, body: BastionGapDismiss) => request('POST', `/gaps/${gapId}/dismiss`, body),
    // Fix drafts and exceptions cite source records: their reads carry asker_user_id (#414).
    listFixDrafts: (q: Partial<BastionFixDraftListQuery> & Asker) =>
      request(
        'GET',
        `/fix-drafts${qs({
          status: q.status,
          gap_id: q.gap_id,
          control_id: q.control_id,
          limit: q.limit === undefined ? undefined : String(q.limit),
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    getFixDraft: (id: string, a: Asker) => request('GET', `/fix-drafts/${id}${qs({ asker_user_id: a.asker_user_id })}`),
    markFixApplied: (id: string, body: BastionFixMarkApplied) => request('POST', `/fix-drafts/${id}/mark-applied`, body),
    listExceptions: (q: Partial<BastionExceptionListQuery> & Asker) =>
      request(
        'GET',
        `/exceptions${qs({
          status: q.status,
          control_id: q.control_id,
          limit: q.limit === undefined ? undefined : String(q.limit),
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    getException: (id: string, a: Asker) => request('GET', `/exceptions/${id}${qs({ asker_user_id: a.asker_user_id })}`),
    proposeException: (body: BastionExceptionPropose) => request('POST', '/exceptions', body),
    listDrift: (q: Partial<BastionDriftListQuery>) =>
      request(
        'GET',
        `/drift${qs({
          control_id: q.control_id,
          unacknowledged: q.unacknowledged === undefined ? undefined : String(q.unacknowledged),
          limit: q.limit === undefined ? undefined : String(q.limit),
          before: q.before,
        })}`,
      ),
    acknowledgeDrift: (id: string, body: BastionDriftAcknowledge) => request('POST', `/drift/${id}/acknowledge`, body),

    // ── M7: policies and attestation (spec 5.1 rows 64-71) ─────────────────────
    // Row 70 (attest) has no client method: session required (spec 2.8, #136).
    listPolicies: (q: Partial<BastionPolicyListQuery> = {}) => request('GET', `/policies${qs({ status: q.status })}`),
    createPolicy: (body: BastionPolicyCreate) => request('POST', '/policies', body),
    updatePolicy: (id: string, body: BastionPolicyUpdate) => request('PATCH', `/policies/${id}`, body),
    getPolicyBody: (id: string) => request('GET', `/policies/${id}/body`),
    listPolicyAttestations: (id: string) => request('GET', `/policies/${id}/attestations`),
    myAttestations: () => request('GET', '/me/attestations'),
    requestAttestations: (id: string, body: BastionRequestAttestations) => request('POST', `/policies/${id}/request-attestations`, body),
    // ── M8: questionnaires and the answer library (spec 5.1 rows 72-83) ─────────────────
    // Row 79 (approve) has no client method: session required (spec 2.8, #136). Row 80 (export)
    // is a byte response: no method.
    listQuestionnaires: (q: Partial<BastionQuestionnaireListQuery> & Partial<Asker> = {}) =>
      request('GET', `/questionnaires${qs({ status: q.status, limit: q.limit === undefined ? undefined : String(q.limit), asker_user_id: q.asker_user_id })}`),
    createQuestionnaire: (body: BastionQuestionnaireCreate) => request('POST', '/questionnaires', body),
    getQuestionnaire: (id: string, a: Partial<Asker> = {}) =>
      request<BastionQuestionnaireResponse>('GET', `/questionnaires/${id}${qs({ asker_user_id: a.asker_user_id })}`),
    updateQuestionnaire: (id: string, body: BastionQuestionnaireUpdate) => request('PATCH', `/questionnaires/${id}`, body),
    autofillQuestionnaire: (id: string, body: BastionQuestionnaireAutofill) => request('POST', `/questionnaires/${id}/autofill`, body),
    listQuestionnaireItems: (id: string, q: Partial<BastionQuestionnaireItemListQuery> & Partial<Asker> = {}) =>
      request(
        'GET',
        `/questionnaires/${id}/items${qs({
          band: q.band,
          review_status: q.review_status,
          needs_review: q.needs_review === undefined ? undefined : String(q.needs_review),
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    reviewQuestionnaireItem: (itemId: string, body: BastionQuestionnaireItemReview) => request('PATCH', `/questionnaire-items/${itemId}`, body),
    draftAnswer: (body: BastionDraftAnswer, a: Partial<Asker> = {}) => request('POST', `/answers/draft${qs({ asker_user_id: a.asker_user_id })}`, body),
    searchAnswerLibrary: (q: Partial<BastionAnswerLibraryQuery> & Partial<Asker> = {}) =>
      request(
        'GET',
        `/answer-library${qs({
          q: q.q,
          include_stale: q.include_stale === undefined ? undefined : String(q.include_stale),
          include_retired: q.include_retired === undefined ? undefined : String(q.include_retired),
          limit: q.limit === undefined ? undefined : String(q.limit),
          asker_user_id: q.asker_user_id,
        })}`,
      ),
    updateAnswerLibrary: (id: string, body: BastionAnswerLibraryUpdate) => request('PATCH', `/answer-library/${id}`, body),
    // Row 9 with the M7 option: use_ai false forces the library's suggestions.
    compileFrameworkWith: (id: string, body: BastionCompileFramework) => request('POST', `/frameworks/${id}/compile`, body),

    // ── M9: sharing, settings and the audit log (spec 5.1 rows 84-100) ──────────
    // Rows 85-87 (room create, revoke, unlock) have no client method: session required (spec
    // 2.8, #136). Row 93 (packet download) is a byte response. Rows 101-104 are the public room.
    previewAuditorRoom: (roomId: string) => request('GET', `/auditor-rooms/${roomId}/preview`),
    respondAuditorRequest: (id: string, body: BastionAuditorRequestUpdate) => request('PATCH', `/auditor-requests/${id}`, body),
    createExport: (body: BastionExportCreate) => request('POST', '/exports', body),
    listExports: (q: Partial<BastionExportListQuery> = {}) =>
      request(
        'GET',
        `/exports${qs({ status: q.status, include_dismissed: q.include_dismissed, limit: q.limit === undefined ? undefined : String(q.limit) })}`,
      ),
    dismissExport: (id: string) => request('POST', `/exports/${id}/dismiss`),
    getSettings: () => request('GET', '/settings'),
    updateSettings: (body: BastionSettingsUpdate) => request('PATCH', '/settings', body),
    listDeliveryProblems: (q: Partial<BastionDeliveryProblemListQuery> = {}) =>
      request('GET', `/delivery-problems${qs({ limit: q.limit === undefined ? undefined : String(q.limit) })}`),
    retryDelivery: (id: string) => request('POST', `/delivery-problems/${id}/retry`, {}),
    auditLog: (q: Partial<BastionAuditLogQuery> = {}) =>
      request(
        'GET',
        `/audit${qs({ action: q.action, subject_type: q.subject_type, cursor: q.cursor, limit: q.limit === undefined ? undefined : String(q.limit) })}`,
      ),

    // ── M10: search (spec 5.1 row 95). The platform search_everything reads this route
    // directly (tools/search-tools.ts); the method is here so the client covers every
    // agent-reachable route (test/bastion-parity.test.ts).
    search: (q: Partial<BastionSearchQuery> & Pick<BastionSearchQuery, 'q'> & Partial<Asker>) =>
      request('GET', `/search${qs({ q: q.q, limit: q.limit === undefined ? undefined : String(q.limit), asker_user_id: q.asker_user_id })}`),
  };
}

export type BastionClient = ReturnType<typeof createBastionClient>;
