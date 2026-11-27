import { impersonateHeader } from '@bigbluebam/ui/impersonation-banner';
import type {
  BastionAcceptedRisk,
  BastionAccessLogRow,
  BastionAnswerLibraryRow,
  BastionAssertion,
  BastionAuditorRequest,
  BastionAuditorRoom,
  BastionCompileRun,
  BastionControlDetail,
  BastionControlListRow,
  BastionControlsResponse,
  BastionCoverageResponse,
  BastionCoverageRow,
  BastionCreatedAuditorRoom,
  BastionDeliveryProblem,
  BastionDriftRow,
  BastionEvidenceSnapshot,
  BastionException,
  BastionExportPacket,
  BastionFeed,
  BastionFeedKey,
  BastionFixDraft,
  BastionFrameworkOption,
  BastionGapRow,
  BastionGapsResponse,
  BastionManualEvidenceItem,
  BastionManualEvidenceLinkView,
  BastionManualEvidenceListResponse,
  BastionMintedFeedKey,
  BastionMyAttestationRow,
  BastionPolicyArticleState,
  BastionPolicyAttestations,
  BastionPolicyAudience,
  BastionPolicyBody,
  BastionPolicyRow,
  BastionPopulationView,
  BastionProposedCheck,
  BastionQuestionnaire,
  BastionQuestionnaireApproval,
  BastionQuestionnaireCitation,
  BastionQuestionnaireItem,
  BastionQuestionnaireSheetMap,
  BastionReadinessNumbersOut,
  BastionRequirementRow,
  BastionRequirementsResponse,
  BastionRoomControl,
  BastionRoomControlDetail,
  BastionRoomEvidenceDetail,
  BastionRoomFile,
  BastionRoomOverview,
  BastionRoomRisk,
  BastionRoomState,
  BastionSettingsView,
  BastionSetupCounts,
  BastionSetupFramework,
  BastionSetupView,
  BastionSoaCompleteness,
  BastionSoaRow,
  BastionSummaryResponse,
  BastionTemplateSummary,
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

/** One organization member, as GET /b3/api/org/members returns it (the people other suite SPAs pick from). */
export interface OrgMember {
  id: string;
  display_name: string;
  email: string;
  is_active?: boolean;
}

export const bamApi = {
  listProjects: () => request<{ data: BamProject[] }>('/b3/api', 'GET', '/projects'),
  /** The organization's members (#268: the "Ask someone" picker). */
  listMembers: () => request<{ data: OrgMember[] }>('/b3/api', 'GET', '/org/members'),
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
/*  Response shapes: aliases of the shared Zod schemas (#371)          */
/* ------------------------------------------------------------------ */
// Every Bastion response type comes from packages/shared/src/schemas/bastion.ts, the schemas the
// bastion-api services return and the MCP tools read (#348, #371). Do not declare a response
// shape here: scripts/lib/bastion-spa-response-types.test.mjs fails on a hand-written copy.

export type PopulationView = BastionPopulationView;
export type AssertionRow = BastionAssertion;
export type ProposedCheck = BastionProposedCheck;
export type SoaCompleteness = BastionSoaCompleteness;
export type SetupCounts = BastionSetupCounts;
export type CompileRun = BastionCompileRun;

/* ------------------------------ M8: questionnaires ------------------------------ */

// #272: request bodies, enums and the sheet mapping come from @bigbluebam/shared (the one Zod
// source the API validates with).
export type QuestionnaireSheetMap = BastionQuestionnaireSheetMap;
export type QuestionnaireRow = BastionQuestionnaire;
export type QuestionnaireCitation = BastionQuestionnaireCitation;
export type QuestionnaireItemRow = BastionQuestionnaireItem;
export type QuestionnaireApproval = BastionQuestionnaireApproval;
export type AnswerLibraryRow = BastionAnswerLibraryRow;

/* ------------------------------ M7: policies ------------------------------ */

export type PolicyAudience = BastionPolicyAudience;
/** The linked article's state: one union with bastion-api and the MCP tools (#285). */
export type PolicyArticleState = BastionPolicyArticleState;
export type PolicyRow = BastionPolicyRow;
export type PolicyAttestations = BastionPolicyAttestations;
export type PolicyBody = BastionPolicyBody;
export type MyAttestationRow = BastionMyAttestationRow;

/* ------------------------------ setup, frameworks, controls ------------------------------ */

export type FrameworkView = BastionSetupFramework;
export type SetupState = BastionSetupView;
export type TemplateRow = BastionTemplateSummary;
export type RequirementRow = BastionRequirementRow;
export type RequirementsResponse = BastionRequirementsResponse;
export type ControlRow = BastionControlListRow;
export type ControlsResponse = BastionControlsResponse;

/* ------------------------------------------------------------------ */
/*  M5: Readiness, Evidence map, Evidence locker, feeds                */
/* ------------------------------------------------------------------ */

/** The shared shapes (#215): the four numbers, banner codes and source columns come from @bigbluebam/shared. */
export type ReadinessNumbers = BastionReadinessNumbersOut;
export type FrameworkOption = BastionFrameworkOption;
export type SummaryResponse = BastionSummaryResponse;
export type CoverageRow = BastionCoverageRow;
export type CoverageResponse = BastionCoverageResponse;
export type EvidenceLink = BastionManualEvidenceLinkView;
export type EvidenceItem = BastionManualEvidenceItem;
export type EvidenceListResponse = BastionManualEvidenceListResponse;
export type FeedRow = BastionFeed;
export type FeedKeyRow = BastionFeedKey;
export type MintedKey = BastionMintedFeedKey;

/* ------------------------------------------------------------------ */
/*  M6: gaps, fixes, exceptions, drift, control detail                 */
/* ------------------------------------------------------------------ */

export type GapRow = BastionGapRow;
export type AcceptedRisk = BastionAcceptedRisk;
export type GapsResponse = BastionGapsResponse;
/** A drafted fix, as the API sends it: the shared response shape (#348). */
export type FixDraftRow = BastionFixDraft;
/** An exception, as the API sends it: the shared response shape (#348). */
export type ExceptionRow = BastionException;
export type DriftRow = BastionDriftRow;
export type ControlDetail = BastionControlDetail;
export type EvidenceSnapshotRow = BastionEvidenceSnapshot;

/* ------------------------------ M9: sharing, settings, the auditor room ------------------------------ */

export type RoomState = BastionRoomState;
export type AuditorRoomRow = BastionAuditorRoom;
export type CreatedRoom = BastionCreatedAuditorRoom;
export type AccessLogRow = BastionAccessLogRow;
export type AuditorRequestRow = BastionAuditorRequest;
export type ExportRow = BastionExportPacket;
export type RoomControl = BastionRoomControl;
export type RoomRisk = BastionRoomRisk;
export type SoaRowView = BastionSoaRow;
export type RoomOverview = BastionRoomOverview;
export type RoomFile = BastionRoomFile;
export type RoomControlDetail = BastionRoomControlDetail;
export type RoomEvidenceDetail = BastionRoomEvidenceDetail;
export type SettingsView = BastionSettingsView;
export type DeliveryProblemRow = BastionDeliveryProblem;

/**
 * The public auditor room's own client (spec 5.2). No session, no org header, no impersonation:
 * the room token travels only as the X-Bastion-Room-Token header (it comes from the URL fragment,
 * which never reaches a server), never in a path or query string. Never redirects to a login.
 */
export function roomRequest<T>(
  path: string,
  token: string,
  opts: { passcode?: string | null; method?: string; body?: unknown; tokenHeader: string; passcodeHeader: string },
): Promise<T> {
  const headers: Record<string, string> = { [opts.tokenHeader]: token };
  if (opts.passcode) headers[opts.passcodeHeader] = opts.passcode;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${BASE}/public/room${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'omit',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).then(async (response) => {
    if (!response.ok) {
      let e: { error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string } } = {};
      try {
        e = await response.json();
      } catch {
        // ignore
      }
      throw new ApiError(response.status, e.error?.code ?? 'UNKNOWN', e.error?.message ?? `Request failed with status ${response.status}`, e.error?.details, e.error?.request_id);
    }
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await response.json()) as T;
    return (await response.blob()) as unknown as T;
  });
}
