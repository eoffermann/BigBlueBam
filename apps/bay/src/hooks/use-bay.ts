import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Asset types (mirror apps/bay-api review-asset model)
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'video' | 'audio' | 'model';

export interface BayAsset {
  id: string;
  name: string;
  media_kind: MediaKind;
  current_version_id: string | null;
  project_id: string | null;
  created_at: string;
  archived_at: string | null;
}

export function useAssets(params?: { project_id?: string }) {
  return useQuery({
    queryKey: ['bay', 'assets', params],
    queryFn: () => api.get<{ data: BayAsset[] }>('/v1/assets', params),
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'assets', id],
    queryFn: () => api.get<{ data: BayAsset }>(`/v1/assets/${id}`),
    enabled: !!id,
  });
}

export interface CreateAssetInput {
  name: string;
  media_kind: MediaKind;
  project_id?: string;
}

export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAssetInput) => api.post<{ data: BayAsset }>('/v1/assets', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'assets'] });
    },
  });
}

export function useArchiveAsset(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ data: BayAsset }>(`/v1/assets/${id}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'assets'] });
      qc.invalidateQueries({ queryKey: ['bay', 'assets', id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Media (bytes live in Bin; Bay versions reference them, BAY-3)
// ---------------------------------------------------------------------------

export function mediaKindFromMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'model';
}

/** Same-origin URL for a version's bytes, served (scan-gated) by Bin. Pass
 *  variant='proxy' for the web-friendly transcode or 'poster' for the still;
 *  both 404 gracefully (the player falls back to the original). */
export function binRawUrl(binAssetId: string, variant?: 'proxy' | 'poster'): string {
  const base = `/bin/api/v1/assets/${binAssetId}/raw`;
  return variant ? `${base}?variant=${variant}` : base;
}

function orgHeaders(): Record<string, string> {
  try {
    const org = (globalThis as { __bayAuthStore?: { getState?: () => { user?: { org_id?: string } } } })
      .__bayAuthStore?.getState?.()?.user?.org_id;
    return org ? { 'X-Org-Id': org } : {};
  } catch {
    return {};
  }
}

/** Upload a file's bytes into Bin and return the new bin asset id. Bytes are
 *  scan-gated; the bin asset is `pending` until the AV sweep clears it. */
export async function uploadFileToBin(file: File): Promise<string> {
  const createRes = await fetch('/bin/api/v1/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    credentials: 'include',
    body: JSON.stringify({ name: file.name, content_type: file.type || 'application/octet-stream' }),
  });
  if (!createRes.ok) throw new Error(`Bin asset create failed (${createRes.status})`);
  const created = (await createRes.json()) as { data: { id: string } };
  const binAssetId = created.data.id;
  const fd = new FormData();
  fd.append('file', file, file.name);
  const upRes = await fetch(`/bin/api/v1/assets/${binAssetId}/upload`, {
    method: 'POST',
    headers: orgHeaders(),
    credentials: 'include',
    body: fd,
  });
  if (!upRes.ok) throw new Error(`Bin upload failed (${upRes.status})`);
  return binAssetId;
}

/** Upload a file as a new review asset: Bin bytes → Bay asset → first version. */
export function useUploadNewAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name }: { file: File; name?: string }) => {
      const binAssetId = await uploadFileToBin(file);
      const asset = (
        await api.post<{ data: BayAsset }>('/v1/assets', {
          name: name || file.name,
          media_kind: mediaKindFromMime(file.type),
        })
      ).data;
      await api.post(`/v1/assets/${asset.id}/versions`, {
        bin_asset_id: binAssetId,
        media_meta: { codec: file.type || undefined },
      });
      return asset;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bay', 'assets'] }),
  });
}

/** Upload a file as a NEW version of an existing review asset. */
export function useUploadVersion(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const binAssetId = await uploadFileToBin(file);
      return api.post<{ data: BayVersion }>(`/v1/assets/${assetId}/versions`, {
        bin_asset_id: binAssetId,
        media_meta: { codec: file.type || undefined },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'versions', assetId] });
      qc.invalidateQueries({ queryKey: ['bay', 'assets', assetId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Bin media assets (Bay shows only MEDIA files from the Bin file store)
// ---------------------------------------------------------------------------

export interface BinMediaAsset {
  id: string;
  name: string;
  content_type: string;
  scan_status: string;
  current_version_id: string | null;
  tags?: string[];
  created_at: string;
}

/** True when a Bin content_type is reviewable media (image/video/audio). */
const MODEL_EXT_RE = /\.(fbx|obj|stl|glb|gltf|ply|dae|usd|usdz|usdc|usda)$/i;

/** Reviewable media: image/video/audio/model by MIME prefix, or a known 3D model
 *  extension (FBX et al. commonly upload as application/octet-stream). */
function isReviewableMedia(asset: { content_type?: string | null; name?: string | null }): boolean {
  const ct = asset.content_type ?? '';
  if (
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.startsWith('model/')
  ) {
    return true;
  }
  return MODEL_EXT_RE.test(asset.name ?? '');
}

/** List Bin assets and filter to reviewable media. Bay is the place you review
 *  the media files that live in Bin, so the library shows only those. */
export function useBinMediaAssets() {
  return useQuery({
    queryKey: ['bay', 'bin-media-assets'],
    queryFn: async (): Promise<BinMediaAsset[]> => {
      const res = await fetch('/bin/api/v1/assets', {
        credentials: 'include',
        headers: orgHeaders(),
      });
      if (!res.ok) throw new Error(`Bin asset list failed (${res.status})`);
      const json = (await res.json()) as { data: BinMediaAsset[] };
      return (json.data ?? []).filter((a) => isReviewableMedia(a));
    },
  });
}

// ---------------------------------------------------------------------------
// Review resolution (find-or-create the 1:1 review for a Bin asset)
// ---------------------------------------------------------------------------

export interface ResolveReviewInput {
  bin_asset_id: string;
  bin_version_id?: string | null;
  name?: string;
  media_kind?: MediaKind;
  content_type?: string;
}

/** Find-or-create the Bay review for a Bin asset; idempotent. Returns the bay
 *  asset whose id the review page renders. */
export function useResolveReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ResolveReviewInput) =>
      api.post<{ data: BayAsset }>('/v1/review/resolve', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bay', 'assets'] }),
  });
}

// ---------------------------------------------------------------------------
// Public share links (guest review)
// ---------------------------------------------------------------------------

export interface ReviewLink {
  id: string;
  asset_id: string;
  token: string;
  url: string;
  allow_comments: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  created_at: string;
}

export function useReviewLinks(assetId: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'review-links', assetId],
    queryFn: () => api.get<{ data: ReviewLink[] }>('/v1/review-links', { asset_id: assetId! }),
    enabled: !!assetId,
  });
}

export function useCreateReviewLink(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { expires_in_days?: number | null; allow_comments?: boolean }) =>
      api.post<{ data: ReviewLink }>('/v1/review-links', { asset_id: assetId, ...input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bay', 'review-links', assetId] }),
  });
}

export function useRevokeReviewLink(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: ReviewLink }>(`/v1/review-links/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bay', 'review-links', assetId] }),
  });
}

