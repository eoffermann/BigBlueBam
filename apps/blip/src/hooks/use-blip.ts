import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Shared shapes (mirror apps/blip-api; all responses are { data } envelopes).
// ---------------------------------------------------------------------------

export interface RateLimitSpec {
  refill_per_sec?: number;
  burst?: number;
  max_body_bytes?: number;
  max_batch_count?: number;
  max_capture_body_bytes?: number;
  max_capture_bytes?: number;
  max_captures_per_report?: number;
}

export interface TrackedApp {
  id: string;
  org_id: string;
  name: string;
  description?: string | null;
  collection_enabled: boolean;
  default_rate_limit?: RateLimitSpec | null;
  created_at: string;
  updated_at?: string;
  // Health (server may include these on GET /apps/:id)
  health?: TrackedAppHealth | null;
}

export interface TrackedAppHealth {
  entries_24h?: number;
  entries_total?: number;
  last_entry_at?: string | null;
  active_keys?: number;
  report_type_count?: number;
  dead_letter_count?: number;
  rejected_24h?: number;
  volume_sparkline?: number[];
}

// ---------------------------------------------------------------------------
// Predicate (Section 7.1) — net-new Blip filter tree.
// ---------------------------------------------------------------------------

export type PredicateOperator =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'is_set' | 'is_not_set';

export interface PredicateCondition {
  field: string; // reserved column or `payload:<dot.path>`
  operator: PredicateOperator;
  value?: unknown;
}

export interface PredicateTree {
  op: 'and' | 'or';
  conditions: Array<PredicateCondition | PredicateTree>;
}

// ---------------------------------------------------------------------------
// Tracked apps
// ---------------------------------------------------------------------------

export function useApps() {
  return useQuery({
    queryKey: ['blip', 'apps'],
    queryFn: () => api.get<{ data: TrackedApp[] }>('/apps'),
  });
}

export function useApp(id: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'apps', id],
    queryFn: () => api.get<{ data: TrackedApp }>(`/apps/${id}`),
    enabled: !!id,
  });
}

export interface CreateAppInput {
  name: string;
  description?: string;
}

export function useCreateApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAppInput) => api.post<{ data: TrackedApp }>('/apps', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'apps'] }),
  });
}

export function useUpdateApp(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CreateAppInput>) =>
      api.patch<{ data: TrackedApp }>(`/apps/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blip', 'apps'] });
      qc.invalidateQueries({ queryKey: ['blip', 'apps', id] });
    },
  });
}

export function useDeleteApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { id: string } }>(`/apps/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'apps'] }),
  });
}

export function useSetCollection(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.post<{ data: TrackedApp }>(`/apps/${id}/collection`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blip', 'apps'] });
      qc.invalidateQueries({ queryKey: ['blip', 'apps', id] });
    },
  });
}

export function useSetRateLimit(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: RateLimitSpec) =>
      api.put<{ data: TrackedApp }>(`/apps/${id}/rate-limit`, spec),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'apps', id] }),
  });
}

// ---------------------------------------------------------------------------
// Ingest keys
// ---------------------------------------------------------------------------

export type KeyStatus = 'active' | 'suspended' | 'revoked';

export interface IngestKey {
  id: string;
  tracked_app_id: string;
  key_id: string;
  last4: string;
  fingerprint: string;
  label?: string | null;
  status: KeyStatus;
  rate_limit_override?: RateLimitSpec | null;
  created_at: string;
  last_used_at?: string | null;
  suspended_at?: string | null;
}

/** Create-key response carries the one-time plaintext token. */
export interface IngestKeyCreated extends IngestKey {
  token: string; // blip_<key_id>_<secret> — shown exactly once
}

export function useKeys(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'keys', appId],
    queryFn: () => api.get<{ data: IngestKey[] }>(`/apps/${appId}/keys`),
    enabled: !!appId,
  });
}

export function useCreateKey(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { label?: string; rate_limit_override?: RateLimitSpec | null }) =>
      api.post<{ data: IngestKeyCreated }>(`/apps/${appId}/keys`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'keys', appId] }),
  });
}

export function useSuspendKey(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, suspend }: { id: string; suspend: boolean }) =>
      api.post<{ data: IngestKey }>(`/keys/${id}/suspend`, { suspend }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'keys', appId] }),
  });
}

export function useRevokeKey(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: IngestKey }>(`/keys/${id}/revoke`, { confirm_action: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'keys', appId] }),
  });
}

