/**
 * Bin media transcode + proxy generation (Bay player polish, follow-up).
 *
 * Browsers can't reliably scrub/seek (or even decode) many source media codecs
 * — ProRes, HEVC, mkv, raw wav. Bay's review player needs a web-friendly proxy.
 * This job is that transcoder. It mirrors bin-av-scan: a once-a-minute sweep
 * (plus on-demand `{ asset_id }`) that claims clean, uploaded, not-yet-
 * transcoded media assets and, per kind:
 *
 *   - video → H.264/AAC mp4 proxy (faststart, max 1280w) + a poster jpg
 *   - audio → AAC m4a proxy + a waveform poster png
 *   - image → a downscaled poster jpg (no proxy; originals serve fine)
 *
 * Artifacts are uploaded next to the canonical object (`<key>.proxy.*` /
 * `<key>.poster.*`) and recorded on bin_assets so /assets/:id/raw?variant=
 * proxy|poster can serve them. transcode_status gates the sweep and is reset to
 * 'pending' by bin-api on every new version.
 *
 * Gated on scan_status: only clean/skipped bytes are ever fed to ffmpeg.
 *
 * Requires the `ffmpeg`/`ffprobe` binaries (added to the worker image in
 * apps/worker/Dockerfile). A missing binary marks the asset 'error' (loud) but
 * never crashes the sweep — the original is still served, just without a proxy.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { downloadObjectToFile, putObjectFromFile } from '../utils/storage.js';

export interface BinTranscodeJobData {
  /** Transcode a single asset immediately instead of sweeping. */
  asset_id?: string;
  /** Max assets per sweep. Defaults to 5 (ffmpeg is CPU-heavy). */
  limit?: number;
}

type MediaKind = 'image' | 'video' | 'audio';

interface MediaAssetRow {
  id: string;
  object_key: string;
  content_type: string;
}

interface TranscodeResult {
  proxyKey: string | null;
  proxyContentType: string | null;
  posterKey: string | null;
  durationSec: number | null;
}

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
// A single ffmpeg invocation cap; large/complex media still finishes well under
// this, and a hang shouldn't wedge the sweep.
const FFMPEG_TIMEOUT_MS = Number(process.env.BIN_TRANSCODE_TIMEOUT_MS ?? 5 * 60_000);

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function mediaKind(ct: string): MediaKind | null {
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return null;
}

/** Run a binary, resolving with its exit code + captured stderr. Never rejects
 *  except on spawn error (e.g. ffmpeg not installed). */
