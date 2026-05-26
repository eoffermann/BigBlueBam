// Agent D — Slack → Banter import API client.
//
// Talks to the banter-api routes at /banter/api/v1/admin/import/slack/*
// (the contract is in docs/plans/slack-import-design.md §9).
//
// The main app's `api` client is hardcoded to /b3/api, so we hand-roll a
// tiny fetcher here that hits /banter/api with the same csrf-cookie +
// credentials-include conventions. ApiError is re-thrown identically so
// the consuming TanStack Query code can keep using `instanceof ApiError`.

import { ApiError } from '@/lib/api';

// ─── Shapes (per design doc §9) ─────────────────────────────────────────────

/** One auto-matched or unmapped Slack user surfaced by the preview scan. */
export interface ImportPreviewUser {
  slack_user_id: string;
  slack_display_name: string;
  slack_real_name: string | null;
  email: string | null;
  is_bot: boolean;
  is_deleted: boolean;
  message_count: number;
  /** Matched BAM user — present iff the preview's email-based auto-match
   * found a single live member in this org. */
  matched_user: { id: string; email: string; display_name: string } | null;
}

export type SlackChannelType = 'public' | 'private' | 'dm' | 'mpim';

export interface ImportPreviewChannel {
  slack_channel_id: string;
  slack_name: string;
  channel_type: SlackChannelType;
  topic: string | null;
  purpose: string | null;
  member_count: number;
  message_count: number;
  is_archived: boolean;
  /** Server-side conflict detection: true if a Banter channel with this
   * name already exists in the project (or at org level if no project). */
  conflict: boolean;
}

/** Returned by POST /upload — small enough to render the mapping wizard. */
export interface ImportPreview {
  workspace_name: string;
  workspace_url: string | null;
  file_size_bytes: number;
  channels_detected: number;
  users_detected: number;
  messages_estimated: number;
}

export interface FullPreview {
  import_id: string;
  workspace_name: string;
  workspace_url: string | null;
  file_size_bytes: number;
  users: ImportPreviewUser[];
  channels: ImportPreviewChannel[];
  totals: {
    channels: number;
    users: number;
    messages: number;
    attachments_estimated_bytes: number;
  };
}

export type UserMappingAction = 'auto_match' | 'send_invite' | 'stub' | 'map_existing' | 'skip';

export interface UserMappingRow {
  slack_user_id: string;
  action: UserMappingAction;
  /** Required when action === 'map_existing'. */
  target_user_id?: string;
  /** When action === 'send_invite', operator can defer the email send. */
  send_email?: boolean;
}

export type ChannelMappingAction = 'import_new' | 'merge_existing' | 'skip';

export interface ChannelMappingRow {
  slack_channel_id: string;
  action: ChannelMappingAction;
  /** When action === 'import_new': defaults to slack_name (server resolves conflicts). */
  target_name?: string;
  /** Required when action === 'merge_existing'. */
  target_channel_id?: string;
}

export interface ImportOptions {
  preserve_timestamps: boolean;
  import_attachments: boolean;
  /** Slack bearer token, used once for downloading files referenced by URL.
   * Stored only for the duration of the worker job; never persisted. */
  slack_bearer_token: string | null;
  import_reactions: boolean;
  import_pins: boolean;
  import_dms: boolean;
  notify_on_completion: boolean;
  dry_run: boolean;
  daily_message_rate_cap: number;
}

export interface ImportMapping {
  project: { mode: 'create_new'; name: string; key: string } | { mode: 'use_existing'; project_id: string };
  users: UserMappingRow[];
  channels: ChannelMappingRow[];
  options: ImportOptions;
}

export type ImportPhase =
  | 'pending'
  | 'unpacking'
  | 'mapping_users'
  | 'creating_channel_group'
  | 'importing_channels'
  | 'importing_messages'
  | 'importing_files'
  | 'importing_reactions'
  | 'importing_pins'
  | 'reconciling'
  | 'done'
  | 'failed'
  | 'aborted';

