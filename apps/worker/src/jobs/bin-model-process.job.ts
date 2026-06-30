/**
 * Bin 3D-model processing + GLB proxy generation (Bay FBX 3D review).
 *
 * Spec: docs/plans/BigBlueBam_Bay_FBX_3D_Review_Design_Document.md §2, §3.
 *
 * Browsers can't load FBX/OBJ/STL/USD directly, and Bay's review viewer is
 * three.js, which speaks GLB. This job is the model counterpart of
 * bin-transcode: a once-a-minute sweep (plus on-demand `{ asset_id }`) that
 * claims clean, uploaded, not-yet-processed *model* assets and, per asset:
 *
 *   1. Converts the source (FBX/OBJ/STL/DAE/PLY/USD/...) to a single
 *      self-contained `.glb` via assimpjs (Assimp compiled to WASM, BSD-3,
 *      pure Node — no native CLI, no Dockerfile change). A source that is
 *      already `.glb` skips Assimp and is normalized through gltf-transform.
 *   2. Optionally runs a gltf-transform optimize pass (weld/dedup/prune) behind
 *      BIN_MODEL_OPTIMIZE. meshopt geometry compression needs the meshoptimizer
 *      encoder, which is not wired here, so `proxy.compression` stays `'none'`.
 *   3. Probes the GLB document and emits `media_meta` (§3): bounds, counts,
 *      skeleton, animations, source format/up-axis/unit, proxy descriptor.
 *   4. (Poster render is DEFERRED for v1 — no headless GL in the worker image,
 *      see §2.2/§2.3 — so poster_object_key is left null.)
 *
 * Artifacts land next to the canonical object (`<key>.proxy.glb`) and are
 * recorded on bin_assets via the same storage utils bin-transcode uses.
 * `proxy_content_type` is `model/gltf-binary`. After write-back the probe is
 * copied forward (merged) into any bay_asset_versions rows linked to the asset
 * so the Bay viewer reads it without a byte round-trip.
 *
 * Gated on scan_status: only clean/skipped bytes are ever fed to the converter.
 * The transcode sweep's "retire to skipped" step is made extension-aware (see
 * bin-transcode.job.ts) so model rows are NOT swept away before this job runs;
 * the two sweeps share `transcode_status` but claim disjoint rows by predicate.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { NodeIO, getBounds } from '@gltf-transform/core';
import type { Document } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';
import assimpjs from 'assimpjs';
import { getDb } from '../utils/db.js';
import { downloadObjectToFile, putObjectFromFile } from '../utils/storage.js';

// assimpjs types live in ../types/assimpjs.d.ts (ambient).

export interface BinModelProcessJobData {
  /** Process a single asset immediately instead of sweeping. */
  asset_id?: string;
  /** Max assets per sweep. Defaults to 3 (conversion is CPU + memory heavy). */
  limit?: number;
}

interface ModelAssetRow {
  id: string;
  object_key: string;
  content_type: string;
  name: string;
}

interface ModelProcessResult {
  proxyKey: string;
  proxyContentType: string;
  mediaMeta: Record<string, unknown>;
}

// Extensions routed to the model path (§2.1). Kept in one place so the claim
// SQL, the retire-step exclusion (bin-transcode.job.ts), and the per-asset
// format detection stay in lockstep.
const MODEL_EXTS = [
  'fbx', 'obj', 'stl', 'glb', 'gltf', 'ply', 'dae', 'usd', 'usdz', 'usdc', 'usda',
] as const;
// POSIX-regex alternation used by the claim/retire SQL ('\.(fbx|obj|...)$').
const MODEL_EXT_REGEX = `\\.(${MODEL_EXTS.join('|')})$`;

// File-size ceiling (§2.3): a multi-million-triangle source can pin a core for
// minutes on the shared worker. Reject above this with a loud `error`.
const MODEL_MAX_BYTES = Number(process.env.BIN_MODEL_MAX_BYTES ?? 314_572_800); // ~300MB
// Per-invocation wall-clock cap so a pathological file can't wedge the sweep.
const MODEL_TIMEOUT_MS = Number(process.env.BIN_MODEL_TIMEOUT_MS ?? 5 * 60_000);
// Optional gltf-transform optimize pass; off by default (aggressive welding
// moves vertices and is wrong for geometry-integrity reviews, §2.2 step 2).
const MODEL_OPTIMIZE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.BIN_MODEL_OPTIMIZE ?? '').toLowerCase(),
);

// glTF primitive modes that produce triangles.
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Lowercased file extension (no dot) of the asset name, falling back to the
 *  object key. Returns null when neither carries one. */
function extOf(name: string, objectKey: string): string | null {
  const src = (name || objectKey).toLowerCase();
  const m = src.match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? null;
}

/** A filename (with extension) for assimpjs's FileList so it can detect the
 *  source format. Prefer the original name; fall back to the object-key base. */