function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
    child.stderr?.on('data', (d) => {
      // Keep only the tail; ffmpeg is chatty.
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

async function probeDuration(inputPath: string): Promise<number | null> {
  try {
    const child = spawn(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    if (!child.stdout) return null;
    let out = '';
    for await (const chunk of child.stdout) out += chunk.toString();
    const n = Number.parseFloat(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function transcodeOne(
  asset: MediaAssetRow,
  kind: MediaKind,
  logger: Logger,
): Promise<TranscodeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'bin-transcode-'));
  try {
    const inputPath = join(dir, 'input');
    const ok = await downloadObjectToFile(asset.object_key, inputPath);
    if (!ok) throw new Error(`source object not readable: ${asset.object_key}`);

    const durationSec = await probeDuration(inputPath);
    const result: TranscodeResult = {
      proxyKey: null,
      proxyContentType: null,
      posterKey: null,
      durationSec,
    };

    if (kind === 'video') {
      const proxyPath = join(dir, 'proxy.mp4');
      const r = await run(FFMPEG, [
        '-y', '-i', inputPath,
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        proxyPath,
      ]);
      if (r.code !== 0 || !(await exists(proxyPath))) {
        throw new Error(`ffmpeg video proxy failed (code ${r.code}): ${r.stderr.slice(-300)}`);
      }
      const proxyKey = `${asset.object_key}.proxy.mp4`;
      await putObjectFromFile(proxyKey, proxyPath, 'video/mp4');
      result.proxyKey = proxyKey;
      result.proxyContentType = 'video/mp4';

      // Poster: a frame ~1s in (fall back to frame 0 for very short clips).
      const posterPath = join(dir, 'poster.jpg');
      let pr = await run(FFMPEG, [
        '-y', '-ss', '1', '-i', inputPath, '-frames:v', '1',
        '-vf', "scale='min(1280,iw)':-2", posterPath,
      ]);
      if (pr.code !== 0 || !(await exists(posterPath))) {
        pr = await run(FFMPEG, [
          '-y', '-i', inputPath, '-frames:v', '1',
          '-vf', "scale='min(1280,iw)':-2", posterPath,
        ]);
      }
      if (pr.code === 0 && (await exists(posterPath))) {
        const posterKey = `${asset.object_key}.poster.jpg`;
        await putObjectFromFile(posterKey, posterPath, 'image/jpeg');
        result.posterKey = posterKey;
      }
    } else if (kind === 'audio') {
      const proxyPath = join(dir, 'proxy.m4a');
      const r = await run(FFMPEG, [
        '-y', '-i', inputPath,
        '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        proxyPath,
      ]);
      if (r.code !== 0 || !(await exists(proxyPath))) {
        throw new Error(`ffmpeg audio proxy failed (code ${r.code}): ${r.stderr.slice(-300)}`);
      }
      const proxyKey = `${asset.object_key}.proxy.m4a`;
      await putObjectFromFile(proxyKey, proxyPath, 'audio/mp4');
      result.proxyKey = proxyKey;
      result.proxyContentType = 'audio/mp4';

      // Waveform poster (nice scrub affordance for audio reviews).
      const posterPath = join(dir, 'poster.png');
      const pr = await run(FFMPEG, [
        '-y', '-i', inputPath,
        '-filter_complex', 'showwavespic=s=1200x240:colors=#3b82f6',
        '-frames:v', '1', posterPath,
      ]);
      if (pr.code === 0 && (await exists(posterPath))) {
        const posterKey = `${asset.object_key}.poster.png`;
        await putObjectFromFile(posterKey, posterPath, 'image/png');
        result.posterKey = posterKey;
      }
    } else {
      // image: downscaled poster only; the original serves directly.
      const posterPath = join(dir, 'poster.jpg');
      const r = await run(FFMPEG, [
        '-y', '-i', inputPath, '-frames:v', '1',
        '-vf', "scale='min(1024,iw)':-2", posterPath,
      ]);
      if (r.code === 0 && (await exists(posterPath))) {
        const posterKey = `${asset.object_key}.poster.jpg`;
        await putObjectFromFile(posterKey, posterPath, 'image/jpeg');
        result.posterKey = posterKey;
      }
    }

    logger.info(
      { assetId: asset.id, kind, proxy: Boolean(result.proxyKey), poster: Boolean(result.posterKey) },
      'bin-transcode: done',
    );
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function processBinTranscodeJob(
  job: Job<BinTranscodeJobData>,
  _env: unknown,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { asset_id, limit } = job.data ?? {};
  const cap = limit ?? 5;

  // Retire non-media pending rows so the sweep index stays small (one shot).
  if (!asset_id) {
    await db.execute(sql`
      UPDATE bin_assets SET transcode_status = 'skipped'
      WHERE transcode_status = 'pending'
        AND scan_status IN ('clean', 'skipped')
        AND object_key <> ''
        AND content_type NOT LIKE 'image/%'
        AND content_type NOT LIKE 'video/%'
        AND content_type NOT LIKE 'audio/%'
        -- Models are claimed by bin-model-process (Bay FBX 3D review); do NOT
        -- retire them to 'skipped' here or they never get a GLB proxy.
        AND NOT (
          lower(name) ~ '\.(fbx|obj|stl|glb|gltf|ply|dae|usd|usdz|usdc|usda)$'
          OR lower(object_key) ~ '\.(fbx|obj|stl|glb|gltf|ply|dae|usd|usdz|usdc|usda)$'
          OR content_type LIKE 'model/%'
        )
    `);
  }

  const raw = asset_id
    ? await db.execute(sql`
        SELECT id, object_key, content_type FROM bin_assets
        WHERE id = ${asset_id}
          AND transcode_status = 'pending'
          AND scan_status IN ('clean', 'skipped')
          AND object_key <> ''
        LIMIT 1
      `)
    : await db.execute(sql`
        SELECT id, object_key, content_type FROM bin_assets
        WHERE transcode_status = 'pending'
          AND scan_status IN ('clean', 'skipped')
          AND object_key <> ''
          AND (content_type LIKE 'image/%' OR content_type LIKE 'video/%' OR content_type LIKE 'audio/%')
        ORDER BY created_at ASC
        LIMIT ${cap}
      `);

  const pending = rows<MediaAssetRow>(raw);
  if (pending.length === 0) {
    logger.debug('bin-transcode: no pending media');
    return;
  }

  logger.info({ jobId: job.id, candidates: pending.length }, 'bin-transcode: sweep start');

  let done = 0;
  let errored = 0;
  for (const asset of pending) {
    const kind = mediaKind(asset.content_type);
    if (!kind) {
      await db.execute(sql`
        UPDATE bin_assets SET transcode_status = 'skipped'
        WHERE id = ${asset.id} AND transcode_status = 'pending'
      `);
      continue;
    }
    try {
      const r = await transcodeOne(asset, kind, logger);
      // Only advance rows still pending (a new version may have re-set it).
      await db.execute(sql`
        UPDATE bin_assets SET
          transcode_status = 'done',
          proxy_object_key = ${r.proxyKey},
          proxy_content_type = ${r.proxyContentType},
          poster_object_key = ${r.posterKey},
          duration_sec = ${r.durationSec}
        WHERE id = ${asset.id} AND transcode_status = 'pending'
      `);
      done += 1;
    } catch (err) {
      errored += 1;
      logger.error(
        { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
        'bin-transcode: failed',
      );
      await db.execute(sql`
        UPDATE bin_assets SET transcode_status = 'error'
        WHERE id = ${asset.id} AND transcode_status = 'pending'
      `);
    }
  }

  logger.info({ jobId: job.id, done, errored }, 'bin-transcode: sweep complete');
}