export interface ImportStatus {
  id: string;
  status: ImportPhase;
  phase: string | null;
  progress_done: number;
  progress_total: number;
  totals_imported: {
    users?: number;
    channels?: number;
    messages?: number;
    files?: number;
    reactions?: number;
    pins?: number;
  };
  totals_skipped: Record<string, number>;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  channel_group_id: string | null;
  project_id: string | null;
  /** Per-channel counters reported during importing_messages. Optional. */
  channels_in_flight?: Array<{
    slack_name: string;
    target_name: string | null;
    messages_done: number;
    messages_total: number;
  }>;
}

export interface ImportHistoryItem {
  id: string;
  status: ImportPhase | string;
  workspace_name: string;
  project_id: string | null;
  channel_group_id: string | null;
  initiated_by: string | null;
  source_filename: string;
  source_size_bytes: number;
  /** Per-phase tallies from the worker: { users, channels, messages, files, reactions, pins }. */
  totals_imported: Record<string, number>;
  totals_skipped: Record<string, number>;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Internal fetcher (mirrors `api` in @/lib/api but targets /banter/api) ──

const BASE = '/banter/api/v1/admin/import/slack';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (MUTATING.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: { error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string } } = {};
    try {
      err = await res.json();
    } catch {
      // ignore parse errors — fall through to the default message
    }
    throw new ApiError(
      res.status,
      err.error?.code ?? 'UNKNOWN',
      err.error?.message ?? `Request failed with status ${res.status}`,
      err.error?.details,
      err.error?.request_id,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function uploadMultipart<T>(path: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const csrf = readCsrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    let err: { error?: { code?: string; message?: string; details?: Record<string, unknown>[]; request_id?: string } } = {};
    try {
      err = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(
      res.status,
      err.error?.code ?? 'UNKNOWN',
      err.error?.message ?? `Upload failed with status ${res.status}`,
      err.error?.details,
      err.error?.request_id,
    );
  }
  return (await res.json()) as T;
}

// ─── Public client ──────────────────────────────────────────────────────────

export interface UploadResponse {
  data: {
    import_id: string;
    preview: ImportPreview;
  };
}

export interface PreviewResponse {
  data: FullPreview;
}

export interface StartResponse {
  data: { status: 'queued'; import_id: string };
}

export interface StatusResponse {
  data: ImportStatus;
}

export interface HistoryResponse {
  data: ImportHistoryItem[];
}

export interface AbortResponse {
  data: {
    aborted: true;
    deleted: Record<string, number>;
  };
}

export const slackImportApi = {
  /** Uploads the export .zip; the server stashes it in MinIO and returns
   * a fast-scan summary good enough to render the wizard's first paint. */
  async upload(file: File): Promise<{ import_id: string; preview: ImportPreview }> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await uploadMultipart<UploadResponse>('/upload', fd);
    return res.data;
  },

  /** Returns the full per-user + per-channel preview for the mapping wizard. */
  async getPreview(id: string): Promise<FullPreview> {
    const res = await request<PreviewResponse>('GET', `/${id}/preview`);
    return res.data;
  },

  /** Submits the operator's mapping + options; enqueues the worker job. */
  async start(id: string, mapping: ImportMapping): Promise<{ status: 'queued' }> {
    const res = await request<StartResponse>('POST', `/${id}/start`, mapping);
    return { status: res.data.status };
  },

  /** Polled every 2s by the running-view to drive the progress UI. */
  async getStatus(id: string): Promise<ImportStatus> {
    const res = await request<StatusResponse>('GET', `/${id}/status`);
    return res.data;
  },

  /** Lists recent imports for the current org (history table). */
  async listHistory(): Promise<ImportHistoryItem[]> {
    const res = await request<HistoryResponse>('GET', '/');
    return res.data;
  },

  /** Aborts an in-flight import. When cleanupStubs=true, also deletes the
   * stub users this import created (per §7 of the design doc). */
  async abort(id: string, cleanupStubs = false): Promise<{ aborted: true; deleted: Record<string, number> }> {
    const qs = cleanupStubs ? '?cleanup_stubs=true' : '';
    const res = await request<AbortResponse>('DELETE', `/${id}${qs}`);
    return res.data;
  },
};
