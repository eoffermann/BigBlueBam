/**
 * Blip timelapse job orchestration (Blip §23.4, §15). Records a timelapse
 * compilation job and hands it to the blip-timelapse worker, which compiles the
 * ordered, filtered, capture-bearing entries into an MP4 stored as a Bin asset
 * (carried back on the job as `video_asset_ref`). Params are captured so a job
 * is reproducible. Every query is org-scoped.
 */
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipTimelapseJobs } from '../db/schema/index.js';
import { enqueueTimelapse } from '../lib/queue.js';
import { getApp } from './app.service.js';
import { NotFoundError } from './errors.js';

export interface CreateTimelapseInput {
  filter?: unknown;
  order?: unknown;
  frame_duration_sec?: number;
  image_selection?: 'first' | 'all';
  max_dimension?: number;
  report_type?: string | null;
}

/** Queue a timelapse compilation job and return its id + status. */
export async function createTimelapse(
  appId: string,
  orgId: string,
  userId: string,
  input: CreateTimelapseInput,
) {
  await getApp(appId, orgId);
  const params = {
    filter: input.filter ?? null,
    order: input.order ?? null,
    frame_duration_sec: input.frame_duration_sec ?? 0.5,
    image_selection: input.image_selection ?? 'first',
    max_dimension: input.max_dimension ?? null,
  };
  const rows = await db
    .insert(blipTimelapseJobs)
    .values({
      org_id: orgId,
      tracked_app_id: appId,
      report_type: input.report_type ?? null,
      params,
      status: 'queued',
      created_by: userId,
    })
    .returning();
  const job = rows[0]!;
  await enqueueTimelapse({ job_id: job.id, org_id: orgId, tracked_app_id: appId });
  return { job_id: job.id, status: job.status };
}

export async function getJob(jobId: string, orgId: string) {
  const rows = await db
    .select()
    .from(blipTimelapseJobs)
    .where(and(eq(blipTimelapseJobs.id, jobId), eq(blipTimelapseJobs.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Timelapse job not found');
  return rows[0]!;
}

export async function listJobs(appId: string, orgId: string) {
  await getApp(appId, orgId);
  return db
    .select()
    .from(blipTimelapseJobs)
    .where(and(eq(blipTimelapseJobs.tracked_app_id, appId), eq(blipTimelapseJobs.org_id, orgId)))
    .orderBy(desc(blipTimelapseJobs.created_at));
}
