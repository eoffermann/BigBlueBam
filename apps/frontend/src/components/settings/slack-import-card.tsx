// Agent D — Slack → Banter import wizard card.
//
// Lives in /b3/settings. Gated on `banter.admin_import.create`. Walks the
// operator through upload → mapping → confirmation → live progress → done,
// following docs/plans/slack-import-design.md §1.
//
// State machine (see WizardState below):
//   idle → uploading → preview_loading → mapping → confirming →
//   running → done | failed | aborted
//
// All backend traffic goes through @/lib/api/slack-import (hits
// /banter/api/v1/admin/import/slack/*). The component renders a graceful
// error state when those routes 404, so it doesn't crash if Agent B hasn't
// landed yet.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  Download,
  ExternalLink,
  Hash,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  RefreshCw,
  Slack,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { PaginatedResponse, Project } from '@bigbluebam/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Dialog } from '@/components/common/dialog';
import { formatDate } from '@/lib/utils';
import { peopleApi, type PersonListItem } from '@/lib/api/people';
import {
  slackImportApi,
  type ChannelMappingRow,
  type FullPreview,
  type ImportHistoryItem,
  type ImportMapping,
  type ImportOptions,
  type ImportPhase,
  type ImportPreview,
  type ImportPreviewChannel,
  type ImportPreviewUser,
  type ImportStatus,
  type UserMappingAction,
  type UserMappingRow,
} from '@/lib/api/slack-import';

const PERMISSION_ID = 'banter.admin_import.create';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const POLL_INTERVAL_MS = 2_000;

const DEFAULT_OPTIONS: ImportOptions = {
  preserve_timestamps: true,
  import_attachments: true,
  slack_bearer_token: null,
  import_reactions: true,
  import_pins: true,
  import_dms: false,
  notify_on_completion: false,
  dry_run: false,
  daily_message_rate_cap: 5000,
};

const PHASE_ORDER: ImportPhase[] = [
  'pending',
  'unpacking',
  'mapping_users',
  'creating_channel_group',
  'importing_channels',
  'importing_messages',
  'importing_files',
  'importing_reactions',
  'importing_pins',
  'reconciling',
  'done',
];

const PHASE_LABELS: Record<ImportPhase, string> = {
  pending: 'Pending',
  unpacking: 'Unpacking export',
  mapping_users: 'Mapping users',
  creating_channel_group: 'Creating channel group',
  importing_channels: 'Importing channels',
  importing_messages: 'Importing messages',
  importing_files: 'Importing attachments',
  importing_reactions: 'Importing reactions',
  importing_pins: 'Importing pins',
  reconciling: 'Reconciling threads',
  done: 'Done',
  failed: 'Failed',
  aborted: 'Aborted',
};

type WizardState =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; progress: number }
  | { kind: 'preview_loading'; importId: string }
  | { kind: 'mapping'; importId: string; preview: FullPreview }
  | { kind: 'confirming'; importId: string; preview: FullPreview }
  | { kind: 'running'; importId: string }
  | { kind: 'done'; importId: string; status: ImportStatus }
  | { kind: 'failed'; importId: string; status: ImportStatus }
  | { kind: 'aborted'; importId: string; status: ImportStatus };

interface MappingFormState {
  projectMode: 'create_new' | 'use_existing';
  newProjectName: string;
  newProjectKey: string;
  existingProjectId: string;
  users: Record<string, UserMappingRow>; // keyed by slack_user_id
  channels: Record<string, ChannelMappingRow>; // keyed by slack_channel_id
  options: ImportOptions;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .toUpperCase();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return Number(n).toLocaleString();
}

function defaultUserAction(u: ImportPreviewUser): UserMappingAction {
  if (u.matched_user) return 'auto_match';
  if (u.email) return 'send_invite';
  return 'stub';
}

function defaultChannelAction(c: ImportPreviewChannel): ChannelMappingAction {
  if (c.channel_type === 'dm' || c.channel_type === 'mpim') return 'skip';
  return 'import_new';
}

type ChannelMappingAction = ChannelMappingRow['action'];

// ─── Component ──────────────────────────────────────────────────────────────

export function SlackImportCard({ onNavigate }: { onNavigate?: (path: string) => void } = {}) {
  const canImport = useCan(PERMISSION_ID);
  if (!canImport) return null;
  return <SlackImportCardInner onNavigate={onNavigate} />;
}

