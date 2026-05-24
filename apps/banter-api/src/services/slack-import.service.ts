// Slack workspace import — service layer for the slack-import routes.
//
// Lives between apps/banter-api/src/routes/slack-import.routes.ts and the
// worker. Responsibilities:
//   - MinIO operations (stash uploads, fetch back for preview re-scan)
//   - Loading the durable banter_slack_imports row with an org-scope check
//   - Validating the user/channel mapping payload from the wizard
//   - Holding the BullMQ queue handle for the slack-import queue (lazy-init)
//
// See docs/plans/slack-import-design.md §3, §4b, §9, §10 for the full
// design. Per §13 #4 the data lives in banter-api; the cross-app Bam
// settings UI calls these routes via the nginx /banter/api/ proxy.

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as Minio from 'minio';
import StreamZip from 'node-stream-zip';
import { and, eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { db } from '../db/index.js';
import { banterSlackImports } from '../db/schema/index.js';
import { env } from '../env.js';

export const SLACK_IMPORT_QUEUE = 'slack-import';

// ── MinIO ──────────────────────────────────────────────────────────

let minioClient: Minio.Client | null = null;
export function getMinioClient(): Minio.Client {
  if (!minioClient) {
    const url = new URL(env.S3_ENDPOINT);
    minioClient = new Minio.Client({
      endPoint: url.hostname,
      port: parseInt(url.port || '9000', 10),
      useSSL: url.protocol === 'https:',
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return minioClient;
}

export function slackImportObjectKey(orgId: string, importId: string): string {
  return `slack-imports/${orgId}/${importId}.zip`;
}

export async function ensureBucket(): Promise<void> {
  const client = getMinioClient();
  const exists = await client.bucketExists(env.S3_BUCKET);
  if (!exists) {
    await client.makeBucket(env.S3_BUCKET, env.S3_REGION);
  }
}

/** Stream an uploaded file (already buffered or in a stream) into MinIO. */
export async function stashUpload(
  key: string,
  body: Buffer | Readable,
  size: number,
  contentType = 'application/zip',
): Promise<void> {
  await ensureBucket();
  const client = getMinioClient();
  await client.putObject(env.S3_BUCKET, key, body, size, {
    'Content-Type': contentType,
  });
}

/** Download the stashed .zip to a temporary directory for scanning. */
export async function downloadToTempfile(key: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const client = getMinioClient();
  const dir = await mkdtemp(join(tmpdir(), 'bbb-slack-import-'));
  const path = join(dir, 'workspace.zip');
  const stream = await client.getObject(env.S3_BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await writeFile(path, Buffer.concat(chunks));
  return {
    path,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

// ── Slack export preview ───────────────────────────────────────────

export interface SlackPreviewUser {
  slack_id: string;
  email: string | null;
  display_name: string;
  real_name: string | null;
  is_bot: boolean;
  is_deleted: boolean;
}

export interface SlackPreviewChannel {
  slack_id: string;
  name: string;
  type: 'public' | 'private' | 'dm' | 'mpim';
  topic: string | null;
  purpose: string | null;
  members: number;
  message_files: number;
}

export interface SlackPreview {
  workspace_name: string;
  users: SlackPreviewUser[];
  channels: SlackPreviewChannel[];
  dms: SlackPreviewChannel[];
  mpims: SlackPreviewChannel[];
  channels_detected: number;
  dms_detected: number;
  users_detected: number;
  messages_estimated: number;
}

interface SlackUserRow {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    email?: string;
    display_name?: string;
    real_name?: string;
  };
}

interface SlackChannelRow {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_mpim?: boolean;
  is_im?: boolean;
  members?: string[];
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
  user?: string; // for DMs
  users?: string[]; // for mpims
}

function mapUser(row: SlackUserRow): SlackPreviewUser {
  const profile = row.profile ?? {};
  return {
    slack_id: row.id ?? '',
    email: profile.email ?? null,
    display_name: profile.display_name || row.name || profile.real_name || row.real_name || row.id || 'unknown',
    real_name: profile.real_name ?? row.real_name ?? null,
    is_bot: row.is_bot === true,
    is_deleted: row.deleted === true,
  };
}

function mapChannel(
  row: SlackChannelRow,
  type: 'public' | 'private' | 'dm' | 'mpim',
): SlackPreviewChannel {
  const members = Array.isArray(row.members)
    ? row.members.length
    : Array.isArray(row.users)
      ? row.users.length
      : typeof row.num_members === 'number'
        ? row.num_members
        : type === 'dm'
          ? 2
          : 0;
  return {
    slack_id: row.id ?? '',
    name: row.name ?? row.id ?? 'unnamed',
    type,
    topic: row.topic?.value ?? null,
    purpose: row.purpose?.value ?? null,
    members,
    message_files: 0,
  };
}

/**
 * Parse the .zip at `zipPath` and produce the wizard preview. Reads only
 * channels.json / groups.json / dms.json / mpims.json / users.json plus a
 * directory listing — never extracts message bodies. The messages estimate
 * is heuristic: count day-files under each channel directory and assume
 * ~50 messages per file.
 */
export async function buildPreview(zipPath: string): Promise<SlackPreview> {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entries = await zip.entries();

    async function readJsonIfPresent<T = unknown>(name: string): Promise<T | null> {
      const entry = entries[name];
      if (!entry || entry.isDirectory) return null;
      const buf = await zip.entryData(name);
      // Strip a UTF-8 BOM if present — Slack exports authored on Windows
      // (or zipped via Compress-Archive in PowerShell) sometimes carry one
      // and JSON.parse trips silently on it.
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }

    const usersRaw = (await readJsonIfPresent<SlackUserRow[]>('users.json')) ?? [];
    const channelsRaw = (await readJsonIfPresent<SlackChannelRow[]>('channels.json')) ?? [];
    const groupsRaw = (await readJsonIfPresent<SlackChannelRow[]>('groups.json')) ?? [];
    const dmsRaw = (await readJsonIfPresent<SlackChannelRow[]>('dms.json')) ?? [];
    const mpimsRaw = (await readJsonIfPresent<SlackChannelRow[]>('mpims.json')) ?? [];

    const users = usersRaw.map(mapUser);
    const channels: SlackPreviewChannel[] = [
      ...channelsRaw.map((r) => mapChannel(r, 'public')),
      ...groupsRaw.map((r) => mapChannel(r, 'private')),
    ];
    const dms = dmsRaw.map((r) => mapChannel(r, 'dm'));
    const mpims = mpimsRaw.map((r) => mapChannel(r, 'mpim'));

    // Count day-files per channel directory for the messages estimate.
    const dirFileCounts = new Map<string, number>();
    for (const name of Object.keys(entries)) {
      const slash = name.indexOf('/');
      if (slash <= 0) continue;
      const e = entries[name];
      if (!e || e.isDirectory) continue;
      const tail = name.slice(slash + 1);
      // Only count top-level YYYY-MM-DD.json files in the directory.
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(tail)) continue;
      const dir = name.slice(0, slash);
      dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1);
    }

    function assignFileCounts(list: SlackPreviewChannel[]) {
      for (const ch of list) {
        const count = dirFileCounts.get(ch.name) ?? 0;
        ch.message_files = count;
      }
    }
    assignFileCounts(channels);
    assignFileCounts(dms);
    assignFileCounts(mpims);

    const messagesEstimated =
      [...channels, ...dms, ...mpims].reduce(
        (acc, c) => acc + c.message_files * 50,
        0,
      );

    // Workspace name fallback: try first channel's creator workspace, then
    // the top-level dir name embedded in an entry, then 'slack-workspace'.
    let workspaceName = 'slack-workspace';
    const firstEntry = Object.keys(entries).find((n) => n.includes('/'));
    if (firstEntry) {
      const root = firstEntry.split('/')[0];
      if (root && root !== 'users.json' && root !== 'channels.json') {
        // The export's outer dir often isn't preserved when Slack zips
        // up flat. Use the first channel name as a soft fallback if no
        // outer dir.
      }
    }
    if (channels[0]?.name) {
      // Don't overwrite — leave as the generic name; channel name isn't
      // workspace name.
    }
    return {
      workspace_name: workspaceName,
      users,
      channels,
      dms,
      mpims,
      channels_detected: channels.length,
      dms_detected: dms.length + mpims.length,
      users_detected: users.length,
      messages_estimated: messagesEstimated,
    };
  } finally {
    await zip.close();
  }
}

// ── DB helpers ─────────────────────────────────────────────────────

export class SlackImportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SlackImportError';
  }
}

export interface SlackImportRow {
  id: string;
  org_id: string;
  project_id: string | null;
  channel_group_id: string | null;
  initiated_by: string;
  workspace_name: string;
  workspace_url: string | null;
  source_filename: string;
  source_size_bytes: number;
  source_minio_key: string;
  mapping: Record<string, unknown>;
  status: string;
  phase: string | null;
  progress_total: number;
  progress_done: number;
  totals_imported: Record<string, unknown>;
  totals_skipped: Record<string, unknown>;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function loadImportRow(
  orgId: string,
  importId: string,
): Promise<SlackImportRow | null> {
  const rows = await db
    .select()
    .from(banterSlackImports)
    .where(
      and(
        eq(banterSlackImports.id, importId),
        eq(banterSlackImports.org_id, orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    channel_group_id: row.channel_group_id,
    initiated_by: row.initiated_by,
    workspace_name: row.workspace_name,
    workspace_url: row.workspace_url,
    source_filename: row.source_filename,
    source_size_bytes: Number(row.source_size_bytes),
    source_minio_key: row.source_minio_key,
    mapping: (row.mapping as Record<string, unknown>) ?? {},
    status: row.status,
    phase: row.phase,
    progress_total: row.progress_total,
    progress_done: row.progress_done,
    totals_imported: (row.totals_imported as Record<string, unknown>) ?? {},
    totals_skipped: (row.totals_skipped as Record<string, unknown>) ?? {},
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Mapping validation ─────────────────────────────────────────────

export type UserMappingAction = 'auto_match' | 'invite' | 'stub' | 'map' | 'skip';
export type ChannelMappingAction = 'new' | 'merge' | 'skip';

export interface UserMappingEntry {
  slack_id: string;
  action: UserMappingAction;
  target_user_id?: string | null;
}

export interface ChannelMappingEntry {
  slack_id: string;
  action: ChannelMappingAction;
  target_channel_id?: string | null;
  target_name?: string | null;
}

export interface ProjectSelection {
  mode: 'create' | 'existing';
  id?: string | null;
  name?: string | null;
  key?: string | null;
}

export interface MappingOptions {
  preserve_timestamps: boolean;
  import_attachments: boolean;
  import_reactions: boolean;
  import_pins: boolean;
  import_dms: boolean;
  notify_on_completion: boolean;
  dry_run: boolean;
  daily_message_rate_cap: number;
  slack_bearer_token: string | null;
}

export interface MappingPayload {
  project: ProjectSelection;
  user_mapping: UserMappingEntry[];
  channel_mapping: ChannelMappingEntry[];
  options: MappingOptions;
}

export interface ValidationIssue {
  field: string;
  issue: string;
}

/**
 * Verify the mapping payload covers every slack user/channel from the
 * preview and that each entry has the fields its action requires.
 *
 * Pure function over the preview + mapping — does NOT verify target_user_id
 * / target_channel_id exist (that's the caller's responsibility because it
 * needs DB access for the org-scope check).
 */
export function validateMapping(
  preview: SlackPreview,
  mapping: MappingPayload,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Project
  if (!mapping.project || (mapping.project.mode !== 'create' && mapping.project.mode !== 'existing')) {
    issues.push({ field: 'project.mode', issue: 'must be "create" or "existing"' });
  } else if (mapping.project.mode === 'create') {
    if (!mapping.project.name || mapping.project.name.trim().length === 0) {
      issues.push({ field: 'project.name', issue: 'required when mode=create' });
    }
    if (!mapping.project.key || mapping.project.key.trim().length === 0) {
      issues.push({ field: 'project.key', issue: 'required when mode=create' });
    }
  } else if (mapping.project.mode === 'existing') {
    if (!mapping.project.id) {
      issues.push({ field: 'project.id', issue: 'required when mode=existing' });
    }
  }

  // User mapping coverage + per-entry validation.
  const userIndex = new Map<string, UserMappingEntry>();
  for (const entry of mapping.user_mapping ?? []) {
    if (entry?.slack_id) userIndex.set(entry.slack_id, entry);
  }
  for (const u of preview.users) {
    const entry = userIndex.get(u.slack_id);
    if (!entry) {
      issues.push({
        field: `user_mapping[${u.slack_id}]`,
        issue: `missing mapping for slack user ${u.slack_id} (${u.display_name})`,
      });
      continue;
    }
    if (entry.action === 'map' && !entry.target_user_id) {
      issues.push({
        field: `user_mapping[${u.slack_id}].target_user_id`,
        issue: 'required when action=map',
      });
    }
    if (entry.action === 'invite' && !u.email) {
      issues.push({
        field: `user_mapping[${u.slack_id}].action`,
        issue: 'invite requires the slack user to have an email',
      });
    }
  }

  // Channel mapping coverage + per-entry validation.
  const allChannels = [
    ...preview.channels,
    ...preview.dms,
    ...preview.mpims,
  ];
  const channelIndex = new Map<string, ChannelMappingEntry>();
  for (const entry of mapping.channel_mapping ?? []) {
    if (entry?.slack_id) channelIndex.set(entry.slack_id, entry);
  }
  for (const c of allChannels) {
    const entry = channelIndex.get(c.slack_id);
    if (!entry) {
      issues.push({
        field: `channel_mapping[${c.slack_id}]`,
        issue: `missing mapping for slack channel ${c.slack_id} (${c.name})`,
      });
      continue;
    }
    if (entry.action === 'merge' && !entry.target_channel_id) {
      issues.push({
        field: `channel_mapping[${c.slack_id}].target_channel_id`,
        issue: 'required when action=merge',
      });
    }
    if (entry.action === 'new' && !entry.target_name && !c.name) {
      issues.push({
        field: `channel_mapping[${c.slack_id}].target_name`,
        issue: 'required when action=new and source has no name',
      });
    }
  }

  return issues;
}

// ── BullMQ queue ───────────────────────────────────────────────────

let queue: Queue | null = null;
let queueConnection: Redis | null = null;

export function getSlackImportQueue(): Queue {
  if (!queue) {
    queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(SLACK_IMPORT_QUEUE, { connection: queueConnection });
  }
  return queue;
}

export async function enqueueSlackImport(importId: string): Promise<string | null> {
  try {
    const job = await getSlackImportQueue().add(
      `import-${importId}`,
      { import_id: importId },
      {
        jobId: `slack-import:${importId}`,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return typeof job.id === 'string' ? job.id : null;
  } catch {
    // Worker startup reconciler should pick up status='queued' rows even
    // if BullMQ enqueue fails. Surface null and let the caller decide.
    return null;
  }
}

// ── Cancellation pub-sub ───────────────────────────────────────────

let cancelPublisher: Redis | null = null;
function getCancelPublisher(): Redis {
  if (!cancelPublisher) {
    cancelPublisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return cancelPublisher;
}

export async function publishAbortSignal(importId: string): Promise<void> {
  try {
    await getCancelPublisher().publish(
      `banter:import:cancel:${importId}`,
      JSON.stringify({ import_id: importId, at: new Date().toISOString() }),
    );
  } catch {
    // best-effort — the worker also re-reads the row's status at every
    // batch boundary, so the worst case is a slightly slower stop.
  }
}