// ---------------------------------------------------------------------------
// Version types
// ---------------------------------------------------------------------------

/** Bounding box / sphere of a model proxy (drives auto-framing + spot scale). */
export interface ModelBounds {
  min?: [number, number, number];
  max?: [number, number, number];
  center?: [number, number, number];
  radius?: number;
}

/** One animation clip on an animated model take (Phase B transport). */
export interface ModelAnimationClip {
  id: string;
  name: string;
  duration_sec: number;
  fps: number;
  frame_count: number;
}

export interface MediaMeta {
  width?: number;
  height?: number;
  duration_sec?: number;
  codec?: string;
  // ---- Model fields (Bay FBX 3D review, §3). All optional; the probe fills
  //      them for media_kind='model'. Kept permissive via the index signature. ----
  /** 'model' when this version is a 3D proxy. */
  kind?: string;
  /** Authored format the GLB proxy was converted from, e.g. 'fbx'. */
  source_format?: string;
  /** Up-axis as authored ('z'); the GLB is normalized to y-up. */
  source_up_axis?: string;
  /** Source unit for the "1 unit = 1 cm" label, e.g. 'cm'. */
  source_unit?: string;
  bounds?: ModelBounds;
  counts?: {
    nodes?: number;
    meshes?: number;
    triangles?: number;
    materials?: number;
    textures?: number;
  };
  skeleton?: { present?: boolean; bones?: number };
  has_animation?: boolean;
  animations?: ModelAnimationClip[];
  proxy?: { format?: string; compression?: string; triangles?: number };
  [key: string]: unknown;
}

export interface BayVersion {
  id: string;
  asset_id: string;
  version_number: number;
  bin_asset_id: string | null;
  bin_version_id: string | null;
  media_meta: MediaMeta | null;
  created_at: string;
}

export function useVersions(assetId: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'versions', assetId],
    queryFn: () => api.get<{ data: BayVersion[] }>(`/v1/assets/${assetId}/versions`),
    enabled: !!assetId,
  });
}

export function useVersion(id: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'version', id],
    queryFn: () => api.get<{ data: BayVersion }>(`/v1/versions/${id}`),
    enabled: !!id,
  });
}

export interface CreateVersionInput {
  bin_asset_id?: string;
  bin_version_id?: string;
  media_meta?: MediaMeta;
}

