/**
 * Blip ingest queue producer (Blip §4.1 step 11). The edge enqueues the redacted
 * batch for durable write; the blip-ingest worker (apps/worker) drains it.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BLIP_INGEST_QUEUE,
  BLIP_EXPORT_JSONL_QUEUE,
  BLIP_TIMELAPSE_QUEUE,
  BLIP_FIELD_INDEX_QUEUE,
  type BlipIngestJobData,
  type BlipExportJobData,
  type BlipTimelapseJobData,
  type BlipFieldIndexJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

export async function enqueueIngest(data: BlipIngestJobData): Promise<void> {
  await getQueue(BLIP_INGEST_QUEUE).add('ingest', data, { removeOnComplete: 1000, removeOnFail: 2000 });
}

export async function enqueueExport(data: BlipExportJobData): Promise<void> {
  await getQueue(BLIP_EXPORT_JSONL_QUEUE).add('export', data, { removeOnComplete: 200, removeOnFail: 500 });
}

export async function enqueueTimelapse(data: BlipTimelapseJobData): Promise<void> {
  await getQueue(BLIP_TIMELAPSE_QUEUE).add('timelapse', data, { removeOnComplete: 200, removeOnFail: 500 });
}

export async function enqueueFieldIndex(data: BlipFieldIndexJobData): Promise<void> {
  await getQueue(BLIP_FIELD_INDEX_QUEUE).add('index', data, { removeOnComplete: 100, removeOnFail: 200 });
}