export function useUpdateKey(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; label?: string; rate_limit_override?: RateLimitSpec | null }) =>
      api.patch<{ data: IngestKey }>(`/keys/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'keys', appId] }),
  });
}

// ---------------------------------------------------------------------------
// Report types + field catalog
// ---------------------------------------------------------------------------

export interface ReportType {
  report_type: string;
  entry_count?: number;
  first_seen?: string;
  last_seen?: string;
  field_count?: number;
}

export function useReportTypes(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'types', appId],
    queryFn: () => api.get<{ data: ReportType[] }>(`/apps/${appId}/types`),
    enabled: !!appId,
  });
}

export interface FieldCatalogEntry {
  id: string;
  tracked_app_id: string;
  report_type: string;
  field_path: string;
  inferred_type: 'string' | 'number' | 'bool' | 'object' | 'array' | 'mixed';
  is_metric: boolean;
  is_indexed: boolean;
  first_seen: string;
  last_seen: string;
  observation_count: number;
}

export function useFieldCatalog(appId: string | undefined, reportType: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'fields', appId, reportType],
    queryFn: () =>
      api.get<{ data: FieldCatalogEntry[] }>(
        `/apps/${appId}/types/${encodeURIComponent(reportType!)}/fields`,
      ),
    enabled: !!appId && !!reportType,
  });
}

export function useIndexField(appId: string | undefined, reportType: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fieldPath: string) =>
      api.post<{ data: FieldCatalogEntry }>(
        `/apps/${appId}/types/${encodeURIComponent(reportType!)}/fields/${encodeURIComponent(fieldPath)}/index`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'fields', appId, reportType] }),
  });
}

export function useSetMetric(appId: string | undefined, reportType: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fieldPath, is_metric }: { fieldPath: string; is_metric: boolean }) =>
      api.post<{ data: FieldCatalogEntry }>(
        `/apps/${appId}/types/${encodeURIComponent(reportType!)}/fields/${encodeURIComponent(fieldPath)}/metric`,
        { is_metric },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'fields', appId, reportType] }),
  });
}

// ---------------------------------------------------------------------------
// Entries (query / tail / purge / export)
// ---------------------------------------------------------------------------

export interface CaptureRef {
  object_key: string;
  thumb_key: string;
  bytes: number;
  content_type?: string;
  width?: number;
  height?: number;
  sha256?: string;
  // tail placeholder for a not-yet-stored capture
  pending?: boolean;
  index?: number;
}

export interface BlipEntry {
  id: string;
  seq: number | string;
  received_at: string;
  tracked_app_id: string;
  report_type: string;
  ingest_key_id?: string | null;
  client_ts?: string | null;
  level?: string | null;
  session_id?: string | null;
  app_version?: string | null;
  platform?: string | null;
  elapsed_ms?: number | null;
  capture_count: number;
  payload: Record<string, unknown>;
  payload_bytes?: number;
}

export interface EntryQueryInput {
  report_type: string;
  filter?: PredicateTree | null;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  page_size?: number;
  cursor?: number | string | null;
  format?: 'json' | 'jsonl';
}

export interface EntryQueryResult {
  data: BlipEntry[];
  next_cursor?: number | string | null;
  total?: number;
}

export function useEntryQuery(appId: string | undefined, input: EntryQueryInput | null) {
  return useQuery({
    queryKey: ['blip', 'entries', appId, input],
    queryFn: () => api.post<EntryQueryResult>(`/apps/${appId}/entries/query`, input),
    enabled: !!appId && !!input?.report_type,
  });
}

export function usePurgeEntries(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { report_type: string; filter?: PredicateTree | null }) =>
      api.post<{ data: { purged: number } }>(`/apps/${appId}/entries/purge`, {
        ...input,
        confirm_action: true,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'entries', appId] }),
  });
}

export function useExportEntries(appId: string | undefined) {
  return useMutation({
    mutationFn: (input: { report_type: string; filter?: PredicateTree | null }) =>
      api.post<{ data: { bin_asset_id: string } }>(`/apps/${appId}/entries/export`, input),
  });
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

/** Resolve a stored capture ref (or its thumbnail) to a short-TTL presigned URL. */
export async function captureUrl(ref: string, thumb = false): Promise<string> {
  const res = await api.get<{ data: { url: string } }>(
    `/captures/${encodeURIComponent(ref)}/url`,
    { thumb: thumb ? 'true' : undefined },
  );
  return res.data.url;
}

// ---------------------------------------------------------------------------
// Timelapse
// ---------------------------------------------------------------------------

export interface TimelapseJob {
  id: string;
  tracked_app_id: string;
  report_type?: string | null;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'ready' | 'failed';
  frame_count?: number | null;
  video_asset_ref?: Record<string, unknown> | null;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export interface TimelapseCreateInput {
  report_type: string;
  filter?: PredicateTree | null;
  order?: string; // default 'seq asc'
  frame_duration_sec?: number; // default 0.5
  image_selection?: 'first' | 'all';
  max_dimension?: number;
}

export function useTimelapses(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'timelapse', appId],
    queryFn: () => api.get<{ data: TimelapseJob[] }>(`/apps/${appId}/timelapse`),
    enabled: !!appId,
  });
}

export function useTimelapse(id: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'timelapse-job', id],
    queryFn: () => api.get<{ data: TimelapseJob }>(`/timelapse/${id}`),
    enabled: !!id,
  });
}

export function useCreateTimelapse(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TimelapseCreateInput) =>
      api.post<{ data: TimelapseJob }>(`/apps/${appId}/timelapse`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'timelapse', appId] }),
  });
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

export type WatchKind = 'match' | 'window';

export interface WindowPredicate {
  window_sec: number;
  aggregate: { op: 'count' | 'rate' | 'avg' | 'min' | 'max' | 'p50' | 'p95' | 'p99'; field?: string };
  comparator: { operator: 'gt' | 'gte' | 'lt' | 'lte'; value: number };
}

export interface Watch {
  id: string;
  tracked_app_id: string;
  report_type?: string | null;
  name: string;
  description?: string | null;
  kind: WatchKind;
  enabled: boolean;
  predicate: PredicateTree | WindowPredicate;
  cooldown_sec: number;
  created_at: string;
  updated_at?: string;
  last_fired_at?: string | null;
}

export interface WatchEvent {
  id: string;
  watch_id: string;
  tracked_app_id: string;
  report_type?: string | null;
  event_name: 'entry.matched' | 'window.breached' | 'window.recovered';
  fired_at: string;
  context: Record<string, unknown>;
}

export function useWatches(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'watches', appId],
    queryFn: () => api.get<{ data: Watch[] }>(`/apps/${appId}/watches`),
    enabled: !!appId,
  });
}

export interface CreateWatchInput {
  name: string;
  description?: string;
  report_type?: string | null;
  kind: WatchKind;
  predicate: PredicateTree | WindowPredicate;
  cooldown_sec?: number;
}

export function useCreateWatch(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWatchInput) =>
      api.post<{ data: Watch }>(`/apps/${appId}/watches`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'watches', appId] }),
  });
}

export function useSetWatchEnabled(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<{ data: Watch }>(`/watches/${id}/enabled`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'watches', appId] }),
  });
}

export function useDeleteWatch(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ data: { id: string } }>(`/watches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'watches', appId] }),
  });
}