function ajsFileName(name: string, objectKey: string): string {
  const fromName = basename(name || '');
  if (fromName && /\.[a-z0-9]+$/i.test(fromName)) return fromName;
  const fromKey = basename(objectKey || '');
  if (fromKey && /\.[a-z0-9]+$/i.test(fromKey)) return fromKey;
  // Last resort: assimpjs needs *some* extension to sniff the importer.
  return fromName || fromKey || 'model.bin';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Count triangles across every mesh primitive in the document. */
function countTriangles(doc: Document): number {
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      const count = indices ? indices.getCount() : (position ? position.getCount() : 0);
      if (mode === MODE_TRIANGLES) triangles += Math.floor(count / 3);
      else if (mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN) {
        triangles += Math.max(0, count - 2);
      }
    }
  }
  return triangles;
}

/** Probe a GLB document into the §3 model media_meta contract. */
function probeMediaMeta(
  doc: Document,
  sourceFormat: string | null,
  proxyTriangles: number,
  compression: 'none' | 'meshopt',
): Record<string, unknown> {
  const root = doc.getRoot();

  // Bounds (world-space) from the default scene.
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  let bounds: Record<string, unknown> | null = null;
  if (scene) {
    const bbox = getBounds(scene);
    const min = bbox.min.map((n) => round(n, 6));
    const max = bbox.max.map((n) => round(n, 6));
    const center: [number, number, number] = [
      round((bbox.min[0] + bbox.max[0]) / 2, 6),
      round((bbox.min[1] + bbox.max[1]) / 2, 6),
      round((bbox.min[2] + bbox.max[2]) / 2, 6),
    ];
    const radius = round(
      Math.hypot(
        bbox.max[0] - center[0],
        bbox.max[1] - center[1],
        bbox.max[2] - center[2],
      ),
    );
    bounds = { min, max, center, radius };
  }

  // Skeleton: union of joints across all skins.
  const skins = root.listSkins();
  let bones = 0;
  for (const skin of skins) bones += skin.listJoints().length;

  // Animations: glTF tracks are sampled in seconds; frame is derived per §3.
  // fps comes from the source scene rate where exposed; default 30 (recorded).
  const DEFAULT_FPS = 30;
  const animations = root.listAnimations().map((anim, i) => {
    let duration = 0;
    for (const sampler of anim.listSamplers()) {
      const input = sampler.getInput();
      if (!input) continue;
      const maxVals = input.getMax([] as number[]);
      const t = Array.isArray(maxVals) ? (maxVals[0] ?? 0) : 0;
      if (t > duration) duration = t;
    }
    const fps = DEFAULT_FPS;
    return {
      id: `anim_${i}`,
      name: anim.getName() || `anim_${i}`,
      duration_sec: round(duration, 3),
      fps,
      frame_count: Math.round(duration * fps),
    };
  });

  return {
    kind: 'model',
    source_format: sourceFormat,
    // Assimp normalizes to y-up; the source axis/unit are not reliably exposed
    // through the GLB document model, so record null rather than guess (§3).
    source_up_axis: null,
    source_unit: null,
    bounds,
    counts: {
      nodes: root.listNodes().length,
      meshes: root.listMeshes().length,
      triangles: countTriangles(doc),
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
    },
    skeleton: { present: skins.length > 0, bones },
    has_animation: animations.length > 0,
    animations,
    proxy: { format: 'glb', compression, triangles: proxyTriangles },
  };
}