export function useCreateVersion(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVersionInput) =>
      api.post<{ data: BayVersion }>(`/v1/assets/${assetId}/versions`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'versions', assetId] });
      qc.invalidateQueries({ queryKey: ['bay', 'assets', assetId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Annotation types
// ---------------------------------------------------------------------------

export type AnchorType = 'frame' | 'timerange' | 'region' | 'viewpoint';

export interface FrameAnchor {
  type: 'frame';
  frame: number;
  /** Playback time the frame was captured at (video). */
  time_sec?: number;
}

export interface TimerangeAnchor {
  type: 'timerange';
  start_sec: number;
  end_sec: number;
}

export interface RegionAnchor {
  type: 'region';
  x: number;
  y: number;
  w: number;
  h: number;
  /** For video: the timecode/frame the region belongs to — a region only
   *  identifies what was annotated together with WHEN. */
  time_sec?: number;
  frame?: number;
}

/** Remembered camera for a 3D viewpoint note (§5). Click the note → fly back. */
export interface ViewpointCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  projection: 'perspective' | 'orthographic';
  ortho_height?: number;
}

/** Animated-take time pin (§5). Present only for animated models (Phase B). */
export interface ViewpointTime {
  clip_id: string | null;
  frame: number;
  time_sec: number;
  fps: number;
}

/** Highlighted spot on the mesh (§5/§6). Two robustness tiers: geometry | screen. */
export interface ViewpointSurface {
  mode: 'geometry' | 'screen';
  // geometry mode: glued to the surface, survives orbit.
  node?: string;
  primitive?: number;
  tri?: number;
  bary?: [number, number, number];
  local_point?: [number, number, number];
  radius?: number;
  // screen mode: a normalized box in the captured camera frame.
  rect?: { x: number; y: number; w: number; h: number };
}

/** Screen-space freehand markup relative to the captured camera (§5). */
export interface ViewpointDraw {
  strokes?: Array<{ color: string; width: number; points: Array<[number, number]> }>;
  shapes?: Array<{ type: string; from: [number, number]; to: [number, number] }>;
}

export interface ViewpointAnchor {
  type: 'viewpoint';
  /** The remembered view. Object per §5; a bare string is tolerated for legacy
   *  rows. Always present for notes captured by the 3D viewer. */
  camera?: ViewpointCamera | string;
  time?: ViewpointTime;
  surface?: ViewpointSurface;
  draw?: ViewpointDraw;
  [key: string]: unknown;
}

export type Anchor = FrameAnchor | TimerangeAnchor | RegionAnchor | ViewpointAnchor;

/** A Bay annotation whose anchor is a 3D viewpoint — the shape the model viewer
 *  consumes for rail markers and focus. */
export interface ViewpointAnnotation {
  id: string;
  anchor: ViewpointAnchor;
  body?: string;
  author_name?: string | null;
  resolved?: boolean;
}

export interface BayAnnotation {
  id: string;
  version_id: string;
  author_id: string | null;
  author_name?: string | null;
  anchor: Anchor;
  body: string;
  resolved: boolean;
  created_at: string;
  thread_parent_id?: string | null;
}

export function useAnnotations(versionId: string | undefined, includeResolved: boolean) {
  return useQuery({
    queryKey: ['bay', 'annotations', versionId, includeResolved],
    queryFn: () =>
      api.get<{ data: BayAnnotation[] }>(`/v1/versions/${versionId}/annotations`, {
        include_resolved: includeResolved ? 'true' : undefined,
      }),
    enabled: !!versionId,
  });
}

export interface CreateAnnotationInput {
  anchor: Anchor;
  body: string;
  thread_parent_id?: string;
}

export function useCreateAnnotation(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAnnotationInput) =>
      api.post<{ data: BayAnnotation }>(`/v1/versions/${versionId}/annotations`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'annotations', versionId] });
    },
  });
}

export function useResolveAnnotation(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.post<{ data: BayAnnotation }>(`/v1/annotations/${id}/resolve`, { resolved }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'annotations', versionId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export type DecisionValue = 'approved' | 'rejected' | 'changes_requested' | 'pending';

export interface BayDecision {
  id: string;
  version_id: string;
  reviewer_id: string;
  reviewer_name?: string | null;
  decision: DecisionValue;
  comment: string | null;
  created_at: string;
}

export function useDecisions(versionId: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'decisions', versionId],
    queryFn: () => api.get<{ data: BayDecision[] }>(`/v1/versions/${versionId}/decisions`),
    enabled: !!versionId,
  });
}

export interface SetDecisionInput {
  decision: DecisionValue;
  comment?: string;
}

export function useSetDecision(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetDecisionInput) =>
      api.put<{ data: BayDecision }>(`/v1/versions/${versionId}/decision`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'decisions', versionId] });
    },
  });
}