export interface WatchTestResult {
  data: BlipEntry[];
  matched_count?: number;
  value?: number;
}

export function useTestWatch(appId: string | undefined) {
  return useMutation({
    mutationFn: (input: { report_type?: string | null; kind: WatchKind; predicate: PredicateTree | WindowPredicate }) =>
      api.post<WatchTestResult>(`/apps/${appId}/watches/test`, input),
  });
}

export function useWatchHistory(watchId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'watch-history', watchId],
    queryFn: () => api.get<{ data: WatchEvent[] }>(`/watches/${watchId}/history`),
    enabled: !!watchId,
  });
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export interface ViewSpec {
  filter?: PredicateTree | null;
  columns?: Array<{ field: string; label?: string; width?: number }>;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  liveTail?: boolean;
  pageSize?: number;
}

export interface SavedView {
  id: string;
  tracked_app_id: string;
  report_type: string;
  name: string;
  owner_id: string;
  scope: 'private' | 'org';
  is_default: boolean;
  spec: ViewSpec;
  created_at: string;
  updated_at?: string;
}

export function useViews(appId: string | undefined, reportType: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'views', appId, reportType],
    queryFn: () =>
      api.get<{ data: SavedView[] }>(
        `/apps/${appId}/types/${encodeURIComponent(reportType!)}/views`,
      ),
    enabled: !!appId && !!reportType,
  });
}

export interface CreateViewInput {
  tracked_app_id: string;
  report_type: string;
  name: string;
  scope?: 'private' | 'org';
  spec: ViewSpec;
}

export function useCreateView(appId: string | undefined, reportType: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateViewInput) => api.post<{ data: SavedView }>('/views', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'views', appId, reportType] }),
  });
}

export function useDeleteView(appId: string | undefined, reportType: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { id: string } }>(`/views/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'views', appId, reportType] }),
  });
}

// ---------------------------------------------------------------------------
// Transform (PII rules) + Retention
// ---------------------------------------------------------------------------

export type TransformAction = 'drop' | 'mask' | 'hash' | 'truncate';

export interface TransformRule {
  match: string; // 'payload:user.email' | 'glob:*token*' | 'regex:...'
  action: TransformAction;
  params?: { keep_last?: number; max_len?: number };
}

export interface TransformSet {
  report_type?: string | null;
  enabled: boolean;
  rules: TransformRule[];
  version?: number;
}

export function useTransform(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'transform', appId],
    queryFn: () => api.get<{ data: TransformSet }>(`/apps/${appId}/transform`),
    enabled: !!appId,
  });
}

export function useSetTransform(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransformSet) =>
      api.put<{ data: TransformSet }>(`/apps/${appId}/transform`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'transform', appId] }),
  });
}

export interface RetentionPolicy {
  report_type?: string | null; // null = app-wide default
  max_age_days?: number | null;
  max_rows?: number | null;
  max_bytes?: number | null;
}

export function useRetention(appId: string | undefined) {
  return useQuery({
    queryKey: ['blip', 'retention', appId],
    queryFn: () => api.get<{ data: RetentionPolicy[] }>(`/apps/${appId}/retention`),
    enabled: !!appId,
  });
}

export function useSetRetention(appId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RetentionPolicy) =>
      api.put<{ data: RetentionPolicy }>(`/apps/${appId}/retention`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blip', 'retention', appId] }),
  });
}