async function processModelOne(
  asset: ModelAssetRow,
  logger: Logger,
): Promise<ModelProcessResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bin-model-'));
  const startedAt = Date.now();
  try {
    const inputPath = join(dir, 'input');
    const ok = await downloadObjectToFile(asset.object_key, inputPath);
    if (!ok) throw new Error(`source object not readable: ${asset.object_key}`);

    const sizeBytes = (await stat(inputPath)).size;
    if (sizeBytes > MODEL_MAX_BYTES) {
      throw new Error(
        `model too large: ${sizeBytes} bytes > ceiling ${MODEL_MAX_BYTES} (BIN_MODEL_MAX_BYTES)`,
      );
    }

    const ext = extOf(asset.name, asset.object_key);
    const sourceFormat = ext;
    const io = new NodeIO();

    // 1. Obtain GLB bytes. `.glb` reads directly; everything else converts.
    let glbBytes: Uint8Array;
    if (ext === 'glb') {
      logger.info({ assetId: asset.id, sizeBytes }, 'bin-model-process: reading glb directly');
      glbBytes = new Uint8Array(await readFile(inputPath));
    } else {
      logger.info(
        { assetId: asset.id, ext, sizeBytes },
        'bin-model-process: converting to glb via assimp (loading WASM)…',
      );
      const ajs = await assimpjs();
      const fl = new ajs.FileList();
      fl.AddFile(ajsFileName(asset.name, asset.object_key), new Uint8Array(await readFile(inputPath)));
      const res = ajs.ConvertFileList(fl, 'glb2');
      if (!res.IsSuccess() || res.FileCount() < 1) {
        throw new Error(`assimp convert failed: ${res.GetErrorCode()}`);
      }
      glbBytes = res.GetFile(0).GetContent();
      logger.info(
        { assetId: asset.id, elapsedMs: Date.now() - startedAt },
        'bin-model-process: assimp conversion complete',
      );
    }

    // 2. Load the document, capture source triangle count, optionally optimize.
    const doc = await io.readBinary(glbBytes);
    const sourceTriangles = countTriangles(doc);
    let compression: 'none' | 'meshopt' = 'none';
    if (MODEL_OPTIMIZE) {
      try {
        await doc.transform(weld(), dedup(), prune());
        logger.info({ assetId: asset.id }, 'bin-model-process: optimize pass applied');
      } catch (err) {
        logger.warn(
          { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
          'bin-model-process: optimize pass failed; serving unoptimized proxy',
        );
      }
    }
    const proxyTriangles = MODEL_OPTIMIZE ? countTriangles(doc) : sourceTriangles;

    // 3. Probe -> media_meta (§3).
    const mediaMeta = probeMediaMeta(doc, sourceFormat, proxyTriangles, compression);

    // 4. Write the normalized GLB proxy next to the canonical object.
    const proxyBytes = await io.writeBinary(doc);
    const proxyPath = join(dir, 'proxy.glb');
    await writeFile(proxyPath, proxyBytes);
    const proxyKey = `${asset.object_key}.proxy.glb`;
    await putObjectFromFile(proxyKey, proxyPath, 'model/gltf-binary');

    logger.info(
      {
        assetId: asset.id,
        sourceFormat,
        triangles: sourceTriangles,
        hasAnimation: mediaMeta.has_animation,
        elapsedMs: Date.now() - startedAt,
      },
      'bin-model-process: done',
    );

    return { proxyKey, proxyContentType: 'model/gltf-binary', mediaMeta };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function processBinModelProcessJob(
  job: Job<BinModelProcessJobData>,
  _env: unknown,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { asset_id, limit } = job.data ?? {};
  const cap = limit ?? 3;

  const raw = asset_id
    ? await db.execute(sql`
        SELECT id, object_key, content_type, name FROM bin_assets
        WHERE id = ${asset_id}
          AND transcode_status = 'pending'
          AND scan_status IN ('clean', 'skipped')
          AND object_key <> ''
        LIMIT 1
      `)
    : await db.execute(sql`
        SELECT id, object_key, content_type, name FROM bin_assets
        WHERE transcode_status = 'pending'
          AND scan_status IN ('clean', 'skipped')
          AND object_key <> ''
          AND (
            lower(name) ~ ${MODEL_EXT_REGEX}
            OR lower(object_key) ~ ${MODEL_EXT_REGEX}
            OR content_type LIKE 'model/%'
          )
        ORDER BY created_at ASC
        LIMIT ${cap}
      `);

  const pending = rows<ModelAssetRow>(raw);
  if (pending.length === 0) {
    logger.debug('bin-model-process: no pending models');
    return;
  }

  logger.info({ jobId: job.id, candidates: pending.length }, 'bin-model-process: sweep start');

  let done = 0;
  let errored = 0;
  for (const asset of pending) {
    try {
      const r = await withTimeout(
        processModelOne(asset, logger),
        MODEL_TIMEOUT_MS,
        `model-process ${asset.id}`,
      );
      // Only advance rows still pending (a new version may have re-set it).
      await db.execute(sql`
        UPDATE bin_assets SET
          transcode_status = 'done',
          proxy_object_key = ${r.proxyKey},
          proxy_content_type = ${r.proxyContentType},
          media_meta = ${JSON.stringify(r.mediaMeta)}::jsonb
        WHERE id = ${asset.id} AND transcode_status = 'pending'
      `);
      done += 1;

      // Copy-forward into Bay so the viewer reads the probe without a byte
      // round-trip. Merge (||) so any client-written fields survive. Bay tables
      // are irrelevant for non-Bay uploads, so failures here are non-fatal.
      try {
        await db.execute(sql`
          UPDATE bay_asset_versions
          SET media_meta = bay_asset_versions.media_meta || ${JSON.stringify(r.mediaMeta)}::jsonb
          WHERE bin_asset_id = ${asset.id}
        `);
      } catch (err) {
        logger.debug(
          { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
          'bin-model-process: bay copy-forward skipped',
        );
      }
    } catch (err) {
      errored += 1;
      logger.error(
        { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
        'bin-model-process: failed',
      );
      await db.execute(sql`
        UPDATE bin_assets SET transcode_status = 'error'
        WHERE id = ${asset.id} AND transcode_status = 'pending'
      `);
    }
  }

  logger.info({ jobId: job.id, done, errored }, 'bin-model-process: sweep complete');
}