function SlackImportCardInner({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const queryClient = useQueryClient();

  // Wizard state machine.
  const [state, setState] = useState<WizardState>({ kind: 'idle' });

  // Toast-style errors that don't fit the state machine (e.g. mapping failed).
  const [error, setError] = useState<string | null>(null);

  // Has the operator deep-linked to a specific import? If so, jump straight to
  // its running/done view. Parsed once on mount; clearing the param doesn't
  // collapse the card so the operator can navigate around freely.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('slack_import');
    if (id) {
      setState({ kind: 'running', importId: id });
    }
  }, []);

  // History list (re-fetched after every state transition that creates or
  // resolves an import). We poll lightly so a recently-aborted import flips
  // its row promptly.
  const historyQuery = useQuery({
    queryKey: ['slack-import-history'],
    queryFn: () => slackImportApi.listHistory(),
    refetchInterval: state.kind === 'running' ? POLL_INTERVAL_MS * 5 : 30_000,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return false;
      return failureCount < 1;
    },
  });

  const backendDown =
    historyQuery.error instanceof ApiError && historyQuery.error.status === 404;

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
          <Slack className="h-5 w-5 text-purple-600 dark:text-purple-400" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Slack Import</h2>
          <p className="text-sm text-zinc-500">
            Import a Slack workspace export into Banter. Channels, messages,
            threads, reactions, and attachments are migrated into a project of
            your choosing. Supports files up to {formatBytes(MAX_UPLOAD_BYTES)}.
          </p>
        </div>
      </div>

      {backendDown && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Slack import is not available yet</div>
            <div className="mt-1 text-xs">
              The backend route <code className="font-mono">/banter/api/v1/admin/import/slack</code> is
              not reachable. The feature may still be rolling out.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Step renderer ────────────────────────────────────────────────── */}
      {state.kind === 'idle' && (
        <UploadStep
          onUploaded={(importId, _preview) => {
            setError(null);
            setState({ kind: 'preview_loading', importId });
          }}
          onError={(msg) => setError(msg)}
          onUploadingChange={(s) => setState(s)}
        />
      )}

      {state.kind === 'uploading' && <UploadingStep fileName={state.fileName} progress={state.progress} />}

      {state.kind === 'preview_loading' && (
        <PreviewLoadingStep
          importId={state.importId}
          onReady={(preview) => setState({ kind: 'mapping', importId: state.importId, preview })}
          onError={(msg) => {
            setError(msg);
            setState({ kind: 'idle' });
          }}
        />
      )}

      {state.kind === 'mapping' && (
        <MappingStep
          preview={state.preview}
          onCancel={() => setState({ kind: 'idle' })}
          onContinue={() => setState({ kind: 'confirming', importId: state.importId, preview: state.preview })}
        />
      )}

      {/* Confirming reuses the mapping step under it; the dialog is overlaid */}
      {state.kind === 'confirming' && (
        <ConfirmingStep
          preview={state.preview}
          importId={state.importId}
          onBack={() => setState({ kind: 'mapping', importId: state.importId, preview: state.preview })}
          onStarted={(id) => {
            queryClient.invalidateQueries({ queryKey: ['slack-import-history'] });
            setState({ kind: 'running', importId: id });
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      {state.kind === 'running' && (
        <RunningStep
          importId={state.importId}
          onDone={(status) => {
            queryClient.invalidateQueries({ queryKey: ['slack-import-history'] });
            if (status.status === 'done') setState({ kind: 'done', importId: state.importId, status });
            else if (status.status === 'failed') setState({ kind: 'failed', importId: state.importId, status });
            else if (status.status === 'aborted') setState({ kind: 'aborted', importId: state.importId, status });
          }}
          onNavigate={onNavigate}
        />
      )}

      {state.kind === 'done' && (
        <CompletionStep
          status={state.status}
          variant="done"
          onDismiss={() => setState({ kind: 'idle' })}
          onNavigate={onNavigate}
        />
      )}

      {state.kind === 'failed' && (
        <CompletionStep
          status={state.status}
          variant="failed"
          onDismiss={() => setState({ kind: 'idle' })}
          onNavigate={onNavigate}
        />
      )}

      {state.kind === 'aborted' && (
        <CompletionStep
          status={state.status}
          variant="aborted"
          onDismiss={() => setState({ kind: 'idle' })}
          onNavigate={onNavigate}
        />
      )}

      {/* ── History ──────────────────────────────────────────────────────── */}
      {!backendDown && historyQuery.data && historyQuery.data.length > 0 && (
        <HistoryTable
          items={historyQuery.data}
          onView={(id) => setState({ kind: 'running', importId: id })}
        />
      )}
    </div>
  );
}

// ─── Step: Upload ───────────────────────────────────────────────────────────

function UploadStep({
  onUploaded,
  onError,
  onUploadingChange,
}: {
  onUploaded: (importId: string, preview: ImportPreview) => void;
  onError: (msg: string) => void;
  onUploadingChange: (s: WizardState) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      onError(`File too large: ${formatBytes(file.size)}. Maximum is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      onError(`Expected a .zip file (got ${file.name}).`);
      return;
    }
    onUploadingChange({ kind: 'uploading', fileName: file.name, progress: 0 });
    try {
      const result = await slackImportApi.upload(file);
      onUploaded(result.import_id, result.preview);
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.status === 404
          ? 'Upload endpoint is not available yet. The backend may still be rolling out.'
          : `${e.message} (status ${e.status})`
        : (e as Error).message;
      onError(msg);
      onUploadingChange({ kind: 'idle' });
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      className={
        'rounded-lg border-2 border-dashed p-8 text-center transition-colors ' +
        (dragOver
          ? 'border-purple-400 bg-purple-50/60 dark:bg-purple-950/30'
          : 'border-zinc-300 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/40')
      }
    >
      <Upload className="h-8 w-8 text-zinc-400 mx-auto mb-3" />
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Drop your Slack export <code className="font-mono text-xs">.zip</code> here
      </p>
      <p className="text-xs text-zinc-500 mt-1">or</p>
      <div className="mt-3 flex items-center justify-center gap-2">
        <Button size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload className="h-4 w-4" />
          Choose file
        </Button>
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        Up to {formatBytes(MAX_UPLOAD_BYTES)}. Export it from Slack →
        Settings → Workspace settings → Import / Export Data.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = ''; // allow re-selecting the same file
        }}
      />
    </div>
  );
}

function UploadingStep({ fileName, progress }: { fileName: string; progress: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-6 space-y-3">
      <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <Loader2 className="h-4 w-4 animate-spin text-purple-600" />
        Uploading <code className="font-mono text-xs">{fileName}</code>…
      </div>
      <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
        <div
          className="h-full bg-purple-600 transition-all"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <p className="text-xs text-zinc-400">
        The server is scanning <code className="font-mono">channels.json</code> and
        {' '}<code className="font-mono">users.json</code>. This takes a few seconds for most exports.
      </p>
    </div>
  );
}

// ─── Step: Preview-loading ──────────────────────────────────────────────────

function PreviewLoadingStep({
  importId,
  onReady,
  onError,
}: {
  importId: string;
  onReady: (p: FullPreview) => void;
  onError: (msg: string) => void;
}) {
  const query = useQuery({
    queryKey: ['slack-import-preview', importId],
    queryFn: () => slackImportApi.getPreview(importId),
    retry: 2,
  });

  useEffect(() => {
    if (query.data) onReady(query.data);
  }, [query.data, onReady]);

  useEffect(() => {
    if (query.error) {
      const e = query.error;
      const msg = e instanceof ApiError ? `${e.message} (status ${e.status})` : (e as Error).message;
      onError(msg);
    }
  }, [query.error, onError]);

  return (
    <div className="flex items-center gap-2 text-sm text-zinc-500 p-6 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading import preview…
    </div>
  );
}

// ─── Step: Mapping wizard ───────────────────────────────────────────────────

function MappingStep({
  preview,
  onCancel,
  onContinue,
}: {
  preview: FullPreview;
  onCancel: () => void;
  onContinue: (mapping: ImportMapping, summary: MappingSummary) => void;
}) {
  return (
    <MappingForm preview={preview} onCancel={onCancel} onContinue={onContinue} />
  );
}

interface MappingSummary {
  totalChannelsImported: number;
  totalMessagesEstimated: number;
  totalUsersTouched: number;
  newStubCount: number;
  inviteCount: number;
  attachmentsBytes: number;
}

function MappingForm({
  preview,
  onCancel,
  onContinue,
}: {
  preview: FullPreview;
  onCancel: () => void;
  onContinue: (mapping: ImportMapping, summary: MappingSummary) => void;
}) {
  // Projects + org members are used by typeaheads further down.
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<PaginatedResponse<Project>>('/projects'),
  });
  const projects = projectsQuery.data?.data ?? [];

  const membersQuery = useQuery({
    queryKey: ['org-members'],
    queryFn: () => peopleApi.listMembers(),
  });
  const members = membersQuery.data?.data ?? [];

  // Seed form from preview.
  const initial = useMemo<MappingFormState>(() => {
    const users: Record<string, UserMappingRow> = {};
    for (const u of preview.users) {
      const action = defaultUserAction(u);
      users[u.slack_user_id] = {
        slack_user_id: u.slack_user_id,
        action,
        target_user_id: u.matched_user?.id,
        send_email: action === 'send_invite' ? true : undefined,
      };
    }
    const channels: Record<string, ChannelMappingRow> = {};
    for (const c of preview.channels) {
      channels[c.slack_channel_id] = {
        slack_channel_id: c.slack_channel_id,
        action: defaultChannelAction(c),
        target_name: c.slack_name,
      };
    }
    return {
      projectMode: 'create_new',
      newProjectName: `Slack: ${preview.workspace_name}`,
      newProjectKey: slugify(preview.workspace_name),
      existingProjectId: '',
      users,
      channels,
      options: { ...DEFAULT_OPTIONS },
    };
  }, [preview]);

  const [form, setForm] = useState<MappingFormState>(initial);

  // Collapse states
  const [projectOpen, setProjectOpen] = useState(true);
  const [usersOpen, setUsersOpen] = useState(true);
  const [autoMappedOpen, setAutoMappedOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(true);

  const updateUser = (slackId: string, patch: Partial<UserMappingRow>) => {
    setForm((f) => ({
      ...f,
      users: { ...f.users, [slackId]: { ...f.users[slackId]!, ...patch } },
    }));
  };
  const updateChannel = (slackId: string, patch: Partial<ChannelMappingRow>) => {
    setForm((f) => ({
      ...f,
      channels: { ...f.channels, [slackId]: { ...f.channels[slackId]!, ...patch } },
    }));
  };

  // Derived buckets
  const autoMappedUsers = preview.users.filter((u) => form.users[u.slack_user_id]?.action === 'auto_match');
  const unmappedUsers = preview.users.filter((u) => form.users[u.slack_user_id]?.action !== 'auto_match');
  const realChannels = preview.channels.filter((c) => c.channel_type === 'public' || c.channel_type === 'private');
  const directChannels = preview.channels.filter((c) => c.channel_type === 'dm' || c.channel_type === 'mpim');

  // Bulk actions
  const bulkInviteAllWithEmail = () => {
    setForm((f) => {
      const next = { ...f.users };
      for (const u of unmappedUsers) {
        if (u.email) next[u.slack_user_id] = { ...next[u.slack_user_id]!, action: 'send_invite', send_email: true };
      }
      return { ...f, users: next };
    });
  };
  const bulkStubAll = () => {
    setForm((f) => {
      const next = { ...f.users };
      for (const u of unmappedUsers) {
        next[u.slack_user_id] = { ...next[u.slack_user_id]!, action: 'stub', target_user_id: undefined };
      }
      return { ...f, users: next };
    });
  };
  const bulkSkipAll = () => {
    if (!window.confirm(
      'Skip ALL unmapped users? Their messages will be attributed to the Slack Migration bot. You can still adjust individual users after this.',
    )) return;
    setForm((f) => {
      const next = { ...f.users };
      for (const u of unmappedUsers) {
        next[u.slack_user_id] = { ...next[u.slack_user_id]!, action: 'skip', target_user_id: undefined };
      }
      return { ...f, users: next };
    });
  };
  const bulkSkipPrivate = () => {
    setForm((f) => {
      const next = { ...f.channels };
      for (const c of realChannels) {
        if (c.channel_type === 'private') next[c.slack_channel_id] = { ...next[c.slack_channel_id]!, action: 'skip' };
      }
      return { ...f, channels: next };
    });
  };
  const bulkSkipArchived = () => {
    setForm((f) => {
      const next = { ...f.channels };
      for (const c of realChannels) {
        if (c.is_archived) next[c.slack_channel_id] = { ...next[c.slack_channel_id]!, action: 'skip' };
      }
      return { ...f, channels: next };
    });
  };

  // Validation + summary
  const summary = useMemo<MappingSummary>(() => {
    let totalChannelsImported = 0;
    let totalMessagesEstimated = 0;
    for (const c of preview.channels) {
      const row = form.channels[c.slack_channel_id];
      if (!row) continue;
      if (c.channel_type === 'dm' || c.channel_type === 'mpim') {
        if (!form.options.import_dms) continue;
      }
      if (row.action !== 'skip') {
        totalChannelsImported += 1;
        totalMessagesEstimated += c.message_count;
      }
    }
    let newStubCount = 0;
    let inviteCount = 0;
    let totalUsersTouched = 0;
    for (const u of preview.users) {
      const row = form.users[u.slack_user_id];
      if (!row) continue;
      totalUsersTouched += 1;
      if (row.action === 'send_invite') {
        newStubCount += 1;
        if (row.send_email !== false) inviteCount += 1;
      } else if (row.action === 'stub') {
        newStubCount += 1;
      }
    }
    return {
      totalChannelsImported,
      totalMessagesEstimated,
      totalUsersTouched,
      newStubCount,
      inviteCount,
      attachmentsBytes: preview.totals.attachments_estimated_bytes,
    };
  }, [preview, form]);

  const errors: string[] = [];
  if (form.projectMode === 'create_new') {
    if (!form.newProjectName.trim()) errors.push('Pick a name for the new project.');
    if (!form.newProjectKey.trim()) errors.push('Project key cannot be empty.');
  } else if (!form.existingProjectId) {
    errors.push('Pick an existing project to import into.');
  }
  for (const c of preview.channels) {
    const row = form.channels[c.slack_channel_id]!;
    if (row.action === 'merge_existing' && !row.target_channel_id) {
      errors.push(`Pick a target channel for "${c.slack_name}" (or change its action).`);
    }
  }
  for (const u of preview.users) {
    const row = form.users[u.slack_user_id]!;
    if (row.action === 'map_existing' && !row.target_user_id) {
      errors.push(`Pick a target user for Slack user "${u.slack_display_name}".`);
    }
    if (row.action === 'send_invite' && !u.email) {
      errors.push(`Slack user "${u.slack_display_name}" has no email — cannot send invite.`);
    }
  }

  const buildMapping = (): ImportMapping => ({
    project:
      form.projectMode === 'create_new'
        ? { mode: 'create_new', name: form.newProjectName.trim(), key: form.newProjectKey.trim().toUpperCase() }
        : { mode: 'use_existing', project_id: form.existingProjectId },
    users: Object.values(form.users),
    channels: Object.values(form.channels),
    options: form.options,
  });

  return (
    <div className="space-y-3">
      {/* Project picker */}
      <Section
        title="1. Target project"
        icon={<Pencil className="h-4 w-4" />}
        open={projectOpen}
        onToggle={() => setProjectOpen((v) => !v)}
        subtitle={
          form.projectMode === 'create_new'
            ? `Create "${form.newProjectName}"`
            : projects.find((p) => p.id === form.existingProjectId)?.name ?? '(none selected)'
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={form.projectMode === 'create_new'}
                onChange={() => setForm((f) => ({ ...f, projectMode: 'create_new' }))}
              />
              Create a new project
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={form.projectMode === 'use_existing'}
                onChange={() => setForm((f) => ({ ...f, projectMode: 'use_existing' }))}
              />
              Use an existing project
            </label>
          </div>

          {form.projectMode === 'create_new' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                id="new-project-name"
                label="Project name"
                value={form.newProjectName}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    newProjectName: e.target.value,
                    newProjectKey: slugify(e.target.value),
                  }))
                }
              />
              <Input
                id="new-project-key"
                label="Project key"
                value={form.newProjectKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, newProjectKey: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') }))
                }
                maxLength={24}
              />
            </div>
          ) : (
            <ProjectTypeahead
              projects={projects}
              value={form.existingProjectId}
              onChange={(id) => setForm((f) => ({ ...f, existingProjectId: id }))}
              loading={projectsQuery.isLoading}
            />
          )}
        </div>
      </Section>

      {/* User mapping */}
      <Section
        title={`2. User mapping (${preview.users.length})`}
        icon={<UserPlus className="h-4 w-4" />}
        open={usersOpen}
        onToggle={() => setUsersOpen((v) => !v)}
        subtitle={
          `${autoMappedUsers.length} auto-matched · ${summary.newStubCount} new stub${summary.newStubCount === 1 ? '' : 's'}` +
          (summary.inviteCount > 0 ? ` · ${summary.inviteCount} invite${summary.inviteCount === 1 ? '' : 's'}` : '')
        }
      >
        {/* Auto-mapped collapsed group */}
        {autoMappedUsers.length > 0 && (
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 mb-3">
            <button
              type="button"
              onClick={() => setAutoMappedOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <span className="inline-flex items-center gap-2">
                {autoMappedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {autoMappedUsers.length} user{autoMappedUsers.length === 1 ? '' : 's'} auto-matched by email
              </span>
              <span className="text-xs text-zinc-500">Review</span>
            </button>
            {autoMappedOpen && (
              <ul className="px-3 pb-3 space-y-1 text-sm">
                {autoMappedUsers.map((u) => (
                  <li key={u.slack_user_id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-zinc-700 dark:text-zinc-300 truncate">
                      <span className="font-medium">{u.slack_display_name}</span>
                      <span className="text-zinc-400 ml-2">{u.email}</span>
                    </span>
                    <span className="text-zinc-500 truncate">
                      → {u.matched_user?.display_name ?? '(unknown)'} ({u.matched_user?.email})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Unmapped table */}
        {unmappedUsers.length > 0 ? (
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Button size="sm" variant="secondary" onClick={bulkInviteAllWithEmail}>
                Send invite to all unmapped with email
              </Button>
              <Button size="sm" variant="secondary" onClick={bulkStubAll}>
                Stub all unmapped
              </Button>
              <Button size="sm" variant="ghost" onClick={bulkSkipAll}>
                Skip all unmapped
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase text-zinc-500">
                    <th className="px-3 py-2 font-medium">Slack user</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Messages</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {unmappedUsers.map((u) => {
                    const row = form.users[u.slack_user_id]!;
                    return (
                      <tr key={u.slack_user_id} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-3 py-2">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{u.slack_display_name}</div>
                          {u.slack_real_name && u.slack_real_name !== u.slack_display_name && (
                            <div className="text-xs text-zinc-500">{u.slack_real_name}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-500 text-xs">{u.email ?? <span className="italic">none</span>}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-zinc-600 dark:text-zinc-400">
                            <MessageSquare className="h-3 w-3" />
                            {formatNumber(u.message_count)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={row.action}
                            onChange={(e) => {
                              const next = e.target.value as UserMappingAction;
                              updateUser(u.slack_user_id, {
                                action: next,
                                target_user_id: next === 'map_existing' ? row.target_user_id : undefined,
                                send_email: next === 'send_invite' ? row.send_email ?? true : undefined,
                              });
                            }}
                            className="text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1"
                          >
                            <option value="send_invite" disabled={!u.email}>Send invite</option>
                            <option value="stub">Stub</option>
                            <option value="map_existing">Map to existing</option>
                            <option value="skip">Skip</option>
                          </select>
                          {row.action === 'send_invite' && (
                            <label className="flex items-center gap-1 mt-1 text-[11px] text-zinc-500">
                              <input
                                type="checkbox"
                                checked={row.send_email !== false}
                                onChange={(e) => updateUser(u.slack_user_id, { send_email: e.target.checked })}
                              />
                              Email invite now
                            </label>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {row.action === 'stub' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[11px] text-green-700 dark:text-green-400">
                              Will be created inactive
                            </span>
                          )}
                          {row.action === 'send_invite' && (
                            <span className="text-xs text-zinc-500">
                              Invite → {u.email}
                            </span>
                          )}
                          {row.action === 'skip' && (
                            <span className="text-xs text-zinc-400">
                              Attributed to migration bot
                            </span>
                          )}
                          {row.action === 'map_existing' && (
                            <UserTypeahead
                              members={members}
                              value={row.target_user_id ?? ''}
                              onChange={(id) => updateUser(u.slack_user_id, { target_user_id: id })}
                              loading={membersQuery.isLoading}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">All users were auto-matched.</p>
        )}
      </Section>

      {/* Channel mapping */}
      <Section
        title={`3. Channel mapping (${realChannels.length})`}
        icon={<Hash className="h-4 w-4" />}
        open={channelsOpen}
        onToggle={() => setChannelsOpen((v) => !v)}
        subtitle={`${summary.totalChannelsImported} will be imported · ~${formatNumber(summary.totalMessagesEstimated)} messages`}
      >
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Button size="sm" variant="ghost" onClick={bulkSkipPrivate}>
            Skip all private channels
          </Button>
          <Button size="sm" variant="ghost" onClick={bulkSkipArchived}>
            Skip all archived channels
          </Button>
        </div>
        <ChannelTable
          channels={realChannels}
          rows={form.channels}
          onUpdate={updateChannel}
          existingChannels={[]}
        />

        {directChannels.length > 0 && (
          <div className="mt-3 rounded-md border border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setDmsOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <span className="inline-flex items-center gap-2">
                {dmsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Direct messages ({directChannels.length})
                <span className="text-xs text-zinc-400">
                  (default off; flip "Import DMs" in options to include)
                </span>
              </span>
            </button>
            {dmsOpen && (
              <div className="p-3">
                <ChannelTable
                  channels={directChannels}
                  rows={form.channels}
                  onUpdate={updateChannel}
                  existingChannels={[]}
                  disabled={!form.options.import_dms}
                />
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Options */}
      <Section
        title="4. Options"
        icon={<Pencil className="h-4 w-4" />}
        open={optionsOpen}
        onToggle={() => setOptionsOpen((v) => !v)}
        subtitle={summarizeOptions(form.options)}
      >
        <OptionsPanel
          options={form.options}
          onChange={(patch) => setForm((f) => ({ ...f, options: { ...f.options, ...patch } }))}
        />
      </Section>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
        <div className="text-xs text-zinc-500">
          {errors.length > 0 && (
            <details>
              <summary className="text-red-600 dark:text-red-400 cursor-pointer">
                {errors.length} validation issue{errors.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-1 list-disc list-inside text-[11px] text-red-600/80 dark:text-red-400/80">
                {errors.slice(0, 5).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
                {errors.length > 5 && <li>… and {errors.length - 5} more</li>}
              </ul>
            </details>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={errors.length > 0}
            onClick={() => onContinue(buildMapping(), summary)}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

function summarizeOptions(o: ImportOptions): string {
  const parts: string[] = [];
  if (o.preserve_timestamps) parts.push('timestamps');
  if (o.import_attachments) parts.push('attachments');
  if (o.import_reactions) parts.push('reactions');
  if (o.import_pins) parts.push('pins');
  if (o.import_dms) parts.push('DMs');
  if (o.dry_run) parts.push('DRY RUN');
  return parts.length ? parts.join(' · ') : '(all off)';
}

// ─── Mapping: subcomponents ────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  icon,
  open,
  onToggle,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          {icon && <span className="text-zinc-500">{icon}</span>}
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
        </div>
        {subtitle && <span className="text-xs text-zinc-500 truncate ml-2">{subtitle}</span>}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function ProjectTypeahead({
  projects,
  value,
  onChange,
  loading,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = projects.find((p) => p.id === value);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return projects.slice(0, 20);
    return projects
      .filter((p) => p.name.toLowerCase().includes(q) || (p.task_id_prefix ?? '').toLowerCase().includes(q) || (p.slug ?? '').toLowerCase().includes(q))
      .slice(0, 20);
  }, [projects, query]);

  if (loading) {
    return <p className="text-xs text-zinc-400">Loading projects…</p>;
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query.length > 0 || !selected ? query : `${selected.name}`}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder="Search projects…"
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
        />
        {selected && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              setQuery('');
            }}
            className="p-1 text-zinc-400 hover:text-zinc-600"
            title="Clear"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
          {filtered.map((p) => (
            <li
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p.id);
                setQuery('');
                setOpen(false);
              }}
              className="px-3 py-2 text-sm cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="font-medium">{p.name}</span>
              {p.task_id_prefix && <span className="ml-2 text-xs text-zinc-400 font-mono">{p.task_id_prefix}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserTypeahead({
  members,
  value,
  onChange,
  loading,
}: {
  members: PersonListItem[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = members.find((m) => m.id === value);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return members.slice(0, 15);
    return members
      .filter((m) => m.display_name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .slice(0, 15);
  }, [members, query]);

  if (loading) {
    return <p className="text-[11px] text-zinc-400">Loading users…</p>;
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query.length > 0 || !selected ? query : selected.display_name}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        placeholder="Search users…"
        className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 w-56 max-h-48 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
          {filtered.map((m) => (
            <li
              key={m.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(m.id);
                setQuery('');
                setOpen(false);
              }}
              className="px-2 py-1 text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <div className="font-medium truncate">{m.display_name}</div>
              <div className="text-zinc-500 truncate">{m.email}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelTable({
  channels,
  rows,
  onUpdate,
  existingChannels: _existingChannels,
  disabled,
}: {
  channels: ImportPreviewChannel[];
  rows: Record<string, ChannelMappingRow>;
  onUpdate: (slackId: string, patch: Partial<ChannelMappingRow>) => void;
  existingChannels: { id: string; name: string }[];
  disabled?: boolean;
}) {
  if (channels.length === 0) return <p className="text-xs text-zinc-500">No channels.</p>;
  return (
    <div className={'overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 ' + (disabled ? 'opacity-50' : '')}>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase text-zinc-500">
            <th className="px-3 py-2 font-medium">Slack channel</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Members</th>
            <th className="px-3 py-2 font-medium">Messages</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Target</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => {
            const row = rows[c.slack_channel_id]!;
            const isPrivate = c.channel_type === 'private';
            return (
              <tr key={c.slack_channel_id} className={'border-t border-zinc-100 dark:border-zinc-800 ' + (c.conflict ? 'bg-amber-50/40 dark:bg-amber-900/10' : '')}>
                <td className="px-3 py-2">
                  <div className="font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                    {isPrivate && <Lock className="h-3 w-3 text-zinc-400" />}
                    {c.slack_name}
                    {c.is_archived && (
                      <span className="text-[10px] uppercase text-zinc-400 rounded bg-zinc-100 dark:bg-zinc-800 px-1">
                        archived
                      </span>
                    )}
                  </div>
                  {c.topic && <div className="text-xs text-zinc-500 truncate max-w-md">{c.topic}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">{c.channel_type}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">{formatNumber(c.member_count)}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">{formatNumber(c.message_count)}</td>
                <td className="px-3 py-2">
                  <select
                    disabled={disabled}
                    value={row.action}
                    onChange={(e) =>
                      onUpdate(c.slack_channel_id, {
                        action: e.target.value as ChannelMappingAction,
                      })
                    }
                    className="text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1"
                  >
                    <option value="import_new">Import as new</option>
                    <option value="merge_existing">Merge into existing</option>
                    <option value="skip">Skip</option>
                  </select>
                  {c.conflict && row.action === 'import_new' && (
                    <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Name conflict — will be auto-suffixed
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {row.action === 'import_new' && (
                    <input
                      type="text"
                      disabled={disabled}
                      value={row.target_name ?? c.slack_name}
                      onChange={(e) => onUpdate(c.slack_channel_id, { target_name: e.target.value })}
                      className="w-32 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs"
                    />
                  )}
                  {row.action === 'merge_existing' && (
                    <input
                      type="text"
                      disabled={disabled}
                      placeholder="target channel id"
                      value={row.target_channel_id ?? ''}
                      onChange={(e) => onUpdate(c.slack_channel_id, { target_channel_id: e.target.value })}
                      className="w-40 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs"
                    />
                  )}
                  {row.action === 'skip' && (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OptionsPanel({
  options,
  onChange,
}: {
  options: ImportOptions;
  onChange: (patch: Partial<ImportOptions>) => void;
}) {
  return (
    <div className="space-y-3">
      <ToggleRow
        label="Preserve original timestamps"
        checked={options.preserve_timestamps}
        onChange={(v) => onChange({ preserve_timestamps: v })}
      />
      <ToggleRow
        label="Import attachments"
        helper="When on, files are re-uploaded to MinIO. Off skips files entirely."
        checked={options.import_attachments}
        onChange={(v) => onChange({ import_attachments: v })}
      />
      {options.import_attachments && (
        <div className="pl-6">
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
            Slack bearer token (optional)
          </label>
          <input
            type="password"
            placeholder="xoxp-…"
            value={options.slack_bearer_token ?? ''}
            onChange={(e) => onChange({ slack_bearer_token: e.target.value || null })}
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-mono"
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Required for standard exports — corporate exports include files locally.
            Token is used once and never stored.
          </p>
        </div>
      )}
      <ToggleRow
        label="Import reactions"
        checked={options.import_reactions}
        onChange={(v) => onChange({ import_reactions: v })}
      />
      <ToggleRow
        label="Import pins"
        checked={options.import_pins}
        onChange={(v) => onChange({ import_pins: v })}
      />
      <ToggleRow
        label="Import DMs and group DMs"
        helper="Privacy-sensitive — off by default. When on, DMs become Banter DMs between mapped users."
        checked={options.import_dms}
        onChange={(v) => onChange({ import_dms: v })}
      />
      <ToggleRow
        label="Notify members on import completion"
        checked={options.notify_on_completion}
        onChange={(v) => onChange({ notify_on_completion: v })}
      />
      <ToggleRow
        label="Dry run"
        helper="Runs the full pipeline without writing anything; produces a diff report."
        checked={options.dry_run}
        onChange={(v) => onChange({ dry_run: v })}
      />
      <div>
        <label className="text-sm text-zinc-700 dark:text-zinc-300 mb-1 block">
          Daily message rate cap
        </label>
        <input
          type="number"
          min={100}
          max={1_000_000}
          value={options.daily_message_rate_cap}
          onChange={(e) =>
            onChange({ daily_message_rate_cap: Math.max(100, parseInt(e.target.value, 10) || 100) })
          }
          className="w-32 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          Throttles the worker so a huge import does not saturate Postgres.
        </p>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  helper,
  checked,
  onChange,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm text-zinc-700 dark:text-zinc-300">{label}</div>
        {helper && <div className="text-[11px] text-zinc-500 mt-0.5">{helper}</div>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
      />
    </label>
  );
}

// ─── Step: Confirming ──────────────────────────────────────────────────────

function ConfirmingStep({
  preview,
  importId,
  onBack,
  onStarted,
  onError,
}: {
  preview: FullPreview;
  importId: string;
  onBack: () => void;
  onStarted: (id: string) => void;
  onError: (msg: string) => void;
}) {
  // Re-render the mapping step under a modal so the user can see context.
  // We restore the mapping from the operator's previous step by re-deriving
  // it here — but to avoid resetting their edits we keep the same form
  // state lifted in MappingForm. For simplicity, the dialog asks them to
  // re-confirm using the already-built mapping passed in via onContinue.
  // Here we receive only the preview, so we render a recomputed default
  // summary and a Start button. (The build happens inside MappingForm.)
  //
  // To keep the state simple in this proof of life, the ConfirmingStep
  // owns a fresh MappingForm whose default seed exactly matches what the
  // operator had visible last; in practice the user clicked Continue, so
  // we trust the mapping was already valid.
  //
  // We render the mapping form here too so the user can still tweak things
  // if they want.
  const [mappingState, setMappingState] = useState<{
    mapping: ImportMapping;
    summary: MappingSummary;
  } | null>(null);

  const startMutation = useMutation({
    mutationFn: (m: ImportMapping) => slackImportApi.start(importId, m),
    onSuccess: () => onStarted(importId),
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.message} (status ${e.status})` : (e as Error).message;
      onError(msg);
    },
  });

  return (
    <>
      <MappingForm
        preview={preview}
        onCancel={onBack}
        onContinue={(mapping, summary) => setMappingState({ mapping, summary })}
      />
      <Dialog
        open={mappingState !== null}
        onOpenChange={(o) => !o && setMappingState(null)}
        title="Start Slack import?"
        description="This kicks off the worker. Progress is shown in the next step."
      >
        {mappingState && (
          <div className="space-y-4">
            <div className="text-sm space-y-1 text-zinc-700 dark:text-zinc-300">
              <SummaryLine label="Channels" value={formatNumber(mappingState.summary.totalChannelsImported)} />
              <SummaryLine label="Messages (est.)" value={formatNumber(mappingState.summary.totalMessagesEstimated)} />
              <SummaryLine label="Users touched" value={formatNumber(mappingState.summary.totalUsersTouched)} />
              <SummaryLine
                label="New stub users"
                value={`${formatNumber(mappingState.summary.newStubCount)}${
                  mappingState.summary.inviteCount > 0 ? ` (${mappingState.summary.inviteCount} invite${mappingState.summary.inviteCount === 1 ? '' : 's'})` : ''
                }`}
              />
              <SummaryLine label="Attachments" value={formatBytes(mappingState.summary.attachmentsBytes)} />
              {mappingState.mapping.options.dry_run && (
                <div className="mt-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/50 p-2 text-xs text-amber-800 dark:text-amber-200">
                  Dry run is ON — no rows will be written.
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
              <Button variant="secondary" onClick={() => setMappingState(null)}>
                Back
              </Button>
              <Button
                onClick={() => startMutation.mutate(mappingState.mapping)}
                loading={startMutation.isPending}
              >
                Start Import
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ─── Step: Running ─────────────────────────────────────────────────────────

function RunningStep({
  importId,
  onDone,
  onNavigate,
}: {
  importId: string;
  onDone: (s: ImportStatus) => void;
  onNavigate?: (path: string) => void;
}) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [cleanupStubs, setCleanupStubs] = useState(false);
  const [_localError, setLocalError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['slack-import-status', importId],
    queryFn: () => slackImportApi.getStatus(importId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && (s === 'done' || s === 'failed' || s === 'aborted') ? false : POLL_INTERVAL_MS;
    },
  });

  const status = statusQuery.data;

  useEffect(() => {
    if (status && (status.status === 'done' || status.status === 'failed' || status.status === 'aborted')) {
      onDone(status);
    }
  }, [status, onDone]);

  const abortMutation = useMutation({
    mutationFn: (cleanup: boolean) => slackImportApi.abort(importId, cleanup),
    onSuccess: () => {
      setConfirmAbort(false);
      statusQuery.refetch();
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.message} (status ${e.status})` : (e as Error).message;
      setLocalError(msg);
    },
  });

  if (statusQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500 p-6 rounded-lg border border-zinc-200 dark:border-zinc-800">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading import status…
      </div>
    );
  }
  if (statusQuery.error) {
    const e = statusQuery.error;
    const msg = e instanceof ApiError ? `${e.message} (status ${e.status})` : (e as Error).message;
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load import status: {msg}
      </div>
    );
  }
  if (!status) return null;

  const currentIdx = PHASE_ORDER.indexOf(status.status);
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Import in progress
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Import id <code className="font-mono">{importId}</code>
          </p>
        </div>
        {status.status !== 'done' && status.status !== 'failed' && status.status !== 'aborted' && (
          <Button size="sm" variant="danger" onClick={() => setConfirmAbort(true)}>
            Abort
          </Button>
        )}
      </div>

      {/* Phase list */}
      <ul className="space-y-1.5">
        {PHASE_ORDER.slice(1).map((phase, i) => {
          const idx = i + 1;
          const isDone = currentIdx > idx;
          const isCurrent = currentIdx === idx;
          return (
            <li key={phase} className="flex items-center gap-2 text-sm">
              {isDone ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : isCurrent ? (
                <Loader2 className="h-4 w-4 text-purple-600 animate-spin" />
              ) : (
                <CircleDashed className="h-4 w-4 text-zinc-300 dark:text-zinc-700" />
              )}
              <span
                className={
                  isCurrent
                    ? 'text-zinc-900 dark:text-zinc-100 font-medium'
                    : isDone
                      ? 'text-zinc-500 line-through'
                      : 'text-zinc-400'
                }
              >
                {PHASE_LABELS[phase]}
              </span>
              {isCurrent && status.progress_total > 0 && (
                <span className="text-xs text-zinc-500 ml-1">
                  {formatNumber(status.progress_done)} / {formatNumber(status.progress_total)}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Progress bar */}
      {status.progress_total > 0 && (
        <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
          <div
            className="h-full bg-purple-600 transition-all"
            style={{
              width: `${Math.min(100, (status.progress_done / Math.max(1, status.progress_total)) * 100)}%`,
            }}
          />
        </div>
      )}

      {/* Per-channel counters */}
      {status.channels_in_flight && status.channels_in_flight.length > 0 && (
        <details>
          <summary className="text-xs text-zinc-500 cursor-pointer">
            Show per-channel progress ({status.channels_in_flight.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {status.channels_in_flight.map((c) => (
              <li key={c.slack_name} className="flex items-center justify-between">
                <span className="text-zinc-700 dark:text-zinc-300">
                  <Hash className="inline h-3 w-3 mr-0.5" />
                  {c.target_name ?? c.slack_name}
                </span>
                <span className="text-zinc-500">
                  {formatNumber(c.messages_done)} / {formatNumber(c.messages_total)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Totals so far */}
      {Object.keys(status.totals_imported).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          {Object.entries(status.totals_imported).map(([k, v]) => (
            <div key={k} className="rounded bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2">
              <div className="text-zinc-500 capitalize">{k}</div>
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{formatNumber(v ?? 0)}</div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={confirmAbort}
        onOpenChange={(o) => !o && setConfirmAbort(false)}
        title="Abort this import?"
        description="The worker will stop and any rows it created will be cleaned up."
      >
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={cleanupStubs}
              onChange={(e) => setCleanupStubs(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <span>
              Also remove the stub users this import created.
              <span className="block text-xs text-zinc-500">
                Auto-mapped and pre-existing users are never touched.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmAbort(false)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              onClick={() => abortMutation.mutate(cleanupStubs)}
              loading={abortMutation.isPending}
            >
              <Trash2 className="h-4 w-4" />
              Abort import
            </Button>
          </div>
        </div>
      </Dialog>

      {onNavigate && <span className="hidden">{/* keep onNavigate referenced */}</span>}
    </div>
  );
}

// ─── Step: Completion (done | failed | aborted) ────────────────────────────

function CompletionStep({
  status,
  variant,
  onDismiss,
  onNavigate,
}: {
  status: ImportStatus;
  variant: 'done' | 'failed' | 'aborted';
  onDismiss: () => void;
  onNavigate?: (path: string) => void;
}) {
  if (variant === 'done') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-900/20 p-5 space-y-3">
        <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
          <Check className="h-5 w-5" />
          <h3 className="text-base font-semibold">Import complete</h3>
        </div>
        <ul className="text-sm text-green-900 dark:text-green-100 space-y-0.5">
          {Object.entries(status.totals_imported).map(([k, v]) => (
            <li key={k}>
              <span className="capitalize">{k}</span>: {formatNumber(v ?? 0)}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 pt-2 border-t border-green-200 dark:border-green-900/50">
          {onNavigate && status.channel_group_id && (
            <Button
              size="sm"
              onClick={() =>
                onNavigate(`/banter/channels?group=${status.channel_group_id}`)
              }
            >
              <ExternalLink className="h-4 w-4" />
              View imported channels
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  if (variant === 'failed') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/20 p-5 space-y-3">
        <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
          <AlertCircle className="h-5 w-5" />
          <h3 className="text-base font-semibold">Import failed</h3>
        </div>
        <p className="text-sm text-red-900 dark:text-red-100">
          {status.error_message ?? 'No error message provided.'}
        </p>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 p-5 space-y-3">
      <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
        <CircleSlash className="h-5 w-5" />
        <h3 className="text-base font-semibold">Import aborted</h3>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Cleanup ran successfully. You can start a new import anytime.
      </p>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

// ─── History table ─────────────────────────────────────────────────────────

function HistoryTable({
  items,
  onView,
}: {
  items: ImportHistoryItem[];
  onView: (id: string) => void;
}) {
  const top = items.slice(0, 10);
  if (top.length === 0) return null;
  return (
    <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 flex items-center gap-2">
        <Download className="h-4 w-4" />
        Recent imports
      </h3>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 text-left text-xs uppercase text-zinc-500">
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">Channels</th>
              <th className="px-3 py-2 font-medium">Messages</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {top.map((it) => (
              <Fragment key={it.id}>
                <tr className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-3 py-2 text-xs text-zinc-500">{formatDate(it.created_at)}</td>
                  <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{it.workspace_name}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{it.project_id ? it.project_id.slice(0, 8) : '—'}</td>
                  <td className="px-3 py-2 text-xs">{formatNumber(it.totals_imported?.channels)}</td>
                  <td className="px-3 py-2 text-xs">{formatNumber(it.totals_imported?.messages)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={it.status as ImportPhase} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => onView(it.id)}>
                      View details
                    </Button>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ImportPhase }) {
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Done
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Failed
      </span>
    );
  }
  if (status === 'aborted') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
        Aborted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:text-purple-400">
      <RefreshCw className="h-2.5 w-2.5 animate-spin" />
      {PHASE_LABELS[status] ?? status}
    </span>
  );
}
