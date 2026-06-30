/**
 * Blip timelapse compilation (Blip §23.4).
 *
 * Any filtered, ordered collection of capture-bearing entries can be stitched
 * into an MP4 — the intent case being a session timelapse (filter to one
 * session_id, order by seq, one frame per capture, fixed frame duration).
 *
 * The worker:
 *   1. Loads the blip_timelapse_jobs row + params, marks it running.
 *   2. Queries the ordered capture-bearing entries (capture_count > 0).
 *   3. Downloads the selected full images (object_key refs) to a temp dir.
 *   4. Runs ffmpeg to assemble an MP4 at the chosen per-frame duration, padding
 *      mixed orientations to a common canvas (max_dimension ceiling).
 *   5. PUTs the MP4 to storage, sets the job to ready with the video ref +
 *      frame count, and emits timelapse.ready.
 *   6. On any failure, sets the job to failed with the error message.
 *
 * ffmpeg is already in the worker image (installed for bin-transcode); no
 * Dockerfile change. Storing the result as a *first-class Bin asset* (so it
 * picks up Bin's transcode proxy/poster columns) is a follow-up TODO — for now
 * the compiled video lives on the storage backbone and the ref is recorded on
 * the job row.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { publishBoltEvent, type BlipTimelapseJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { getObjectBuffer, putObjectBuffer } from '../utils/storage.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFMPEG_TIMEOUT_MS = Number(process.env.BLIP_TIMELAPSE_TIMEOUT_MS ?? 10 * 60_000);
const MAX_FRAMES = 5000;

interface JobRow {
  id: string;
  org_id: string;
  tracked_app_id: string;
  report_type: string | null;
  params: {
    filter?: Record<string, unknown>;
    order?: string;
    frame_duration_sec?: number;
    image_selection?: 'first' | 'all';
    max_dimension?: number;
  };
}

interface EntryRow {
  payload: { screen_captures?: Array<{ object_key?: string }> };
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.stderr?.on('data', (d) => {
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

async function exists(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

export async function processBlipTimelapseJob(
  job: Job<BlipTimelapseJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { job_id, org_id, tracked_app_id } = job.data;

  const jobRows = rows<JobRow>(
    await db.execute(sql`
      SELECT id, org_id, tracked_app_id, report_type, params
      FROM blip_timelapse_jobs
      WHERE id = ${job_id} AND org_id = ${org_id}
      LIMIT 1
    `),
  );
  const row = jobRows[0];
  if (!row) {
    logger.warn({ job_id }, 'blip-timelapse: job row not found');
    return;
  }

  await db.execute(sql`
    UPDATE blip_timelapse_jobs SET status = 'running' WHERE id = ${job_id}
  `);

  const dir = await mkdtemp(join(tmpdir(), 'blip-timelapse-'));
  try {
    const params = row.params ?? {};
    const frameDur = Number(params.frame_duration_sec) > 0 ? Number(params.frame_duration_sec) : 0.5;
    const imageSelection = params.image_selection === 'all' ? 'all' : 'first';
    const maxDim = Number(params.max_dimension) > 0 ? Math.floor(Number(params.max_dimension)) : 1280;
    const order = params.order === 'seq desc' ? sql`seq DESC` : sql`seq ASC`;

    // Minimal filter support: session_id equality is the intent case.
    const sessionId =
      params.filter && typeof params.filter.session_id === 'string'
        ? (params.filter.session_id as string)
        : null;
    const typeClause = row.report_type ? sql`AND report_type = ${row.report_type}` : sql``;
    const sessionClause = sessionId ? sql`AND session_id = ${sessionId}` : sql``;

    const entries = rows<EntryRow>(
      await db.execute(sql`
        SELECT payload
        FROM blip_entries
        WHERE org_id = ${org_id}
          AND tracked_app_id = ${tracked_app_id}
          AND capture_count > 0
          ${typeClause}
          ${sessionClause}
        ORDER BY ${order}
        LIMIT ${MAX_FRAMES}
      `),
    );

    // Collect the ordered object keys to fetch.
    const objectKeys: string[] = [];
    for (const e of entries) {
      const caps = e.payload?.screen_captures;
      if (!Array.isArray(caps) || caps.length === 0) continue;
      if (imageSelection === 'all') {
        for (const c of caps) if (c?.object_key) objectKeys.push(c.object_key);
      } else {
        const first = caps.find((c) => c?.object_key);
        if (first?.object_key) objectKeys.push(first.object_key);
      }
    }

    if (objectKeys.length === 0) {
      await db.execute(sql`
        UPDATE blip_timelapse_jobs
        SET status = 'failed', error = 'no capture-bearing entries matched', completed_at = NOW()
        WHERE id = ${job_id}
      `);
      logger.warn({ job_id }, 'blip-timelapse: no frames matched');
      return;
    }

    // Download frames to numbered JPEGs.
    let frameCount = 0;
    for (const key of objectKeys) {
      const buf = await getObjectBuffer(key);
      if (!buf) continue;
      await writeFile(join(dir, `frame_${String(frameCount).padStart(5, '0')}.jpg`), buf);
      frameCount += 1;
    }
    if (frameCount === 0) {
      await db.execute(sql`
        UPDATE blip_timelapse_jobs
        SET status = 'failed', error = 'no frames could be downloaded', completed_at = NOW()
        WHERE id = ${job_id}
      `);
      logger.warn({ job_id }, 'blip-timelapse: all frame downloads failed');
      return;
    }

    // Assemble: -framerate (1/frameDur) input fps; pad to a common even canvas so
    // mixed orientations encode cleanly; yuv420p for broad playback.
    const outPath = join(dir, 'timelapse.mp4');
    const inputFps = 1 / frameDur;
    const vf =
      `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease,` +
      `pad=${maxDim}:${maxDim}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `format=yuv420p`;
    const r = await run(FFMPEG, [
      '-y',
      '-framerate', String(inputFps),
      '-i', join(dir, 'frame_%05d.jpg'),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-r', '30',
      '-movflags', '+faststart',
      outPath,
    ]);
    const size = await exists(outPath);
    if (r.code !== 0 || size === 0) {
      throw new Error(`ffmpeg failed (code ${r.code}): ${r.stderr.slice(-300)}`);
    }

    const mp4 = await readFile(outPath);
    const objectKey = `${org_id}/blip/timelapse/${job_id}.mp4`;
    await putObjectBuffer(objectKey, mp4, 'video/mp4');

    const videoAssetRef = {
      object_key: objectKey,
      content_type: 'video/mp4',
      bytes: size,
      sha256: createHash('sha256').update(mp4).digest('hex'),
    };

    await db.execute(sql`
      UPDATE blip_timelapse_jobs
      SET status = 'ready',
          frame_count = ${frameCount},
          video_asset_ref = ${JSON.stringify(videoAssetRef)}::jsonb,
          error = NULL,
          completed_at = NOW()
      WHERE id = ${job_id}
    `);

    await publishBoltEvent(
      'timelapse.ready',
      'blip',
      {
        job_id,
        tracked_app_id,
        video_asset_ref: videoAssetRef,
        frame_count: frameCount,
        frame_duration_sec: frameDur,
      },
      org_id,
    );

    logger.info({ job_id, frameCount, objectKey }, 'blip-timelapse: ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ job_id, err: message }, 'blip-timelapse: failed');
    await db
      .execute(sql`
        UPDATE blip_timelapse_jobs
        SET status = 'failed', error = ${message}, completed_at = NOW()
        WHERE id = ${job_id}
      `)
      .catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
